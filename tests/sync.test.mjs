/**
 * The reconnecting socket, without a browser.
 *
 * A fake WebSocket and a fake clock make the loop observable: the auth frame is always first, a
 * queued frame is resent after a drop until it is acknowledged, and a deliberate close stops.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { GroupSocket, MAX_DELAY_MS, MIN_DELAY_MS, backoffDelay } from '../public/sync.js';

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    FakeSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  close() {
    this.readyState = 3;
    for (const fn of this.listeners.close ?? []) fn({});
  }

  emit(type, event = {}) {
    if (type === 'open') this.readyState = 1;
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
}

function fakeWindow() {
  let next = 0;
  const timers = new Map();

  return {
    WebSocket: FakeSocket,
    setTimeout(fn) {
      const id = ++next;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn) {
      const id = ++next;
      timers.set(id, fn);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    run(id) {
      const fn = timers.get(id);
      timers.delete(id);
      fn?.();
    },
    runAll() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    pending() {
      return timers.size;
    },
    addEventListener() {},
    removeEventListener() {}
  };
}

test('sync: backoff grows from half a second to a ten-second ceiling with jitter', () => {
  assert.equal(backoffDelay(0, () => 0), MIN_DELAY_MS);
  assert.equal(backoffDelay(0, () => 1), MIN_DELAY_MS * 1.2);
  assert.equal(backoffDelay(4, () => 0), 8_000 * 0.8);
  assert.equal(backoffDelay(5, () => 0), MAX_DELAY_MS * 0.8);
  assert.equal(backoffDelay(5, () => 1), MAX_DELAY_MS);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const delay = backoffDelay(attempt, Math.random);
    assert.ok(delay >= MIN_DELAY_MS && delay <= MAX_DELAY_MS);
  }
});

test('sync: auth is first, queued frames survive a drop, and an ack retires one', () => {
  FakeSocket.instances = [];
  const win = fakeWindow();
  const frames = [];
  const statuses = [];
  const socket = new GroupSocket({
    url: 'ws://test/api/ws',
    auth: { t: 'auth', id: 'member' },
    win,
    onFrame: (frame) => frames.push(frame),
    onStatus: (status) => statuses.push(status)
  });

  socket.send({ t: 'put', id: 'one' }, { id: 'one' });
  assert.equal(socket.queue.length, 1, 'a frame sent while down is queued');

  socket.connect();
  const first = FakeSocket.instances.at(-1);
  first.emit('open');
  assert.deepEqual(first.sent[0], { t: 'auth', id: 'member' }, 'auth precedes the queue');
  assert.deepEqual(first.sent[1], { t: 'put', id: 'one' });
  assert.equal(socket.isOpen, true);

  socket.send({ t: 'put', id: 'two' }, { id: 'two' });
  assert.equal(first.sent.at(-1).id, 'two');
  assert.equal(socket.queue.length, 2);

  first.emit('message', { data: JSON.stringify({ t: 'record', id: 'two' }) });
  assert.deepEqual(frames, [{ t: 'record', id: 'two' }]);
  assert.ok(statuses.includes('open'));

  first.emit('close');
  assert.ok(statuses.includes('reconnecting'));
  assert.ok(win.pending() >= 1, 'a reconnect is scheduled');
  win.runAll();

  const second = FakeSocket.instances.at(-1);
  assert.notEqual(second, first);
  second.emit('open');
  assert.deepEqual(second.sent[0], { t: 'auth', id: 'member' });
  assert.deepEqual(
    second.sent.slice(1).map((frame) => frame.id),
    ['one', 'two'],
    'unacknowledged frames are sent again'
  );

  socket.ack('two');
  assert.deepEqual(socket.queue.map((entry) => entry.id), ['one']);

  second.emit('close');
  win.runAll();
  const third = FakeSocket.instances.at(-1);
  third.emit('open');
  assert.deepEqual(
    third.sent.slice(1).map((frame) => frame.id),
    ['one'],
    'an acknowledged frame is not replayed'
  );

  socket.close();
  assert.equal(socket.queue.length, 1);
  assert.equal(win.pending(), 0, 'a deliberate close does not schedule another attempt');
});

test('sync: a refusal close is final, not a reconnect loop', () => {
  FakeSocket.instances = [];
  const win = fakeWindow();
  const statuses = [];
  const socket = new GroupSocket({
    url: 'ws://test/api/ws',
    auth: { t: 'auth', id: 'member' },
    win,
    onFrame: () => {},
    onStatus: (status) => statuses.push(status)
  });

  socket.connect();
  const first = FakeSocket.instances.at(-1);
  first.emit('open');
  first.emit('close', { code: 1008 });

  assert.ok(statuses.includes('closed'));
  assert.equal(win.pending(), 0, 'no retry is scheduled after a refusal');
  assert.equal(socket.isOpen, false);
});
