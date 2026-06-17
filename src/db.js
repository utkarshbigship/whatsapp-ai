const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const config   = require('../config');
const logger   = require('./logger');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'messages.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id    TEXT NOT NULL,
    group_name  TEXT,
    author      TEXT,
    author_name TEXT,
    body        TEXT,
    msg_type    TEXT,
    has_media   INTEGER DEFAULT 0,
    timestamp   INTEGER NOT NULL,
    created_at  INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_group_ts ON messages(group_id, timestamp);

  CREATE TABLE IF NOT EXISTS reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id      TEXT NOT NULL,
    group_name    TEXT,
    report        TEXT NOT NULL,
    message_count INTEGER,
    window_label  TEXT,
    period_start  INTEGER,
    period_end    INTEGER,
    model         TEXT,
    trigger       TEXT,
    created_at    INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_rep_group ON reports(group_id, created_at);

  CREATE TABLE IF NOT EXISTS clusters (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS group_clusters (
    group_id    TEXT PRIMARY KEY,
    cluster_id  TEXT NOT NULL,
    group_name  TEXT,
    updated_at  INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT,
    time_hhmm   TEXT NOT NULL,            -- "HH:MM" in scheduler timezone
    window_mode TEXT NOT NULL DEFAULT 'previous-day', -- previous-day | today-so-far
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// --- Idempotent migrations: add columns to pre-existing reports tables ---
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('reports', 'scope',        `scope TEXT NOT NULL DEFAULT 'group'`);
ensureColumn('reports', 'metrics_json', `metrics_json TEXT`);
ensureColumn('reports', 'cluster_id',   `cluster_id TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_rep_scope ON reports(scope, period_start, period_end);`);

// Seed the default cluster so unassigned groups always have a home.
db.prepare(`INSERT OR IGNORE INTO clusters (id, name) VALUES ('all', 'All')`).run();

const stmtInsertMsg = db.prepare(`
  INSERT INTO messages (group_id, group_name, author, author_name, body, msg_type, has_media, timestamp)
  VALUES (@group_id, @group_name, @author, @author_name, @body, @msg_type, @has_media, @timestamp)
`);
const stmtUpdateBody = db.prepare(`UPDATE messages SET body = @body WHERE id = @id`);

const stmtMessagesRange = db.prepare(`
  SELECT author, author_name, body, msg_type, timestamp
  FROM messages WHERE group_id = @group_id AND timestamp >= @from AND timestamp <= @to
  ORDER BY timestamp ASC
`);

const stmtKnownGroups = db.prepare(`
  SELECT group_id,
         MAX(group_name) AS group_name,
         COUNT(*) AS total_messages,
         MAX(timestamp) AS last_message_ts,
         SUM(CASE WHEN timestamp >= @todayStart THEN 1 ELSE 0 END) AS today_messages
  FROM messages GROUP BY group_id ORDER BY last_message_ts DESC
`);

const stmtRecentMessages = db.prepare(`
  SELECT author_name, author, body, msg_type, timestamp
  FROM messages WHERE group_id = @group_id
  ORDER BY timestamp DESC LIMIT @limit
`);

const stmtInsertReport = db.prepare(`
  INSERT INTO reports (group_id, group_name, report, message_count, window_label, period_start, period_end, model, trigger, scope, metrics_json, cluster_id)
  VALUES (@group_id, @group_name, @report, @message_count, @window_label, @period_start, @period_end, @model, @trigger, @scope, @metrics_json, @cluster_id)
`);
const stmtReportsForGroup = db.prepare(`
  SELECT id, group_name, report, message_count, window_label, period_start, period_end, model, trigger, created_at
  FROM reports WHERE group_id = @group_id ORDER BY created_at DESC LIMIT @limit
`);
const stmtDeleteMsgs    = db.prepare(`DELETE FROM messages WHERE group_id = @group_id`);
const stmtDeleteReports = db.prepare(`DELETE FROM reports  WHERE group_id = @group_id`);
const stmtPurgeMsgs     = db.prepare(`DELETE FROM messages WHERE timestamp  < @cutoff`);
const stmtPurgeReports  = db.prepare(`DELETE FROM reports  WHERE created_at < @cutoff`);

// Latest group report per group whose window falls inside [from, to].
const stmtGroupReportsForWindow = db.prepare(`
  SELECT id, group_id, group_name, report, metrics_json, message_count,
         window_label, period_start, period_end, created_at
  FROM reports
  WHERE scope = 'group' AND period_start >= @from AND period_end <= @to
  GROUP BY group_id HAVING MAX(created_at)
  ORDER BY group_name ASC
`);
const stmtMasterReports = db.prepare(`
  SELECT id, group_id, group_name, report, message_count, window_label,
         period_start, period_end, model, trigger, metrics_json, cluster_id, created_at
  FROM reports WHERE scope = 'master' AND cluster_id = @cluster_id
  ORDER BY created_at DESC LIMIT @limit
`);
const stmtReportsBeforeForGroup = db.prepare(`
  SELECT id, group_name, window_label, period_start, period_end, created_at
  FROM reports
  WHERE group_id = @group_id AND scope = 'group' AND period_end <= @beforeTs
  ORDER BY period_end DESC LIMIT @limit
`);
const stmtMasterReportsBefore = db.prepare(`
  SELECT id, group_name, window_label, period_start, period_end, created_at
  FROM reports
  WHERE scope = 'master' AND cluster_id = @cluster_id AND period_end <= @beforeTs
  ORDER BY period_end DESC LIMIT @limit
`);
const stmtGroupsWithActivity = db.prepare(`
  SELECT group_id, MAX(group_name) AS group_name, COUNT(*) AS message_count
  FROM messages WHERE timestamp >= @from AND timestamp <= @to
  GROUP BY group_id ORDER BY message_count DESC
`);

// --- clusters ---
const stmtListClusters   = db.prepare(`SELECT id, name, created_at FROM clusters ORDER BY name ASC`);
const stmtUpsertCluster  = db.prepare(`
  INSERT INTO clusters (id, name) VALUES (@id, @name)
  ON CONFLICT(id) DO UPDATE SET name = excluded.name
`);
const stmtAssignGroup = db.prepare(`
  INSERT INTO group_clusters (group_id, cluster_id, group_name, updated_at)
  VALUES (@group_id, @cluster_id, @group_name, strftime('%s','now'))
  ON CONFLICT(group_id) DO UPDATE SET
    cluster_id = excluded.cluster_id, group_name = excluded.group_name, updated_at = excluded.updated_at
`);
const stmtGroupsForCluster  = db.prepare(`SELECT group_id, group_name FROM group_clusters WHERE cluster_id = @cluster_id`);
const stmtClusterForGroup   = db.prepare(`SELECT cluster_id FROM group_clusters WHERE group_id = @group_id`);

// --- schedules ---
const stmtListSchedules  = db.prepare(`SELECT id, label, time_hhmm, window_mode, enabled, created_at FROM schedules ORDER BY time_hhmm ASC`);
const stmtCreateSchedule = db.prepare(`
  INSERT INTO schedules (label, time_hhmm, window_mode, enabled)
  VALUES (@label, @time_hhmm, @window_mode, @enabled)
`);
const stmtUpdateSchedule = db.prepare(`
  UPDATE schedules SET label = @label, time_hhmm = @time_hhmm, window_mode = @window_mode, enabled = @enabled
  WHERE id = @id
`);
const stmtDeleteSchedule = db.prepare(`DELETE FROM schedules WHERE id = @id`);

module.exports = {
  insertMessage(msg) { return stmtInsertMsg.run(msg).lastInsertRowid; },
  updateMessageBody(id, body) { stmtUpdateBody.run({ id, body }); },

  getMessagesInRange(groupId, from, to) {
    return stmtMessagesRange.all({ group_id: groupId, from, to });
  },
  getKnownGroups(todayStart) { return stmtKnownGroups.all({ todayStart }); },
  getRecentMessages(groupId, limit) { return stmtRecentMessages.all({ group_id: groupId, limit }); },

  insertReport(row) {
    return stmtInsertReport.run({ scope: 'group', metrics_json: null, cluster_id: null, ...row });
  },
  getReportsForGroup(groupId, limit) { return stmtReportsForGroup.all({ group_id: groupId, limit }); },
  getReportsByIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const clean = ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n));
    if (!clean.length) return [];
    const placeholders = clean.map(() => '?').join(',');
    return db.prepare(
      `SELECT id, group_id, group_name, report, window_label, metrics_json, cluster_id, period_start, period_end, created_at
       FROM reports WHERE id IN (${placeholders}) ORDER BY created_at ASC`
    ).all(...clean);
  },

  // --- master / cross-group ---
  getGroupReportsForWindow(from, to, groupIds) {
    const rows = stmtGroupReportsForWindow.all({ from, to });
    if (!Array.isArray(groupIds) || !groupIds.length) return rows;
    const set = new Set(groupIds);
    return rows.filter((r) => set.has(r.group_id));
  },
  getMasterReports(clusterId, limit) { return stmtMasterReports.all({ cluster_id: clusterId, limit }); },
  getReportsBeforeForGroup(groupId, beforeTs, limit) {
    return stmtReportsBeforeForGroup.all({ group_id: groupId, beforeTs, limit });
  },
  getMasterReportsBefore(clusterId, beforeTs, limit) {
    return stmtMasterReportsBefore.all({ cluster_id: clusterId, beforeTs, limit });
  },
  getGroupsWithActivity(from, to) { return stmtGroupsWithActivity.all({ from, to }); },

  // --- clusters ---
  listClusters() { return stmtListClusters.all(); },
  upsertCluster(id, name) { return stmtUpsertCluster.run({ id, name }); },
  assignGroup(groupId, clusterId, groupName) {
    return stmtAssignGroup.run({ group_id: groupId, cluster_id: clusterId, group_name: groupName || null });
  },
  getGroupsForCluster(clusterId) { return stmtGroupsForCluster.all({ cluster_id: clusterId }); },
  getClusterForGroup(groupId) {
    const row = stmtClusterForGroup.get({ group_id: groupId });
    return row ? row.cluster_id : 'all';
  },

  // --- schedules ---
  listSchedules() { return stmtListSchedules.all(); },
  createSchedule(row) {
    return stmtCreateSchedule.run({
      label: row.label || null, time_hhmm: row.time_hhmm,
      window_mode: row.window_mode || 'previous-day', enabled: row.enabled ? 1 : 0,
    });
  },
  updateSchedule(row) {
    return stmtUpdateSchedule.run({
      id: row.id, label: row.label || null, time_hhmm: row.time_hhmm,
      window_mode: row.window_mode || 'previous-day', enabled: row.enabled ? 1 : 0,
    });
  },
  deleteSchedule(id) { return stmtDeleteSchedule.run({ id }); },

  deleteGroup(groupId) {
    const m = stmtDeleteMsgs.run({ group_id: groupId });
    const r = stmtDeleteReports.run({ group_id: groupId });
    return { messages: m.changes, reports: r.changes };
  },

  purgeOld() {
    const now = Math.floor(Date.now() / 1000);
    stmtPurgeMsgs.run({ cutoff: now - config.retention.purgeMessagesAfterDays * 86400 });
    if (config.retention.purgeReportsAfterDays > 0) {
      stmtPurgeReports.run({ cutoff: now - config.retention.purgeReportsAfterDays * 86400 });
    }
  },

  close() { db.close(); },
};
