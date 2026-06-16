const fs     = require('fs');
const config = require('../config');
const logger = require('./logger');

let aiClient = null;
async function getClient() {
  if (!aiClient) {
    const { GoogleGenAI } = await import('@google/genai');
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return aiClient;
}

// Prompt is loaded fresh each run so edits to the .md take effect immediately.
function loadPrompt() {
  return fs.readFileSync(config.prompts.analyst, 'utf8');
}

function buildTranscript(messages) {
  let t = messages.map((m) => {
    const who  = m.author_name || m.author || 'Unknown';
    const time = new Date(m.timestamp * 1000).toLocaleString('en-IN', {
      timeZone: config.analysis.timezone,
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    const text = m.body && m.body.trim() ? m.body : `[${m.msg_type}]`;
    return `[${time}] ${who}: ${text}`;
  }).join('\n');

  if (t.length > config.gemini.maxTranscriptChars) {
    t = '...(earlier messages trimmed)...\n' + t.slice(-config.gemini.maxTranscriptChars);
  }
  return t;
}

/**
 * Produce an escalation report for a group's messages.
 * @param {object} opts
 * @param {string} opts.groupName
 * @param {Array}  opts.messages
 * @param {string} opts.windowLabel
 * @param {Array}  [opts.priorReports]  [{label, report}] earlier reports for context
 * @returns {Promise<string|null>}
 */
async function analyze({ groupName, messages, windowLabel, priorReports = [] }) {
  if (!messages || messages.length < config.analysis.minMessages) return null;

  const ai = await getClient();
  const systemInstruction = loadPrompt();
  const transcript = buildTranscript(messages);

  let priorBlock = '';
  if (priorReports.length) {
    const joined = priorReports.map((p) =>
      `--- Previous report (${p.label}) ---\n${p.report}`).join('\n\n');
    priorBlock =
      `Previous reports provided for context. Use them to carry forward escalations ` +
      `that were still open, avoid re-counting ones already closed, and note anything ` +
      `from before that is STILL unresolved:\n"""\n${joined}\n"""\n\n`;
  }

  const userContent =
    `Group: ${groupName}\n` +
    `Window: ${windowLabel}\n` +
    `Total messages in window: ${messages.length}\n\n` +
    priorBlock +
    `Transcript:\n"""\n${transcript}\n"""`;

  let lastErr;
  for (let attempt = 1; attempt <= config.gemini.retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: config.gemini.model,
        contents: userContent,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: config.gemini.thinkingLevel },
        },
      });
      const text = (response.text || '').trim();
      if (text) return text;
      lastErr = new Error('Empty response');
    } catch (err) {
      lastErr = err;
      logger.warn(`Analyze attempt ${attempt}/${config.gemini.retries}: ${err.message}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  logger.error(`Analysis failed for "${groupName}":`, lastErr?.message);
  return null;
}

module.exports = { analyze };
