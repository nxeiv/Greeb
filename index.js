'use strict';

const {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} = require('discord.js');

const config = require('./config');
const {
  checkGeminiConnection,
  generateDecision,
  getConfiguredKeyCount,
  isGeminiCooldownError,
} = require('./ai');
const { createChannelStateStore, createTaskLimiter, createPerKeyTaskScheduler } = require('./runtime');
const {
  containsHighRiskTopic,
  shouldConsiderSpontaneous,
  validateReply,
} = require('./policy');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const channelActivity = new Map();
const MAX_PENDING_PER_CHANNEL = 3;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const channelScheduler = createPerKeyTaskScheduler({
  maxPendingPerKey: MAX_PENDING_PER_CHANNEL,
});
const channelStore = createChannelStateStore({
  maxChannels: 500,
  maxMessages: 30,
  ttlMs: 30 * 60 * 1000,
  isBusy: channelId => channelScheduler.has(channelId),
  onEvict: channelId => channelActivity.delete(channelId),
});
const aiLimiter = createTaskLimiter({
  maxConcurrent: config.conversation.maxConcurrentAIRequests,
  maxPending: config.conversation.maxPendingAIRequests,
});
const recentGeminiFailureLogs = new Map();
const recentOperationalFailureLogs = new Map();
let aiHealth = null;

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log('[' + timestamp + '] [Gree] ' + message);
}

function setAiHealth(healthy) {
  if (!client.user || aiHealth === healthy) return;
  const previous = aiHealth;
  aiHealth = healthy;

  const activity = healthy
    ? { name: 'hanging out', type: ActivityType.Watching }
    : { name: 'AI temporarily unavailable', type: ActivityType.Watching };

  Promise.resolve(client.user.setPresence({
    activities: [activity],
    status: healthy ? 'online' : 'idle',
  })).catch(error => {
    logRateLimited(
      recentOperationalFailureLogs,
      'presence',
      'Unable to update bot presence: ' + redactSecrets(error && error.message ? error.message : error),
    );
  });

  if (previous === false && healthy) {
    log('Gemini connectivity recovered; normal presence restored.');
  }
}

function redactSecrets(value) {
  return String(value || 'Unknown error')
    .replace(/AIza[0-9A-Za-z_-]{30,}/g, '[redacted API key]')
    .replace(/\b[\w-]{24,}\.[\w-]{6,}\.[\w-]{20,}\b/g, '[redacted Discord token]')
    .replace(/\b(DISCORD_TOKEN|GEMINI_API_KEY(?:_[2-4])?)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

function logRateLimited(map, key, message, intervalMs = 60000) {
  const now = Date.now();
  const previous = map.get(key) || 0;
  if (now - previous < intervalMs) return;

  if (map.size >= 100) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [entryKey, time] of map) {
      if (time < oldestTime) {
        oldestKey = entryKey;
        oldestTime = time;
      }
    }
    if (oldestKey !== null) map.delete(oldestKey);
  }

  map.set(key, now);
  const safeMessage = redactSecrets(message).replace(/\s+/g, ' ').slice(0, 420);
  log(safeMessage);
}

function logGeminiFailure(error) {
  const raw = String(error && error.message ? error.message : error || 'Unknown Gemini error');
  const safeMessage = redactSecrets(raw).replace(/\s+/g, ' ').slice(0, 420);
  const signature = safeMessage.replace(/key slot \d+/gi, 'key slot [n]');
  logRateLimited(recentGeminiFailureLogs, signature, 'Gemini request failed: ' + safeMessage);
}

