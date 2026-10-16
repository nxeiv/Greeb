'use strict';

const config = require('./config');

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

  let lastError = null;

  for (let index = 0; index < keys.length; index++) {
    try {
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(config.gemini.model) + ':generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': keys[index],
          },
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: SYSTEM_PROMPT }],
            },
            contents: [{
              role: 'user',
              parts: [{ text: requestText }],
            }],
            generationConfig: {
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
          }),
          signal: AbortSignal.timeout(30000),
        },
      );

      const responseText = await response.text();
      let body;
      try {
        body = JSON.parse(responseText);
      } catch {
        const contentType = response.headers.get('content-type') || 'unknown';
        const preview = responseText.replace(/\\s+/g, ' ').trim().slice(0, 180);
        throw new Error(
          'Gemini returned a non-JSON response (HTTP ' + response.status +
          ', content-type: ' + contentType +
          (preview ? ', body starts with: ' + preview : ', empty body') +
          '). Check the hosting network/proxy response and Gemini endpoint.',
        );
      }

      if (response.ok) {
        const rawText = body && body.candidates && body.candidates[0] &&
          body.candidates[0].content && body.candidates[0].content.parts
          ? body.candidates[0].content.parts.map(part => part.text || '').join('').trim()
          : '';

        if (!rawText) throw new Error('Gemini returned an empty response.');
        return parseDecision(rawText);
      }

      const apiMessage = body && body.error && body.error.message
        ? body.error.message
        : 'HTTP ' + response.status;
      lastError = new Error('Gemini key ' + (index + 1) + ' failed: ' + apiMessage);

      // A 429 commonly reflects project-level quota. Trying sibling keys
      // from the same project immediately just repeats a doomed request.
      if (response.status === 429) break;
      if (![401, 403, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Gemini request failed.');
}

module.exports = {
  generateDecision,
  getConfiguredKeyCount,
};
