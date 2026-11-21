// ============================================================
// BOT CLONING — users can clone this bot onto their OWN BotFather bot
// ============================================================
// Flow (user):  main menu -> "🤖 Clone This Bot" -> send BotFather token
//               -> send admin Telegram ID -> bot is cloned & goes live.
//
// What is cloned: the bot's CODE only. Every clone starts with a completely
// EMPTY store (no products / users / orders / wallets from the main bot).
//
// How it works: every clone runs as its own child process of this server
// (`node bot.js` with its own BOT_TOKEN, its own DATA_DIR and its own storage
// key-prefix in Firebase/Supabase). So the data of each clone is separate from
// the main bot and from every other clone.
//
// Admins of every clone = CLONE_OWNER_ID (default 8937671622) + the admin ID
// the user typed.
//
// Owner UI: Admin Panel -> 🤖 Cloned Bots  (live list, token, username, stop /
// start / restart / delete, feature ON/OFF, limits).

const { Markup } = require('telegraf');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const OWNER_CLONE_ID = String(process.env.CLONE_OWNER_ID || '8937671622').trim();
const MAIN_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const MASK_RE = /\d{6,12}:[A-Za-z0-9_-]{30,}/g;
const STATE_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZE = 8;
const USER_LIMIT_STEPS = [1, 2, 3, 5, 10];
const TOTAL_LIMIT_STEPS = [3, 5, 10, 15, 20];

const esc = (v) => String(v === undefined || v === null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDate = (ts) => {
  try { return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }); } catch (e) { return String(ts); }
};
const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

const STATUS_LABEL = {
  running: '🟢 Live',
  starting: '🟡 Starting',
  restarting: '🟠 Restarting',
  stopped: '⏹ Stopped',
  crashed: '🔴 Crashed',
  invalid_token: '🔴 Token invalid'
};

