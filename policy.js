'use strict';

const HIGH_RISK_TOPIC_PATTERN = /\b(?:politic(?:s|al|ian)?|election|government|president|religio(?:n|us)|racial?|racism|racist|ethnic(?:ity)?|sexism|sexist|homophob(?:ia|ic)|transphob(?:ia|ic)|hate speech|slur|harassment|discriminat(?:e|ion)|suicid(?:e|al)|self[\s-]?harm|murder|rape|sexual assault|abuse|assault|genocide|terroris(?:m|t)|war|bomb(?:ing)?|traged(?:y|ies)|trauma|controvers(?:y|ial)|scandal|server drama|relationship drama|cheat(?:ed|ing)?|breakup|private messages?|leak(?:ed)?|expos(?:e|ed|ing)|rumou?r|dox(?:x|xing)|blackmail|call[\s-]?out|cancel(?:led|ed|ling|ing)?|revenge)\b/i;

const RISKY_REPLY_PATTERN = /\b(?:politic(?:s|al|ian)?|election|religio(?:n|us)|racis(?:m|t)|ethnic(?:ity)?|sexism|sexist|homophob(?:ia|ic)|transphob(?:ia|ic)|hate speech|slur|harassment|discriminat(?:e|ion)|suicid(?:e|al)|self[\s-]?harm|murder|rape|sexual assault|abuse|assault|genocide|terroris(?:m|t)|war|bomb(?:ing)?|traged(?:y|ies)|trauma|controvers(?:y|ial)|scandal|server drama|relationship drama|cheat(?:ed|ing)?|breakup|private messages?|leak(?:ed)?|expos(?:e|ed|ing)|rumou?r|dox(?:x|xing)|blackmail|cancel(?:led|ed|ling|ing)?|dark jokes?|offensive joke|go die)\b/i;

function containsHighRiskTopic(text) {
  return HIGH_RISK_TOPIC_PATTERN.test(String(text || ''));
}

function shouldConsiderSpontaneous(options) {
  const content = String(options.content || '').trim();
  const chance = Number(options.chance);
  const random = typeof options.random === 'function' ? options.random() : Math.random();

  if (content.length < 28) return false;
  if (!Number.isFinite(chance) || chance <= 0 || chance > 0.25) return false;
  if (containsHighRiskTopic(content)) return false;
  return random < chance;
}

function validateReply(value) {
  if (typeof value !== 'string') return null;

  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  if (!text || text.length > 1800) return null;
  if (/@everyone\b|@here\b|<@!?[0-9]+>|<@&[0-9]+>/i.test(text)) return null;
  if (/https?:\/\/|www\./i.test(text)) return null;
  if (RISKY_REPLY_PATTERN.test(text)) return null;

  return text;
}

module.exports = {
  containsHighRiskTopic,
  shouldConsiderSpontaneous,
  validateReply,
};