function cleanIncomingContent(content, botUserId) {
  let text = String(content || '');

  if (botUserId) {
    text = text.replace(new RegExp('<@!?' + botUserId + '>', 'g'), ' ');
  }

  return text
    .replace(/<@!?[0-9]+>/g, '@member')
    .replace(/<@&[0-9]+>/g, '@role')
    .replace(/<#[0-9]+>/g, '#channel')
    .replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/www\.\S+/gi, '[link omitted]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function isAllowedChannel(channelId) {
  return config.conversation.channelIds.length === 0 ||
    config.conversation.channelIds.includes(channelId);
}

function getHistory(channelId) {
  return channelStore.get(channelId);
}

function addToHistory(channelId, entry) {
  return channelStore.add(channelId, entry);
}

function formatHistory(channelId) {
  const history = getHistory(channelId)
    .slice(-config.conversation.contextMessages)
    .filter(entry => !containsHighRiskTopic(entry.content));
  const labels = new Map();
  let nextMemberNumber = 1;

  return history.map(entry => {
    let label;

    if (entry.isGree) {
      label = 'Gree';
    } else {
      if (!labels.has(entry.authorId)) {
        labels.set(entry.authorId, 'Member ' + nextMemberNumber);
        nextMemberNumber++;
      }
      label = labels.get(entry.authorId);
    }

    return label + ': ' + entry.content;
  }).join('\n');
}

function getActivity(channelId) {
  if (!channelActivity.has(channelId)) {
    channelActivity.set(channelId, {
      lastUnsolicitedAt: 0,
      lastDirectStartedAt: 0,
      responses: [],
      unsolicited: [],
    });
  }

  return channelActivity.get(channelId);
}

function canStartResponse(channelId, direct) {
  const activity = getActivity(channelId);
  const now = Date.now();

  activity.responses = activity.responses.filter(time => now - time < 60000);
  if (activity.responses.length >= 8) return false;

  if (direct) {
    if (now - activity.lastDirectStartedAt < 1200) return false;
    activity.lastDirectStartedAt = now;
    return true;
  }

  activity.unsolicited = activity.unsolicited.filter(time => now - time < TEN_MINUTES_MS);
  if (!config.conversation.autoChatEnabled) return false;
  if (activity.unsolicited.length >= config.conversation.maxUnsolicitedPerTenMinutes) return false;
  if (now - activity.lastUnsolicitedAt < config.conversation.unsolicitedCooldownMs) return false;

  return true;
}

async function clearLegacyCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    log('Removed any old global slash commands.');
  } catch (error) {
    logRateLimited(recentOperationalFailureLogs, 'clear-global-commands',
      'Could not remove old global commands: ' + redactSecrets(error && error.message ? error.message : error));
  }

  if (config.discord.guildId) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, config.discord.guildId),
        { body: [] },
      );
      log('Removed any old guild slash commands from the configured GUILD_ID.');
    } catch (error) {
      logRateLimited(recentOperationalFailureLogs, 'clear-guild-commands',
        'Could not remove old guild commands: ' + redactSecrets(error && error.message ? error.message : error));
    }
  }
}

async function processCandidate(message, direct, latestMessage) {
  const channelId = message.channel.id;
  if (!canStartResponse(channelId, direct)) return;

  const recentHistory = getHistory(channelId)
    .slice(-config.conversation.contextMessages);

  // Do not join while a sensitive topic is still active in the latest messages.
  if (recentHistory.slice(-5).some(entry => containsHighRiskTopic(entry.content))) return;

  const context = formatHistory(channelId);
  let decision;

  try {
    decision = await aiLimiter.run(() => generateDecision({
      direct,
      context,
      latestMessage,
    }), { priority: direct ? 'high' : 'normal' });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (/reprioritized for a direct mention/.test(message)) return;
    if (isGeminiCooldownError(error)) return;
    if (/AI request queue is full/.test(message)) return;
    setAiHealth(false);
    logGeminiFailure(error);
    return;
  }

  setAiHealth(true);
  if (!decision || decision.shouldRespond !== true) return;

  const reply = validateReply(decision.message);
  if (!reply) {
    log('A generated reply was withheld by the local safety checks.');
    return;
  }

  const activity = getActivity(channelId);
  const now = Date.now();
  activity.responses.push(now);

  if (!direct) {
    activity.lastUnsolicitedAt = now;
    activity.unsolicited.push(now);
  }

  if (typeof message.channel.sendTyping === 'function') {
    try {
      await message.channel.sendTyping();
    } catch (error) {
      // Typing is optional: a missing permission or rate limit must not prevent a reply.
      logRateLimited(
        recentOperationalFailureLogs,
        'typing:' + channelId,
        'Typing indicator failed in #' + (message.channel.name || channelId) + ': ' +
          (error && error.message ? error.message : error),
      );
    }
  }

  try {
    const sent = await message.channel.send({
      content: reply,
      allowedMentions: { parse: [] },
    });

    addToHistory(channelId, {
      authorId: client.user.id,
      content: reply,
      isGree: true,
      createdAt: Date.now(),
    });

    if (sent && typeof sent.id === 'string') {
      log((direct ? 'Replied in ' : 'Joined ') + '#' + (message.channel.name || channelId) + '.');
    }
  } catch (error) {
    logRateLimited(
      recentOperationalFailureLogs,
      'send:' + channelId,
      'Unable to send a reply in #' + (message.channel.name || channelId) + ': ' +
        (error && error.message ? error.message : error),
    );
  }
}

