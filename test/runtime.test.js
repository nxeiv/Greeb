'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChannelStateStore, createTaskLimiter } = require('../runtime');

test('channel state stores only the configured number of recent messages', () => {
  let now = 1000;
  const store = createChannelStateStore({
    maxChannels: 3,
    maxMessages: 2,
    ttlMs: 1000,
    clock: () => now,
  });

  assert.equal(store.add('alpha', { content: 'one', createdAt: now }), true);
  now++;
  assert.equal(store.add('alpha', { content: 'two', createdAt: now }), true);
  now++;
  assert.equal(store.add('alpha', { content: 'three', createdAt: now }), true);

  assert.deepEqual(store.get('alpha').map(entry => entry.content), ['two', 'three']);
});

test('expired history is cleared even when the same channel becomes active again', () => {
  let now = 1000;
  const evicted = [];
  const store = createChannelStateStore({
    maxChannels: 3,
    maxMessages: 30,
    ttlMs: 100,
    clock: () => now,
    onEvict: channelId => evicted.push(channelId),
  });

  store.add('alpha', { content: 'old private context', createdAt: now });
  now += 101;
  store.add('alpha', { content: 'new conversation', createdAt: now });

  assert.deepEqual(store.get('alpha').map(entry => entry.content), ['new conversation']);
  assert.deepEqual(evicted, ['alpha']);
});

test('bounded channel state evicts the least-recently-active idle channel', () => {
  let now = 1000;
  const busy = new Set();
  const store = createChannelStateStore({
    maxChannels: 2,
    maxMessages: 30,
    ttlMs: 10000,
    clock: () => now,
    isBusy: channelId => busy.has(channelId),
  });

  store.add('alpha', { content: 'a', createdAt: now });
  now++;
  store.add('beta', { content: 'b', createdAt: now });
  now++;
  store.add('gamma', { content: 'c', createdAt: now });

  assert.equal(store.size(), 2);
  assert.equal(store.has('alpha'), false);
  assert.equal(store.has('beta'), true);
  assert.equal(store.has('gamma'), true);
});

test('channel state refuses new tracking if every retained channel is busy', () => {
  let now = 1000;
  const busy = new Set();
  const store = createChannelStateStore({
    maxChannels: 1,
    clock: () => now,
    isBusy: channelId => busy.has(channelId),
  });

  store.add('alpha', { content: 'a', createdAt: now });
  busy.add('alpha');
  now++;
  assert.equal(store.add('beta', { content: 'b', createdAt: now }), false);
  assert.equal(store.size(), 1);
});

test('task limiter caps active work and rejects overflow instead of growing forever', async () => {
  const limiter = createTaskLimiter({ maxConcurrent: 1, maxPending: 1 });
  let releaseFirst;
  let releaseSecond;
  let active = 0;
  let highestActive = 0;

  const first = limiter.run(() => new Promise(resolve => {
    active++;
    highestActive = Math.max(highestActive, active);
    releaseFirst = value => {
      active--;
      resolve(value);
    };
  }));

  const second = limiter.run(() => new Promise(resolve => {
    active++;
    highestActive = Math.max(highestActive, active);
    releaseSecond = value => {
      active--;
      resolve(value);
    };
  }));

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseFirst, 'function');
  assert.equal(typeof releaseSecond, 'undefined');
  await assert.rejects(limiter.run(async () => 'overflow'), /queue is full/);

  releaseFirst('first');
  assert.equal(await first, 'first');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseSecond, 'function');
  releaseSecond('second');
  assert.equal(await second, 'second');

  assert.equal(highestActive, 1);
  assert.deepEqual(limiter.getStats(), {
    active: 0,
    queued: 0,
    maxConcurrent: 1,
    maxPending: 1,
  });
});

test('task limiter continues draining after a task rejects', async () => {
  const limiter = createTaskLimiter({ maxConcurrent: 1, maxPending: 2 });

  await assert.rejects(
    limiter.run(async () => { throw new Error('expected failure'); }),
    /expected failure/,
  );
  assert.equal(await limiter.run(async () => 'still works'), 'still works');
  assert.equal(limiter.getStats().active, 0);
});
