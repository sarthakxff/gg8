# 📸 Instagram Account Monitor — Discord Bot (v6)

Monitors Instagram accounts for **bans** and **recoveries**. Sends Discord alerts the moment a change is confirmed.

---

## ✅ What's New in v6

| Change | Why |
|--------|-----|
| **2-minute check interval** (was 12 seconds) | 12s was way too fast — Railway IPs got rate-limited instantly, causing false ban/unban results |
| **3× confirmation required** before any alert | Eliminates false positives from ambiguous Instagram responses |
| **10-account maximum** (was 200) | Realistic limit that avoids hammering Instagram |
| **Staggered polling** | All accounts start spread out, not at the same second |
| **RapidAPI as primary source** | Far more reliable from Railway's datacenter IPs than direct scraping |
| **Independent backoff per account** | Rate limits on one account don't affect others |
| **`/monitor status` is always one-shot** | Instant check, no confirmation wait |

---

## 🚀 Railway Setup (recommended)

### 1. Create the bot on Discord
1. Go to https://discord.com/developers/applications → **New Application**
2. **Bot** tab → **Add Bot** → **Reset Token** → copy it
3. **OAuth2 → URL Generator**: scopes = `bot`, `applications.commands`; permissions = `Send Messages`, `Embed Links`, `Mention Everyone`
4. Invite the bot to your server

### 2. Push to GitHub
```bash
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 3. Deploy to Railway
1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**
2. Select your repo
3. Go to **Variables** tab and add:

| Variable | Value |
|----------|-------|
| `DISCORD_TOKEN` | Your bot token |
| `DISCORD_CHANNEL_ID` | Channel ID for ban/unban alerts |
| `DISCORD_GUILD_ID` | Your server ID |
| `RAPIDAPI_KEY` | Your RapidAPI key (see below) |
| `LOG_CHANNEL_ID` | *(optional)* Private admin log channel |
| `PROXY_URL` | *(optional)* `http://user:pass@host:port` |

4. Railway auto-deploys. Check logs to confirm `✅ Logged in as YourBot#1234`.

### Getting a RapidAPI key
1. Go to https://rapidapi.com/alexanderxbx/api/instagram-scraper-api2
2. Sign up (free) → Subscribe to the **Basic** plan (free tier)
3. Copy your API key from the dashboard

---

## 💬 Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/monitor add <username>` | Anyone | Add account — bot auto-detects live vs banned |
| `/monitor list` | Owner + granted users | Full active list |
| `/monitor status <username>` | Anyone | Instant one-shot status check |
| `/monitor remove <username>` | Anyone | Remove + archive to Old Clients |
| `/monitor grant @user` | Owner only | Give access to `/monitor list` |
| `/monitor revoke @user` | Owner only | Remove access |
| `/help` | Anyone | Command reference |

---

## ⚙️ How the Confirmation System Works

Instagram frequently returns **ambiguous responses** — a banned account might briefly return a 200 page, or a live account's page might return a "not available" message during a glitch.

The bot now requires **3 consecutive identical results** before treating a status change as real:

```
Check 1: @username → BANNED  (1/3 — not confirmed yet)
Check 2: @username → BANNED  (2/3 — still pending)
Check 3: @username → BANNED  (3/3 — CONFIRMED ✅ → alert sent!)
```

If any check in the sequence returns a different result, the counter resets:
```
Check 1: @username → BANNED  (1/3)
Check 2: @username → ACCESSIBLE  ← flip! counter resets
Check 3: @username → BANNED  (1/3 again)
```

This is why you set the interval to 2 minutes — with 3 confirmations needed, the actual alert will fire within ~6 minutes of a real ban, which is perfectly acceptable.

---

## 📁 File Structure

```
instagram-monitor/
├── bot.js                  ← Main bot
├── instagramChecker.js     ← Instagram checker (RapidAPI + HTML fallback)
├── store.js                ← JSON database logic
├── package.json            ← Dependencies
├── railway.json            ← Railway deployment config
├── .env.example            ← Template (copy to .env for local dev)
├── .gitignore              ← Excludes .env, node_modules, JSON DBs
└── README.md
```

Auto-created at runtime (not in git):
```
monitoring_base.json    ← Active monitoring slots
old_clients.json        ← Archived accounts
permissions.json        ← Owner + allowed users
```

---

## ⚠️ Important Notes

- **Never commit `.env`** — your bot token and API keys are in there
- The JSON files (`monitoring_base.json` etc.) are excluded from git — Railway stores them on disk. If Railway redeploys, they persist as long as you use a **volume** or the same Railway instance. For production use, consider adding a proper database.
- Keep `CHECK_INTERVAL_MS` at **60000 or higher**. Lower values will cause rate limits and false positives.
