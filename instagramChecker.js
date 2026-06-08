/**
 * instagramChecker.js — v7 (Session Cookie edition)
 *
 * Strategy (in order of priority):
 *   1. Instagram private API  → Uses your own session cookies (rotated).
 *   2. HTML scrape via residential proxy (PROXY_URL) if set.
 *   3. Direct HTML scrape fallback (last resort, often blocked on Railway).
 *
 * Required env vars:
 *   IG_COOKIE_1   — First Instagram session cookie string
 *   IG_COOKIE_2   — Second Instagram session cookie string
 *   PROXY_URL     — (optional) Residential proxy URL
 */
 
const axios = require("axios");
 
// ── Constants ──────────────────────────────────────────────────────────────
const PROXY_URL = process.env.PROXY_URL || null;
 
// Your two Instagram session cookies — set these in Railway env vars
const IG_COOKIES = [
  process.env.IG_COOKIE_1 || null,
  process.env.IG_COOKIE_2 || null,
].filter(Boolean); // removes nulls if one isn't set
 
let cookieIndex = 0;
function nextCookie() {
  if (IG_COOKIES.length === 0) return null;
  const cookie = IG_COOKIES[cookieIndex % IG_COOKIES.length];
  cookieIndex++;
  return cookie;
}
 
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
      const user = json && json.entry_data && json.entry_data.ProfilePage &&
                   json.entry_data.ProfilePage[0] && json.entry_data.ProfilePage[0].graphql &&
                   json.entry_data.ProfilePage[0].graphql.user;
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
 
// ── Extract csrftoken from a cookie string ─────────────────────────────────
function extractCsrfToken(cookieStr) {
  const match = cookieStr.match(/csrftoken=([^;]+)/);
  return match ? match[1] : "missing";
}
 
// ── Instagram private API check (using session cookie) ────────────────────
async function checkViaCookie(username) {
  const cookie = nextCookie();
  if (!cookie) return null; // no cookies configured
 
  const csrfToken = extractCsrfToken(cookie);
 
  try {
    // Instagram's internal web API — same endpoint the browser uses
    const resp = await axios.get(
      "https://www.instagram.com/api/v1/users/web_profile_info/",
      {
        params: { username: username },
        headers: {
          "User-Agent":       nextUA(),
          "Cookie":           cookie,
          "X-CSRFToken":      csrfToken,
          "X-IG-App-ID":      "936619743392459", // standard IG web app ID
          "X-Requested-With": "XMLHttpRequest",
          "Referer":          "https://www.instagram.com/" + username + "/",
          "Accept":           "application/json",
          "Accept-Language":  "en-US,en;q=0.9",
          "Sec-Fetch-Site":   "same-origin",
          "Sec-Fetch-Mode":   "cors",
          "Sec-Fetch-Dest":   "empty",
        },
        timeout: 15000,
        validateStatus: function() { return true; },
      }
    );
 
    const httpStatus = resp.status;
    const data = resp.data;
 
    console.log("[CookieAPI DEBUG]", httpStatus, JSON.stringify(data).slice(0, 300));
 
    if (httpStatus === 429) {
      return { status: STATUS.RATE_LIMITED, detail: "Cookie API: rate limited (429). Rotating cookie next call.", profile: null };
    }
 
    if (httpStatus === 401 || httpStatus === 403) {
      // Session expired or cookie invalid — treat as error so fallback kicks in
      console.warn("[CookieAPI] Auth error " + httpStatus + " — cookie may be expired.");
      return { status: STATUS.ERROR, detail: "Cookie API: auth error " + httpStatus + " (cookie may be expired).", profile: null };
    }
 
    if (httpStatus === 404) {
      return { status: STATUS.BANNED, detail: "Cookie API: account not found (404).", profile: null };
    }
 
    if (httpStatus === 200 && data && data.data && data.data.user) {
      const u = data.data.user;
      const profile = {
        followers:    u.edge_followed_by ? u.edge_followed_by.count : null,
        following:    u.edge_follow      ? u.edge_follow.count      : null,
        posts:        u.edge_owner_to_timeline_media ? u.edge_owner_to_timeline_media.count : null,
        displayName:  u.full_name        || null,
        profilePicUrl: u.profile_pic_url_hd || u.profile_pic_url || null,
        isPrivate:    u.is_private       || false,
      };
      return { status: STATUS.ACCESSIBLE, detail: "Cookie API: profile accessible.", profile: profile };
    }
 
    // 200 but user is null  →  account banned / doesn't exist
    if (httpStatus === 200 && data && data.data && data.data.user === null) {
      return { status: STATUS.BANNED, detail: "Cookie API: user is null (account banned or removed).", profile: null };
    }
 
    return { status: STATUS.ERROR, detail: "Cookie API: unexpected response (HTTP " + httpStatus + ").", profile: null };
 
  } catch (err) {
    if (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT") {
      return { status: STATUS.ERROR, detail: "Cookie API: request timed out.", profile: null };
    }
    return null;
  }
}
 
// ── HTML scrape (direct or via proxy) ─────────────────────────────────────
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
 
// ── Raw check (single attempt, no confirmation logic) ─────────────────────
async function rawCheck(username) {
  const checkedAt = new Date();
 
  // 1. Session cookie API (primary)
  if (IG_COOKIES.length > 0) {
    const result = await checkViaCookie(username);
    if (result && result.status !== STATUS.ERROR) {
      return Object.assign({}, result, { checkedAt: checkedAt, method: "CookieAPI" });
    }
    if (result) {
      console.warn("[rawCheck] Cookie method returned error, falling back. Detail:", result.detail);
    }
  }
 
  // 2. Residential proxy HTML scrape
  if (PROXY_URL) {
    const result = await checkViaHTTP(username, true);
    if (result && result.status !== STATUS.ERROR) {
      return Object.assign({}, result, { checkedAt: checkedAt, method: "Proxy" });
    }
  }
 
  // 3. Direct scrape (last resort)
  const result = await checkViaHTTP(username, false);
  return Object.assign(
    {},
    result || { status: STATUS.ERROR, detail: "All methods failed.", profile: null },
    { checkedAt: checkedAt, method: "Direct" }
  );
}
 
// ── Public checkAccount (with confirmation) ───────────────────────────────
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
