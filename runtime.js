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

  function run(task, options = {}) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('Task limiter expects a function.'));
    }

    const priority = options.priority === 'high' ? 1 : 0;

    if (active >= maxConcurrent && queue.length >= maxPending) {
      let evictIndex = -1;

      // When a direct mention arrives, let it replace a queued unsolicited
      // reply rather than making the user wait behind speculative activity.
      if (priority === 1) {
        for (let index = queue.length - 1; index >= 0; index--) {
          if (queue[index].priority === 0) {
            evictIndex = index;
            break;
          }
        }
      }

      if (evictIndex < 0) {
        return Promise.reject(new Error('AI request queue is full; this reply was skipped to prevent a backlog.'));
      }

      const [evicted] = queue.splice(evictIndex, 1);
      evicted.reject(new Error('AI request queue was reprioritized for a direct mention; this reply was skipped.'));
    }

    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, priority };
      const insertBefore = queue.findIndex(queued => queued.priority < priority);

      if (insertBefore < 0) queue.push(item);
      else queue.splice(insertBefore, 0, item);

      drain();
    });
  }

  function getStats() {
    return { active, queued: queue.length, maxConcurrent, maxPending };
  }

  return { getStats, run };
}


function createPerKeyTaskScheduler(options = {}) {
  const maxPendingPerKey = positiveInteger(options.maxPendingPerKey, 3);
  const states = new Map();

  function finish(key, state, item, error, value) {
    // Keep map/runner state consistent before waking the caller.
    state.running = false;
    if (state.queue.length > 0) runNext(key, state);
    else states.delete(key);

    if (error) item.reject(error);
    else item.resolve(value);
  }

  function runNext(key, state) {
    if (state.running || state.queue.length === 0) {
      if (!state.running && state.queue.length === 0) states.delete(key);
      return;
    }

    const item = state.queue.shift();
    state.running = true;

    Promise.resolve()
      .then(item.task)
      .then(
        value => finish(key, state, item, null, value),
        error => finish(key, state, item, error),
      );
  }

  function enqueue(key, task, options = {}) {
    if (typeof key !== 'string' || key.length === 0) {
      return Promise.reject(new TypeError('Scheduler key must be a non-empty string.'));
    }
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('Scheduler expects a function.'));
    }

    const priority = options.priority === 'high' ? 1 : 0;
    let state = states.get(key);

    if (!state) {
      state = { running: false, queue: [] };
      states.set(key, state);
    }

    const pendingCount = state.queue.length + (state.running ? 1 : 0);
    if (pendingCount >= maxPendingPerKey) {
      let evictIndex = -1;

      if (priority === 1) {
        for (let index = state.queue.length - 1; index >= 0; index--) {
          if (state.queue[index].priority === 0) {
            evictIndex = index;
            break;
          }
        }
      }

      if (evictIndex < 0) {
        if (!state.running && state.queue.length === 0) states.delete(key);
        return Promise.resolve(undefined);
      }

      const [evicted] = state.queue.splice(evictIndex, 1);
      evicted.reject(new Error('Channel queue was reprioritized for a direct mention; this reply was skipped.'));
    }

    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, priority };
      const insertBefore = state.queue.findIndex(queued => queued.priority < priority);

      if (insertBefore < 0) state.queue.push(item);
      else state.queue.splice(insertBefore, 0, item);

      runNext(key, state);
    });
  }

  function getStats(key) {
    if (typeof key === 'string') {
      const state = states.get(key);
      return state
        ? { running: state.running, queued: state.queue.length, maxPendingPerKey }
        : { running: false, queued: 0, maxPendingPerKey };
    }

    let running = 0;
    let queued = 0;
    for (const state of states.values()) {
      if (state.running) running++;
      queued += state.queue.length;
    }
    return { activeKeys: states.size, running, queued, maxPendingPerKey };
  }

  return {
    enqueue,
    getStats,
    has: key => states.has(key),
  };
}

module.exports = {
  createChannelStateStore,
  createTaskLimiter,
};
