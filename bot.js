/**
 * bot.js — Instagram Account Monitor (v6)
 *
 * Key changes from v5:
 *   • CHECK interval: 2 minutes per account (120 000 ms) — no more false positives
 *     from too-fast polling that triggers Instagram rate limits.
 *   • 10-account maximum (was 200 — unrealistic).
 *   • Confirmation system: status must appear 3× in a row before triggering
 *     an alert. This kills false ban/unban notifications from ambiguous responses.
 *   • Staggered starts: accounts don't all fire at the same second.
 *   • Better rate-limit handling: backs off per-account independently.
 *   • /monitor status uses a one-shot check (no confirmation needed).
 *   • Confirmation progress shown in console so you can see it working.
 *
 * Commands:
 *   /help
 *   /monitor add <username>
 *   /monitor list
 *   /monitor status <username>
 *   /monitor remove <username>
 *   /monitor grant <user>
 *   /monitor revoke <user>
 */

require("dotenv").config();
const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, Events,
  MessageFlags,
} = require("discord.js");

const { monitoringBase, oldClients, permissions, MAX_ACTIVE } = require("./store");
const { checkAccount, checkAccountOnce, STATUS, jitter, formatCount, CONFIRMATION_NEEDED } = require("./instagramChecker");

// ── Env validation ─────────────────────────────────────────────────────────
const REQUIRED_ENV = ["DISCORD_TOKEN", "DISCORD_CHANNEL_ID", "DISCORD_GUILD_ID"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key] || process.env[key].includes("your_")) {
    console.error(`❌  Missing env var: ${key}. Edit your .env file.`);
    process.exit(1);
  }
}
if (!process.env.LOG_CHANNEL_ID || process.env.LOG_CHANNEL_ID.includes("your_")) {
  console.warn("⚠️  LOG_CHANNEL_ID not set — admin activity logging is disabled.");
}
if (!process.env.RAPIDAPI_KEY) {
  console.warn("⚠️  RAPIDAPI_KEY not set — falling back to HTML scraping only (less reliable).");
}

const TOKEN           = process.env.DISCORD_TOKEN;
const CHANNEL_ID      = process.env.DISCORD_CHANNEL_ID;
const GUILD_ID        = process.env.DISCORD_GUILD_ID;
const LOG_CHANNEL_ID  = process.env.LOG_CHANNEL_ID || null;

// 2-minute base interval. Each account also gets a random stagger offset
// so they don't all fire simultaneously and hammer the API together.
const BASE_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || "120000", 10);

// ── Discord client ─────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Slash command definitions ──────────────────────────────────────────────
const userOpt   = (opt) => opt.setName("username").setDescription("Instagram username (without @)").setRequired(true);
const memberOpt = (opt) => opt.setName("user").setDescription("Discord user to grant/revoke access").setRequired(true);

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("How to use the Instagram Monitor bot")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("monitor")
    .setDescription("Instagram account monitor — track bans and recoveries")
    .addSubcommand((s) => s.setName("add")    .setDescription("Add an Instagram account to monitor").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("list")   .setDescription("Show currently active watching list"))
    .addSubcommand((s) => s.setName("status") .setDescription("Check the current status of a monitored account").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("remove") .setDescription("Stop monitoring an account").addStringOption(userOpt))
    .addSubcommand((s) => s.setName("grant")  .setDescription("(Owner) Grant a user access").addUserOption(memberOpt))
    .addSubcommand((s) => s.setName("revoke") .setDescription("(Owner) Revoke a user's access").addUserOption(memberOpt))
    .toJSON(),
];

// ── Register slash commands ────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("📡 Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
}

// ── Admin log ─────────────────────────────────────────────────────────────
async function adminLog({ type, title, description, color, user, guild, fields = [] }) {
  if (!LOG_CHANNEL_ID) return;
  const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!logChannel) return;

  const typeColors  = { COMMAND: 0x5865f2, BOT_RESPONSE: 0x36393f, ALERT: 0xff9900, SYSTEM: 0x888888 };
  const typeLabels  = { COMMAND: "📥 USER COMMAND", BOT_RESPONSE: "📤 BOT RESPONSE", ALERT: "🔔 ALERT SENT", SYSTEM: "⚙️ SYSTEM" };

  const embed = new EmbedBuilder()
    .setColor(color ?? typeColors[type] ?? 0x888888)
    .setTitle(`${typeLabels[type] ?? type} — ${title}`)
    .setDescription(description || "_no detail_")
    .setTimestamp();

  if (user) embed.setAuthor({ name: `${user.tag} (ID: ${user.id})`, iconURL: user.displayAvatarURL?.() });
  if (guild) embed.setFooter({ text: guild });
  if (fields.length) embed.addFields(fields);

  await logChannel.send({ embeds: [embed] }).catch((e) => console.error("Admin log failed:", e.message));
}

