// DB-driven scheduler: run times are managed from the dashboard (schedules table).
// Each run generates all active group reports first, then one master report per cluster.
const cron    = require('node-cron');
const config  = require('../config');
const logger  = require('./logger');
const db      = require('./db');
const runlock = require('./runlock');
const {
  generateReport, generateMasterReport,
  previousDayWindowIST, todaySoFarWindowIST,
} = require('./reportEngine');

const tasks = new Map(); // scheduleId -> cron task

/** Limited-concurrency promise pool (no extra dependency). */
async function runPool(taskFns, size) {
  const queue = taskFns.slice();
  const workers = Array.from({ length: Math.max(1, size) }, async () => {
    while (queue.length) {
      const fn = queue.shift();
      try { await fn(); } catch (e) { logger.error('Scheduler task error:', e.message); }
    }
  });
  await Promise.all(workers);
}

/** Run one full pass: group reports, then per-cluster master reports. */
async function runOnce(windowMode = 'previous-day') {
  const win = windowMode === 'today-so-far' ? todaySoFarWindowIST() : previousDayWindowIST();
  const groups = db.getGroupsWithActivity(win.from, win.to);
  logger.info(`Scheduler: ${groups.length} active groups for ${win.label}`);

  // 1) Group reports (limited parallelism, each with its own prior-day context).
  const groupTasks = groups.map((g) => async () => {
    const prior = db.getReportsBeforeForGroup(g.group_id, win.from, 1);
    await generateReport({
      groupId: g.group_id, groupName: g.group_name,
      window: { from: win.from, to: win.to, label: win.label },
      contextReportIds: prior.length ? [prior[0].id] : [],
      trigger: 'schedule',
      thinkingLevel: config.agents.scheduledThinkingLevel,
    });
  });
  await runPool(groupTasks, config.agents.groupConcurrency);

  // 2) Master reports — only AFTER all group reports are saved. One per cluster.
  const clusters = db.listClusters();
  for (const c of clusters) {
    runlock.begin(c.id);
    try {
      const priorMaster = db.getMasterReportsBefore(c.id, win.from, 1);
      const r = await generateMasterReport({
        clusterId: c.id,
        window: { from: win.from, to: win.to, label: win.label },
        contextReportIds: priorMaster.length ? [priorMaster[0].id] : [],
        trigger: 'schedule',
      });
      if (!r) logger.info(`Scheduler: no group reports for cluster "${c.id}" — master skipped.`);
    } catch (e) {
      logger.error(`Scheduler master "${c.id}":`, e.message);
    } finally {
      runlock.end(c.id);
    }
  }
  logger.info(`Scheduler: run complete for ${win.label}.`);
}

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
      logger.info(`Scheduler fired: "${s.label || s.time_hhmm}" (${s.window_mode})`);
      runOnce(s.window_mode).catch((e) => logger.error('Scheduler run failed:', e.message));
    }, { timezone: config.scheduler.timezone });
    tasks.set(s.id, task);
  }
  logger.info(`Scheduler armed: ${tasks.size} schedule(s), tz ${config.scheduler.timezone}.`);
}

function start() { reload(); }

module.exports = { start, reload, runOnce };
