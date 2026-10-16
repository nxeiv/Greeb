'use strict';

require('dotenv').config();

function parsePositiveInteger(value, fallback, maximum) {
  if (value == null || String(value).trim() === '') return fallback;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return maximum ? Math.min(parsed, maximum) : parsed;
}

function parseFraction(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0.25) return fallback;
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim();
  if (/^(true|1|yes|on)$/i.test(normalized)) return true;
  if (/^(false|0|no|off)$/i.test(normalized)) return false;
  return fallback;
}

const config = {
  discord: {
    token: process.env.DISCORD_TOKEN || '',
    guildId: process.env.GUILD_ID || '',
  },
  gemini: {
    model: String(process.env.GEMINI_MODEL || '').trim() || 'gemini-3.6-flash',
  },
  conversation: {
    autoChatEnabled: parseBoolean(process.env.GREE_AUTO_CHAT_ENABLED, true),
    autoChatChance: parseFraction(process.env.GREE_AUTO_CHAT_CHANCE, 0.06),
    unsolicitedCooldownMs: parsePositiveInteger(
      process.env.GREE_UNSOLICITED_COOLDOWN_MS,
      60000,
      3600000,
    ),
    maxUnsolicitedPerTenMinutes: parsePositiveInteger(
      process.env.GREE_MAX_UNSOLICITED_PER_10_MINUTES,
      3,
      20,
    ),
    contextMessages: parsePositiveInteger(
      process.env.GREE_CONTEXT_MESSAGES,
      15,
      30,
    ),
    maxConcurrentAIRequests: parsePositiveInteger(
      process.env.GREE_MAX_CONCURRENT_AI_REQUESTS,
      3,
      5,
    ),
    maxPendingAIRequests: parsePositiveInteger(
      process.env.GREE_MAX_PENDING_AI_REQUESTS,
      30,
      100,
    ),
    channelIds: (process.env.GREE_CHANNEL_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  },
};

module.exports = config;
