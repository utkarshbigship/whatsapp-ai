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

function init() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] },
  });

  client.on('qr', (qr) => { logger.info('Scan QR with the bot WhatsApp account:'); qrcode.generate(qr, { small: true }); });
  client.on('authenticated', () => logger.info('Authenticated. Session saved.'));
  client.on('auth_failure', (m) => logger.error('Auth failure:', m, '— delete .wwebjs_auth and re-scan.'));
  client.on('ready', () => { isReady = true; logger.info('WhatsApp client is READY.'); });
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

      let authorName = msg._data?.notifyName || null;
      if (!authorName) {
        try { const c = await msg.getContact(); authorName = c.pushname || c.name || c.number || null; } catch (_) {}
      }

      const isMedia = !!msg.hasMedia;
      const baseBody = msg.body || '';

      // Insert immediately (raw), so nothing is lost. Media gets enriched async.
      const id = db.insertMessage({
        group_id: groupId, group_name: groupName,
        author: msg.author || null, author_name: authorName,
        body: isMedia ? (baseBody ? baseBody + ' [media analysing…]' : '[media analysing…]') : baseBody,
        msg_type: msg.type, has_media: isMedia ? 1 : 0, timestamp: msg.timestamp,
      });
      logger.debug(`[${groupName}] ${authorName || msg.author}: ${(baseBody || '['+msg.type+']').slice(0,60)}`);

      // Enrich media in the background (does not block the handler).
      if (isMedia && config.media.enabled && config.media.types.includes(msg.type)) {
        (async () => {
          try {
            const m = await msg.downloadMedia();
            const desc = await media.understand(m, msg.type);
            const body = baseBody ? `${baseBody} ${desc}` : desc;
            db.updateMessageBody(id, body);
            logger.debug(`[${groupName}] media enriched: ${desc.slice(0, 80)}`);
          } catch (e) {
            logger.warn(`Media enrich failed: ${e.message}`);
            db.updateMessageBody(id, baseBody ? `${baseBody} [${msg.type}]` : `[${msg.type}]`);
          }
        })();
      }
    } catch (err) {
      logger.error('Error handling message:', err.message);
    }
  });

  return client;
}

async function sendText(to, text) {
  if (!isReady) { logger.warn('Client not ready; skipping send.'); return false; }
  await client.sendMessage(to, text);
  return true;
}

module.exports = { init, sendText, getClient: () => client, isReady: () => isReady };
