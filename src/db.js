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
`);

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
  INSERT INTO reports (group_id, group_name, report, message_count, window_label, period_start, period_end, model, trigger)
  VALUES (@group_id, @group_name, @report, @message_count, @window_label, @period_start, @period_end, @model, @trigger)
`);
const stmtReportsForGroup = db.prepare(`
  SELECT id, group_name, report, message_count, window_label, period_start, period_end, model, trigger, created_at
  FROM reports WHERE group_id = @group_id ORDER BY created_at DESC LIMIT @limit
`);
const stmtDeleteMsgs    = db.prepare(`DELETE FROM messages WHERE group_id = @group_id`);
const stmtDeleteReports = db.prepare(`DELETE FROM reports  WHERE group_id = @group_id`);
const stmtPurgeMsgs     = db.prepare(`DELETE FROM messages WHERE timestamp  < @cutoff`);
const stmtPurgeReports  = db.prepare(`DELETE FROM reports  WHERE created_at < @cutoff`);

module.exports = {
  insertMessage(msg) { return stmtInsertMsg.run(msg).lastInsertRowid; },
  updateMessageBody(id, body) { stmtUpdateBody.run({ id, body }); },

  getMessagesInRange(groupId, from, to) {
    return stmtMessagesRange.all({ group_id: groupId, from, to });
  },
  getKnownGroups(todayStart) { return stmtKnownGroups.all({ todayStart }); },
  getRecentMessages(groupId, limit) { return stmtRecentMessages.all({ group_id: groupId, limit }); },

  insertReport(row) { return stmtInsertReport.run(row); },
  getReportsForGroup(groupId, limit) { return stmtReportsForGroup.all({ group_id: groupId, limit }); },
  getReportsByIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const clean = ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n));
    if (!clean.length) return [];
    const placeholders = clean.map(() => '?').join(',');
    return db.prepare(
      `SELECT id, group_name, report, window_label, created_at
       FROM reports WHERE id IN (${placeholders}) ORDER BY created_at ASC`
    ).all(...clean);
  },

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
