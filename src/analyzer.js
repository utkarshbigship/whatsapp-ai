const fs     = require('fs');
const config = require('../config');
const logger = require('./logger');
const db     = require('./db');

// Log one DeepSeek call's token usage + cost to the audit log. `meta` carries scope + group name.
function recordUsage(usage, meta) {
  if (!usage || !meta) return;
  try {
    const inTok  = usage.prompt_tokens || 0;
    const outTok = usage.completion_tokens || 0; // includes reasoning tokens (billed as output)
    const usd = (inTok / 1e6) * config.deepseek.priceInputPerM + (outTok / 1e6) * config.deepseek.priceOutputPerM;
    db.insertUsage({
      scope: meta.scope, group_id: meta.groupId || null, group_name: meta.groupName || null,
      model: config.deepseek.model, input_tokens: inTok, output_tokens: outTok,
      cost_usd: +usd.toFixed(6), cost_inr: +(usd * config.usdInr).toFixed(4), trigger: meta.trigger || null,
    });
  } catch (e) { logger.warn(`Usage log failed: ${e.message}`); }
}

let aiClient = null;
async function getClient() {
  if (!aiClient) {
    const OpenAI = require('openai'); // DeepSeek is OpenAI-compatible
    aiClient = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: config.deepseek.baseUrl,
      maxRetries: 0, // we run our own retry loop below; timing is handled per-request (streaming)
    });
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

  if (t.length > config.deepseek.maxTranscriptChars) {
    t = '...(earlier messages trimmed)...\n' + t.slice(-config.deepseek.maxTranscriptChars);
  }
  return t;
}

/**
 * Stream one DeepSeek call and return { text, usage, finishReason }. Uses ACTIVITY-based
 * timeouts (not a flat overall timeout): a generous wait for the first chunk (thinking can be
 * slow to start at max reasoning), a shorter idle window that resets on every subsequent chunk,
 * and a last-resort hard ceiling. This lets a genuinely slow-but-progressing 'max' reasoning call
 * run to completion instead of being killed mid-flight and restarted from scratch (which was
 * turning one slow call into several, compounding latency and cost).
 */
async function streamOnce(ai, payload) {
  const controller = new AbortController();
  let idleTimer = null;
  const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); };
  const armIdle = (ms) => { clearIdle(); idleTimer = setTimeout(() => controller.abort(), ms); };
  const hardTimer = setTimeout(() => controller.abort(), config.deepseek.hardTimeoutMs);

  try {
    armIdle(config.deepseek.firstByteTimeoutMs);
    const stream = await ai.chat.completions.create(
      { ...payload, stream: true, stream_options: { include_usage: true } },
      { signal: controller.signal },
    );

    let text = '';
    let usage = null;
    let finishReason = null;
    let gotChunk = false;
    for await (const chunk of stream) {
      gotChunk = true;
      armIdle(config.deepseek.idleTimeoutMs); // reset the idle window on every chunk received
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) text += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage; // final chunk (empty choices) carries usage
    }
    return { text: text.trim(), usage, finishReason };
  } catch (err) {
    if (controller.signal.aborted) {
      const err2 = new Error(`stream stalled (no data received in time)`);
      err2.isTimeout = true;
      throw err2;
    }
    throw err;
  } finally {
    clearIdle();
    clearTimeout(hardTimer);
  }
}

/**
 * Shared DeepSeek call with retry/backoff. Returns trimmed text or null.
 * Reasoning depth defaults to config.deepseek.reasoningEffort (max) for every report.
 */
async function generate({ systemInstruction, userContent, reasoningEffort, meta }) {
  const ai = await getClient();
  const payload = {
    model: config.deepseek.model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userContent },
    ],
    reasoning_effort: reasoningEffort || config.deepseek.reasoningEffort,
    max_tokens: config.deepseek.maxOutputTokens,
  };

  let lastErr;
  for (let attempt = 1; attempt <= config.deepseek.retries; attempt++) {
    try {
      const { text, usage, finishReason } = await streamOnce(ai, payload);
      // A 'length' finish means the model was cut off — the trailing JSON counts block is
      // likely missing, which silently zeroes all metrics. Surface it loudly.
      if (finishReason === 'length') {
        logger.warn(`DeepSeek output hit max_tokens (${config.deepseek.maxOutputTokens}) — report may be truncated; raise DEEPSEEK_MAX_TOKENS.`);
      }
      if (text) { recordUsage(usage, meta); return text; }
      lastErr = new Error('Empty response');
    } catch (err) {
      lastErr = err;
      logger.warn(`DeepSeek attempt ${attempt}/${config.deepseek.retries}: ${err.message}`);
    }
    if (attempt < config.deepseek.retries) await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  // Throw (don't return null) so callers can distinguish a generation FAILURE from an empty window.
  logger.error('DeepSeek generate failed:', lastErr?.message);
  throw new Error(`DeepSeek generation failed: ${lastErr?.message || 'unknown error'}`);
}

const METRIC_KEYS = [
  'raised', 'closed', 'verified_closed', 'claimed_closed_unconfirmed', 'promised_not_done', 'pending',
  'responded_meaningful', 'formality_only', 'missed',
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
async function analyze({ groupName, messages, windowLabel, priorReports = [], meta }) {
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

  return generate({ systemInstruction, userContent, meta });
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
async function analyzeMaster({ windowLabel, groupReports, priorMasterReports = [], meta }) {
  if (!groupReports || !groupReports.length) return null;
  const systemInstruction = loadPrompt(config.prompts.master);

  const blockFor = (g) =>
    `### GROUP id=${g.groupId} name="${g.groupName}"\n` +
    `(When citing this group, tag it EXACTLY as {{G:${g.groupId}|${g.groupName}}})\n` +
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
      try {
        const d = await generate({
          systemInstruction,
          userContent: masterUser(windowLabel, batches[i].join('\n'), [], note),
          meta,
        });
        if (d) digests.push(`### BATCH DIGEST ${i + 1}\n${d}`);
      } catch (e) {
        logger.warn(`Master batch ${i + 1}/${batches.length} failed, skipping its groups: ${e.message}`);
      }
    }
    // Guard: if digests themselves overflow, keep the highest-signal head under cap.
    combinedInput = digests.join('\n\n');
    if (combinedInput.length > cap) {
      logger.warn('Master digests still exceed cap; truncating to fit.');
      combinedInput = combinedInput.slice(0, cap);
    }
  }

  try {
    return await generate({
      systemInstruction,
      userContent: masterUser(windowLabel, combinedInput, priorMasterReports),
      meta,
    });
  } catch (e) {
    // Master is best-effort — a failure returns null so the batch completes gracefully.
    logger.error(`Master aggregate failed: ${e.message}`);
    return null;
  }
}

module.exports = { analyze, analyzeMaster, parseMetrics };