// ── Helpers ────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!ms || ms < 0) return "unknown";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function tsField(isoString) {
  if (!isoString) return "Never";
  return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:F>`;
}

function tsRelative(isoString) {
  if (!isoString) return "Never";
  return `<t:${Math.floor(new Date(isoString).getTime() / 1000)}:R>`;
}

function validateUsername(username) {
  return /^[a-zA-Z0-9._]{1,30}$/.test(username);
}

function getAlertMentionIds(account) {
  const { ownerId, allowedUsers } = permissions.listAllowed();
  const ids = new Set();
  if (account.addedById) ids.add(account.addedById);
  if (ownerId) ids.add(ownerId);
  if (Array.isArray(allowedUsers)) allowedUsers.forEach((id) => ids.add(id));
  return [...ids];
}

function resolveProfilePic(username, scrapedUrl) {
  return scrapedUrl || `https://unavatar.io/instagram/${username}`;
}

function buildProfileFields(profile, label = "📸 Last Known Profile Stats") {
  if (!profile || (profile.followers === null && profile.following === null)) {
    return [{ name: label, value: "_Stats unavailable — Instagram did not expose public data._", inline: false }];
  }
  const lines = [];
  if (profile.displayName) lines.push(`**Name:** ${profile.displayName}`);
  lines.push(`**👥 Followers:** ${formatCount(profile.followers) ?? "N/A"}`);
  lines.push(`**➡️ Following:** ${formatCount(profile.following) ?? "N/A"}`);
  if (profile.posts !== null) lines.push(`**🖼️ Posts:** ${formatCount(profile.posts)}`);
  if (profile.isPrivate) lines.push(`**🔒 Account Type:** Private`);
  return [{ name: label, value: lines.join("\n"), inline: false }];
}

// ── Notification: BANNED ──────────────────────────────────────────────────
async function notifyAccountBanned(username, account) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const now        = Date.now();
  const timeTaken  = account.addedAt ? formatDuration(now - new Date(account.addedAt).getTime()) : "unknown";
  const bannedAt   = new Date(now).toISOString();
  const mentionIds = getAlertMentionIds(account);
  const pings      = mentionIds.map((id) => `<@${id}>`).join(" ");
  const adderPing  = account.addedById ? `<@${account.addedById}>` : `**${account.addedBy}**`;
  const profile    = account.cachedProfile || null;
  const picUrl     = resolveProfilePic(username, profile?.profilePicUrl);

  const embed = new EmbedBuilder()
    .setColor(0xff2200)
    .setTitle("🚨  Target Account Has Been Banned!")
    .setDescription(`Hey ${adderPing}!\n\nYour target **@${username}** has just been **BANNED / DELETED** from Instagram.`)
    .setThumbnail(picUrl)
    .addFields(
      { name: "🎯 Target Account",    value: `[@${username}](https://instagram.com/${username})`, inline: true  },
      { name: "👤 Added By",          value: account.addedBy,                                     inline: true  },
      { name: "🕐 Banned At",         value: tsField(bannedAt),                                   inline: false },
      { name: "⏱️ Time Taken to Ban", value: timeTaken,                                           inline: true  },
      { name: "🔢 Total Checks Done", value: account.checkCount.toLocaleString(),                 inline: true  },
      ...buildProfileFields(profile, "📸 Profile Stats at Time of Ban"),
    )
    .setFooter({ text: "Instagram Monitor • Archived to Old Clients automatically" })
    .setTimestamp();

  await channel.send({ content: pings, embeds: [embed], allowedMentions: { users: mentionIds } })
  .then(() => console.log(`✅ Notification sent for @${username}`))
  .catch((err) => console.error(`❌ Failed to send notification for @${username}:`, err.message));

  await adminLog({
    type: "ALERT", title: `@${username} — BANNED`, color: 0xff2200,
    description:
      `🚨 **Ban detected** for \`@${username}\`.\n` +
      `Notification sent to: ${pings}\n\n` +
      `**Added by:** ${account.addedBy} (ID: \`${account.addedById ?? "unknown"}\`)\n` +
      `**Banned at:** ${new Date(bannedAt).toUTCString()}\n` +
      `**Time taken:** ${timeTaken}\n` +
      `**Checks done:** ${account.checkCount.toLocaleString()}`,
    fields: buildProfileFields(profile, "📸 Profile Stats at Ban"),
  });
}

