/**
 * instagramChecker.js — v6
 *
 * Strategy (in order of priority):
 *   1. RapidAPI  → Most reliable from datacenter IPs (Railway).
 *   2. HTML scrape via residential proxy (PROXY_URL) if set.
 *   3. Direct HTML scrape fallback (last resort, often blocked on Railway).
 */

const axios = require("axios");

// ── Constants ──────────────────────────────────────────────────────────────
const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY  || null;
const RAPIDAPI_HOST = "instagram-scraper-stable-api.p.rapidapi.com";
const PROXY_URL     = process.env.PROXY_URL     || null;

const CONFIRMATION_NEEDED = 2;

const STATUS = {
  BANNED:       "BANNED",
  ACCESSIBLE:   "ACCESSIBLE",
  RATE_LIMITED: "RATE_LIMITED",
  ERROR:        "ERROR",
};

const confirmationTracker = {};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
];
let uaIndex = 0;
function nextUA() { return USER_AGENTS[(uaIndex++) % USER_AGENTS.length]; }

function jitter(baseMs) {
  const variance = Math.floor(baseMs * 0.2);
  return Math.max(5000, baseMs + Math.floor(Math.random() * variance * 2) - variance);
}

function formatCount(n) {
  if (n === null || n === undefined) return "N/A";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function parseAbbreviated(str) {
  if (!str) return null;
  const clean = str.replace(/,/g, "");
  if (/B$/i.test(clean)) return Math.round(parseFloat(clean) * 1_000_000_000);
  if (/M$/i.test(clean)) return Math.round(parseFloat(clean) * 1_000_000);
  if (/K$/i.test(clean)) return Math.round(parseFloat(clean) * 1_000);
  return parseInt(clean, 10) || null;
}

function extractProfileFromHTML(html, username) {
  const stats = {
    followers: null, following: null, posts: null,
    displayName: null, profilePicUrl: null, isPrivate: false,
  };
  try {
    const sharedMatch = html.match(/window\._sharedData\s*=\s*(\{.+?\});<\/script>/s);
    if (sharedMatch) {
      const json = JSON.parse(sharedMatch[1]);
      const user = json && json.entry_data && json.entry_data.ProfilePage && json.entry_data.ProfilePage[0] && json.entry_data.ProfilePage[0].graphql && json.entry_data.ProfilePage[0].graphql.user;
      if (user) {
        stats.followers    = user.edge_followed_by ? user.edge_followed_by.count : null;
        stats.following    = user.edge_follow ? user.edge_follow.count : null;
        stats.posts        = user.edge_owner_to_timeline_media ? user.edge_owner_to_timeline_media.count : null;
        stats.displayName  = user.full_name || null;
        stats.profilePicUrl = user.profile_pic_url_hd || user.profile_pic_url || null;
        stats.isPrivate    = user.is_private || false;
        return stats;
      }
    }

    const followersM = html.match(/"edge_followed_by":\{"count":(\d+)/);
    const followingM = html.match(/"edge_follow":\{"count":(\d+)/);
    const postsM     = html.match(/"edge_owner_to_timeline_media":\{"count":(\d+)/);
    const nameM      = html.match(/"full_name":"([^"]+)"/);
    const picM       = html.match(/"profile_pic_url_hd":"([^"]+)"/);
    const picFallM   = html.match(/"profile_pic_url":"([^"]+)"/);
    const privateM   = html.match(/"is_private":(true|false)/);

    if (followersM) stats.followers   = parseInt(followersM[1], 10);
    if (followingM) stats.following   = parseInt(followingM[1], 10);
    if (postsM)     stats.posts       = parseInt(postsM[1], 10);
    if (nameM)      stats.displayName = nameM[1].replace(/\\u([\dA-Fa-f]{4})/g, function(_, h) { return String.fromCharCode(parseInt(h, 16)); });
    if (picM || picFallM) stats.profilePicUrl = (picM ? picM[1] : picFallM[1]).replace(/\\\//g, "/");
    if (privateM)   stats.isPrivate   = privateM[1] === "true";

    if (stats.followers !== null) return stats;

    const descM = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
               || html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
    if (descM) {
      const desc = descM[1];
      const fM = desc.match(/([\d,.]+[KMB]?)\s+Followers?/i);
      const gM = desc.match(/([\d,.]+[KMB]?)\s+Following/i);
      const pM = desc.match(/([\d,.]+[KMB]?)\s+Posts?/i);
      if (fM) stats.followers = parseAbbreviated(fM[1]);
      if (gM) stats.following = parseAbbreviated(gM[1]);
      if (pM) stats.posts     = parseAbbreviated(pM[1]);
    }
    const picMetaM = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (picMetaM) stats.profilePicUrl = picMetaM[1];
    const titleM = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (titleM) {
      const nm = titleM[1].match(/^(.+?)\s*\(@/);
      if (nm) stats.displayName = nm[1].trim();
    }
  } catch (_) {}
  return stats;
}

async function checkViaRapidAPI(username) {
  if (!RAPIDAPI_KEY) return null;

  try {
    const resp = await axios.get(
      "https://" + RAPIDAPI_HOST + "/ig_get_fb_profile_hover.php",
      {
        params: { username: username },
        headers: {
          "X-RapidAPI-Key":  RAPIDAPI_KEY,
          "X-RapidAPI-Host": RAPIDAPI_HOST,
        },
        timeout: 15000,
        validateStatus: function() { return true; },
      }
    );

    const httpStatus = resp.status;
    const data = resp.data;

    if (httpStatus === 429) {
      return { status: STATUS.RATE_LIMITED, detail: "RapidAPI quota reached.", profile: null };
    }

    if (httpStatus === 404) {
      return { status: STATUS.ERROR, detail: "RapidAPI: account not found (may be API error).", profile: null };
    }

    const user = (data && data.user) || (data && data.data) || data;

    if (httpStatus === 200 && user && (user.username || user.id)) {
      const profile = {
        followers:    user.follower_count    || (user.edge_followed_by && user.edge_followed_by.count) || null,
        following:    user.following_count   || (user.edge_follow && user.edge_follow.count) || null,
        posts:        user.media_count       || user.timeline_media_count || null,
        displayName:  user.full_name         || null,
        profilePicUrl: user.profile_pic_url_hd || user.profile_pic_url || null,
        isPrivate:    user.is_private        || false,
      };
      return { status: STATUS.ACCESSIBLE, detail: "RapidAPI: profile accessible.", profile: profile };
    }

    return { status: STATUS.BANNED, detail: "RapidAPI: HTTP " + httpStatus + ".", profile: null };

  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, detail: "RapidAPI: request timed out.", profile: null };
    }
    return null;
  }
}

async function checkViaHTTP(username, useProxy) {
  if (useProxy === undefined) useProxy = false;
  const url = "https://www.instagram.com/" + username + "/";
  const headers = {
    "User-Agent": nextUA(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Cache-Control": "max-age=0",
  };

  const axiosConfig = {
    timeout: 15000,
    maxRedirects: 3,
    headers: headers,
    validateStatus: function() { return true; },
  };

  if (useProxy && PROXY_URL) {
    axiosConfig.proxy = false;
    try {
      const HttpsProxyAgent = require("https-proxy-agent").HttpsProxyAgent;
      axiosConfig.httpsAgent = new HttpsProxyAgent(PROXY_URL);
    } catch (_) {
      return null;
    }
  }

  try {
    const resp = await axios.get(url, axiosConfig);
    const httpStatus = resp.status;
    const data = resp.data;

    if (httpStatus === 429) {
      return { status: STATUS.RATE_LIMITED, detail: "HTTP: rate limited (429).", profile: null };
    }
    if (httpStatus === 404) {
      return { status: STATUS.BANNED, detail: "HTTP: 404 not found.", profile: null };
    }
    if (httpStatus === 200) {
      const isSorryPage =
        data.includes("Sorry, this page isn") ||
        data.includes("isn't available") ||
        data.includes("page not available") ||
        data.includes("The link you followed may be broken");

      if (isSorryPage) {
        return { status: STATUS.BANNED, detail: "HTTP: 'not available' page.", profile: null };
      }

      const hasProfile =
        data.includes('"username":"' + username + '"') ||
        data.includes('/@' + username) ||
        data.includes('"ProfilePage"') ||
        data.includes("instagram.com/" + username);

      if (hasProfile) {
        const profile = extractProfileFromHTML(data, username);
        return { status: STATUS.ACCESSIBLE, detail: "HTTP: profile page found.", profile: profile };
      }

      return { status: STATUS.ERROR, detail: "HTTP: ambiguous response (likely soft block).", profile: null };
    }

    return { status: STATUS.BANNED, detail: "HTTP: unexpected status " + httpStatus + ".", profile: null };

  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, detail: "HTTP: request timed out.", profile: null };
    }
    return { status: STATUS.ERROR, detail: "HTTP: " + err.message, profile: null };
  }
}

