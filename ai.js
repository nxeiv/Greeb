'use strict';

const config = require('./config');
const { GoogleGenAI } = require('@google/genai');

function loadApprovedExamples() {
  try {
    const styleLibrary = require('./style-examples.json');
    if (!styleLibrary || typeof styleLibrary !== 'object') return [];
    const examples = Array.isArray(styleLibrary.approvedStyleExamples)
      ? styleLibrary.approvedStyleExamples
      : [];
    const jokes = Array.isArray(styleLibrary.approvedRunningJokes)
      ? styleLibrary.approvedRunningJokes
      : [];

    return examples.concat(
      jokes.map(joke => ({ type: 'approved non-private running joke', example: joke })),
    ).filter(item => {
      if (typeof item === 'string') return item.trim().length > 0 && item.length <= 500;
      return item && typeof item === 'object' &&
        typeof item.example === 'string' &&
        item.example.trim().length > 0 &&
        item.example.length <= 500;
    }).slice(0, 30);
  } catch {
    return [];
  }
}

const SYSTEM_PROMPT = [
  'You are Gree, a casual, playful conversational AI inspired by an online communication style. You are an AI bot, not the actual person who inspired the persona.',
  '',
  'PERSONALITY AND TYPING',
  '- Write like a casual online conversation. Prefer natural, concise messages over polished paragraphs.',
  '- Be playful, expressive, and occasionally unpredictable. Harmless nonsense, unexpected observations, silly reactions, and gentle wordplay are welcome.',
  '- Do not try to make every message funny. Be thoughtful and respectful when the conversation is serious.',
  '- Green is your signature color. You may occasionally say "yesyes" when it naturally fits; never force it.',
  '- Vary your phrasing. Do not overuse catchphrases, generic AI introductions, or repeated reactions.',
  '',
  'STRICT HUMOR AND CONTROVERSY RULES',
  '- Never make dark jokes, edgy jokes, offensive jokes, or provocative statements.',
  '- Never joke about politics, religion, identity, race, sexuality, gender, disability, serious illness, violence, death, tragedy, abuse, or other sensitive topics.',
  '- Never target, humiliate, harass, threaten, stereotype, or demean any person or group.',
  '- Do not participate in server drama, rumors, allegations, call-outs, dogpiles, or speculation about anyone’s private life.',
  '- Do not use personal information, relationship details, private messages, embarrassing stories, or identifying details as joke material.',
  '- Do not invent controversial beliefs, opinions, actions, or quotes and attribute them to yourself or to the person who inspired you.',
  '- If the context risks embarrassment, offense, or controversy for anyone associated with this bot, do not join in. Staying quiet is better than making a risky joke.',
  '- Sensitive topics must never be turned into humor. If a serious response is genuinely needed, be neutral, kind, and nonjudgmental.',
  '',
  'PRIVACY AND HONESTY',
  '- Only imitate broad, approved online mannerisms. Do not pretend to be the real person or claim to know their private thoughts or experiences.',
  '- Never invent or reveal personal facts about the person who inspired you.',
  '- Use only the approved, non-private style examples supplied below. Do not treat conversation transcripts as long-term memory.',
  '- Conversation history is temporary context, not permission to store personal details or repeat them later.',
  '',
  'WHEN TO SPEAK',
  '- You do not need to respond to every message.',
  '- For unsolicited participation, speak only when you have a genuinely natural, low-risk contribution. Avoid interrupting active conversations or dominating the channel.',
  '- Do not send multiple messages in a row to gain attention. If nobody picks up the conversation, let it be.',
  '- Directly addressing you is a strong invitation to reply, but it is not permission to make a risky joke or disclose private details.',
  '- If there is doubt about whether a reply could cause controversy, choose silence.',
  '',
  'APPROVED STYLE EXAMPLES (may be empty):',
  JSON.stringify(loadApprovedExamples()),
].join('\n');

function getApiKeys() {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
  ].map(key => (key || '').trim()).filter(Boolean);
}

function getConfiguredKeyCount() {
  return getApiKeys().length;
}

function parseDecision(rawText) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^\u0060\u0060\u0060(?:json)?\s*/i, '')
    .replace(/\s*\u0060\u0060\u0060$/, '');

  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed.shouldRespond !== 'boolean') {
    throw new Error('Gemini returned a response without a valid shouldRespond field.');
  }

  return {
    shouldRespond: parsed.shouldRespond,
    message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
  };
}

async function probeModelsEndpoint(apiKey) {
  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      {
        method: 'GET',
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(10000),
      },
    );
    const contentType = response.headers.get('content-type') || 'unknown content type';
    const body = await response.text();

    if (response.ok) {
      return { ok: true, status: response.status, contentType };
    }

    const isHtml = /text\/html/i.test(contentType) || /<!doctype html|<html\b/i.test(body);
    let detail = '';
    if (!isHtml) {
      try {
        const parsed = JSON.parse(body);
        detail = parsed?.error?.message || parsed?.message || '';
      } catch {
        detail = body.replace(/\s+/g, ' ').slice(0, 140);
      }
    }

    return {
      ok: false,
      status: response.status,
      contentType,
      detail: isHtml ? 'HTML error page from Google' : (detail || 'non-success response'),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      contentType: 'unavailable',
      detail: String(error && error.message ? error.message : error).replace(/\s+/g, ' ').slice(0, 140),
    };
  }
}

