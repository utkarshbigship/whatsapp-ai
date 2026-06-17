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
  app.use(express.json());
  app.use(session({
    secret: config.dashboard.sessionSecret,
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 12 * 3600 * 1000 },
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

  // serve static AFTER auth routes; login page handles gating client-side
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- data ----
  app.get('/api/groups', requireAuth, (req, res) => {
    try { res.json({ groups: db.getKnownGroups(tzTodayStart()) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/groups/:id/messages', requireAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
      res.json({ messages: db.getRecentMessages(req.params.id, limit) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/groups/:id/reports', requireAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
      res.json({ reports: db.getReportsForGroup(req.params.id, limit) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // analyse on demand. body: { groupName, fromDate?, toDate?, hours?, deliver? }
  app.post('/api/groups/:id/analyse', requireAuth, async (req, res) => {
    try {
      const groupId   = req.params.id;
      const groupName = req.body?.groupName || groupId;
      const window = {
        fromDate: req.body?.fromDate, toDate: req.body?.toDate, hours: req.body?.hours,
      };
      const contextReportIds = req.body?.contextReportIds || [];
      const result = await generateReport({ groupId, groupName, window, contextReportIds, trigger: 'dashboard' });
      if (!result) return res.status(422).json({ error: 'Not enough messages in that window.' });

      let delivered = false;
      if (req.body?.deliver && whatsapp.isReady()) {
        await whatsapp.sendText(config.recipient, formatForDelivery(groupName, result));
        delivered = true;
      }
      res.json({ ...result, delivered });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
      const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
      const reports = db.getMasterReports(clusterId, limit);
      // "New since" awareness tag for the latest master report.
      let newSince = null;
      if (reports.length) {
        const latest = reports[0];
        const groupIds = clusterId !== 'all' ? db.getGroupsForCluster(clusterId).map((g) => g.group_id) : null;
        newSince = db.countMessagesSince(latest.period_end, groupIds);
      }
      res.json({ reports, lock: runlock.status(clusterId), newSince });
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

  // Progress of the latest run for a cluster (drives the dashboard progress panel).
  app.get('/api/master/progress', requireAuth, (req, res) => {
    try {
      const clusterId = req.query.clusterId || 'all';
      const run = db.getLatestRun(clusterId) || db.getLatestRun(null);
      res.json({ run: run || null, lock: runlock.status(clusterId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Trigger the full pipeline (group reports -> master) asynchronously.
  // body: { clusterId?, fromDate?, toDate?, hours? }
  app.post('/api/master/analyse', requireAuth, (req, res) => {
    const clusterId = req.body?.clusterId || 'all';
    try {
      const lock = runlock.status(clusterId);
      if (lock.running) return res.status(202).json({ status: 'in_progress', startedAt: lock.startedAt });

      const { fromDate, toDate, hours } = req.body || {};
      // Date range / hours -> window; otherwise default to today-so-far snapshot (cutoff = now).
      const window = (fromDate && toDate) ? { fromDate, toDate } : (hours ? { hours } : { mode: 'today-so-far' });
      // Fire-and-forget; the dashboard polls /api/master/progress.
      orchestrator.runBatch({ clusterId, window, trigger: 'dashboard', smartReuse: true, withMaster: true })
        .catch((e) => logger.error('master runBatch:', e.message));
      res.json({ status: 'started' });
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

  app.listen(config.dashboard.port, () =>
    logger.info(`Dashboard on http://localhost:${config.dashboard.port} (login: ${config.dashboard.user})`));
}

module.exports = { start };
