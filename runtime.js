'use strict';

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createChannelStateStore(options = {}) {
  const maxChannels = positiveInteger(options.maxChannels, 500);
  const maxMessages = positiveInteger(options.maxMessages, 30);
  const ttlMs = positiveInteger(options.ttlMs, 30 * 60 * 1000);
  const isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false;
  const onEvict = typeof options.onEvict === 'function' ? options.onEvict : () => {};
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const histories = new Map();

  function getLastActivityAt(history) {
    const lastEntry = history[history.length - 1];
    return lastEntry && Number.isFinite(lastEntry.createdAt) ? lastEntry.createdAt : 0;
  }

  function evict(channelId) {
    if (histories.delete(channelId)) onEvict(channelId);
  }

  function prune(now = clock()) {
    for (const [channelId, history] of histories) {
      if (isBusy(channelId)) continue;
      if (now - getLastActivityAt(history) > ttlMs) evict(channelId);
    }
  }

  function ensureTracked(channelId, now = clock()) {
    if (typeof channelId !== 'string' || channelId.length === 0) return false;

    // Prune before checking for an existing key so even a repeatedly used
    // channel loses stale history when its next message arrives after the TTL.
    prune(now);
    if (histories.has(channelId)) return true;
    if (histories.size < maxChannels) return true;

    let oldestChannelId = null;
    let oldestActivityAt = Infinity;

    for (const [candidateId, history] of histories) {
      if (isBusy(candidateId)) continue;
      const activityAt = getLastActivityAt(history);
      if (activityAt < oldestActivityAt) {
        oldestActivityAt = activityAt;
        oldestChannelId = candidateId;
      }
    }

    if (oldestChannelId === null) return false;
    evict(oldestChannelId);
    return true;
  }

  function add(channelId, entry) {
    if (!ensureTracked(channelId)) return false;

    const history = histories.get(channelId) || [];
    history.push(entry);

    if (history.length > maxMessages) {
      history.splice(0, history.length - maxMessages);
    }

    histories.set(channelId, history);
    return true;
  }

  function get(channelId) {
    return histories.get(channelId) || [];
  }

  function clear() {
    for (const channelId of histories.keys()) evict(channelId);
  }

  return {
    add,
    clear,
    get,
    has: channelId => histories.has(channelId),
    prune,
    size: () => histories.size,
  };
}

function createTaskLimiter(options = {}) {
  const maxConcurrent = positiveInteger(options.maxConcurrent, 3);
  const maxPending = Number.isSafeInteger(options.maxPending) && options.maxPending >= 0
    ? options.maxPending
    : 30;
  const queue = [];
  let active = 0;

  function finish(item, error, value) {
    // Release the slot and start waiting work before resolving the caller's
    // promise, so limiter state is consistent as soon as callers resume.
    active--;
    drain();
    if (error) item.reject(error);
    else item.resolve(value);
  }

  function drain() {
    while (active < maxConcurrent && queue.length > 0) {
      const item = queue.shift();
      active++;

      Promise.resolve()
        .then(item.task)
        .then(
          value => finish(item, null, value),
          error => finish(item, error),
        );
    }
  }

  function run(task) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('Task limiter expects a function.'));
    }

    if (active >= maxConcurrent && queue.length >= maxPending) {
      return Promise.reject(new Error('AI request queue is full; this reply was skipped to prevent a backlog.'));
    }

    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
  }

  function getStats() {
    return { active, queued: queue.length, maxConcurrent, maxPending };
  }

  return { getStats, run };
}

module.exports = {
  createChannelStateStore,
  createTaskLimiter,
};