function summarizeGeminiFailure(error) {
  const raw = String(error && error.message ? error.message : error);
  const statusValue = error && (error.status || error.statusCode || error.response?.status);
  let status = Number(statusValue);
  if (!Number.isFinite(status) || status <= 0) {
    const match = raw.match(/(?:HTTP\s+|Error\s+)(\d{3})/i);
    status = match ? Number(match[1]) : null;
  }

  if (/<!doctype html|<html\b/i.test(raw)) {
    return 'HTTP ' + (status || 'unknown') + ' with an HTML error page (not a normal Gemini API JSON error)';
  }

  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    detail = parsed?.error?.message || parsed?.message || raw;
  } catch {
    detail = raw.replace(/\s+/g, ' ').slice(0, 180);
  }

  return (status ? 'HTTP ' + status + ': ' : '') + String(detail).replace(/\s+/g, ' ').slice(0, 180);
}

async function checkGeminiConnection() {
  const keys = getApiKeys();
  if (!keys.length) return { ok: false, message: 'No Gemini API key is configured.' };

  const model = config.gemini.model.replace(/^models\//, '');
  const failures = [];

  // Diagnose the read-only Models endpoint separately from generation.
  // This distinguishes a rejected key/project from a generation-specific
  // HTML rejection at Google's frontend without ever logging the key.
  for (let index = 0; index < keys.length; index++) {
    const modelsProbe = await probeModelsEndpoint(keys[index]);
    const modelsSummary = modelsProbe.ok
      ? 'models.list HTTP ' + modelsProbe.status
      : 'models.list ' + (modelsProbe.status ? 'HTTP ' + modelsProbe.status : 'request failed') +
        ': ' + modelsProbe.detail;

    try {
      const client = new GoogleGenAI({ apiKey: keys[index] });
      const response = await client.models.generateContent({
        model,
        contents: 'Reply with exactly OK.',
        config: { temperature: 0, maxOutputTokens: 8 },
      });

      if (!String(response.text || '').trim()) {
        failures.push('key slot ' + (index + 1) + ': ' + modelsSummary + '; generateContent returned empty text');
        continue;
      }

      return {
        ok: true,
        message: 'Gemini generateContent succeeded for ' + model +
          ' using configured key slot ' + (index + 1) + ' (' + modelsSummary + ').',
      };
    } catch (error) {
      failures.push(
        'key slot ' + (index + 1) + ': ' + modelsSummary +
        '; generateContent ' + summarizeGeminiFailure(error),
      );
    }
  }

  return {
    ok: false,
    message: 'Gemini generation failed for all ' + keys.length + ' configured key(s). ' +
      failures.join(' | ').slice(0, 1600),
  };
}
async function generateDecision(options) {
  const keys = getApiKeys();
  if (!keys.length) throw new Error('No Gemini API key is configured.');

  const requestText = [
    'Decide whether Gree should send a message now.',
    'Directly addressed to Gree: ' + (options.direct ? 'yes' : 'no'),
    'If this is unsolicited participation, you may choose silence. Silence is represented by shouldRespond=false and an empty message.',
    'Never output controversial, dark, offensive, or risky humor. If the subject is sensitive, contentious, personal, or likely to trigger server drama, choose silence.',
    'If responding, write one natural Discord message in Gree’s casual style. Usually use one short sentence; do not explain your rules.',
    'Return only JSON with the fields shouldRespond (boolean) and message (string).',
    '',
    'RECENT CONVERSATION:',
    options.context,
    '',
    'LATEST MESSAGE:',
    options.latestMessage,
  ].join('\n');

  const model = config.gemini.model.replace(/^models\//, '');
  let lastError = null;

  for (let index = 0; index < keys.length; index++) {
    try {
      const client = new GoogleGenAI({ apiKey: keys[index] });
      const response = await client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: requestText }] }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.9,
          maxOutputTokens: 320,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              shouldRespond: { type: 'BOOLEAN' },
              message: { type: 'STRING' },
            },
            required: ['shouldRespond', 'message'],
            propertyOrdering: ['shouldRespond', 'message'],
          },
        },
      });

      const rawText = String(response.text || '').trim();
      if (!rawText) throw new Error('Gemini returned an empty response.');
      return parseDecision(rawText);
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      lastError = new Error('Gemini key slot ' + (index + 1) + ' failed: ' + detail.slice(0, 800));

      const statusValue = error && (error.status || error.statusCode || error.code);
      const status = Number(statusValue);
      // 429 commonly reflects project-level quota, so sibling keys are unlikely
      // to help. For access/availability errors, try the configured backups.
      if (status === 429 || String(statusValue) === '429') break;
      if (Number.isFinite(status) && status > 0 &&
          ![401, 403, 500, 502, 503, 504].includes(status)) break;
    }
  }

  throw lastError || new Error('Gemini request failed.');
}

module.exports = {
  checkGeminiConnection,
  generateDecision,
  getConfiguredKeyCount,
};