// ── Notification: UNBANNED ────────────────────────────────────────────────
async function notifyAccountUnbanned(username, account, freshProfile) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch((err) => { console.error("❌ Channel fetch failed:", err.message); return null; });
if (!channel) { console.error("❌ Channel not found! Check DISCORD_CHANNEL_ID in Railway variables."); return; }

  const now        = Date.now();
  const timeTaken  = account.addedAt ? formatDuration(now - new Date(account.addedAt).getTime()) : "unknown";
  const unbannedAt = new Date(now).toISOString();
  const mentionIds = getAlertMentionIds(account);
  const pings      = mentionIds.map((id) => `<@${id}>`).join(" ");
  const adderPing  = account.addedById ? `<@${account.addedById}>` : `**${account.addedBy}**`;
  const picUrl     = resolveProfilePic(username, freshProfile?.profilePicUrl);

  const embed = new EmbedBuilder()
    .setColor(0x00ff88)
    .setTitle("✅  Client Account Has Been Recovered!")
    .setDescription(`Hey ${adderPing}!\n\nYour client's account **@${username}** is now **UN-BANNED** and back on Instagram! 🎉`)
    .setThumbnail(picUrl)
    .addFields(
      { name: "🎯 Client Account",      value: `[@${username}](https://instagram.com/${username})`, inline: true  },
      { name: "👤 Added By",            value: account.addedBy,                                     inline: true  },
      { name: "🕐 Unbanned At",         value: tsField(unbannedAt),                                 inline: false },
      { name: "⏱️ Time Taken to Unban", value: timeTaken,                                           inline: true  },
      { name: "🔢 Total Checks Done",   value: account.checkCount.toLocaleString(),                 inline: true  },
      ...buildProfileFields(freshProfile, "📸 Current Profile Stats"),
    )
    .setFooter({ text: "Instagram Monitor • Archived to Old Clients automatically" })
    .setTimestamp();

  await channel.send({ content: pings, embeds: [embed], allowedMentions: { users: mentionIds } })
  .then(() => console.log(`✅ Unban notification sent for @${username}`))
  .catch((err) => console.error(`❌ NOTIFICATION FAILED for @${username}:`, err.message));

  await adminLog({
    type: "ALERT", title: `@${username} — UNBANNED / RECOVERED`, color: 0x00ff88,
    description:
      `✅ **Unban detected** for \`@${username}\`.\n` +
      `Notification sent to: ${pings}\n\n` +
      `**Added by:** ${account.addedBy} (ID: \`${account.addedById ?? "unknown"}\`)\n` +
      `**Unbanned at:** ${new Date(unbannedAt).toUTCString()}\n` +
      `**Time taken:** ${timeTaken}\n` +
      `**Checks done:** ${account.checkCount.toLocaleString()}`,
    fields: buildProfileFields(freshProfile, "📸 Profile Stats at Recovery"),
  });
}

// ── Archive helpers ────────────────────────────────────────────────────────
function archiveRecord(record, reason) {
  const timeTaken  = record.addedAt ? Date.now() - new Date(record.addedAt).getTime() : null;
  const resolution =
    reason === "BAN_DETECTED"     ? `Banned after ${formatDuration(timeTaken)} of monitoring.` :
    reason === "UNBAN_DETECTED"   ? `Recovered after ${formatDuration(timeTaken)} of monitoring.` :
    reason === "MANUALLY_REMOVED" ? "Manually removed from monitoring." : "Archived.";
  oldClients.archive(record, reason, resolution);
}

function archiveAndStop(username, reason) {
  stopMonitoring(username);
  const record = monitoringBase.get(username);
  if (record) {
    archiveRecord(record, reason);
    monitoringBase.update(username, { active: false });
  }
}

// ── Monitor loop ───────────────────────────────────────────────────────────
const activeTimers   = {};   // username → setTimeout handle
const backoffTimers  = {};   // username → per-account backoff ms (resets after success)

