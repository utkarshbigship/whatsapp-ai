// Shared report logic for the command, the dashboard, the master agent, and the scheduler.
const config   = require('../config');
const db       = require('./db');
const logger   = require('./logger');
const { analyze, analyzeMaster, parseMetrics } = require('./analyzer');

// India Standard Time is a fixed UTC+5:30 offset (no DST) — safe to hardcode.
function istDateToEpoch(dateStr, time) {
  return Math.floor(new Date(`${dateStr}T${time}+05:30`).getTime() / 1000);
}

function istDateStr(d) {
  const ist = new Date(d.toLocaleString('en-US', { timeZone: config.analysis.timezone }));
  const yyyy = ist.getFullYear();
  const mm = String(ist.getMonth() + 1).padStart(2, '0');
  const dd = String(ist.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Previous calendar day in IST, as full-day window. */
function previousDayWindowIST() {
  const y = new Date(Date.now() - 24 * 3600 * 1000);
  const dateStr = istDateStr(y);
  return {
    from: istDateToEpoch(dateStr, '00:00:00'),
    to:   istDateToEpoch(dateStr, '23:59:59'),
    label: dateStr,
    dateStr,
  };
}

/** Today so far in IST (midnight → now). */
function todaySoFarWindowIST() {
  const dateStr = istDateStr(new Date());
  return {
    from: istDateToEpoch(dateStr, '00:00:00'),
    to:   Math.floor(Date.now() / 1000),
    label: `${dateStr} (so far)`,
    dateStr,
  };
}

/** Resolve a window into {from, to, label} unix seconds. */
function resolveWindow(window = {}) {
  // Pre-resolved window (scheduler passes exact epochs).
  if (window.from && window.to) {
    return { from: window.from, to: window.to, label: window.label || 'custom' };
  }
  const { fromDate, toDate, hours } = window;
  if (fromDate && toDate) {
    return {
      from: istDateToEpoch(fromDate, '00:00:00'),
      to:   istDateToEpoch(toDate,   '23:59:59'),
      label: `${fromDate} to ${toDate}`,
    };
  }
  const h  = hours || config.analysis.defaultWindowHours;
  const to = Math.floor(Date.now() / 1000);
  return { from: to - h * 3600, to, label: `last ${h}h` };
}

/**
 * Generate and store an escalation report for one group.
 * @returns {Promise<{report, messageCount, windowLabel, metrics}|null>}
 */
async function generateReport({ groupId, groupName, window, contextReportIds, trigger = 'manual', thinkingLevel }) {
  const { from, to, label } = resolveWindow(window || {});
  const messages = db.getMessagesInRange(groupId, from, to);
  if (messages.length < config.analysis.minMessages) return null;

  let priorReports = [];
  if (Array.isArray(contextReportIds) && contextReportIds.length) {
    priorReports = db.getReportsByIds(contextReportIds).map((r) => ({
      label: r.window_label || new Date(r.created_at * 1000).toLocaleDateString('en-IN'),
      report: r.report,
    }));
  }

  const report = await analyze({ groupName, messages, windowLabel: label, priorReports, thinkingLevel });
  if (!report) return null;

  const metrics = parseMetrics(report);
  db.insertReport({
    group_id: groupId, group_name: groupName, report,
    message_count: messages.length, window_label: label,
    period_start: from, period_end: to,
    model: config.gemini.model, trigger,
    scope: 'group', metrics_json: metrics ? JSON.stringify(metrics) : null,
  });

  return { report, messageCount: messages.length, windowLabel: label, metrics };
}

const INT_KEYS = [
  'raised', 'closed', 'pending', 'responded_meaningful', 'formality_only', 'missed',
  'high_panic', 'critical', 'abuse_legal', 'follow_ups_seller', 'staff_responses_to_followups',
  'first_mile', 'last_mile', 'best_case_count', 'worst_case_count',
];

/** Deterministically sum per-group metrics. avg_* are weighted over reporting groups. */
function sumMetrics(list) {
  const totals = {};
  for (const k of INT_KEYS) totals[k] = 0;
  let hrW = 0, hrN = 0, dayW = 0, dayN = 0;
  for (const m of list) {
    if (!m) continue;
    for (const k of INT_KEYS) totals[k] += Number(m[k]) || 0;
    const closed = Number(m.closed) || 0;
    const w = closed > 0 ? closed : 1;
    if (m.avg_hours_to_close != null) { hrW += Number(m.avg_hours_to_close) * w; hrN += w; }
    if (m.avg_days_to_close  != null) { dayW += Number(m.avg_days_to_close) * w; dayN += w; }
  }
  totals.avg_hours_to_close = hrN ? +(hrW / hrN).toFixed(2) : null;
  totals.avg_days_to_close  = dayN ? +(dayW / dayN).toFixed(2) : null;
  return totals;
}

const LABELS = {
  raised: 'Escalations raised', closed: 'Closed', pending: 'Pending',
  responded_meaningful: 'Responded meaningfully', formality_only: 'Formality only',
  missed: 'No response / missed', high_panic: 'High-panic (3+ follow-ups)',
  critical: 'Critical', abuse_legal: 'Abuse / legal',
  follow_ups_seller: 'Follow-ups by sellers', staff_responses_to_followups: 'Staff responses to follow-ups',
  first_mile: 'First Mile', last_mile: 'Last Mile',
  best_case_count: 'Best case (fast clean closes)', worst_case_count: 'Worst case (critical/long-open)',
  avg_hours_to_close: 'Avg hours to close', avg_days_to_close: 'Avg days to close',
};

function renderTotalsBlock(totals, groupCount, withMetricsCount) {
  const lines = [
    `**Totals (computed across ${groupCount} group${groupCount === 1 ? '' : 's'}` +
      (withMetricsCount != null && withMetricsCount !== groupCount
        ? `, ${withMetricsCount} with machine counts` : '') + `)**`,
  ];
  for (const k of INT_KEYS) lines.push(`- ${LABELS[k]}: ${totals[k]}`);
  lines.push(`- ${LABELS.avg_hours_to_close}: ${totals.avg_hours_to_close ?? 'n/a'}`);
  lines.push(`- ${LABELS.avg_days_to_close}: ${totals.avg_days_to_close ?? 'n/a'}`);
  return lines.join('\n');
}

/**
 * Generate and store a master (cross-group) report for ONE cluster.
 * Totals are summed in code; the LLM writes only prose/flags/group-tags.
 * @returns {Promise<{report, messageCount, windowLabel, metrics}|null>}
 */
async function generateMasterReport({ clusterId = 'all', window, contextReportIds, trigger = 'manual' }) {
  const { from, to, label } = resolveWindow(window || {});

  // Restrict to this cluster's groups (default cluster 'all' = every group with a report in window).
  let groupIds = null;
  if (clusterId && clusterId !== 'all') {
    groupIds = db.getGroupsForCluster(clusterId).map((g) => g.group_id);
    if (!groupIds.length) return null;
  }

  const rows = db.getGroupReportsForWindow(from, to, groupIds);
  if (!rows.length) return null;

  const groupReports = rows.map((r) => ({
    groupId: r.group_id,
    groupName: r.group_name || r.group_id,
    report: r.report,
    metrics: r.metrics_json ? safeParse(r.metrics_json) : null,
  }));

  const withMetrics = groupReports.map((g) => g.metrics).filter(Boolean);
  const totals = sumMetrics(withMetrics);

  let priorMasterReports = [];
  if (Array.isArray(contextReportIds) && contextReportIds.length) {
    priorMasterReports = db.getReportsByIds(contextReportIds).map((r) => ({
      label: r.window_label || new Date(r.created_at * 1000).toLocaleDateString('en-IN'),
      report: r.report,
    }));
  }

  const prose = await analyzeMaster({ windowLabel: label, groupReports, priorMasterReports });
  if (!prose) return null;

  const totalsBlock = renderTotalsBlock(totals, groupReports.length, withMetrics.length);
  const report = `${totalsBlock}\n\n${prose}`;
  const messageCount = rows.reduce((n, r) => n + (r.message_count || 0), 0);

  db.insertReport({
    group_id: `${config.master.groupIdPrefix}:${clusterId}`,
    group_name: clusterId === 'all' ? 'All Groups (Master)' : `Master — ${clusterId}`,
    report, message_count: messageCount, window_label: label,
    period_start: from, period_end: to,
    model: config.gemini.model, trigger,
    scope: 'master', cluster_id: clusterId,
    metrics_json: JSON.stringify({ ...totals, group_count: groupReports.length }),
  });

  return { report, messageCount: groupReports.length, windowLabel: label, metrics: totals };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function formatForDelivery(groupName, result) {
  return `📋 *${groupName}* — escalation report (${result.windowLabel})\n` +
         `_${result.messageCount} messages analysed_\n\n${result.report}`;
}

function formatMasterForDelivery(result) {
  return `📊 *Master report* (${result.windowLabel})\n` +
         `_${result.messageCount} groups aggregated_\n\n${result.report}`;
}

module.exports = {
  generateReport, generateMasterReport,
  formatForDelivery, formatMasterForDelivery,
  resolveWindow, previousDayWindowIST, todaySoFarWindowIST, istDateToEpoch,
};
