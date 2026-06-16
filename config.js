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

  // Prompts (edit the .md files, no code change needed)
  prompts: {
    analyst: path.join(__dirname, 'prompts', 'escalation-analyst.md'),
    mediaExtract: path.join(__dirname, 'prompts', 'media-extract.md'),
  },

  // Analysis window
  analysis: {
    defaultWindowHours: 24,
    timezone: 'Asia/Kolkata',
    minMessages: 2,
  },

  // Media understanding (done at ingestion, folded into transcript)
  media: {
    enabled: true,
    types: ['image', 'video', 'audio', 'ptt', 'document', 'sticker'],
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