async function scheduleCheck(username, initialDelayMs = 0) {
  const account = monitoringBase.get(username);
  if (!account || !account.active) return;

  const delay = initialDelayMs > 0
    ? initialDelayMs
    : jitter(backoffTimers[username] || BASE_INTERVAL_MS);

  activeTimers[username] = setTimeout(async () => {
    const prev = monitoringBase.get(username);
    if (!prev || !prev.active) return;

    // Pass current known status so confirmation logic knows what "changed" means
    const result = await checkAccount(username, prev.lastStatus);

    const updates = {
      lastChecked: result.checkedAt.toISOString(),
      checkCount:  (prev.checkCount || 0) + 1,
    };

    // ── Rate limited ────────────────────────────────────────────────────────
    if (result.status === STATUS.RATE_LIMITED) {
      const backoff = Math.min((backoffTimers[username] || BASE_INTERVAL_MS) * 2, 10 * 60 * 1000); // max 10 min
      backoffTimers[username] = backoff;
      console.warn(`⚠️  [${username}] Rate limited. Backing off to ${Math.round(backoff / 1000)}s.`);
      monitoringBase.update(username, updates);
      scheduleCheck(username, backoff);
      return;
    }

    // ── Error: keep same interval, don't update lastStatus ─────────────────
    if (result.status === STATUS.ERROR) {
      console.warn(`⚠️  [${username}] Check error: ${result.detail}`);
      monitoringBase.update(username, updates);
      scheduleCheck(username);
      return;
    }

   // Success — reset backoff
backoffTimers[username] = BASE_INTERVAL_MS;

// Only update lastStatus after CONFIRMED change
if (result.confirmed) {
  updates.lastStatus = result.status;
}
if (result.status === STATUS.ACCESSIBLE && result.profile) {
  updates.cachedProfile = result.profile;
}
monitoringBase.update(username, updates);

    const methodTag = result.method ? ` [${result.method}]` : "";

    // ── Confirmation progress log ───────────────────────────────────────────
    if (!result.confirmed && result.confirmCount) {
      console.log(
        `[${new Date().toLocaleTimeString()}] @${username} (${prev.mode})${methodTag}` +
        ` → ${result.status} ` +
        `(confirming: ${result.confirmCount}/${CONFIRMATION_NEEDED})`
      );
    } else {
      console.log(
        `[${new Date().toLocaleTimeString()}] @${username} (${prev.mode})${methodTag}` +
        ` → ${result.status}`
      );
    }

    // ── Only act on CONFIRMED status changes ────────────────────────────────
    if (!result.confirmed) {
      scheduleCheck(username);
      return;
    }

    const updated = monitoringBase.get(username);

    // LIVE → BANNED
    if (updated.mode === "WATCH_FOR_BAN" && result.status === STATUS.BANNED) {
      console.log(`🚨  @${username} CONFIRMED BANNED after ${CONFIRMATION_NEEDED} checks. Alerting...`);
      monitoringBase.update(username, {
        active: false,
        eventDetectedAt: result.checkedAt.toISOString(),
        lastStatus: STATUS.BANNED,
      });
      const finalRecord = monitoringBase.get(username);
      archiveRecord(finalRecord, "BAN_DETECTED");
      await notifyAccountBanned(username, finalRecord);
      return;
    }

    // BANNED → ACCESSIBLE
    if (updated.mode === "WATCH_FOR_UNBAN" && result.status === STATUS.ACCESSIBLE) {
      console.log(`✅  @${username} CONFIRMED UNBANNED after ${CONFIRMATION_NEEDED} checks. Alerting...`);
      monitoringBase.update(username, {
        active: false,
        eventDetectedAt: result.checkedAt.toISOString(),
        lastStatus: STATUS.ACCESSIBLE,
        cachedProfile: result.profile,
      });
      const finalRecord = monitoringBase.get(username);
      archiveRecord(finalRecord, "UNBAN_DETECTED");
      await notifyAccountUnbanned(username, finalRecord, result.profile);
      return;
    }

    scheduleCheck(username);
  }, delay);
}

function startMonitoring(username, initialDelayMs = 0) {
  if (activeTimers[username]) clearTimeout(activeTimers[username]);
  scheduleCheck(username, initialDelayMs);
}

function stopMonitoring(username) {
  if (activeTimers[username]) {
    clearTimeout(activeTimers[username]);
    delete activeTimers[username];
  }
  delete backoffTimers[username];
}

function resumeAll() {
  const active = Object.keys(monitoringBase.getActive());
  if (!active.length) {
    console.log("📭 No active accounts to resume.");
    adminLog({ type: "SYSTEM", title: "Bot Started", description: "No active accounts. Ready for new entries." });
    return;
  }

  console.log(`▶️  Resuming monitoring for: ${active.join(", ")}`);

  // Stagger starts: each account fires STAGGER_MS apart so they don't all
  // hit Instagram at the same second.
  const STAGGER_MS = Math.floor(BASE_INTERVAL_MS / (active.length + 1));
  active.forEach((username, i) => {
    const delay = (i + 1) * STAGGER_MS;
    console.log(`  ↪ @${username} first check in ${Math.round(delay / 1000)}s`);
    startMonitoring(username, delay);
  });

  adminLog({
    type: "SYSTEM",
    title: "Bot Restarted — Monitoring Resumed",
    description:
      `Resumed monitoring for **${active.length}** account(s): ` +
      active.map((u) => `\`@${u}\``).join(", ") +
      `\n\nBase interval: **${Math.round(BASE_INTERVAL_MS / 1000)}s** | Confirmations needed: **${CONFIRMATION_NEEDED}**`,
  });
}

