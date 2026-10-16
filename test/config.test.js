'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function loadConfig(overrides = {}) {
  const script = [
    "const config = require('./config');",
    "const ai = require('./ai');",
    "process.stdout.write(JSON.stringify({",
    "  discordToken: config.discord.token,",
    "  guildId: config.discord.guildId,",
    "  configuredKeyCount: ai.getConfiguredKeyCount(),",
    "  model: config.gemini.model,",
    "  autoChatEnabled: config.conversation.autoChatEnabled,",
    "  autoChatChance: config.conversation.autoChatChance,",
    "  contextMessages: config.conversation.contextMessages,",
    "  unsolicitedCooldownMs: config.conversation.unsolicitedCooldownMs,",
    "  maxConcurrentAIRequests: config.conversation.maxConcurrentAIRequests,",
    "  maxPendingAIRequests: config.conversation.maxPendingAIRequests",
    "}));",
  ].join('\n');

  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DISCORD_TOKEN: 'test-token',
      GUILD_ID: '',
      GEMINI_API_KEY: 'test-key',
      GEMINI_API_KEY_2: '',
      GEMINI_API_KEY_3: '',
      GEMINI_API_KEY_4: '',
      GEMINI_MODEL: '',
      GREE_AUTO_CHAT_ENABLED: '',
      GREE_AUTO_CHAT_CHANCE: '',
      GREE_CONTEXT_MESSAGES: '',
      GREE_UNSOLICITED_COOLDOWN_MS: '',
      GREE_MAX_CONCURRENT_AI_REQUESTS: '',
      GREE_MAX_PENDING_AI_REQUESTS: '',
      ...overrides,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('blank environment values use documented defaults', () => {
  const config = loadConfig();

  assert.equal(config.discordToken, 'test-token');
  assert.equal(config.guildId, '');
  assert.equal(config.configuredKeyCount, 1);
  assert.equal(config.model, 'gemini-3.6-flash');
  assert.equal(config.autoChatEnabled, true);
  assert.equal(config.autoChatChance, 0.06);
  assert.equal(config.contextMessages, 15);
  assert.equal(config.unsolicitedCooldownMs, 60000);
  assert.equal(config.maxConcurrentAIRequests, 3);
  assert.equal(config.maxPendingAIRequests, 30);
});

test('boolean and fractional settings parse valid values', () => {
  const config = loadConfig({
    GREE_AUTO_CHAT_ENABLED: 'off',
    GREE_AUTO_CHAT_CHANCE: '0.2',
  });

  assert.equal(config.autoChatEnabled, false);
  assert.equal(config.autoChatChance, 0.2);
});

test('numeric settings reject partial values and clamp excessive values', () => {
  const invalid = loadConfig({
    GREE_CONTEXT_MESSAGES: '12messages',
    GREE_UNSOLICITED_COOLDOWN_MS: '1e3',
    GREE_MAX_CONCURRENT_AI_REQUESTS: '999',
    GREE_MAX_PENDING_AI_REQUESTS: '-2',
  });

  assert.equal(invalid.contextMessages, 15);
  assert.equal(invalid.unsolicitedCooldownMs, 60000);
  assert.equal(invalid.maxConcurrentAIRequests, 5);
  assert.equal(invalid.maxPendingAIRequests, 30);
});

test('invalid booleans and fractions safely fall back', () => {
  const config = loadConfig({
    GREE_AUTO_CHAT_ENABLED: 'maybe',
    GREE_AUTO_CHAT_CHANCE: '2',
  });

  assert.equal(config.autoChatEnabled, true);
  assert.equal(config.autoChatChance, 0.06);
});

test('credentials and model names are trimmed, and duplicate API keys are counted once', () => {
  const config = loadConfig({
    DISCORD_TOKEN: '  test-token  ',
    GUILD_ID: '  123456789  ',
    GEMINI_API_KEY: '  duplicate-key  ',
    GEMINI_API_KEY_2: 'duplicate-key',
    GEMINI_API_KEY_3: ' second-key ',
    GEMINI_API_KEY_4: '',
    GEMINI_MODEL: '  gemini-test-model  ',
  });

  assert.equal(config.discordToken, 'test-token');
  assert.equal(config.guildId, '123456789');
  assert.equal(config.model, 'gemini-test-model');
  assert.equal(config.configuredKeyCount, 2);
});

