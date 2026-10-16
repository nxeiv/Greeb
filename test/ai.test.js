'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkGeminiConnection,
  generateDecision,
  getHtml403CooldownRemainingMs,
  isHtmlForbiddenResponse,
  summarizeGeminiFailure,
} = require('../ai');

test('recognizes a generic HTML 403 as different from a JSON API denial', () => {
  const error = Object.assign(
    new Error('<!doctype html><html><title>Error 403 (Forbidden)!!1</title></html>'),
    { status: 403 },
  );

  assert.equal(isHtmlForbiddenResponse(error), true);
  assert.match(summarizeGeminiFailure(error), /HTML error page/);
});

test('does not classify ordinary JSON 403 API errors as HTML frontend blocks', () => {
  const error = Object.assign(
    new Error('{"error":{"message":"API key is invalid or does not have access"}}'),
    { status: 403 },
  );

  assert.equal(isHtmlForbiddenResponse(error), false);
  assert.match(summarizeGeminiFailure(error), /HTTP 403/);
  assert.match(summarizeGeminiFailure(error), /API key is invalid/);
});

test('preflight stops after the first HTML 403 instead of cycling backup keys', async () => {
  const html = '<!doctype html><html><title>Error 403 (Forbidden)!!1</title><body>Permission denied</body></html>';
  let fetchCalls = 0;
  let generationCalls = 0;

  const result = await checkGeminiConnection({
    apiKeys: ['secret-test-key-one', 'secret-test-key-two', 'secret-test-key-three'],
    fetchImpl: async () => {
      fetchCalls++;
      return {
        ok: false,
        status: 403,
        headers: { get: () => 'text/html; charset=UTF-8' },
        text: async () => html,
      };
    },
    createClient: () => ({
      models: {
        generateContent: async () => {
          generationCalls++;
          throw Object.assign(new Error(html), { status: 403 });
        },
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(fetchCalls, 1);
  assert.equal(generationCalls, 1);
  assert.match(result.message, /HTML error page/);
  assert.match(result.message, /stopped after key slot 1 of 3/);
  assert.doesNotMatch(result.message, /failed for all 3 configured key/);
  assert.doesNotMatch(result.message, /secret-test-key/);
  assert.ok(getHtml403CooldownRemainingMs() > 0);
  await assert.rejects(
    generateDecision({ direct: true, context: '', latestMessage: 'hello' }),
    /paused for about .* after a generic HTML 403/,
  );
});

test('preflight succeeds if the Models probe and generateContent succeed', async () => {
  let generationCalls = 0;

  const result = await checkGeminiConnection({
    apiKeys: ['secret-test-key'],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => '{"models":[]}',
    }),
    createClient: () => ({
      models: {
        generateContent: async () => {
          generationCalls++;
          return { text: 'OK' };
        },
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(generationCalls, 1);
  assert.match(result.message, /generateContent succeeded/);
  assert.doesNotMatch(result.message, /secret-test-key/);
});
