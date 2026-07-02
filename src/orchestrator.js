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

/**
 * Generate group reports for a frozen snapshot of active groups, optionally then the master.
 * Returns the run id. Progress is tracked in report_runs.
 */
async function runBatch({ clusterId = 'all', window, trigger = 'manual', smartReuse = false, withMaster = false, contextReportIds = [] }) {
  // Serialize batch-level runs: a group batch and a manual master must never overlap.
  if (runlock.globalStatus().running) {
    logger.warn('runBatch: another batch is already running — skipping this request.');
    const latest = db.getLatestRun(null);
    return latest ? latest.id : null;
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

  runlock.beginGlobal();
  runlock.begin(clusterId); // per-cluster, for the dashboard's status display
  try {
    let done = 0;
    const tasks = active.map((g) => async () => {
      db.updateRun(runId, { current_group: g.group_name || g.group_id });
      let reused = false;
      if (smartReuse) {
        const last = db.getLatestGroupReport(g.group_id);
        if (last && last.period_start === from && last.period_end === cutoff &&
            (Math.floor(Date.now() / 1000) - last.created_at) < FRESH_SECONDS &&
            db.countMessagesSince(last.period_end, [g.group_id]).messages === 0) {
          reused = true;
        }
      }
      if (!reused) {
        await generateReport({
          groupId: g.group_id, groupName: g.group_name,
          window: { from, to: cutoff, label },
          trigger, // reports always run at max reasoning (config.deepseek.reasoningEffort)
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
    }
    db.updateRun(runId, { phase: 'done', status: 'complete', finished_at: Math.floor(Date.now() / 1000) });
  } catch (e) {
    logger.error('runBatch failed:', e.message);
    db.updateRun(runId, { phase: 'error', status: 'error', error: e.message, finished_at: Math.floor(Date.now() / 1000) });
  } finally {
    runlock.end(clusterId);
    runlock.endGlobal();
  }
  return runId;
}

module.exports = { runBatch };
