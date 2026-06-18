require('dotenv').config();
const config   = require('./../config');
const logger   = require('./logger');
const db       = require('./db');
const whatsapp = require('./whatsapp');
const server   = require('./server');
const { generateReport, formatForDelivery } = require('./reportEngine');

function preflight() {
  const p = [];
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes('your_'))
    p.push('GEMINI_API_KEY missing/placeholder in .env');
  if (config.command.enabled && (!config.recipient || config.recipient.includes('X')))
    logger.warn('RECIPIENT_NUMBER not set — !analyse command delivery will fail.');
  if (p.length) { p.forEach((x) => logger.error('CONFIG: ' + x)); process.exit(1); }
  logger.info(`Model: ${config.gemini.model} | thinking: ${config.gemini.thinkingLevel}`);
}

async function main() {
  preflight();
  logger.info('Starting Escalation Analyst...');
  const stale = db.failStaleRuns();
  if (stale) logger.warn(`Marked ${stale} interrupted run(s) as error after restart.`);
  const client = whatsapp.init();
  server.start();
  require('./scheduler').start();

  // optional: --analyse "Group Name" generates a report once ready (for testing)
  const idx = process.argv.indexOf('--analyse');
  if (idx !== -1) {
    const name = process.argv[idx + 1];
    client.on('ready', async () => {
      const groups = db.getKnownGroups(0).filter((g) => (g.group_name || '').includes(name || ''));
      for (const g of groups) {
        const r = await generateReport({ groupId: g.group_id, groupName: g.group_name, trigger: 'cli' });
        if (r) { logger.info(`\n${formatForDelivery(g.group_name, r)}`); }
      }
    });
  }

  await client.initialize();
}

function shutdown(s) { logger.info(`${s} — shutting down.`); try { db.close(); } catch (_) {} process.exit(0); }
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => logger.error('Unhandled rejection:', r));
process.on('uncaughtException',  (e) => logger.error('Uncaught exception:', e.message));

main().catch((e) => { logger.error('Fatal startup error:', e); process.exit(1); });
