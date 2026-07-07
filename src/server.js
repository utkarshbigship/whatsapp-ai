const express = require('express');
const session = require('express-session');
const path    = require('path');
const config  = require('../config');
const logger  = require('./logger');
const db      = require('./db');
const whatsapp = require('./whatsapp');
const runlock  = require('./runlock');
const scheduler = require('./scheduler');
const orchestrator = require('./orchestrator');
const { generateReport, formatForDelivery } = require('./reportEngine');

function tzTodayStart() {
  const local = new Date(new Date().toLocaleString('en-US', { timeZone: config.analysis.timezone }));
  local.setHours(0, 0, 0, 0);
  return Math.floor(local.getTime() / 1000);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  res.status(401).json({ error: 'Not logged in' });
}

function start() {
  if (!config.dashboard.enabled) { logger.info('Dashboard disabled.'); return; }
  const app = express();
  app.set('trust proxy', 1); // honour X-Forwarded-Proto from nginx for secure cookies
  app.use(express.json());

  // SQLite-backed sessions so logins survive restarts (the default MemoryStore leaks and
  // logs everyone out on every restart).
  const SqliteStore = require('better-sqlite3-session-store')(session);
  const Database = require('better-sqlite3');
  const sessionDb = new Database(path.join(__dirname, '..', 'data', 'sessions.db'));
  app.use(session({
    store: new SqliteStore({ client: sessionDb, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
    secret: config.dashboard.sessionSecret,
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.dashboard.cookieSecure, maxAge: 12 * 3600 * 1000 },
  }));

  // ---- auth ----
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === config.dashboard.user && password === config.dashboard.pass) {
      req.session.authed = true;
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Invalid credentials' });
  });
  app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
  app.get('/api/me', (req, res) => res.json({ authed: !!(req.session && req.session.authed) }));

  // serve static AFTER auth routes; login page handles gating client-side.
  // index.html must never be cached — it's what decides which JS/CSS the browser loads, so a
  // stale cached copy would silently hide new features after a deploy (e.g. a new nav tab).
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    },
  }));

  // ---- data ----
  app.get('/api/groups', requireAuth, (req, res) => {
    try {
      const groups = db.getKnownGroups(tzTodayStart());
      // Include groups that have reports but no recent messages (e.g. after a long
      // disconnect or message purge) so their reports stay reachable in the dashboard.
      const seen = new Set(groups.map((g) => g.group_id));
      for (const r of db.getGroupsWithReports()) {
        if (!seen.has(r.group_id)) {
          groups.push({ group_id: r.group_id, group_name: r.group_name,
            total_messages: 0, today_messages: 0, last_message_ts: r.last_report_at });
        }
      }
      res.json({ groups });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/groups/:id/messages', requireAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
      res.json({ messages: db.getRecentMessages(req.params.id, limit) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/groups/:id/reports', requireAuth, (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days || '7', 10), 90);
      res.json({ reports: db.getReportsForGroup(req.params.id, { days }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // On-demand analysis runs in the BACKGROUND (a synchronous request would 504 on a slow model).
  // The dashboard polls /analyse/status. Terminal entries self-clean after a TTL.
  const analyseJobs = new Map(); // groupId -> { status:'running'|'done'|'empty'|'error', ... }
  const JOB_TTL_MS = 10 * 60 * 1000;
  function finishJob(groupId, payload) {
    analyseJobs.set(groupId, { ...payload, finishedAt: Date.now() });
    const t = setTimeout(() => {
      const j = analyseJobs.get(groupId);
      if (j && j.status !== 'running') analyseJobs.delete(groupId);
    }, JOB_TTL_MS);
    if (t.unref) t.unref();
  }

  // analyse on demand. body: { groupName, fromDate?, toDate?, hours?, deliver?, contextReportIds? }
  app.post('/api/groups/:id/analyse', requireAuth, (req, res) => {
    const groupId = req.params.id;
    const running = analyseJobs.get(groupId);
    if (running && running.status === 'running') {
      return res.status(202).json({ status: 'in_progress', startedAt: running.startedAt });
    }
    const groupName = req.body?.groupName || groupId;
    const window = { fromDate: req.body?.fromDate, toDate: req.body?.toDate, hours: req.body?.hours };
    const contextReportIds = req.body?.contextReportIds || [];
    const deliver = !!req.body?.deliver;

    analyseJobs.set(groupId, { status: 'running', startedAt: Date.now() });
    res.json({ status: 'started' });

    // Fire-and-forget; the report is saved to the DB on completion regardless of the HTTP request.
    (async () => {
      try {
        // generateReport returns null ONLY for a too-empty window; a model failure throws.
        const result = await generateReport({ groupId, groupName, window, contextReportIds, trigger: 'dashboard' });
        if (!result) { finishJob(groupId, { status: 'empty' }); return; }
        let delivered = false;
        if (deliver && whatsapp.isReady()) {
          try { await whatsapp.sendText(config.recipient, formatForDelivery(groupName, result)); delivered = true; }
          catch (e) { logger.warn(`WhatsApp delivery failed for ${groupName}: ${e.message}`); }
        }
        finishJob(groupId, { status: 'done', delivered });
      } catch (e) {
        logger.error(`analyse ${groupName}: ${e.message}`);
        finishJob(groupId, { status: 'error', error: e.message });
      }
    })();
  });

  // Poll the status of the background analysis for a group.
  app.get('/api/groups/:id/analyse/status', requireAuth, (req, res) => {
    res.json(analyseJobs.get(req.params.id) || { status: 'idle' });
  });

  app.delete('/api/groups/:id', requireAuth, (req, res) => {
    try { res.json(db.deleteGroup(req.params.id)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/groups/:id/context-suggestions', requireAuth, (req, res) => {
    try {
      const beforeTs = parseInt(req.query.beforeTs || '0', 10);
      const limit = Math.min(parseInt(req.query.limit || '2', 10), 5);
      res.json({ suggestions: db.getReportsBeforeForGroup(req.params.id, beforeTs, limit) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- master (cross-group) ----
  app.get('/api/master/reports', requireAuth, (req, res) => {
    try {
      const clusterId = req.query.clusterId || 'all';
      const days = Math.min(parseInt(req.query.days || '7', 10), 90);
      const reports = db.getMasterReports(clusterId, { days });
      // "New since" awareness tag for the latest master report.
      let newSince = null;
      if (reports.length) {
        const latest = reports[0];
        const groupIds = clusterId !== 'all' ? db.getGroupsForCluster(clusterId).map((g) => g.group_id) : null;
        newSince = db.countMessagesSince(latest.period_end, groupIds);
      }
      res.json({ reports, lock: runlock.anyBatchRunning(), newSince });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/master/context-suggestions', requireAuth, (req, res) => {
    try {
      const clusterId = req.query.clusterId || 'all';
      const beforeTs = parseInt(req.query.beforeTs || '0', 10);
      const limit = Math.min(parseInt(req.query.limit || '2', 10), 5);
      res.json({ suggestions: db.getMasterReportsBefore(clusterId, beforeTs, limit) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Progress of a specific run (by id) — or the latest run for a cluster as a fallback.
  app.get('/api/master/progress', requireAuth, (req, res) => {
    try {
      const runId = req.query.runId ? parseInt(req.query.runId, 10) : null;
      const clusterId = req.query.clusterId || 'all';
      const run = runId ? db.getRun(runId) : (db.getLatestRun(clusterId) || db.getLatestRun(null));
      res.json({ run: run || null, lock: runlock.anyBatchRunning() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Trigger the full pipeline (group reports -> master). startBatch creates the run synchronously
  // and returns its id so the dashboard polls THIS exact run (never a stale "latest" one). Setup
  // errors throw here and surface to the user instead of failing silently.
  // body: { clusterId?, fromDate?, toDate?, hours?, contextReportIds? }
  app.post('/api/master/analyse', requireAuth, (req, res) => {
    const clusterId = req.body?.clusterId || 'all';
    try {
      const { fromDate, toDate, hours } = req.body || {};
      const contextReportIds = req.body?.contextReportIds || [];
      // Date range / hours -> window; otherwise default to today-so-far snapshot (cutoff = now).
      const window = (fromDate && toDate) ? { fromDate, toDate } : (hours ? { hours } : { mode: 'today-so-far' });
      const { runId, alreadyRunning } = orchestrator.startBatch({
        clusterId, window, trigger: 'dashboard', smartReuse: true, withMaster: true, contextReportIds,
      });
      res.json({ runId, status: alreadyRunning ? 'in_progress' : 'started' });
    } catch (e) { logger.error('master analyse:', e.message); res.status(500).json({ error: e.message }); }
  });

  // ---- usage / cost audit ----
  app.get('/api/usage', requireAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
      const now = Math.floor(Date.now() / 1000);
      res.json({
        log: db.getUsageLog(limit),
        total: db.getUsageSummary(0),
        last24h: db.getUsageSummary(now - 86400),
        today: db.getUsageSummary(tzTodayStart()),
        rate: config.usdInr,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- clusters ----
  app.get('/api/clusters', requireAuth, (req, res) => {
    try { res.json({ clusters: db.listClusters() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/clusters', requireAuth, (req, res) => {
    try {
      const { id, name } = req.body || {};
      if (!id || !name) return res.status(400).json({ error: 'id and name required' });
      db.upsertCluster(String(id).trim(), String(name).trim());
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/clusters/:id/groups', requireAuth, (req, res) => {
    try { res.json({ groups: db.getGroupsForCluster(req.params.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/groups/:id/cluster', requireAuth, (req, res) => {
    try {
      const { clusterId, groupName } = req.body || {};
      if (!clusterId) return res.status(400).json({ error: 'clusterId required' });
      db.assignGroup(req.params.id, clusterId, groupName);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---- schedules ----
  app.get('/api/schedules', requireAuth, (req, res) => {
    try { res.json({ schedules: db.listSchedules() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/schedules', requireAuth, (req, res) => {
    try {
      const { time_hhmm } = req.body || {};
      if (!/^\d{1,2}:\d{2}$/.test(time_hhmm || '')) return res.status(400).json({ error: 'time_hhmm must be "HH:MM"' });
      db.createSchedule(req.body);
      scheduler.reload();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.put('/api/schedules/:id', requireAuth, (req, res) => {
    try {
      db.updateSchedule({ ...req.body, id: parseInt(req.params.id, 10) });
      scheduler.reload();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/schedules/:id', requireAuth, (req, res) => {
    try {
      db.deleteSchedule(parseInt(req.params.id, 10));
      scheduler.reload();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.listen(config.dashboard.port, config.dashboard.host, () =>
    logger.info(`Dashboard on http://${config.dashboard.host}:${config.dashboard.port} (login: ${config.dashboard.user})`));
}

module.exports = { start };
