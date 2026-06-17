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
function loadPrompt(file) {
  return fs.readFileSync(file || config.prompts.analyst, 'utf8');
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

/** Shared Gemini call with retry/backoff. Returns trimmed text or null. */
async function generate({ systemInstruction, userContent, thinkingLevel }) {
  const ai = await getClient();
  let lastErr;
  for (let attempt = 1; attempt <= config.gemini.retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: config.gemini.model,
        contents: userContent,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: thinkingLevel || config.gemini.thinkingLevel },
        },
      });
      const text = (response.text || '').trim();
      if (text) return text;
      lastErr = new Error('Empty response');
    } catch (err) {
      lastErr = err;
      logger.warn(`Gemini attempt ${attempt}/${config.gemini.retries}: ${err.message}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  logger.error('Gemini generate failed:', lastErr?.message);
  return null;
}

const METRIC_KEYS = [
  'raised', 'closed', 'pending', 'responded_meaningful', 'formality_only', 'missed',
  'high_panic', 'critical', 'abuse_legal', 'follow_ups_seller', 'staff_responses_to_followups',
  'first_mile', 'last_mile', 'avg_hours_to_close', 'avg_days_to_close',
  'best_case_count', 'worst_case_count',
];
const FLOAT_KEYS = new Set(['avg_hours_to_close', 'avg_days_to_close']);

/**
 * Extract the machine-readable counts block emitted by the group prompt.
 * Returns a normalised object of known keys, or null if not found / unparseable.
 */
function parseMetrics(text) {
  if (!text) return null;
  let candidate = null;
  // 1) Prefer the LAST ```json ... ``` fenced block (the prompt says it's last).
  const jsonFences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (jsonFences.length) candidate = jsonFences[jsonFences.length - 1][1];
  // 2) Any fenced block whose content references "raised".
  if (!candidate) {
    const any = [...text.matchAll(/```\s*([\s\S]*?)```/g)].map((m) => m[1])
      .filter((s) => /"raised"\s*:/.test(s));
    if (any.length) candidate = any[any.length - 1];
  }
  // 3) Last bare {...} containing "raised".
  if (!candidate) {
    const m = text.match(/\{[^{}]*"raised"[\s\S]*?\}/g);
    if (m) candidate = m[m.length - 1];
  }
  if (!candidate) return null;

  let obj;
  try { obj = JSON.parse(candidate.trim()); } catch { return null; }

  const out = {};
  for (const k of METRIC_KEYS) {
    const v = obj[k];
    if (FLOAT_KEYS.has(k)) out[k] = (v == null ? null : Number(v));
    else out[k] = Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0;
  }
  return out;
}

/**
 * Produce an escalation report for a group's messages.
 * @returns {Promise<string|null>}
 */
async function analyze({ groupName, messages, windowLabel, priorReports = [], thinkingLevel }) {
  if (!messages || messages.length < config.analysis.minMessages) return null;

  const systemInstruction = loadPrompt(config.prompts.analyst);
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

  return generate({ systemInstruction, userContent, thinkingLevel });
}

/** Build the master user message for one cluster's group reports (or batch digests). */
function masterUser(windowLabel, combinedInput, priorMasterReports = [], extraNote = '') {
  let priorBlock = '';
  if (priorMasterReports.length) {
    const joined = priorMasterReports.map((p) =>
      `--- Previous master report (${p.label}) ---\n${p.report}`).join('\n\n');
    priorBlock =
      `Previous master reports for cross-day context. Carry forward still-open cross-group ` +
      `issues and age them:\n"""\n${joined}\n"""\n\n`;
  }
  return (
    `Window: ${windowLabel}\n\n` +
    (extraNote ? extraNote + '\n\n' : '') +
    priorBlock +
    `Per-group reports:\n"""\n${combinedInput}\n"""`
  );
}

/**
 * Aggregate per-group reports into a master narrative for ONE cluster.
 * Numbers are NOT trusted from the model — totals are computed in reportEngine.
 * @param {object} opts
 * @param {string} opts.windowLabel
 * @param {Array}  opts.groupReports  [{groupId, groupName, report, metrics}]
 * @param {Array}  [opts.priorMasterReports]  [{label, report}]
 * @returns {Promise<string|null>}  prose only
 */
async function analyzeMaster({ windowLabel, groupReports, priorMasterReports = [] }) {
  if (!groupReports || !groupReports.length) return null;
  const systemInstruction = loadPrompt(config.prompts.master);

  const blockFor = (g) =>
    `### GROUP id=${g.groupId} name="${g.groupName}"\n` +
    `(When citing this group, tag it EXACTLY as {{G:${g.groupId}}}${g.groupName})\n` +
    `${g.report}\n`;

  const blocks = groupReports.map(blockFor);
  const totalChars = blocks.reduce((n, b) => n + b.length, 0);
  const cap = config.master.batchChars;

  let combinedInput;
  if (totalChars <= cap) {
    combinedInput = blocks.join('\n');
  } else {
    // MAP: split into batches under the cap, digest each one.
    let batches = [];
    let cur = [], curLen = 0;
    for (const b of blocks) {
      if (curLen + b.length > cap && cur.length) { batches.push(cur); cur = []; curLen = 0; }
      cur.push(b); curLen += b.length;
    }
    if (cur.length) batches.push(cur);

    let digests = [];
    for (let i = 0; i < batches.length; i++) {
      const note = `BATCH ${i + 1}/${batches.length} — produce a partial digest. PRESERVE every {{G:...}} token verbatim.`;
      const d = await generate({
        systemInstruction,
        userContent: masterUser(windowLabel, batches[i].join('\n'), [], note),
      });
      if (d) digests.push(`### BATCH DIGEST ${i + 1}\n${d}`);
    }
    // Guard: if digests themselves overflow, keep the highest-signal head under cap.
    combinedInput = digests.join('\n\n');
    if (combinedInput.length > cap) {
      logger.warn('Master digests still exceed cap; truncating to fit.');
      combinedInput = combinedInput.slice(0, cap);
    }
  }

  return generate({
    systemInstruction,
    userContent: masterUser(windowLabel, combinedInput, priorMasterReports),
  });
}

module.exports = { analyze, analyzeMaster, parseMetrics };
