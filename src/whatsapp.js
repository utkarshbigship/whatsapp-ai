const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('../config');
const logger = require('./logger');
const db     = require('./db');
const media  = require('./media');
const { generateReport, formatForDelivery } = require('./reportEngine');

let client;
let isReady = false;

function shouldTrack(groupId, groupName) {
  if (config.groups.mode === 'all') return true;
  const name = (groupName || '').toLowerCase();
  return config.groups.list.some((e) => {
    const x = e.toLowerCase();
    return x.endsWith('@g.us') ? x === groupId.toLowerCase() : name.includes(x);
  });
}

async function handleCommand(msg, groupId, groupName) {
  const cmd = config.command;
  if (!cmd.enabled || !msg.body) return false;
  if (msg.body.trim().toLowerCase() !== cmd.trigger.toLowerCase()) return false;
  if (cmd.ownerOnly) {
    const sender = (msg.author || '').toLowerCase();
    if (!cmd.ownerNumber || sender !== cmd.ownerNumber.toLowerCase()) {
      logger.warn(`Ignoring ${cmd.trigger} from non-owner in "${groupName}".`);
      return true;
    }
  }
  logger.info(`${cmd.trigger} for "${groupName}"...`);
  const result = await generateReport({ groupId, groupName, trigger: 'command' });
  if (!result) {
    if (cmd.deliverTo === 'group') await msg.reply('Not enough messages in the window to analyse.');
    return true;
  }
  const text = formatForDelivery(groupName, result);
  if (cmd.deliverTo === 'group') await msg.reply(text);
  else await client.sendMessage(config.recipient, text);
  return true;
}

// A minified page-side error (whatsapp-web.js hooking broken WhatsApp Web internals) surfaces
// as a useless one-char message like "r". Include the error name + first stack frame so the log
// says *where* it broke (e.g. WWebJS.getChatModel) instead of a bare letter.
function errInfo(err) {
  if (!err) return 'unknown';
  const name = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
  const first = (err.stack || '').split('\n').find((l) => /\bat\b/.test(l));
  return `${name}${err.message || 'no message'}${first ? ` | ${first.trim()}` : ''}`;
}

function init() {
  const clientOpts = {
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] },
  };
  // Optionally pin the WhatsApp Web build to a known-good version so a WhatsApp-side update can't
  // silently break the library's Store hooks. Opt-in via WA_WEB_VERSION.
  if (config.whatsapp.webVersion) {
    clientOpts.webVersion = config.whatsapp.webVersion;
    clientOpts.webVersionCache = {
      type: 'remote',
      remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${config.whatsapp.webVersion}.html`,
    };
    logger.info(`Pinning WhatsApp Web version ${config.whatsapp.webVersion}.`);
  }
  client = new Client(clientOpts);

  client.on('qr', (qr) => { logger.info('Scan QR with the bot WhatsApp account:'); qrcode.generate(qr, { small: true }); });
  client.on('authenticated', () => logger.info('Authenticated. Session saved.'));
  client.on('auth_failure', (m) => logger.error('Auth failure:', m, '— delete .wwebjs_auth and re-scan.'));
  client.on('ready', async () => {
    isReady = true;
    logger.info('WhatsApp client is READY.');
    await backfillRecent().catch((e) => logger.warn('Backfill failed:', errInfo(e)));
  });
  client.on('disconnected', (reason) => {
    isReady = false;
    logger.warn('Disconnected:', reason, `— reconnecting in ${config.whatsapp.reconnectDelaySeconds}s`);
    setTimeout(() => client.initialize().catch((e) => logger.error('Reconnect failed:', e.message)),
      config.whatsapp.reconnectDelaySeconds * 1000);
  });

  client.on('message', async (msg) => {
    try {
      if (!msg.from.endsWith('@g.us')) return;
      const chat = await msg.getChat();
      const groupId = msg.from;
      const groupName = chat.name || groupId;
      if (!shouldTrack(groupId, groupName)) return;

      if (await handleCommand(msg, groupId, groupName)) return;
      await persistMessage(msg, groupId, groupName);
    } catch (err) {
      logger.error('Error handling message:', errInfo(err));
    }
  });

  return client;
}

// Store one message (idempotent via wa_id) and enrich media in the background.
async function persistMessage(msg, groupId, groupName) {
  let authorName = msg._data?.notifyName || null;
  if (!authorName) {
    try { const c = await msg.getContact(); authorName = c.pushname || c.name || c.number || null; } catch (_) {}
  }
  const isMedia = !!msg.hasMedia;
  const baseBody = msg.body || '';
  const { id, inserted } = db.insertMessageInfo({
    group_id: groupId, group_name: groupName,
    author: msg.author || null, author_name: authorName,
    body: isMedia ? (baseBody ? baseBody + ' [media analysing…]' : '[media analysing…]') : baseBody,
    msg_type: msg.type, has_media: isMedia ? 1 : 0, timestamp: msg.timestamp,
    wa_id: msg.id?._serialized || null,
  });
  if (!inserted) return false; // duplicate (already stored) — skip enrichment
  logger.debug(`[${groupName}] ${authorName || msg.author}: ${(baseBody || '['+msg.type+']').slice(0,60)}`);

  if (isMedia && config.media.enabled && config.media.types.includes(msg.type)) {
    (async () => {
      try {
        const m = await msg.downloadMedia();
        const desc = await media.understand(m, msg.type);
        db.updateMessageBody(id, baseBody ? `${baseBody} ${desc}` : desc);
        logger.debug(`[${groupName}] media enriched: ${desc.slice(0, 80)}`);
      } catch (e) {
        logger.warn(`Media enrich failed: ${e.message}`);
        db.updateMessageBody(id, baseBody ? `${baseBody} [${msg.type}]` : `[${msg.type}]`);
      }
    })();
  }
  return true;
}

// On (re)connect, pull recent messages per tracked group to recover any gap left by a
// restart/disconnect. Idempotent: dedup on wa_id + a per-group timestamp cursor.
async function backfillRecent() {
  const limit = config.whatsapp.backfillLimit;
  if (!limit || limit < 1) return;
  let chats;
  try { chats = await client.getChats(); } catch (e) { logger.warn('Backfill getChats failed:', errInfo(e)); return; }
  let added = 0, groupsTouched = 0;
  for (const chat of chats) {
    const groupId = chat.id?._serialized || '';
    if (!groupId.endsWith('@g.us')) continue;
    const groupName = chat.name || groupId;
    if (!shouldTrack(groupId, groupName)) continue;
    try {
      const cursor = db.getLastMessageTs(groupId); // only consider messages newer than what we have
      const msgs = await chat.fetchMessages({ limit });
      let groupAdded = 0;
      for (const m of msgs) {
        if (cursor && m.timestamp <= cursor) continue;
        if (await persistMessage(m, groupId, groupName)) { added++; groupAdded++; }
      }
      if (groupAdded) groupsTouched++;
    } catch (e) {
      logger.warn(`Backfill "${groupName}" failed: ${e.message}`);
    }
  }
  if (added) logger.info(`Backfill: recovered ${added} message(s) across ${groupsTouched} group(s).`);
  else logger.info('Backfill: no missed messages.');
}

async function sendText(to, text) {
  if (!isReady) { logger.warn('Client not ready; skipping send.'); return false; }
  await client.sendMessage(to, text);
  return true;
}

module.exports = { init, sendText, getClient: () => client, isReady: () => isReady };