// ══════════════════════════════════════════════════════════════════════════
// INTERACTION HANDLER
// ══════════════════════════════════════════════════════════════════════════
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /help ──────────────────────────────────────────────────────────────
  if (commandName === "help") {
    const checkMins = Math.round(BASE_INTERVAL_MS / 60000);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📖  Instagram Monitor — Help")
      .setDescription(
        "This bot monitors Instagram accounts and alerts you the moment they get **banned** or **unbanned**.\n" +
        "Simply add an account and the bot handles everything automatically."
      )
      .addFields(
        {
          name: "➕  `/monitor add <username>`",
          value:
            "Add an Instagram account to monitor.\n" +
            "• If the account is **live**, the bot watches for it getting banned/deleted.\n" +
            "• If the account is **already banned**, the bot watches for it coming back.\n" +
            "_The bot auto-detects which mode to use — just add the username._",
        },
        {
          name: "📋  `/monitor list`",
          value: "Shows all accounts currently being monitored — status, who added them, and how long they've been watched.",
        },
        {
          name: "🔍  `/monitor status <username>`",
          value: "Runs an immediate live check right now and shows current status, profile stats, and check history.",
        },
        {
          name: "🗑️  `/monitor remove <username>`",
          value: "Stops monitoring an account and moves it to the archived Old Clients database.",
        },
        {
          name: "⚙️  Bot Settings",
          value:
            `• Check interval: **every ~${checkMins} minute${checkMins === 1 ? "" : "s"}**\n` +
            `• Max accounts: **${MAX_ACTIVE}**\n` +
            `• Confirmations before alert: **${CONFIRMATION_NEEDED} consecutive checks**\n` +
            "• False positives are prevented — a status must be confirmed multiple times.",
        },
        {
          name: "🔔  How notifications work",
          value:
            "When a **ban** or **unban** is confirmed, an alert is sent that includes:\n" +
            "• Exact time of the event\n" +
            "• How long it took from when you added it\n" +
            "• Follower, following, and post counts\n" +
            "• Profile picture",
        },
      )
      .setFooter({ text: `Instagram Monitor v6 • /monitor add <username> to get started` })
      .setTimestamp();

    await adminLog({
      type: "COMMAND", title: "/help",
      description: `<@${interaction.user.id}> used \`/help\``,
      user: interaction.user,
      guild: `${interaction.guild?.name ?? "DM"} | #${interaction.channel?.name ?? "unknown"}`,
    });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (commandName !== "monitor") return;

  const sub      = interaction.options.getSubcommand();
  const rawUser  = interaction.options.getString("username") || "";
  const username = rawUser.toLowerCase().replace(/^@/, "");
  const logCtx   = `${interaction.guild?.name ?? "DM"} | #${interaction.channel?.name ?? "unknown"}`;

  // ── /monitor grant ─────────────────────────────────────────────────────
  if (sub === "grant") {
    const perms = permissions.load();
    if (!perms.ownerId) {
      permissions.setOwner(interaction.user.id);
    } else if (!permissions.isOwner(interaction.user.id)) {
      await adminLog({ type: "COMMAND", title: "/monitor grant — DENIED", color: 0xff4444,
        description: `<@${interaction.user.id}> tried to grant access but is not the owner.`,
        user: interaction.user, guild: logCtx });
      return interaction.reply({ content: "❌ Only the **owner** can grant access.", ephemeral: true });
    }
    const target = interaction.options.getUser("user");
    permissions.grantAccess(target.id);
    await adminLog({ type: "COMMAND", title: "/monitor grant",
      description: `<@${interaction.user.id}> granted access to <@${target.id}> (\`${target.tag}\`).`,
      user: interaction.user, guild: logCtx });
    return interaction.reply({ content: `✅ **${target.tag}** can now use \`/monitor list\` and will be pinged on all alerts.`, ephemeral: true });
  }

  // ── /monitor revoke ────────────────────────────────────────────────────
  if (sub === "revoke") {
    if (!permissions.isOwner(interaction.user.id)) {
      await adminLog({ type: "COMMAND", title: "/monitor revoke — DENIED", color: 0xff4444,
        description: `<@${interaction.user.id}> tried to revoke access but is not the owner.`,
        user: interaction.user, guild: logCtx });
      return interaction.reply({ content: "❌ Only the **owner** can revoke access.", ephemeral: true });
    }
    const target = interaction.options.getUser("user");
    permissions.revokeAccess(target.id);
    await adminLog({ type: "COMMAND", title: "/monitor revoke",
      description: `<@${interaction.user.id}> revoked access from <@${target.id}>.`,
      user: interaction.user, guild: logCtx });
    return interaction.reply({ content: `🚫 **${target.tag}** no longer has access.`, ephemeral: true });
  }

  // ── /monitor add ───────────────────────────────────────────────────────
  if (sub === "add") {
    if (!validateUsername(username)) {
      return interaction.reply({ content: "❌ Invalid Instagram username. Use only letters, numbers, `.` and `_`.", ephemeral: true });
    }
    if (monitoringBase.get(username)?.active) {
      return interaction.reply({ content: `⚠️ **@${username}** is already being monitored.`, ephemeral: true });
    }
    if (monitoringBase.activeCount() >= MAX_ACTIVE) {
      return interaction.reply({ content: `❌ Monitoring Base is full (${MAX_ACTIVE} slots max). Remove an account first.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    // Use one-shot check for the initial add (no confirmation needed)
    const firstCheck = await checkAccountOnce(username);
    const mode       = firstCheck.status === STATUS.ACCESSIBLE ? "WATCH_FOR_BAN" : "WATCH_FOR_UNBAN";

    const added = monitoringBase.add(
      username, interaction.user.tag, interaction.user.id,
      mode, firstCheck.status === STATUS.ACCESSIBLE ? "ACCESSIBLE" : "BANNED"
    );

    if (!added.ok) {
      if (added.reason === "already_monitored") return interaction.editReply({ content: `⚠️ **@${username}** is already being monitored.` });
      if (added.reason === "max_reached")       return interaction.editReply({ content: `❌ Monitoring Base is full (${MAX_ACTIVE} slots).` });
    }

    monitoringBase.update(username, {
      lastChecked:   firstCheck.checkedAt.toISOString(),
      lastStatus:    firstCheck.status,
      checkCount:    1,
      cachedProfile: firstCheck.profile || null,
    });

    startMonitoring(username);

    const picUrl   = resolveProfilePic(username, firstCheck.profile?.profilePicUrl);
    const checkMin = Math.round(BASE_INTERVAL_MS / 60000);
    const modeText = mode === "WATCH_FOR_BAN"
      ? "Account is **LIVE** — watching for ban/deletion"
      : "Account is **BANNED** — watching for recovery/unban";

    let embed;
    if (mode === "WATCH_FOR_BAN") {
      embed = new EmbedBuilder()
        .setColor(0x00cc55)
        .setTitle("🟢  Account Is Live — Monitoring for Ban")
        .setThumbnail(picUrl)
        .setDescription(
          `**@${username}** is currently **LIVE** on Instagram.\n\n` +
          `You'll be notified the moment this account gets **banned or deactivated**.\n\n` +
          `⏱️ Checking every ~${checkMin} min · 🔒 ${CONFIRMATION_NEEDED}× confirmation required before alert`
        )
        .addFields(
          { name: "🎯 Target",         value: `[@${username}](https://instagram.com/${username})`, inline: true },
          { name: "📊 Current Status", value: "🟢 LIVE / ACCESSIBLE",                             inline: true },
          { name: "👤 Added By",       value: interaction.user.tag,                                inline: true },
          { name: "🔔 Watching For",   value: "Ban / Deletion / Deactivation",                    inline: false },
          ...buildProfileFields(firstCheck.profile, "📸 Current Profile Stats"),
        )
        .setFooter({ text: "Instagram Monitor v6 • Monitoring Base" })
        .setTimestamp();
    } else {
      embed = new EmbedBuilder()
        .setColor(0xff4444)
        .setTitle("🔴  Account Is Banned — Monitoring for Recovery")
        .setThumbnail(picUrl)
        .setDescription(
          `**@${username}** is currently **BANNED** on Instagram.\n\n` +
          `You'll be notified the moment this account gets **un-banned or recovered**.\n\n` +
          `⏱️ Checking every ~${checkMin} min · 🔒 ${CONFIRMATION_NEEDED}× confirmation required before alert`
        )
        .addFields(
          { name: "🎯 Client Account", value: `[@${username}](https://instagram.com/${username})`, inline: true },
          { name: "📊 Current Status", value: "🔴 BANNED",                                        inline: true },
          { name: "👤 Added By",       value: interaction.user.tag,                                inline: true },
          { name: "🔔 Watching For",   value: "Unban / Account Recovery",                         inline: false },
          { name: "📸 Profile Stats",  value: "_Not available — account is currently banned._",   inline: false },
        )
        .setFooter({ text: "Instagram Monitor v6 • Monitoring Base" })
        .setTimestamp();
    }

    await adminLog({
      type: "COMMAND", title: `/monitor add — @${username}`,
      color: mode === "WATCH_FOR_BAN" ? 0x00cc55 : 0xff4444,
      description:
        `<@${interaction.user.id}> added \`@${username}\` to Monitoring Base.\n\n` +
        `**Mode:** ${modeText}\n` +
        `**Initial status:** ${firstCheck.status}\n` +
        `**Check method:** ${firstCheck.method ?? "unknown"}\n` +
        `**Slots used:** ${monitoringBase.activeCount()}/${MAX_ACTIVE}`,
      user: interaction.user, guild: logCtx,
      fields: buildProfileFields(firstCheck.profile, "📸 Profile Stats at Add Time"),
    });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /monitor list ──────────────────────────────────────────────────────
  if (sub === "list") {
    if (!permissions.canViewList(interaction.user.id)) {
      return interaction.reply({ content: "🔒 You don't have permission. Ask the owner to run `/monitor grant @you`.", ephemeral: true });
    }

    const active = monitoringBase.listActive();

    if (!active.length) {
      return interaction.reply({ content: "📭 No accounts are currently being monitored. Use `/monitor add <username>` to get started.", ephemeral: true });
    }

    const watchingBan   = active.filter((a) => a.mode === "WATCH_FOR_BAN");
    const watchingUnban = active.filter((a) => a.mode === "WATCH_FOR_UNBAN");
    const checkMin      = Math.round(BASE_INTERVAL_MS / 60000);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📡  Active Monitoring List")
      .setDescription(
        `**${active.length}** account(s) being watched — **${active.length}/${MAX_ACTIVE}** slots used.\n` +
        `Check interval: ~${checkMin} min · Confirmation: ${CONFIRMATION_NEEDED}× required`
      )
      .setFooter({ text: "Instagram Monitor v6 • Active Only" })
      .setTimestamp();

    if (watchingBan.length) {
      embed.addFields({
        name: `🟢 LIVE — Watching for Ban (${watchingBan.length})`,
        value: watchingBan.map((a) => {
          const f = a.cachedProfile?.followers != null ? ` · ${formatCount(a.cachedProfile.followers)} followers` : "";
          return `🟢 **@${a.username}**${f}\n┣ Added by: \`${a.addedBy}\`\n┣ Added: ${tsRelative(a.addedAt)}\n┗ Checks: ${a.checkCount.toLocaleString()}`;
        }).join("\n\n"),
      });
    }

    if (watchingUnban.length) {
      embed.addFields({
        name: `🔴 BANNED — Watching for Recovery (${watchingUnban.length})`,
        value: watchingUnban.map((a) =>
          `🔴 **@${a.username}**\n┣ Added by: \`${a.addedBy}\`\n┣ Added: ${tsRelative(a.addedAt)}\n┗ Checks: ${a.checkCount.toLocaleString()}`
        ).join("\n\n"),
      });
    }

    await adminLog({
      type: "COMMAND", title: "/monitor list",
      description: `<@${interaction.user.id}> viewed the list. Active: ${active.length}/${MAX_ACTIVE}`,
      user: interaction.user, guild: logCtx,
    });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /monitor status ────────────────────────────────────────────────────
  if (sub === "status") {
    if (!username) return interaction.reply({ content: "❌ Please provide an Instagram username.", ephemeral: true });

    const account = monitoringBase.get(username);
    if (!account) {
      return interaction.reply({ content: `❌ **@${username}** is not in the active Monitoring Base.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    // One-shot check for /status — no confirmation needed, just show truth right now
    const result = await checkAccountOnce(username);
    monitoringBase.update(username, {
      lastChecked: result.checkedAt.toISOString(),
      lastStatus:  result.status,
      checkCount:  (account.checkCount || 0) + 1,
      ...(result.profile ? { cachedProfile: result.profile } : {}),
    });

    const updated   = monitoringBase.get(username);
    const color     = result.status === STATUS.ACCESSIBLE ? 0x00ff88 : result.status === STATUS.RATE_LIMITED ? 0xffcc00 : 0xff4444;
    const modeLabel = updated.mode === "WATCH_FOR_BAN" ? "🟢 Watching for Ban/Deletion" : "🔴 Watching for Unban/Recovery";
    const sEmoji    = { BANNED: "🔴", ACCESSIBLE: "🟢", RATE_LIMITED: "🟡", ERROR: "⚠️" };
    const picUrl    = resolveProfilePic(username, updated.cachedProfile?.profilePicUrl);
    const checkMin  = Math.round(BASE_INTERVAL_MS / 60000);

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`📊 Status Check — @${username}`)
      .setThumbnail(picUrl)
      .addFields(
        { name: "📊 Current Status", value: `${sEmoji[result.status] || "⏳"} ${result.status}`, inline: true  },
        { name: "🎯 Monitor Mode",   value: modeLabel,                                            inline: true  },
        { name: "👤 Added By",       value: updated.addedBy,                                      inline: true  },
        { name: "🔢 Total Checks",   value: updated.checkCount.toLocaleString(),                  inline: true  },
        { name: "📅 Added",          value: tsField(updated.addedAt),                             inline: true  },
        { name: "🕐 Last Checked",   value: tsField(updated.lastChecked),                         inline: true  },
        { name: "⚙️ Check Interval", value: `~${checkMin} min (${CONFIRMATION_NEEDED}× confirm)`, inline: true  },
        { name: "🔍 Detail",         value: result.detail,                                        inline: false },
        ...buildProfileFields(updated.cachedProfile, "📸 Profile Stats"),
      )
      .setFooter({ text: "Instagram Monitor v6 • Live Check" })
      .setTimestamp();

    await adminLog({
      type: "COMMAND", title: `/monitor status — @${username}`,
      description: `<@${interaction.user.id}> ran status check on \`@${username}\`. Result: ${result.status}`,
      color, user: interaction.user, guild: logCtx,
      fields: buildProfileFields(updated.cachedProfile, "📸 Profile Stats"),
    });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /monitor remove ────────────────────────────────────────────────────
  if (sub === "remove") {
    if (!username) return interaction.reply({ content: "❌ Please provide an Instagram username.", ephemeral: true });

    const account = monitoringBase.get(username);
    if (!account) {
      return interaction.reply({ content: `❌ **@${username}** is not in the active Monitoring Base.`, ephemeral: true });
    }

    archiveAndStop(username, "MANUALLY_REMOVED");

    const embed = new EmbedBuilder()
      .setColor(0x888888)
      .setTitle("🗑️  Account Removed & Archived")
      .setDescription(`**@${username}** has been removed from active monitoring and saved to the **Old Clients** archive.`)
      .addFields(
        { name: "👤 Was Added By", value: account.addedBy,          inline: true },
        { name: "📅 Was Added On", value: tsField(account.addedAt), inline: true },
        { name: "🔢 Total Checks", value: `${account.checkCount}`,  inline: true },
      )
      .setFooter({ text: "Instagram Monitor v6 • Archived to Old Clients" })
      .setTimestamp();

    await adminLog({
      type: "COMMAND", title: `/monitor remove — @${username}`,
      color: 0x888888,
      description:
        `<@${interaction.user.id}> removed \`@${username}\` from Monitoring Base.\n` +
        `**Originally added by:** ${account.addedBy}\n` +
        `**Total checks:** ${account.checkCount.toLocaleString()}`,
      user: interaction.user, guild: logCtx,
    });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ── Ready ──────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`\n✅ Logged in as ${client.user.tag}`);
  console.log(`📡 Notification channel : ${CHANNEL_ID}`);
  console.log(`📦 Max monitoring slots : ${MAX_ACTIVE}`);
  console.log(`⏱️  Check interval       : ${Math.round(BASE_INTERVAL_MS / 1000)}s (~${Math.round(BASE_INTERVAL_MS / 60000)} min)`);
  console.log(`✅  Confirmations needed : ${CONFIRMATION_NEEDED}x`);
  console.log(`🔐 Admin log channel    : ${LOG_CHANNEL_ID ?? "NOT SET (disabled)"}`);
  console.log(`🔑 RapidAPI             : ${process.env.RAPIDAPI_KEY ? "configured ✅" : "not set ⚠️"}`);
  console.log(`🌐 Proxy                : ${process.env.PROXY_URL    ? "configured ✅" : "not set"}\n`);
  await registerCommands();
  resumeAll();
  console.log("🤖 Bot is running. Use /monitor in Discord.\n");
});

client.login(TOKEN);
