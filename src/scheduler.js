// DB-driven scheduler. Each schedule fires a group run at the chosen time; when all
// group reports finish, the run automatically generates the overall master report.
const cron    = require('node-cron');
const config  = require('../config');
const logger  = require('./logger');
const db      = require('./db');
const { runBatch } = require('./orchestrator');

const tasks = new Map(); // scheduleId -> cron task

function cronFor(timeHHMM) {
  const [h, m] = String(timeHHMM).split(':').map((x) => parseInt(x, 10));
  return `${m || 0} ${h || 0} * * *`;
}

function clearTasks() {
  for (const t of tasks.values()) { try { t.stop(); } catch (_) {} }
  tasks.clear();
}

/** (Re)load schedules from the DB and arm cron tasks. */
function reload() {
  clearTasks();
  if (!config.scheduler.enabled) { logger.info('Scheduler disabled.'); return; }
  const schedules = db.listSchedules().filter((s) => s.enabled);
  for (const s of schedules) {
    const expr = cronFor(s.time_hhmm);
    if (!cron.validate(expr)) { logger.warn(`Invalid schedule time "${s.time_hhmm}" (id ${s.id})`); continue; }
    const task = cron.schedule(expr, () => {
      logger.info(`Scheduler fired: group run "${s.label || s.time_hhmm}" (${s.window_mode}) → auto master`);
      Promise.resolve(
        runBatch({ clusterId: 'all', window: { mode: s.window_mode }, trigger: 'schedule', smartReuse: false, withMaster: true })
      ).catch((e) => logger.error('Scheduler run failed:', e.message));
    }, { timezone: config.scheduler.timezone });
    tasks.set(s.id, task);
  }
  logger.info(`Scheduler armed: ${tasks.size} schedule(s), tz ${config.scheduler.timezone}.`);
}

function start() { reload(); }

module.exports = { start, reload };
