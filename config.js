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

  // Gemini — now used ONLY for media conversion (image/voice/pdf → text). Cheap & sufficient.
  gemini: {
    mediaModel: process.env.GEMINI_MEDIA_MODEL || 'gemini-3.1-flash-lite',
    retries: 3,
  },

  // DeepSeek — drives the escalation reasoning (group + master reports). OpenAI-compatible API.
  deepseek: {
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
    // Reasoning depth. Native values: high | max. 'high' is strong for extraction while leaving
    // budget for the full report — 'max' spends almost the whole token budget on hidden reasoning,
    // truncating the output (blank metrics) and taking ~10min. Use 'max' only if you accept that.
    reasoningEffort: process.env.DEEPSEEK_REASONING || 'high',
    // Output cap. Reasoning tokens share this budget, and a full table + AWB journeys + JSON can be
    // long. Too low = report truncated before the JSON block, which zeroes all metrics.
    maxOutputTokens: parseInt(process.env.DEEPSEEK_MAX_TOKENS || '40000', 10),
    // Per-request timeout (ms). Prevents the SDK's 10-min default from hanging a job.
    timeoutMs: parseInt(process.env.DEEPSEEK_TIMEOUT_MS || '150000', 10),
    // Transcript cap (chars). DeepSeek V4 has a 1M-token context; this keeps input bounded.
    maxTranscriptChars: parseInt(process.env.DEEPSEEK_MAX_TRANSCRIPT_CHARS || '600000', 10),
    retries: 3,
  },

  // Multi-agent run settings
  agents: {
    // How many group-agent report calls run in parallel during a scheduled/master run.
    // Tune to your provider's rate limit — raise it as your quota allows.
    groupConcurrency: parseInt(process.env.GROUP_AGENT_CONCURRENCY || '4', 10),
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
    host: process.env.DASHBOARD_HOST || '127.0.0.1', // bind localhost; expose via nginx
    port: parseInt(process.env.DASHBOARD_PORT || '8080', 10),
    user: process.env.DASH_USER || 'admin',
    pass: process.env.DASH_PASS || 'change-me',
    sessionSecret: process.env.DASH_SECRET || 'dev-secret-change-me',
    cookieSecure: process.env.COOKIE_SECURE === 'true', // set true once HTTPS is live
  },

  retention: {
    purgeMessagesAfterDays: 30, // raw messages are transient
    purgeReportsAfterDays: 0,   // 0 = keep reports forever (the durable artifact)
  },

  whatsapp: {
    reconnectDelaySeconds: 30,
    // On (re)connect, pull this many recent messages per group to recover any gap
    // created by a restart/disconnect. 0 disables backfill.
    backfillLimit: parseInt(process.env.WA_BACKFILL_LIMIT || '50', 10),
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};
