'use strict';

require('dotenv').config();

function parsePositiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return maximum ? Math.min(parsed, maximum) : parsed;
}

function parseFraction(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0.25) return fallback;
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value == null || value.trim() === '') return fallback;
  if (/^(true|1|yes|on)$/i.test(value.trim())) return true;
  if (/^(false|0|no|off)$/i.test(value.trim())) return false;
  return fallback;
}

const config = {
  discord: {
    token: process.env.DISCORD_TOKEN || '',
    guildId: process.env.GUILD_ID || '',
  },
  gemini: {
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
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
    channelIds: (process.env.GREE_CHANNEL_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  },
};

module.exports = config;