function setupClones(bot, fb, { userState, getAdminState, enabled = true } = {}) {
  // Clones themselves never get the clone feature (no clone-of-a-clone)
  if (!enabled) {
    return {
      middleware: (ctx, next) => next(),
      register() {},
      handleText: async () => false,
      isEnabled: async () => false,
      bootAll: async () => {},
      stopAll: async () => {}
    };
  }

  const cloneState = {}; // { telegramId: { step, token?, me?, at } }
  const procs = new Map(); // botId -> runtime info
  let shuttingDown = false;

  const mainOwners = () => (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const mainBotId = () => String(process.env.BOT_TOKEN || '').split(':')[0];
  const isOwner = (ctx) => fb.isAdmin(ctx.from.id);

  // ---------------------------------------------------------------
  // Telegram helpers
  // ---------------------------------------------------------------
  async function tgGetMe(token) {
    try {
      const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 15000 });
      if (r.data && r.data.ok && r.data.result) return { ok: true, me: r.data.result };
      return { ok: false, reason: 'invalid' };
    } catch (e) {
      const code = e.response && e.response.status;
      if (code === 401 || code === 404) return { ok: false, reason: 'invalid' };
      return { ok: false, reason: 'network' };
    }
  }

  async function tgSend(token, chatId, text, extra = {}) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }, { timeout: 15000 });
      return true;
    } catch (e) { return false; }
  }

  async function notifyOwners(text, kb) {
    for (const o of mainOwners()) {
      try { await bot.telegram.sendMessage(o, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...(kb || {}) }); } catch (e) {}
    }
  }

  async function show(ctx, text, kb) {
    const extra = { parse_mode: 'HTML', disable_web_page_preview: true, ...(kb || {}) };
    if (ctx.callbackQuery) {
      try { await ctx.editMessageText(text, extra); return; }
      catch (e) {
        if (/not modified/i.test(e.message || '')) return;
        try { await ctx.deleteMessage(); } catch (e2) {}
      }
    }
    await ctx.reply(text, extra);
  }

  // ---------------------------------------------------------------
  // Child-process supervisor
  // ---------------------------------------------------------------
  function buildEnv(rec) {
    const env = {
      ...process.env,
      IS_CLONE: '1',
      BOT_TOKEN: rec.token,
      BOT_USERNAME: rec.username || '',
      STORE_NAME: rec.name || process.env.STORE_NAME || 'STORE',
      ADMIN_TELEGRAM_IDS: (rec.adminIds || []).join(','),
      DATA_DIR: path.join(MAIN_DATA_DIR, 'clones', String(rec.id)),
      STORAGE_KEY_PREFIX: `clone${rec.id}__`,
      PORT: '0'
    };
    // The clone has no Mini App (it is served by the main bot's web address)
    delete env.MINIAPP_URL; delete env.MINIAPP_BUTTON_TEXT; delete env.RENDER_EXTERNAL_URL; delete env.ADMIN_API_SECRET;
    // Never hand the owner's payment credentials to somebody else's bot
    // (set CLONE_INHERIT_PAYMENT=1 on the main server to share them on purpose).
    if (process.env.CLONE_INHERIT_PAYMENT !== '1') {
      for (const k of ['ORVIX_PAY_TOKEN', 'ORVIX_PAY_REDIRECT_URL', 'FAMPAY_UPI_ID', 'PAYX_URL', 'PAYX_API_KEY']) delete env[k];
    }
    return env;
  }

  function startProc(rec) {
    if (shuttingDown) return;
    const id = String(rec.id);
    let rt = procs.get(id);
    if (rt && rt.child && !rt.exited) return; // already running
    if (!rt) { rt = { restarts: 0, logs: [] }; procs.set(id, rt); }
    rt.status = 'starting';
    rt.stopping = false;
    rt.exited = false;
    rt.startedAt = Date.now();
    rt.readyAt = null;

    let child;
    try {
      child = fork(path.join(__dirname, 'bot.js'), [], { env: buildEnv(rec), silent: true });
    } catch (e) {
      rt.status = 'crashed';
      rt.lastError = e.message;
      return;
    }
    rt.child = child;
    rt.pid = child.pid;

    const pushLog = (buf) => {
      String(buf).split('\n').map(s => s.trim()).filter(Boolean).forEach((line) => {
        const clean = line.replace(MASK_RE, '***').slice(0, 300);
        rt.logs.push(clean);
        if (rt.logs.length > 40) rt.logs.shift();
        console.log(`[clone @${rec.username}] ${clean}`);
      });
    };
    child.stdout.on('data', pushLog);
    child.stderr.on('data', pushLog);
    child.on('message', (m) => {
      if (m && m.type === 'ready') { rt.status = 'running'; rt.readyAt = Date.now(); }
    });
    child.on('error', (e) => { rt.lastError = e.message; });
    child.on('exit', (code, signal) => {
      rt.exited = true;
      rt.child = null;
      rt.pid = null;
      if (rt.stopping || shuttingDown) { rt.status = 'stopped'; return; }

      if (code === 42) {
        rt.status = 'invalid_token';
        rt.lastError = 'Bot token invalid / revoked in BotFather';
        fb.updateClone(id, { enabled: false, lastError: rt.lastError }).catch(() => {});
        notifyOwners(`🔴 <b>Clone stopped</b>\n\n@${esc(rec.username)} ka token invalid ho gaya (BotFather me revoke hua hoga).`, Markup.inlineKeyboard([[Markup.button.callback('👁 Open', `admin_clone_${id}`)]]));
        return;
      }

      if (Date.now() - rt.startedAt > 60000) rt.restarts = 0;
      rt.restarts++;
      rt.lastError = `Process exited (code ${code}${signal ? ', ' + signal : ''})`;
      if (rt.restarts > 8) {
        rt.status = 'crashed';
        notifyOwners(`🔴 <b>Clone crashed</b>\n\n@${esc(rec.username)} baar-baar band ho raha hai, auto-restart band kar diya.`, Markup.inlineKeyboard([[Markup.button.callback('👁 Open', `admin_clone_${id}`)]]));
        return;
      }
      rt.status = 'restarting';
      const delay = Math.min(5000 * Math.pow(2, rt.restarts - 1), 60000);
      rt.timer = setTimeout(async () => {
        rt.timer = null;
        try {
          const cur = await fb.getClone(id);
          if (cur && cur.enabled !== false && !shuttingDown) startProc(cur);
        } catch (e) {}
      }, delay);
    });
  }

  function stopProc(id, timeoutMs = 15000) {
    id = String(id);
    const rt = procs.get(id);
    if (!rt) return Promise.resolve();
    if (rt.timer) { clearTimeout(rt.timer); rt.timer = null; }
    if (!rt.child || rt.exited) { rt.status = 'stopped'; return Promise.resolve(); }
    rt.stopping = true;
    const child = rt.child;
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      try { child.kill('SIGTERM'); } catch (e) { clearTimeout(t); resolve(); }
    });
  }

  async function bootAll() {
    const all = await fb.getClones();
    const list = Object.values(all).filter(r => r.enabled !== false);
    if (list.length) console.log(`🤖 Starting ${list.length} cloned bot(s)...`);
    for (const rec of list) {
      startProc(rec);
      await new Promise(r => setTimeout(r, 2500)); // stagger so the server is not hit by N boots at once
    }
  }

  async function stopAll() {
    shuttingDown = true;
    await Promise.all([...procs.keys()].map(id => stopProc(id, 12000)));
  }

  function statusOf(rec) {
    const rt = procs.get(String(rec.id));
    return (rt && rt.status) || (rec.enabled === false ? 'stopped' : 'starting');
  }

  // ---------------------------------------------------------------
  // Creating a clone
  // ---------------------------------------------------------------
  async function checkCanClone(ctx) {
    const settings = await fb.getCloneSettings();
    if (!settings.enabled) return { ok: false, msg: '🚫 Clone feature abhi band hai.' };
    const all = Object.values(await fb.getClones());
    const active = all.filter(r => r.enabled !== false).length;
    if (active >= settings.maxTotal) return { ok: false, msg: '🚧 Abhi naye clones ki limit puri ho gayi hai. Thodi der baad try karo.' };
    if (!isOwner(ctx)) {
      const mine = all.filter(r => String(r.createdBy && r.createdBy.id) === String(ctx.from.id)).length;
      if (mine >= settings.perUserLimit) return { ok: false, msg: `🚫 Aap maximum ${settings.perUserLimit} bot clone kar sakte ho (aap already ${mine} kar chuke ho).` };
    }
    return { ok: true, settings };
  }

  async function finishCreate(ctx, st, adminId) {
    if (st.busy) return;
    st.busy = true;
    try {
      const can = await checkCanClone(ctx);
      if (!can.ok) { delete cloneState[ctx.from.id]; return show(ctx, can.msg, homeKb()); }

      const existing = await fb.getClone(st.me.id);
      if (existing) { delete cloneState[ctx.from.id]; return show(ctx, '⚠️ Ye bot pehle se clone ho chuka hai.', homeKb()); }

      const adminIds = [...new Set([OWNER_CLONE_ID, String(adminId)])];
      const rec = {
        id: String(st.me.id),
        token: st.token,
        username: st.me.username || '',
        name: st.me.first_name || st.me.username || 'Bot',
        adminIds,
        userAdminId: String(adminId),
        createdBy: { id: String(ctx.from.id), name: ctx.from.first_name || '', username: ctx.from.username || '' },
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await fb.saveClone(rec.id, rec);
      startProc(rec);
      delete cloneState[ctx.from.id];

      // let the new admin know (works only if they already pressed Start on the new bot)
      await tgSend(rec.token, adminId, `✅ <b>Aapka bot ready hai!</b>\n\n/start dabao aur /admin se admin panel kholo.\n\nNote: ye bot bilkul fresh hai — koi products/users/data nahi hai.`);

      await show(ctx,
        `✅ <b>Bot clone ho gaya!</b>\n\n🤖 Bot: @${esc(rec.username)}\n👤 Admin ID: <code>${esc(adminId)}</code>\n\n` +
        `Ab apne bot (@${esc(rec.username)}) me jaakar <b>/start</b> dabao, phir <b>/admin</b> se admin panel kholo.\n` +
        `📦 Bot fresh hai — main bot ka koi data copy nahi hua.\n\n<i>Bot 1-2 minute me live ho jayega.</i>`,
        Markup.inlineKeyboard([[Markup.button.url('🤖 Open my bot', `https://t.me/${rec.username}`)], [Markup.button.callback('🏠 Home', 'menu_home')]]));

      notifyOwners(
        `🆕 <b>New bot cloned</b>\n\n🤖 @${esc(rec.username)} (${esc(rec.name)})\n👤 By: ${esc(rec.createdBy.name)}${rec.createdBy.username ? ' (@' + esc(rec.createdBy.username) + ')' : ''} — <code>${esc(rec.createdBy.id)}</code>\n🛡 Admins: ${adminIds.map(a => `<code>${esc(a)}</code>`).join(', ')}`,
        Markup.inlineKeyboard([[Markup.button.callback('👁 Open', `admin_clone_${rec.id}`)]])
      );
    } catch (err) {
      console.error('Clone create failed:', err);
      delete cloneState[ctx.from.id];
      await show(ctx, '⚠️ Clone banane me error aaya. Thodi der baad dobara try karo.', homeKb());
    }
  }

  const homeKb = () => Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'menu_home')]]);
  const cancelKb = () => Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'clone_cancel')]]);

  // ---------------------------------------------------------------
  // Text steps (token -> admin id)
  // ---------------------------------------------------------------
  async function handleText(ctx) {
    const st = cloneState[ctx.from.id];
    if (!st) return false;
    if (Date.now() - st.at > STATE_TTL_MS) { delete cloneState[ctx.from.id]; return false; }
    const text = (ctx.message.text || '').trim();
    if (text.startsWith('/')) { delete cloneState[ctx.from.id]; return false; }
    if (/^(❌\s*)?cancel$/i.test(text)) {
      delete cloneState[ctx.from.id];
      await ctx.reply('❌ Clone cancel kar diya.', homeKb());
      return true;
    }

    if (st.step === 'token') {
      // the token is a secret — remove it from the chat right away
      try { await ctx.deleteMessage(); } catch (e) {}
      if (!TOKEN_RE.test(text)) {
        await ctx.reply('❌ Ye valid bot token nahi lag raha.\n\nToken aisa dikhta hai: 123456789:AAH...xyz\n@BotFather se copy karke dobara bhejo.', cancelKb());
        return true;
      }
      if (text.split(':')[0] === mainBotId()) {
        await ctx.reply('❌ Ye is main bot ka hi token hai. Apne naye bot ka token do.', cancelKb());
        return true;
      }
      const r = await tgGetMe(text);
      if (!r.ok) {
        await ctx.reply(r.reason === 'invalid' ? '❌ Token galat hai ya revoke ho chuka hai. BotFather se sahi token lo.' : '⚠️ Telegram se connect nahi ho paya, thodi der baad dobara token bhejo.', cancelKb());
        return true;
      }
      if (!r.me.is_bot) { await ctx.reply('❌ Ye bot ka token nahi hai.', cancelKb()); return true; }
      if (await fb.getClone(r.me.id)) {
        delete cloneState[ctx.from.id];
        await ctx.reply(`⚠️ @${r.me.username} pehle se clone ho chuka hai.`, homeKb());
        return true;
      }
      cloneState[ctx.from.id] = { step: 'admin', token: text, me: r.me, at: Date.now() };
      await ctx.reply(
        `✅ Token mil gaya — bot: @${r.me.username}\n\nAb us bot ka <b>admin Telegram ID</b> bhejo (sirf numbers).\n\nApna ID pata nahi? @userinfobot se mil jayega, ya neeche button dabao.`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback(`👤 Mera ID use karo (${ctx.from.id})`, 'clone_useme')], [Markup.button.callback('❌ Cancel', 'clone_cancel')]]) }
      );
      return true;
    }

    if (st.step === 'admin') {
      if (!/^\d{5,15}$/.test(text)) {
        await ctx.reply('❌ Admin ID sirf numbers me hona chahiye (5–15 digits). Dobara bhejo.', cancelKb());
        return true;
      }
      await finishCreate(ctx, st, text);
      return true;
    }
    return false;
  }

  // Drops a half-finished clone flow when the user wanders off to something else
  async function middleware(ctx, next) {
    const uid = ctx.from && ctx.from.id;
    const st = uid && cloneState[uid];
    if (st) {
      const data = ctx.callbackQuery && ctx.callbackQuery.data;
      const isCmd = ctx.message && typeof ctx.message.text === 'string' && ctx.message.text.startsWith('/');
      if (Date.now() - st.at > STATE_TTL_MS || isCmd || (data && !data.startsWith('clone_'))) delete cloneState[uid];
    }
    return next();
  }

  // ---------------------------------------------------------------
  // Admin dashboard views
  // ---------------------------------------------------------------
  async function showDashboard(ctx) {
    const settings = await fb.getCloneSettings();
    const all = Object.values(await fb.getClones());
    let live = 0, stopped = 0, problem = 0;
    for (const r of all) {
      const s = statusOf(r);
      if (s === 'running' || s === 'starting' || s === 'restarting') live++;
      else if (s === 'stopped') stopped++;
      else problem++;
    }
    const text =
      `🤖 <b>Cloned Bots</b>\n\n` +
      `Feature: ${settings.enabled ? '✅ ON' : '🚫 OFF'}\n` +
      `Total: <b>${all.length}</b>  •  🟢 Live: <b>${live}</b>  •  ⏹ Stopped: <b>${stopped}</b>  •  🔴 Problem: <b>${problem}</b>\n\n` +
      `👤 Per-user limit: <b>${settings.perUserLimit}</b>\n` +
      `🔢 Max live bots: <b>${settings.maxTotal}</b>\n\n` +
      `<i>Har clone alag process me chalta hai, isliye server RAM ke hisaab se Max live bots rakho.</i>`;
    await show(ctx, text, Markup.inlineKeyboard([
      [Markup.button.callback(`📋 Bots List (${all.length})`, 'admin_clones_list_0')],
      [Markup.button.callback(settings.enabled ? '🚫 Turn Feature OFF' : '✅ Turn Feature ON', 'admin_clones_toggle')],
      [Markup.button.callback(`👤 Per-user limit: ${settings.perUserLimit}`, 'admin_clones_cycleuser'), Markup.button.callback(`🔢 Max bots: ${settings.maxTotal}`, 'admin_clones_cycletotal')],
      [Markup.button.callback('🔄 Refresh', 'admin_clones')],
      [Markup.button.callback('⬅️ Back', 'admin_home')]
    ]));
  }

  async function showList(ctx, page) {
    const all = Object.values(await fb.getClones()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page), pages - 1);
    const slice = all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    const rows = slice.map(r => [Markup.button.callback(`${(STATUS_LABEL[statusOf(r)] || '').split(' ')[0]} @${r.username}`.slice(0, 60), `admin_clone_${r.id}`)]);
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('◀️ Prev', `admin_clones_list_${page - 1}`));
    if (page < pages - 1) nav.push(Markup.button.callback('Next ▶️', `admin_clones_list_${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([Markup.button.callback('🔄 Refresh', `admin_clones_list_${page}`)]);
    rows.push([Markup.button.callback('⬅️ Back', 'admin_clones')]);
    const text = all.length
      ? `📋 <b>Cloned bots</b> (${all.length}) — page ${page + 1}/${pages}\n\n🟢 live  🟡 starting  🟠 restarting  ⏹ stopped  🔴 problem\n\nBot pe tap karo — username, token, admins sab milega.`
      : '📋 Abhi koi bot clone nahi hua.';
    await show(ctx, text, Markup.inlineKeyboard(rows));
  }

  async function showDetail(ctx, id) {
    const rec = await fb.getClone(id);
    if (!rec) return show(ctx, '❌ Ye clone ab nahi mila.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin_clones_list_0')]]));
    const rt = procs.get(String(rec.id)) || {};
    const status = statusOf(rec);
    const up = status === 'running' && rt.readyAt ? ` (uptime ${fmtDur(Date.now() - rt.readyAt)})` : '';
    const lastErr = rt.lastError || rec.lastError;
    const text =
      `🤖 <b>${esc(rec.name)}</b>\n\n` +
      `Username: @${esc(rec.username)}\n` +
      `Bot ID: <code>${esc(rec.id)}</code>\n` +
      `Token: <code>${esc(rec.token)}</code>\n\n` +
      `Status: ${STATUS_LABEL[status] || status}${up}\n` +
      (rt.restarts ? `Auto-restarts: ${rt.restarts}\n` : '') +
      `\n👤 Cloned by: ${esc(rec.createdBy && rec.createdBy.name)}${rec.createdBy && rec.createdBy.username ? ' (@' + esc(rec.createdBy.username) + ')' : ''} — <code>${esc(rec.createdBy && rec.createdBy.id)}</code>\n` +
      `🛡 Admins: ${(rec.adminIds || []).map(a => `<code>${esc(a)}</code>`).join(', ')}\n` +
      `🕒 Created: ${esc(fmtDate(rec.createdAt))}\n` +
      (lastErr ? `\n⚠️ Last issue: ${esc(lastErr)}\n` : '');
    const running = status === 'running' || status === 'starting' || status === 'restarting';
    await show(ctx, text, Markup.inlineKeyboard([
      [running ? Markup.button.callback('⏹ Stop', `admin_clonestop_${rec.id}`) : Markup.button.callback('▶️ Start', `admin_clonestart_${rec.id}`), Markup.button.callback('🔄 Restart', `admin_clonerestart_${rec.id}`)],
      [Markup.button.callback('📜 Logs', `admin_clonelog_${rec.id}`), Markup.button.callback('🗑 Delete', `admin_clonedel_${rec.id}`)],
      [Markup.button.url('🔗 Open bot', `https://t.me/${rec.username}`)],
      [Markup.button.callback('🔄 Refresh', `admin_clone_${rec.id}`), Markup.button.callback('⬅️ Back', 'admin_clones_list_0')]
    ]));
  }

  // ---------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------
  function register() {
    const ownerOnly = async (ctx) => {
      if (isOwner(ctx)) return true;
      try { await ctx.answerCbQuery('Sirf owner ke liye.', { show_alert: true }); } catch (e) {}
      return false;
    };

    // ---- user side ----
    bot.action('clone_home', async (ctx) => {
      await ctx.answerCbQuery();
      delete cloneState[ctx.from.id];
      delete userState[ctx.from.id];
      const settings = await fb.getCloneSettings();
      if (!settings.enabled) return show(ctx, '🚫 Clone feature abhi band hai.', homeKb());
      const mine = Object.values(await fb.getClones()).filter(r => String(r.createdBy && r.createdBy.id) === String(ctx.from.id));
      const rows = [[Markup.button.callback('➕ Clone Bot', 'clone_start')]];
      if (mine.length) rows.push([Markup.button.callback(`📂 My Bots (${mine.length})`, 'clone_mine')]);
      rows.push([Markup.button.callback('🏠 Home', 'menu_home')]);
      await show(ctx,
        `🤖 <b>Clone This Bot</b>\n\nIs bot ki copy apne khud ke bot par chalao!\n\n` +
        `<b>Kya chahiye:</b>\n1️⃣ @BotFather me jaakar <code>/newbot</code> se naya bot banao\n2️⃣ Uska <b>bot token</b> yaha bhejo\n3️⃣ Apna <b>admin Telegram ID</b> bhejo\n\n` +
        `Bas — aapka bot live ho jayega. 🚀\n\n📦 <i>Sirf bot clone hota hai, data nahi. Aapka bot bilkul khali (fresh) shuru hoga.</i>`,
        Markup.inlineKeyboard(rows));
    });

    bot.action('clone_start', async (ctx) => {
      await ctx.answerCbQuery();
      const can = await checkCanClone(ctx);
      if (!can.ok) return show(ctx, can.msg, homeKb());
      delete userState[ctx.from.id];
      const adminState = getAdminState && getAdminState();
      if (adminState) delete adminState[ctx.from.id];
      cloneState[ctx.from.id] = { step: 'token', at: Date.now() };
      await show(ctx,
        `🔑 <b>Step 1/2 — Bot Token</b>\n\n@BotFather se mila apne bot ka <b>token</b> bhejo.\n\nExample: <code>123456789:AAH...xyz</code>\n\n🔒 Token bhejte hi main us message ko chat se delete kar dunga.`,
        cancelKb());
    });

    bot.action('clone_cancel', async (ctx) => {
      await ctx.answerCbQuery('Cancelled');
      delete cloneState[ctx.from.id];
      await show(ctx, '❌ Clone cancel kar diya.', homeKb());
    });

    bot.action('clone_useme', async (ctx) => {
      await ctx.answerCbQuery();
      const st = cloneState[ctx.from.id];
      if (!st || st.step !== 'admin') return show(ctx, '⚠️ Session expire ho gaya. Dobara /start karke Clone Bot dabao.', homeKb());
      await finishCreate(ctx, st, String(ctx.from.id));
    });

    bot.action('clone_mine', async (ctx) => {
      await ctx.answerCbQuery();
      const mine = Object.values(await fb.getClones()).filter(r => String(r.createdBy && r.createdBy.id) === String(ctx.from.id));
      const lines = mine.map(r => `${STATUS_LABEL[statusOf(r)] || ''}  @${esc(r.username)}`).join('\n') || 'Koi bot nahi.';
      await show(ctx, `📂 <b>My Bots</b>\n\n${lines}`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'clone_home')]]));
    });

    // ---- owner side ----
    bot.action('admin_clones', async (ctx) => { if (!(await ownerOnly(ctx))) return; await ctx.answerCbQuery(); await showDashboard(ctx); });
    bot.action(/^admin_clones_list_(\d+)$/, async (ctx) => { if (!(await ownerOnly(ctx))) return; await ctx.answerCbQuery(); await showList(ctx, parseInt(ctx.match[1], 10)); });
    bot.action(/^admin_clone_(\d+)$/, async (ctx) => { if (!(await ownerOnly(ctx))) return; await ctx.answerCbQuery(); await showDetail(ctx, ctx.match[1]); });

    bot.action('admin_clones_toggle', async (ctx) => {
      if (!(await ownerOnly(ctx))) return;
      const s = await fb.getCloneSettings();
      await fb.updateCloneSettings({ enabled: !s.enabled });
      await ctx.answerCbQuery(!s.enabled ? 'Clone feature ON' : 'Clone feature OFF');
      await showDashboard(ctx);
    });
    bot.action('admin_clones_cycleuser', async (ctx) => {
      if (!(await ownerOnly(ctx))) return;
      const s = await fb.getCloneSettings();
      const i = USER_LIMIT_STEPS.indexOf(s.perUserLimit);
      const next = USER_LIMIT_STEPS[(i + 1) % USER_LIMIT_STEPS.length];
      await fb.updateCloneSettings({ perUserLimit: next });
      await ctx.answerCbQuery(`Per-user limit: ${next}`);
      await showDashboard(ctx);
    });
    bot.action('admin_clones_cycletotal', async (ctx) => {
      if (!(await ownerOnly(ctx))) return;
      const s = await fb.getCloneSettings();
      const i = TOTAL_LIMIT_STEPS.indexOf(s.maxTotal);
      const next = TOTAL_LIMIT_STEPS[(i + 1) % TOTAL_LIMIT_STEPS.length];
      await fb.updateCloneSettings({ maxTotal: next });
      await ctx.answerCbQuery(`Max live bots: ${next}`);
      await showDashboard(ctx);
    });

    bot.action(/^admin_clonestop_(\d+)$/, async (ctx) => {
      if (!(await ownerOnly(ctx))) return;
      const id = ctx.match[1];
      await ctx.answerCbQuery('Stopping...');
      await fb.updateClone(id, { enabled: false });
      await stopProc(id);
      await showDetail(ctx, id);
    });
    bot.action(/^admin_clonestart_(\d+)$/, async (ctx) => {
      if (!(await ownerOnly(ctx))) return;
      const id = ctx.match[1];
      const rt = procs.get(id); if (rt) rt.restarts = 0;
      const rec = await fb.updateClone(id, { enabled: true, lastError: '' });
      if (!rec) return ctx.answerCbQuery('Clone nahi mila', { show_alert: true });
      await ctx.answerCbQuery('Starting...');
      startProc(rec);
      await showDetail(ctx, id);
    });
    bot.action(/^admin_clonerestart_(\d+)$/, async (ctx) => {
      if (!(await ownerOnly(ctx))) return;
      const id = ctx.match[1];
      const rec = await fb.updateClone(id, { enabled: true, lastError: '' });
      if (!rec) return ctx.answerCbQuery('Clone nahi mila', { show_alert: true });
      await ctx.answerCbQuery('Restarting...');
      await stopProc(id);
      const rt = procs.get(id); if (rt) rt.restarts = 0;
      startProc(rec);
      await showDetail(ctx, id);
    });
    bot.action(/^admin_clonelog_(\d+)$/, async (ctx) => {
      if (!(await ownerOnly(ctx))) return;
      await ctx.answerCbQuery();
      const id = ctx.match[1];
      const rt = procs.get(id);
      const lines = rt && rt.logs.length ? rt.logs.slice(-15).join('\n') : 'Abhi koi log nahi.';
      await show(ctx, `📜 <b>Logs</b> (last 15)\n\n<pre>${esc(lines).slice(0, 3500)}</pre>`, Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', `admin_clonelog_${id}`), Markup.button.callback('⬅️ Back', `admin_clone_${id}`)]]));
    });
    bot.action(/^admin_clonedel_(\d+)$/, async (ctx) => {
      if (!(await ownerOnly(ctx))) return;
      await ctx.answerCbQuery();
      const id = ctx.match[1];
      const rec = await fb.getClone(id);
      if (!rec) return show(ctx, '❌ Clone nahi mila.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin_clones_list_0')]]));
      await show(ctx, `⚠️ <b>Delete @${esc(rec.username)}?</b>\n\nBot band ho jayega aur list se hat jayega. Ye undo nahi hota.`,
        Markup.inlineKeyboard([[Markup.button.callback('✅ Yes, delete', `admin_clonedelyes_${id}`), Markup.button.callback('❌ No', `admin_clone_${id}`)]]));
    });
    bot.action(/^admin_clonedelyes_(\d+)$/, async (ctx) => {
      if (!(await ownerOnly(ctx))) return;
      const id = ctx.match[1];
      await ctx.answerCbQuery('Deleting...');
      await stopProc(id);
      procs.delete(id);
      await fb.deleteClone(id);
      try { fs.rmSync(path.join(MAIN_DATA_DIR, 'clones', id), { recursive: true, force: true }); } catch (e) {}
      await showList(ctx, 0);
    });
  }

  return { middleware, register, handleText, isEnabled: async () => (await fb.getCloneSettings()).enabled, bootAll, stopAll };
}

module.exports = { setupClones };
