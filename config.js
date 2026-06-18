require('dotenv').config();
const path = require('path');

module.exports = {
  groups: {
    mode: 'all', // 'whitelist' | 'all'
    list: [
      // 'Team BigShip',
      // '120363012345678901@g.us',
    ],
  },

  recipient: process.env.RECIPIENT_NUMBER,

  // Gemini — model + thinking are env-driven, change anytime
  gemini: {
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    thinkingLevel: process.env.GEMINI_THINKING || 'high', // minimal|low|medium|high
    retries: 3,
    maxTranscriptChars: 800000,
  },

  // Multi-agent run settings
  agents: {
    // How many group-agent Gemini calls run in parallel during a scheduled/master run.
    // Tune to your Gemini tier's rate limit — raise it as your quota allows.
    groupConcurrency: parseInt(process.env.GROUP_AGENT_CONCURRENCY || '4', 10),
    // Thinking level used for scheduled group reports (cheaper than the on-demand default).
    scheduledThinkingLevel: process.env.GROUP_THINKING || 'medium',
  },

  // Master (cross-group) aggregation
  master: {
    groupIdPrefix: '__master__',  // master report group_id = `__master__:<clusterId>`
    batchChars: 600000,           // per-batch cap for map-reduce (below gemini.maxTranscriptChars)
  },

  // Prompts (edit the .md files, no code change needed)
  prompts: {
    analyst: path.join(__dirname, 'prompts', 'escalation-analyst.md'),
    master: path.join(__dirname, 'prompts', 'master-analyst.md'),
    mediaExtract: path.join(__dirname, 'prompts', 'media-extract.md'),
  },

  // Scheduler — run times are stored in the DB (managed from the dashboard), not here.
  scheduler: {
    enabled: process.env.SCHEDULER_ENABLED !== 'false',
    timezone: 'Asia/Kolkata',
  },

  // Analysis window
  analysis: {
    defaultWindowHours: 24,
    timezone: 'Asia/Kolkata',
    minMessages: 1,
  },

  // Media understanding (done at ingestion, folded into transcript)
  media: {
    enabled: true,
    types: ['image', 'video', 'audio', 'ptt', 'document', 'sticker'],
    spreadsheetMaxChars: 20000, // cap on extracted .csv/.xlsx text folded into the transcript
    maxBytes: 18 * 1024 * 1024,
    storeDir: path.join(__dirname, 'data', 'media'),
  },

  // On-demand command inside a group
  command: {
    enabled: true,
    trigger: '!analyse',
    ownerOnly: true,
    ownerNumber: process.env.RECIPIENT_NUMBER,
    deliverTo: 'dm',
  },

  dashboard: {
    enabled: true,
    port: parseInt(process.env.DASHBOARD_PORT || '8080', 10),
    user: process.env.DASH_USER || 'admin',
    pass: process.env.DASH_PASS || 'change-me',
    sessionSecret: process.env.DASH_SECRET || 'dev-secret-change-me',
  },

  retention: {
    purgeMessagesAfterDays: 30, // raw messages are transient
    purgeReportsAfterDays: 0,   // 0 = keep reports forever (the durable artifact)
  },

  whatsapp: { reconnectDelaySeconds: 30 },

  logLevel: process.env.LOG_LEVEL || 'info',
};
