# 🤖 Clone Bot feature

## User flow
Main menu → **🤖 Clone This Bot** → ➕ Clone Bot → bot token (BotFather) → admin Telegram ID → bot goes live.
- The token message is deleted from the chat right after it is read.
- "Mera ID use karo" button = the user becomes admin with one tap.
- Only the CODE is cloned. Every clone starts with an empty store (no products/users/orders/wallets).

## Admins of every clone
`8937671622` (owner, change with env `CLONE_OWNER_ID`) + the admin ID the user typed.

## Owner panel: Admin Panel → 🤖 Cloned Bots
- Live / stopped / problem counts, feature ON/OFF
- Per-user limit (1/2/3/5/10) and max live bots (3/5/10/15/20) — tap to cycle
- Bots list → each bot shows name, @username, token, bot id, status + uptime, who cloned it, admin IDs, created time
- ⏹ Stop · ▶️ Start · 🔄 Restart · 📜 Logs · 🗑 Delete
- You get a Telegram message whenever a new bot is cloned, or a clone crashes / its token is revoked.

## How it works (important)
- Each clone = its own child process (`node bot.js`) with its own `BOT_TOKEN`, `DATA_DIR` and
  `STORAGE_KEY_PREFIX=clone<botId>__`. In Firebase/Supabase its data lives under that prefix, so it is
  fully separate from the main bot and from other clones.
- Clones are auto-started when the main bot starts, auto-restarted if they crash, and stopped cleanly on deploy.
- Clones have NO Mini App (the mini app is served from the main bot's web address).
- Clones do NOT get the owner's payment credentials (ORVIX_PAY_*, FAMPAY_UPI_ID, PAYX_*). Clone admins set
  their own PayX in-bot. To share yours on purpose: env `CLONE_INHERIT_PAYMENT=1`.

## Needs
- An external DB (Firebase/Supabase env vars) on the main server — otherwise the clone list is lost on every Render deploy.
- RAM: each clone is a Node process (~60–90 MB). On a 512 MB Render instance keep "Max bots" at 3–5.

## Files changed
New: `clones.js` · Changed: `bot.js`, `localdb.js`, `storage.js`, `adminPanel.js`
