// DB-driven scheduler. Two schedule types managed from the dashboard:
//   - 'group'  : freezes active groups at fire time and generates their reports.
//   - 'master' : aggregates the latest COMPLETE group run (run it ~15 min after the group one).
const cron    = require('node-cron');
const config  = require('../config');
const logger  = require('./logger');
const db      = require('./db');
const { runBatch, runMasterFromLatestRun } = require('./orchestrator');

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
      logger.info(`Scheduler fired: ${s.type} "${s.label || s.time_hhmm}" (${s.window_mode})`);
      const run = s.type === 'master'
        ? runMasterFromLatestRun()
        : runBatch({ window: { mode: s.window_mode }, trigger: 'schedule', smartReuse: false, withMaster: false });
      Promise.resolve(run).catch((e) => logger.error('Scheduler run failed:', e.message));
    }, { timezone: config.scheduler.timezone });
    tasks.set(s.id, task);
  }
  logger.info(`Scheduler armed: ${tasks.size} schedule(s), tz ${config.scheduler.timezone}.`);
}

function start() { reload(); }

module.exports = { start, reload };
