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

function loadPrompt() {
  return fs.readFileSync(config.prompts.mediaExtract, 'utf8');
}

// Spreadsheet detection + local extraction (.csv / .xlsx / .xls) — cheaper and far more
// accurate than sending a sheet through the vision model.
function isSpreadsheet(media) {
  const mt = (media.mimetype || '').toLowerCase();
  const fn = (media.filename || '').toLowerCase();
  return mt.includes('csv') || mt.includes('spreadsheet') || mt.includes('ms-excel') ||
         /\.(csv|xlsx|xls)$/.test(fn);
}

function parseSpreadsheet(media) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(Buffer.from(media.data, 'base64'), { type: 'buffer' });
  const parts = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]).trim();
    if (csv) parts.push(wb.SheetNames.length > 1 ? `# Sheet: ${name}\n${csv}` : csv);
  }
  let text = parts.join('\n\n');
  const max = config.media.spreadsheetMaxChars || 20000;
  if (text.length > max) text = text.slice(0, max) + '\n…[truncated]';
  return text;
}

/**
 * Understand a downloaded WhatsApp media object via Gemini multimodal.
 * @param {{mimetype:string,data:string,filename?:string}} media  base64 data
 * @param {string} type  msg.type (image|video|audio|ptt|document|sticker)
 * @returns {Promise<string>}  one-line description for the transcript
 */
async function understand(media, type) {
  try {
    if (!media || !media.data) return `[${type}: media unavailable]`;

    const bytes = Buffer.byteLength(media.data, 'base64');
    if (bytes > config.media.maxBytes) {
      return `[${type}: too large to analyse (${Math.round(bytes / 1048576)}MB)]`;
    }

    // Spreadsheets: extract tabular text locally and fold it into the transcript.
    if (type === 'document' && isSpreadsheet(media)) {
      try {
        const text = parseSpreadsheet(media);
        const name = media.filename ? ` ${media.filename}` : '';
        return text ? `[spreadsheet${name}]\n${text}` : `[spreadsheet${name}: empty]`;
      } catch (e) {
        logger.warn(`Spreadsheet parse failed (${media.filename || ''}): ${e.message}`);
        // fall through to the multimodal path
      }
    }

    // Normalise voice-note mimetype for Gemini.
    let mimeType = media.mimetype || 'application/octet-stream';
    if (type === 'ptt' && mimeType.startsWith('audio')) mimeType = 'audio/ogg';

    const ai = await getClient();
    const response = await ai.models.generateContent({
      model: config.gemini.model,
      contents: [
        { inlineData: { mimeType, data: media.data } },
        { text: `Media type: ${type}. Describe per instructions.` },
      ],
      config: {
        systemInstruction: loadPrompt(),
        thinkingConfig: { thinkingLevel: 'low' }, // media extraction is simple
      },
    });

    const text = (response.text || '').trim();
    const label = type === 'ptt' ? 'voice note' : type;
    return text ? `[${label}] ${text}` : `[${label}: no content extracted]`;
  } catch (err) {
    logger.warn(`Media understand failed (${type}): ${err.message}`);
    return `[${type}: analysis failed]`;
  }
}

module.exports = { understand };
