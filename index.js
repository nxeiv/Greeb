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
const { generateDecision, getConfiguredKeyCount } = require('./ai');
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
const MAX_STORED_MESSAGES = 30;
const TEN_MINUTES_MS = 10 * 60 * 1000;

function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log('[' + timestamp + '] [Gree] ' + message);
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
  const history = getHistory(channelId);
  history.push(entry);

  if (history.length > MAX_STORED_MESSAGES) {
    history.splice(0, history.length - MAX_STORED_MESSAGES);
  }

  channelHistory.set(channelId, history);
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
    decision = await generateDecision({
      direct,
      context,
      latestMessage,
    });
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

  addToHistory(message.channel.id, {
    authorId: message.author.id,
    content: text,
    isGree: false,
    createdAt: Date.now(),
  });

  // Stay silent and do not send high-risk source messages to Gemini.
  if (containsHighRiskTopic(text)) return;

  const chanceEligible = !direct && config.conversation.autoChatEnabled &&
    shouldConsiderSpontaneous({
      content: text,
      chance: config.conversation.autoChatChance,
      random: Math.random,
    });

  if (!direct && !chanceEligible) return;

  const previous = channelQueues.get(message.channel.id) || Promise.resolve();
  const task = previous.then(
    () => processCandidate(message, direct, text),
    () => processCandidate(message, direct, text),
  ).catch(error => {
    log('Message handler failed: ' + (error && error.message ? error.message : String(error)));
  });

  channelQueues.set(message.channel.id, task);
  void task.then(() => {
    if (channelQueues.get(message.channel.id) === task) {
      channelQueues.delete(message.channel.id);
    }
  });
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
