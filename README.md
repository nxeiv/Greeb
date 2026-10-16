# Gree Bot

Gree Bot is a conversation-only Discord AI inspired by an online persona. It is designed to be casual, spontaneous, silly, and friendly without using private information or risky humor.

## What it does

- Replies when someone mentions Gree or directly replies to one of her messages.
- May occasionally join an ordinary conversation when the context gives it a natural reason to speak.
- Uses Gemini with the existing four-key fallback setup.
- Keeps a small amount of recent channel context in memory only. It is not written to disk.
- Labels people as Member 1, Member 2, and so on before sending context to Gemini instead of sending Discord usernames.
- Enforces channel cooldowns, reply limits, message validation, disabled mention parsing, and a conservative high-risk-topic gate.
- Does not register slash commands or prefix commands.
- Does not connect to Minecraft or include Minecraft features.

## Setup

1. Use Node.js 20 or newer.
2. Install dependencies with npm install.
3. Copy .env.example to .env.
4. Add the Discord bot token as DISCORD_TOKEN and at least one Gemini key as GEMINI_API_KEY. The numbered key variables are optional fallbacks.
5. Set GEMINI_MODEL if you want a different model. The default is gemini-3.6-flash.
6. Enable the Message Content privileged gateway intent for the bot in the Discord Developer Portal. Give the bot permission to view channels, read message history, and send messages in the channels where it should chat.
7. Start it with npm start.

Do not commit .env, bot tokens, or API keys.

## No commands

Gree has no user-facing slash or prefix commands. On startup, the bot attempts to delete old global slash commands left by the previous application. To remove old guild-scoped commands for this same Discord application too, set GUILD_ID to the server's ID while starting the bot. This does not remove commands belonging to another Discord application, such as the Main Bot. The cleanup is best-effort and logs an error if Discord rejects it.

## Conversation controls

- GREE_AUTO_CHAT_ENABLED=true enables occasional spontaneous participation. Set it to false to make Gree reply only when directly addressed.
- GREE_AUTO_CHAT_CHANCE=0.06 controls the chance that an eligible ordinary message is considered for a reply. It is not a guarantee that Gree will speak.
- GREE_UNSOLICITED_COOLDOWN_MS=60000 sets the minimum gap between unsolicited replies per channel.
- GREE_MAX_UNSOLICITED_PER_10_MINUTES=3 limits unsolicited replies per channel over a rolling ten-minute window.
- GREE_CONTEXT_MESSAGES=15 controls how many recent messages are provided as temporary context.
- GREE_CHANNEL_IDS can contain a comma-separated list of channel IDs. Leave it empty to allow all eligible server text channels the bot can access.

The local chance and cooldown controls run before Gemini is called, reducing needless API requests. Direct replies also have channel-level rate limits.

## Privacy boundary

Gree is an AI bot inspired by an online persona, not the actual person. Do not add personal history, relationship details, private messages, identifying facts, or embarrassing stories to the style library.

The style-examples.json file starts empty. Add only general style examples and non-private recurring jokes that the person who inspired the persona has approved. Keep examples short, anonymized, and free of personal details. The bot does not persist conversations across restarts, but the selected recent messages are sent to the configured Gemini API when the bot generates or considers a reply. Review the relevant service's privacy terms before deployment.

## Humor and safety

Gree is explicitly instructed not to make dark, offensive, controversial, or targeted jokes. The code also abstains from a conservative set of high-risk topics, rejects risky-looking outputs and links, disables Discord mentions in replies, and applies anti-spam limits.

These are defensive checks, not a mathematical guarantee that an AI can never produce an inappropriate reply. Test the bot in a private server before enabling it in a busy community, and keep the ability to turn off unsolicited participation with GREE_AUTO_CHAT_ENABLED=false.

## Checks

Run npm run check for JavaScript syntax checks and npm test for the local conversation-policy tests.
