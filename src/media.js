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