async function handleMessage(message) {
  if (
    message.author.bot ||
    message.system ||
    !message.guild ||
    !client.user ||
    !message.channel ||
    !message.channel.isTextBased() ||
    typeof message.channel.send !== 'function' ||
    !isAllowedChannel(message.channel.id)
  ) return;

  const text = cleanIncomingContent(message.content, client.user.id);
  if (!text) return;

  let direct = message.mentions.users.has(client.user.id) ||
    Boolean(message.mentions.repliedUser && message.mentions.repliedUser.id === client.user.id);

  // Some Discord replies omit a replied-user mention; verify the referenced message.
  if (
    !direct &&
    message.reference &&
    message.reference.messageId &&
    message.channel.messages &&
    typeof message.channel.messages.fetch === 'function'
  ) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
      direct = Boolean(
        referencedMessage &&
        referencedMessage.author &&
        referencedMessage.author.id === client.user.id
      );
    } catch {
      // If the referenced message is unavailable, continue without treating it as direct.
    }
  }

  if (!addToHistory(message.channel.id, {
    authorId: message.author.id,
    content: text,
    isGree: false,
    createdAt: Date.now(),
  })) return;

  // Stay silent and do not send high-risk source messages to Gemini.
  if (containsHighRiskTopic(text)) return;

  const chanceEligible = !direct && config.conversation.autoChatEnabled &&
    shouldConsiderSpontaneous({
      content: text,
      chance: config.conversation.autoChatChance,
      random: Math.random,
    });

  if (!direct && !chanceEligible) return;

  const channelId = message.channel.id;
  void channelScheduler.enqueue(
    channelId,
    () => processCandidate(message, direct, text),
    { priority: direct ? 'high' : 'normal' },
  ).catch(error => {
    if (error && /reprioritized for a direct mention/.test(error.message || '')) return;
    logRateLimited(
      recentOperationalFailureLogs,
      'message-handler',
      'Message handler failed: ' + redactSecrets(error && error.message ? error.message : error),
    );
  });
}

client.on(Events.MessageCreate, message => {
  void handleMessage(message).catch(error => {
    logRateLimited(
      recentOperationalFailureLogs,
      'message-intake',
      'Message intake failed: ' + redactSecrets(error && error.message ? error.message : error),
    );
  });
});

client.on('error', error => {
  logRateLimited(
    recentOperationalFailureLogs,
    'discord-client',
    'Discord client error: ' + redactSecrets(error && error.message ? error.message : error),
  );
});

client.once(Events.ClientReady, async readyClient => {
  log('Logged in as ' + readyClient.user.tag + '.');
  log('Conversation-only mode enabled; no slash or prefix commands are registered.');
  log('Gemini model: ' + config.gemini.model + '; configured API keys: ' + getConfiguredKeyCount() + '.');
  log('Request limits: ' + config.conversation.maxConcurrentAIRequests +
    ' concurrent Gemini request(s), up to ' + config.conversation.maxPendingAIRequests + ' waiting globally.');
  log(config.conversation.autoChatEnabled
    ? 'Selective unsolicited participation is enabled.'
    : 'Unsolicited participation is disabled; Gree replies only when directly addressed.');

  readyClient.user.setPresence({
    activities: [{ name: 'checking AI connection', type: ActivityType.Watching }],
    status: 'idle',
  });

  void checkGeminiConnection().then(result => {
    log((result.ok ? 'Gemini preflight passed: ' : 'Gemini preflight warning: ') + result.message);
    setAiHealth(result.ok);
  }).catch(error => {
    setAiHealth(false);
    logGeminiFailure(error);
  });

  await clearLegacyCommands();
});

let shutdownStarted = false;

async function shutdown(reason) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  log('Shutting down after ' + reason + '.');

  try {
    await client.destroy();
  } catch (error) {
    process.exitCode = 1;
    logRateLimited(
      recentOperationalFailureLogs,
      'shutdown',
      'Error while closing Discord client: ' + (error && error.message ? error.message : error),
    );
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('unhandledRejection', reason => {
  process.exitCode = 1;
  logRateLimited(
    recentOperationalFailureLogs,
    'unhandled-rejection',
    'Unhandled rejection: ' + (reason && reason.message ? reason.message : String(reason)),
  );
  void shutdown('an unhandled promise rejection');
});

if (!config.discord.token) {
  console.error('[Gree] DISCORD_TOKEN is missing. Add it to the environment before starting.');
  process.exit(1);
}

if (getConfiguredKeyCount() === 0) {
  console.error('[Gree] No Gemini API key is configured. Add GEMINI_API_KEY (or a numbered backup).');
  process.exit(1);
}

log('Starting Discord client.');
client.login(config.discord.token).catch(error => {
  console.error('[Gree] Discord login failed: ' + redactSecrets(error && error.message ? error.message : error));
  process.exitCode = 1;
  void shutdown('Discord login failure');
});