async function rawCheck(username) {
  const checkedAt = new Date();

  if (RAPIDAPI_KEY) {
    const result = await checkViaRapidAPI(username);
    if (result && result.status !== STATUS.ERROR) {
      return Object.assign({}, result, { checkedAt: checkedAt, method: "RapidAPI" });
    }
  }

  if (PROXY_URL) {
    const result = await checkViaHTTP(username, true);
    if (result && result.status !== STATUS.ERROR) {
      return Object.assign({}, result, { checkedAt: checkedAt, method: "Proxy" });
    }
  }

  const result = await checkViaHTTP(username, false);
  return Object.assign({}, result || { status: STATUS.ERROR, detail: "All methods failed.", profile: null }, { checkedAt: checkedAt, method: "Direct" });
}

async function checkAccount(username, knownStatus) {
  if (knownStatus === undefined) knownStatus = null;
  const raw = await rawCheck(username);

  if (raw.status === STATUS.RATE_LIMITED || raw.status === STATUS.ERROR) {
    delete confirmationTracker[username];
    return Object.assign({}, raw, { confirmed: false });
  }

  const tracker = confirmationTracker[username] || { pendingStatus: null, count: 0, lastProfile: null };

  if (raw.status === knownStatus) {
    confirmationTracker[username] = { pendingStatus: null, count: 0, lastProfile: null };
    return Object.assign({}, raw, { confirmed: false });
  }

  if (tracker.pendingStatus === raw.status) {
    tracker.count++;
    tracker.lastProfile = raw.profile || tracker.lastProfile;
  } else {
    tracker.pendingStatus = raw.status;
    tracker.count = 1;
    tracker.lastProfile = raw.profile || null;
  }

  confirmationTracker[username] = tracker;

  const confirmed = tracker.count >= CONFIRMATION_NEEDED;

  if (confirmed) {
    delete confirmationTracker[username];
  }

  return Object.assign({}, raw, {
    profile: tracker.lastProfile,
    confirmed: confirmed,
    confirmCount: tracker.count,
    confirmNeeded: CONFIRMATION_NEEDED,
  });
}

async function checkAccountOnce(username) {
  return rawCheck(username);
}

module.exports = { checkAccount, checkAccountOnce, STATUS, jitter, formatCount, CONFIRMATION_NEEDED };
