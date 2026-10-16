'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  containsHighRiskTopic,
  shouldConsiderSpontaneous,
  validateReply,
} = require('../policy');

test('high-risk topics are identified before a message is sent to Gemini', () => {
  assert.equal(containsHighRiskTopic('this server drama is getting weird'), true);
  assert.equal(containsHighRiskTopic('who wants to build something green'), false);
});

test('spontaneous replies require enough text, an eligible topic, and a successful chance roll', () => {
  assert.equal(shouldConsiderSpontaneous({
    content: 'this message is long enough to be considered',
    chance: 0.1,
    random: () => 0.05,
  }), true);

  assert.equal(shouldConsiderSpontaneous({
    content: 'hi',
    chance: 0.1,
    random: () => 0,
  }), false);

  assert.equal(shouldConsiderSpontaneous({
    content: 'this server drama is getting weird and stressful',
    chance: 0.1,
    random: () => 0,
  }), false);

  assert.equal(shouldConsiderSpontaneous({
    content: 'this message is long enough to be considered',
    chance: 0.1,
    random: () => 0.9,
  }), false);
});

test('reply validation accepts harmless conversational text', () => {
  assert.equal(validateReply('  yesyes that is so random  '), 'yesyes that is so random');
});

test('reply validation rejects dangerous mentions, links, excessive length, and risky topics', () => {
  assert.equal(validateReply('@everyone look at this'), null);
  assert.equal(validateReply('check https://example.com'), null);
  assert.equal(validateReply('this might turn into server drama'), null);
  assert.equal(validateReply('x'.repeat(1801)), null);
  assert.equal(validateReply('  '), null);
});
