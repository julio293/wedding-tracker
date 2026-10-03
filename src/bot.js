import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { handleMessage } from './handler.js';
import { RECEIPTS_DIR, claimMessage, getSettings, setSetting } from './db.js';

const { Client, LocalAuth } = pkg;

// Which chat to listen to: a group by name (default), or "self" for your own "Message yourself" chat.
const TARGET = process.env.WA_CHAT || 'Wedding Budget';
// Every bot reply ends with this invisible marker so we never process our own replies.
const MARK = '⁣';
const BACKLOG_SECONDS = Number(process.env.WA_BACKLOG_HOURS || 6) * 3600;
const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const CHROME_DEFAULT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SESSION_DIR = path.resolve(process.env.DATA_DIR || 'data', 'wa-session');

// Shared with the dashboard so the QR can be scanned from a browser when running on a server.
export const waStatus = { state: 'starting', qr: null, me: null, target: TARGET, error: null };

const ext = (mime) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' })[mime] || 'bin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

// Race a promise against a timer. The losing promise is still running inside puppeteer and may
// reject minutes later; swallow that so it can't surface as an unhandled rejection and kill the process.
function withTimeout(promise, ms, label = 'call') {
  promise.catch(() => {});
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// A browser that didn't close (crash, network drop, destroy() timing out) keeps the session profile
// open; a new launch on the same profile then hangs forever. Kill any such leftovers first.
function killOrphanBrowsers(dir) {
  try {
    execFileSync('pkill', ['-9', '-f', `user-data-dir=${dir}`], { stdio: 'ignore' });
    console.log('[wa] killed leftover browser(s) using the session');
  } catch { /* exit 1 = nothing to kill, or pkill unavailable */ }
}

// Chromium leaves Singleton* lock files in its profile when a container is killed; a restart then
// refuses to open the "in use" profile. Clear them before launching.
function clearChromeLocks(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (/^Singleton(Lock|Cookie|Socket)$/.test(entry.name)) rmSync(path.join(entry.parentPath ?? entry.path, entry.name), { force: true });
  }
}

// Group id: env override > remembered from a previous run > looked up by name
let groupId = process.env.WA_GROUP_ID || getSettings().wa_group_id || null;

let client = null;
let restarting = false;
let failures = 0;

// Post a message to the tracked group (e.g. when the public dashboard link changes).
// Queued until WhatsApp is ready.
const pendingAnnouncements = [];
export async function announce(text) {
  if (!client || waStatus.state !== 'ready' || !groupId) { pendingAnnouncements.push(text); return; }
  try { await withTimeout(client.sendMessage(groupId, text + MARK), 30000, 'announce'); }
  catch (err) { console.error('[wa] announce failed:', err.message); }
}
function flushAnnouncements() {
  for (const text of pendingAnnouncements.splice(0)) announce(text);
}

// Close Chromium cleanly so the saved WhatsApp session isn't corrupted on redeploys.
export async function stopBot() {
  restarting = true; // stop the watchdog/restart loop
  const c = client;
  client = null;
  if (c) await withTimeout(c.destroy(), 15000, 'destroy').catch((err) => console.error('[wa] destroy on shutdown failed:', err.message));
  try { c?.pupBrowser?.process()?.kill('SIGKILL'); } catch { /* already gone */ }
}

export function startBot() {
  launch();
  // Watchdog: if WhatsApp Web stops answering, tear it down and start again.
  setInterval(async () => {
    if (restarting || !client || waStatus.state !== 'ready') return;
    try {
      const state = await withTimeout(client.getState(), 30000, 'getState');
      if (state !== 'CONNECTED') console.log('[wa] watchdog: state is', state);
    } catch (err) {
      restart(`watchdog: ${err.message}`);
    }
  }, 120000).unref();
}

