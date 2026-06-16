// Shared report logic for the command, the dashboard, and any scheduler.
const config   = require('../config');
const db       = require('./db');
const { analyze } = require('./analyzer');

function tzNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: config.analysis.timezone }));
}

/** Resolve a window into {from, to, label} unix seconds. */
function resolveWindow({ fromDate, toDate, hours } = {}) {
  if (fromDate && toDate) {
    const from = Math.floor(new Date(fromDate + 'T00:00:00').getTime() / 1000);
    const to   = Math.floor(new Date(toDate   + 'T23:59:59').getTime() / 1000);
    return { from, to, label: `${fromDate} to ${toDate}` };
  }
  const h  = hours || config.analysis.defaultWindowHours;
  const to = Math.floor(Date.now() / 1000);
  return { from: to - h * 3600, to, label: `last ${h}h` };
}

/**
 * Generate and store an escalation report for one group.
 * @param {object} opts
 * @param {string} opts.groupId
 * @param {string} opts.groupName
 * @param {object} [opts.window]            {fromDate,toDate,hours}
 * @param {number[]} [opts.contextReportIds] prior report ids to feed as context
 * @param {string} [opts.trigger]
 * @returns {Promise<{report:string, messageCount:number, windowLabel:string}|null>}
 */
async function generateReport({ groupId, groupName, window, contextReportIds, trigger = 'manual' }) {
  const { from, to, label } = resolveWindow(window || {});
  const messages = db.getMessagesInRange(groupId, from, to);
  if (messages.length < config.analysis.minMessages) return null;

  // Optional: pull selected prior reports to give the model cross-day memory.
  let priorReports = [];
  if (Array.isArray(contextReportIds) && contextReportIds.length) {
    priorReports = db.getReportsByIds(contextReportIds).map((r) => ({
      label: r.window_label || new Date(r.created_at * 1000).toLocaleDateString('en-IN'),
      report: r.report,
    }));
  }

  const report = await analyze({ groupName, messages, windowLabel: label, priorReports });
  if (!report) return null;

  db.insertReport({
    group_id: groupId, group_name: groupName, report,
    message_count: messages.length, window_label: label,
    period_start: from, period_end: to,
    model: config.gemini.model, trigger,
  });

  return { report, messageCount: messages.length, windowLabel: label };
}

function formatForDelivery(groupName, result) {
  return `📋 *${groupName}* — escalation report (${result.windowLabel})\n` +
         `_${result.messageCount} messages analysed_\n\n${result.report}`;
}

module.exports = { generateReport, formatForDelivery, resolveWindow };
