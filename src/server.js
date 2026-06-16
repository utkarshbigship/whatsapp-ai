const express = require('express');
const session = require('express-session');
const path    = require('path');
const config  = require('../config');
const logger  = require('./logger');
const db      = require('./db');
const whatsapp = require('./whatsapp');
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

  app.listen(config.dashboard.port, () =>
    logger.info(`Dashboard on http://localhost:${config.dashboard.port} (login: ${config.dashboard.user})`));
}

module.exports = { start };