async function restart(reason) {
  if (restarting) return;
  restarting = true;
  failures += 1;
  const delay = Math.min(10000 * failures, 120000);
  console.error(`[wa] restarting WhatsApp in ${delay / 1000}s — ${reason}`);
  Object.assign(waStatus, { state: 'restarting', qr: null, error: reason });
  const old = client;
  client = null;
  try { if (old) await withTimeout(old.destroy(), 20000, 'destroy'); } catch (err) { console.error('[wa] destroy failed:', err.message); }
  try { old?.pupBrowser?.process()?.kill('SIGKILL'); } catch { /* already gone */ }
  await sleep(delay);
  restarting = false;
  launch();
}

function launch() {
  const executablePath = process.env.CHROME_PATH || (existsSync(CHROME_DEFAULT) ? CHROME_DEFAULT : undefined);
  killOrphanBrowsers(SESSION_DIR);
  clearChromeLocks(SESSION_DIR);
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      executablePath,
      // Low-memory profile: WhatsApp Web is one tab, so drop per-site processes and background features.
      args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote',
        '--renderer-process-limit=1', '--disable-site-isolation-trials',
        '--disable-features=site-per-process,Translate,BackForwardCache,MediaRouter,OptimizationHints',
        '--disable-extensions', '--disable-background-networking', '--disable-default-apps', '--mute-audio',
        '--js-flags=--max-old-space-size=512',
      ],
    },
  });
  client = c;
  const startedAt = Math.floor(Date.now() / 1000);
  Object.assign(waStatus, { state: 'starting', qr: null });

  c.on('qr', (qr) => {
    console.log('\n📱 Scan this QR in WhatsApp → Settings → Linked devices → Link a device\n');
    qrcode.generate(qr, { small: true });
    console.log('…or open the dashboard and scan it there.');
    QRCode.toDataURL(qr, { margin: 1, width: 280 }).then((url) => Object.assign(waStatus, { state: 'qr', qr: url }));
  });
  c.on('authenticated', () => { console.log('[wa] authenticated'); Object.assign(waStatus, { state: 'authenticated', qr: null }); });
  c.on('auth_failure', (m) => { console.error('[wa] auth failure:', m); restart(`auth failure: ${m}`); });
  c.on('disconnected', (r) => { console.error('[wa] disconnected:', r); restart(`disconnected: ${r}`); });
  c.on('ready', () => {
    failures = 0;
    Object.assign(waStatus, { state: 'ready', qr: null, error: null, me: c.info?.pushname || c.info?.wid?.user });
    console.log(`[wa] ready — listening to ${TARGET === 'self' ? 'your "Message yourself" chat' : `group "${TARGET}"`}`);
    resolveGroup(c, 'startup').then(flushAnnouncements);
  });

  // msg.getChat() / client.getChatById() / msg.getContact() crash or hang on WhatsApp Web's current
  // build, so we never call them: the chat id comes from the message, names from WA's chat store.
  const lastLookup = new Map(); // chatId -> ms of last lookup, so unknown groups are re-checked at most once a minute

  async function isTargetChat(msg, chatId) {
    if (TARGET === 'self') {
      const me = c.info?.wid?._serialized;
      return msg.fromMe && !chatId.endsWith('@g.us') && (chatId === me || msg.to === msg.from || chatId.endsWith('@lid'));
    }
    if (!chatId.endsWith('@g.us')) return false;
    if (chatId === groupId) return true;
    if (groupId) return false; // we already know our group; other groups are simply not ours
    if (Date.now() - (lastLookup.get(chatId) || 0) > 60_000) {
      lastLookup.set(chatId, Date.now());
      await resolveGroup(c, `message from ${chatId}`);
      return chatId === groupId;
    }
    return false;
  }

  async function send(msg, chatId, text) {
    try {
      await withTimeout(msg.reply(text + MARK), 30000, 'reply');
    } catch (err) {
      console.error('[wa] reply failed, sending plain message:', err.message);
      await withTimeout(c.sendMessage(chatId, text + MARK), 30000, 'sendMessage');
    }
  }

  // message_create fires for messages from others AND from you, so you can log from your own phone.
  let seen = 0;
  c.on('message_create', async (msg) => {
    if (++seen <= 3 || seen % 50 === 0) console.log(`[wa] message events received: ${seen}`);
    const chatId = String(msg.id?.remote?._serialized || msg.id?.remote || (msg.fromMe ? msg.to : msg.from));
    // msg.id._serialized isn't always populated on WhatsApp Web's current build; build a stable id ourselves.
    const msgId = String(msg.id?._serialized || `${msg.fromMe ? 'true' : 'false'}_${chatId}_${msg.id?.id ?? msg.timestamp}`);
    // Explain every skip for messages from our group (and, with WA_DEBUG, metadata for all others).
    const skip = (why) => {
      if (chatId === groupId || process.env.WA_DEBUG) {
        console.log(`[wa] skip (${why}) chat=${chatId === groupId ? 'target' : chatId} type=${msg.type} fromMe=${msg.fromMe} ts=${msg.timestamp} id=${msgId}`);
      }
    };
    try {
      // WhatsApp delivers messages sent while we were offline as a backlog after (re)connecting.
      // Handle anything from the last few hours, exactly once.
      if (msg.timestamp < startedAt - BACKLOG_SECONDS) return skip('older than backlog window');
      if (msg.body?.includes(MARK)) return; // our own reply — expected, don't log
      if (!['chat', 'image', 'document'].includes(msg.type)) return skip('unsupported type');
      if (!(await isTargetChat(msg, chatId))) return skip('not the target chat');
      if (!claimMessage(msgId)) return skip('already handled');

      let image = null;
      let receiptPath = null;
      if (msg.hasMedia) {
        const media = await withTimeout(msg.downloadMedia(), 60000, 'downloadMedia');
        if (media && MEDIA_TYPES.includes(media.mimetype)) {
          image = { mimetype: media.mimetype, data: media.data };
          const file = `${Date.now()}-${String(msg.id?.id ?? 'media').replace(/[^\w-]/g, '')}.${ext(media.mimetype)}`;
          writeFileSync(path.join(RECEIPTS_DIR, file), Buffer.from(media.data, 'base64'));
          receiptPath = file;
        }
      }
      const text = msg.body || '';
      if (!text.trim() && !image) return skip('empty');

      // Sender display name is already on the raw message; no extra WhatsApp round-trip needed.
      const sender = String(msg.fromMe
        ? c.info?.pushname || 'me'
        : msg._data?.notifyName || String(msg.author || '').split('@')[0] || 'someone');

      console.log(`[wa] ${sender}: ${text.slice(0, 80)}${image ? ' [media]' : ''}`);
      const reply = await handleMessage({ text, image, receiptPath, sender, msgId });
      if (reply) await send(msg, chatId, reply);
      if (reply) console.log('[wa] replied');
    } catch (err) {
      console.error('[wa] failed to handle message:', err.message);
      try { await send(msg, chatId, '⚠️ Gagal mencatat: ' + err.message); } catch { /* ignore */ }
    }
  });

  c.initialize().catch((err) => {
    if (client !== c) return; // already replaced
    restart(`failed to start: ${err.message}`);
  });
}

async function resolveGroup(c, reason) {
  try {
    const groups = await withTimeout(c.pupPage.evaluate(() => {
      const { Chat } = window.require('WAWebCollections');
      return Chat.getModelsArray()
        .filter((ch) => ch.id?.server === 'g.us')
        .map((ch) => ({ id: ch.id._serialized, name: ch.formattedTitle || ch.name || ch.groupMetadata?.subject || null }));
    }), 15000, 'list groups');
    const hit = groups.find((g) => norm(g.name) === norm(TARGET));
    if (hit) {
      if (hit.id !== groupId) console.log(`[wa] found group "${hit.name}" → ${hit.id} (${reason})`);
      else console.log(`[wa] group "${hit.name}" confirmed (${reason})`);
      groupId = hit.id;
      setSetting('wa_group_id', hit.id);
    } else {
      console.log(`[wa] no group named "${TARGET}" (${reason}). Groups I can see: ${groups.map((g) => JSON.stringify(g.name)).join(', ') || 'none'}`);
    }
  } catch (err) {
    console.error(`[wa] group lookup failed (${reason}):`, err.message);
  }
}
