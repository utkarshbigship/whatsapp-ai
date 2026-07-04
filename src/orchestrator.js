// Batch "runs": freeze the active-group set at a cutoff, generate group reports with progress,
// and (optionally) aggregate the master. Single source of truth for progress + verification.
const config  = require('../config');
const logger  = require('./logger');
const db      = require('./db');
const runlock = require('./runlock');
const {
  generateReport, generateMasterReport, resolveWindow,
  previousDayWindowIST, todaySoFarWindowIST,
} = require('./reportEngine');

const FRESH_SECONDS = 30 * 60; // smart-reuse freshness threshold

/** Limited-concurrency promise pool (no extra dependency). */
async function runPool(taskFns, size) {
  const queue = taskFns.slice();
  const workers = Array.from({ length: Math.max(1, size) }, async () => {
    while (queue.length) {
      const fn = queue.shift();
      try { await fn(); } catch (e) { logger.error('Run task error:', e.message); }
    }
  });
  await Promise.all(workers);
}

/** Window for a scheduler firing: cutoff is "now" (the fire time) for the snapshot. */
function windowForMode(mode) {
  if (mode === 'previous-day') return previousDayWindowIST();
  // 'today-so-far' (default): midnight IST → now (fire time = cutoff).
  return todaySoFarWindowIST();
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Start a batch: synchronously freeze the active-group set, create the run record, and launch the
 * heavy work in the background. Returns { runId, alreadyRunning } IMMEDIATELY so callers (and the
 * dashboard) can track this EXACT run by id — never a stale "latest" one. Throws only on genuine
 * setup errors (surfaced to the user), never silently.
 */
function startBatch({ clusterId = 'all', window, trigger = 'manual', smartReuse = false, withMaster = false, contextReportIds = [] } = {}) {
  // Serialize batch-level runs: a group batch and a manual master must never overlap.
  if (runlock.globalStatus().running) {
    logger.warn('startBatch: another batch is already running — returning the in-progress run.');
    const latest = db.getLatestRun(null);
    return { runId: latest ? latest.id : null, alreadyRunning: true };
  }

  const hasExplicit = window && (window.from || window.fromDate || window.hours);
  const w = hasExplicit ? resolveWindow(window) : windowForMode((window && window.mode) || 'today-so-far');
  const from = w.from, cutoff = w.to, label = w.label;

  // Freeze the active-group set at the cutoff.
  let active = db.getGroupsWithActivity(from, cutoff);
  if (clusterId && clusterId !== 'all') {
    const members = new Set(db.getGroupsForCluster(clusterId).map((g) => g.group_id));
    active = active.filter((g) => members.has(g.group_id));
  }
  const groupIds = active.map((g) => g.group_id);

  const runId = db.createRun({
    trigger, cluster_id: clusterId, window_label: label,
    window_from: from, window_to: cutoff, group_ids: groupIds,
  });

  // Hold the lock now (synchronously) so a second click can't start a parallel run.
  runlock.beginGlobal();
  runlock.begin(clusterId); // per-cluster, for the dashboard's status display

  // Fire the heavy work; the dashboard polls the run by id.
  runBatchWork(runId, { from, cutoff, label, active, groupIds, clusterId, trigger, smartReuse, withMaster, contextReportIds })
    .catch((e) => logger.error('runBatchWork crashed:', e.message));

  return { runId, alreadyRunning: false };
}

/** The actual work of a batch (group reports → optional master). Always releases the lock. */
async function runBatchWork(runId, ctx) {
  const { from, cutoff, label, active, groupIds, clusterId, trigger, smartReuse, withMaster, contextReportIds } = ctx;
  try {
    let done = 0;
    const tasks = active.map((g) => async () => {
      db.updateRun(runId, { current_group: g.group_name || g.group_id });
      let reused = false;
      if (smartReuse) {
        const last = db.getLatestGroupReport(g.group_id);
        if (last && last.period_start === from && last.period_end === cutoff &&
            (nowSec() - last.created_at) < FRESH_SECONDS &&
            db.countMessagesSince(last.period_end, [g.group_id]).messages === 0) {
          reused = true;
        }
      }
      if (!reused) {
        await generateReport({
          groupId: g.group_id, groupName: g.group_name,
          window: { from, to: cutoff, label }, trigger,
        }).catch((e) => logger.error(`Run group ${g.group_name}: ${e.message}`));
      }
      done += 1;
      db.updateRun(runId, { completed_groups: done });
    });
    await runPool(tasks, config.agents.groupConcurrency);

    if (withMaster) {
      db.updateRun(runId, { phase: 'master', current_group: null });
      const r = await generateMasterReport({
        clusterId, window: { from, to: cutoff, label }, groupIds, trigger, contextReportIds,
      });
      if (r) db.updateRun(runId, { master_report_id: r.reportId });
      else db.updateRun(runId, {
        note: active.length
          ? 'Group reports ran, but none could be aggregated into a master for this window.'
          : 'No active groups with messages in this window — nothing to analyse.',
      });
    }
    db.updateRun(runId, { phase: 'done', status: 'complete', finished_at: nowSec() });
  } catch (e) {
    logger.error('runBatch failed:', e.message);
    db.updateRun(runId, { phase: 'error', status: 'error', error: e.message, finished_at: nowSec() });
  } finally {
    runlock.end(clusterId);
    runlock.endGlobal();
  }
}

/** Back-compat wrapper (scheduler): start the batch and resolve with its run id. */
async function runBatch(opts) { return startBatch(opts).runId; }

module.exports = { runBatch, startBatch };
