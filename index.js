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
const { checkGeminiConnection, generateDecision, getConfiguredKeyCount } = require('./ai');
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

const channelHistory = new Map();
const channelQueues = new Map();
const channelActivity = new Map();
const channelPendingCounts = new Map();
const aiRequestQueue = [];
const MAX_STORED_MESSAGES = 30;
const MAX_TRACKED_CHANNELS = 500;
const CHANNEL_STATE_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_PER_CHANNEL = 3;
const TEN_MINUTES_MS = 10 * 60 * 1000;
let activeAIRequests = 0;

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log('[' + timestamp + '] [Gree] ' + message);
}

function evictChannelState(channelId) {
  channelHistory.delete(channelId);
  channelActivity.delete(channelId);
}

function pruneChannelState(now = Date.now()) {
  for (const [channelId, history] of channelHistory) {
    const lastEntry = history[history.length - 1];
    const lastActivityAt = lastEntry && Number.isFinite(lastEntry.createdAt)
      ? lastEntry.createdAt
      : 0;

    if (
      !channelQueues.has(channelId) &&
      now - lastActivityAt > CHANNEL_STATE_TTL_MS
    ) {
      evictChannelState(channelId);
    }
  }
}

function ensureChannelTracked(channelId) {
  if (channelHistory.has(channelId)) return true;

  const now = Date.now();
  pruneChannelState(now);

  if (channelHistory.size < MAX_TRACKED_CHANNELS) return true;

  let oldestChannelId = null;
  let oldestActivityAt = Infinity;

  for (const [candidateId, history] of channelHistory) {
    if (candidateId === channelId || channelQueues.has(candidateId)) continue;
    const lastEntry = history[history.length - 1];
    const activityAt = lastEntry && Number.isFinite(lastEntry.createdAt)
      ? lastEntry.createdAt
      : 0;

    if (activityAt < oldestActivityAt) {
      oldestActivityAt = activityAt;
      oldestChannelId = candidateId;
    }
  }

  if (oldestChannelId === null) return false;
  evictChannelState(oldestChannelId);
  return true;
}

function drainAIRequestQueue() {
  while (
    activeAIRequests < config.conversation.maxConcurrentAIRequests &&
    aiRequestQueue.length > 0
  ) {
    const item = aiRequestQueue.shift();
    activeAIRequests++;

    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        activeAIRequests--;
        drainAIRequestQueue();
      });
  }
}

function runWithAIConcurrency(task) {
  return new Promise((resolve, reject) => {
    if (
      activeAIRequests >= config.conversation.maxConcurrentAIRequests &&
      aiRequestQueue.length >= config.conversation.maxPendingAIRequests
    ) {
      reject(new Error('AI request queue is full; this reply was skipped to prevent a backlog.'));
      return;
    }

    aiRequestQueue.push({ task, resolve, reject });
    drainAIRequestQueue();
  });
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
  return channelHistory.get(channelId) || [];
}

function addToHistory(channelId, entry) {
  if (!ensureChannelTracked(channelId)) return false;

  const history = getHistory(channelId);
  history.push(entry);

  if (history.length > MAX_STORED_MESSAGES) {
    history.splice(0, history.length - MAX_STORED_MESSAGES);
  }

  channelHistory.set(channelId, history);
  return true;
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
    log('Could not remove old global commands: ' + error.message);
  }

  if (config.discord.guildId) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, config.discord.guildId),
        { body: [] },
      );
      log('Removed any old guild slash commands from the configured GUILD_ID.');
    } catch (error) {
      log('Could not remove old guild commands: ' + error.message);
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
    decision = await runWithAIConcurrency(() => generateDecision({
      direct,
      context,
      latestMessage,
    }));
  } catch (error) {
    log('Gemini request failed: ' + error.message);
    return;
  }

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

  try {
    if (typeof message.channel.sendTyping === 'function') {
      await message.channel.sendTyping();
    }

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
    log('Unable to send a reply: ' + error.message);
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
  const pendingCount = channelPendingCounts.get(channelId) || 0;
  if (pendingCount >= MAX_PENDING_PER_CHANNEL) return;

  channelPendingCounts.set(channelId, pendingCount + 1);
  const previous = channelQueues.get(channelId) || Promise.resolve();
  const task = previous.then(
    () => processCandidate(message, direct, text),
    () => processCandidate(message, direct, text),
  ).catch(error => {
    log('Message handler failed: ' + (error && error.message ? error.message : String(error)));
  }).finally(() => {
    const remaining = (channelPendingCounts.get(channelId) || 1) - 1;
    if (remaining > 0) channelPendingCounts.set(channelId, remaining);
    else channelPendingCounts.delete(channelId);

    if (channelQueues.get(channelId) === task) {
      channelQueues.delete(channelId);
    }
  });

  channelQueues.set(channelId, task);
}

client.on(Events.MessageCreate, message => {
  void handleMessage(message).catch(error => {
    log('Message intake failed: ' + (error && error.message ? error.message : String(error)));
  });
});

client.once(Events.ClientReady, async readyClient => {
  log('Logged in as ' + readyClient.user.tag + '.');
  log('Conversation-only mode enabled; no slash or prefix commands are registered.');
  log('Gemini model: ' + config.gemini.model + '; configured API keys: ' + getConfiguredKeyCount() + '.');
  void checkGeminiConnection().then(result => {
    log((result.ok ? 'Gemini preflight passed: ' : 'Gemini preflight warning: ') + result.message);

    if (!result.ok) {
      readyClient.user.setPresence({
        activities: [{ name: 'AI temporarily unavailable', type: ActivityType.Watching }],
        status: 'idle',
      });
    }
  }).catch(error => {
    log('Gemini preflight failed unexpectedly: ' + (error && error.message ? error.message : String(error)));
    readyClient.user.setPresence({
      activities: [{ name: 'AI connection issue', type: ActivityType.Watching }],
      status: 'idle',
    });
  });
  log(config.conversation.autoChatEnabled
    ? 'Selective unsolicited participation is enabled.'
    : 'Unsolicited participation is disabled; Gree replies only when directly addressed.');

  readyClient.user.setPresence({
    activities: [{
      name: 'hanging out',
      type: ActivityType.Watching,
    }],
    status: 'online',
  });

  await clearLegacyCommands();
});

process.on('unhandledRejection', reason => {
  const message = reason && reason.message ? reason.message : String(reason);
  log('Unhandled rejection: ' + message);
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
  console.error('[Gree] Discord login failed: ' + error.message);
  process.exitCode = 1;
});
