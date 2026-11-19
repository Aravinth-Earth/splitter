/**
 * The page's lifecycle frames, without a browser.
 *
 * A group's end is announced with a frame, and a wipe that stopped part-way is announced with a
 * different one. The page has three sockets — host, member and resume — and every one of them has to
 * read those frames the same way, so the reading is one exported function rather than three copies
 * that can drift. Two promises are pinned here. An end leaves the group; a failed wipe does not,
 * because the socket is still attached, so navigating away would tell the person their group ended
 * when it did not. And the copy is checked for what it may not claim: a failed wipe deletes the keys
 * before the meta, so the records may already be gone and the message must not imply they are not.
 *
 * A wipe in progress refuses writes with a `refused` frame carrying the code `wiping`. That is not a
 * judgement about the write and not the group's end, so it is read the same way as the failed wipe:
 * the socket and the group view stay, and the status line says the group is being deleted.
 *
 * No jsdom and no browser: `public/app.js` is a plain ES module whose DOM wiring sits behind a
 * guard, so node can import it and test the rules that decide what a frame means.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LEFT_MESSAGE,
  REMOVED_MESSAGE,
  WIPE_FAILED_MESSAGE,
  WIPING_MESSAGE,
  init,
  isWipingRefusal,
  lifecycleFrameOutcome
} from '../public/app.js';
import {
  deriveGroupKey,
  formatCode,
  generateCode,
  groupIdFromCode,
  idFromSecret,
  randomSecret,
  seal
} from '../public/crypto.js';
import { expenseAad } from '../public/expense.js';
import {
  codeFor,
  lastGroup,
  revsFor,
  saveCode,
  saveRevs,
  saveSession,
  sessionFor,
  setLastGroup
} from '../public/store.js';
import { cacheFor, outboxFor, saveCache, saveOutbox } from '../public/cache.js';

test('a wipe that failed keeps the group on screen and does not claim the data survived', () => {
  assert.equal(lifecycleFrameOutcome({ t: 'wipe-failed' }), 'stay', 'the group view is not left');

  assert.match(WIPE_FAILED_MESSAGE, /delete failed/i, 'the copy names the failed delete');
  assert.match(WIPE_FAILED_MESSAGE, /still exists/i, 'and says the group is still there');
  assert.match(
    WIPE_FAILED_MESSAGE,
    /some or all of its data may be gone/i,
    'and does not overpromise: the keys go before the meta, so the records may already be deleted'
  );
  assert.match(WIPE_FAILED_MESSAGE, /try again/i, 'and says what to do about it');
  assert.doesNotMatch(
    WIPE_FAILED_MESSAGE,
    /still open/i,
    'a half-wiped group is not "still open": it can exist with nothing in it'
  );
  assert.ok(
    WIPE_FAILED_MESSAGE.length <= 120,
    'the message is one status line, not a paragraph over the group'
  );
});

test('a refusal that says the group is being wiped keeps the socket and the group view', () => {
  assert.equal(
    isWipingRefusal({ t: 'refused', code: 'wiping' }),
    true,
    'the refusal the server sends mid-wipe is handled, not read as an end'
  );

  assert.match(WIPING_MESSAGE, /being deleted/i, 'the copy says the group is going');
  assert.match(WIPING_MESSAGE, /try again/i, 'and that a later attempt can work');
  assert.ok(WIPING_MESSAGE.length <= 120, 'it is a status line, not a paragraph');

  /* Every other refusal, and every other frame, is somebody else's answer. */
  for (const frame of [
    { t: 'refused', code: 'not_host' },
    { t: 'refused', code: 'unknown_group' },
    { t: 'refused' },
    { t: 'wipe-failed' },
    { t: 'ended' },
    {},
    null,
    undefined,
    'wiping',
    42
  ]) {
    assert.equal(
      isWipingRefusal(frame),
      false,
      `${JSON.stringify(frame) ?? String(frame)} is not a wiping refusal`
    );
  }
});

test('an ended frame still leaves the group, and every other frame changes nothing', () => {
  assert.equal(lifecycleFrameOutcome({ t: 'ended' }), 'leave', 'the end frame is the one that leaves');

  for (const frame of [
    { t: 'state' },
    { t: 'record' },
    { t: 'presence' },
    { t: 'conflict' },
    { t: 'left' },
    { t: 'refused', code: 'not_host' },
    {}
  ]) {
    assert.equal(
      lifecycleFrameOutcome(frame),
      null,
      `${frame.t ?? 'an empty frame'} must not move the page`
    );
  }
});

test('a frame that is not an object changes nothing and throws nothing', () => {
  for (const frame of [null, undefined, 'ended', 42, [], ['ended']]) {
    assert.equal(
      lifecycleFrameOutcome(frame),
      null,
      `${JSON.stringify(frame) ?? String(frame)} is not a frame`
    );
  }
});

/* --------------------------------------------------------------- the page */

/*
 * The rules above are pure, but the end and the chip are behaviours of the wired page: which
 * element is shown, which store was cleared, whether a timer still opens a socket. A fake DOM, a
 * fake clock and a fake WebSocket let these tests drive `init` exactly as a browser does, without
 * jsdom and without weakening what is asserted.
 */

const pageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageSource = readFileSync(join(pageRoot, 'public', 'index.html'), 'utf8');

const RECONNECTING = 'Reconnecting…';
const ENDED = 'This group has ended. It cannot be reopened.';

function attributesOf(source) {
  const attributes = {};
  for (const match of source.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)) {
    attributes[match[1]] = match[2] ?? '';
  }
  return attributes;
}

class FakeElement {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.hidden = Object.hasOwn(attributes, 'hidden');
    this.checked = Object.hasOwn(attributes, 'checked');
    this.disabled = Object.hasOwn(attributes, 'disabled');
    this.value = attributes.value ?? '';
    this.dataset = {};
    this.className = attributes.class ?? '';
    this.parentElement = null;
    this._text = '';
    this.childNodes = [];
    this.listeners = new Map();
    const classes = new Set((attributes.class ?? '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const wanted = force ?? !classes.has(name);
        if (wanted) classes.add(name);
        else classes.delete(name);
        return wanted;
      }
    };
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }

  addEventListener(type, listener, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ listener, once: options?.once === true });
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((entry) => entry.listener !== listener));
  }

  dispatch(type, event = {}) {
    const delivered = { type, preventDefault() {}, ...event };
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      if (entry.once) this.removeEventListener(type, entry.listener);
      entry.listener(delivered);
    }
  }

  append(...nodes) {
    this.childNodes.push(...nodes);
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
  }

  remove() {}

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'hidden') this.hidden = true;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  focus() {}

  blur() {}

  querySelectorAll() {
    return [];
  }

  querySelector() {
    return null;
  }

  click() {
    this.dispatch('click');
  }
}

function fakeDocument() {
  const byId = new Map();
  const elements = [];
  const body = new FakeElement('body');
  for (const match of pageSource.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/gs)) {
    const attributes = attributesOf(match[2]);
    const element = new FakeElement(match[1], attributes);
    element.parentElement = body;
    elements.push(element);
    if (attributes.id) byId.set(attributes.id, element);
  }
  return {
    documentElement: new FakeElement('html'),
    body,
    getElementById: (id) => byId.get(id) ?? null,
    querySelectorAll: (selector) => {
      const match = /^input\[name="([^"]+)"\]$/.exec(selector);
      if (!match) return [];
      return elements.filter(
        (element) => element.tagName === 'INPUT' && element.attributes.name === match[1]
      );
    },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag)
  };
}

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  emit(type, event = {}) {
    if (type === 'open') this.readyState = 1;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  message(frame) {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }

  drop(code = 1006) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code });
  }
}

function fakeStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    }
  };
}

function fakeClock() {
  let next = 0;
  let now = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay = 0) {
      const id = ++next;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, delay = 0) {
      const id = ++next;
      timers.set(id, { fn, at: now + delay, every: delay });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at > target) continue;
          if (due === null || timer.at < due.timer.at || (timer.at === due.timer.at && id < due.id)) {
            due = { id, timer };
          }
        }
        if (due === null) break;
        now = due.timer.at;
        if (due.timer.every !== undefined) due.timer.at = now + due.timer.every;
        else timers.delete(due.id);
        due.timer.fn();
      }
    }
  };
}

/**
 * A window whose address bar can be read and rewritten.
 *
 * The page strips a code it has consumed with `history.replaceState`, so the fake has one: writing
 * the address is the same act a browser performs, and `hash`/`search` follow it so a boot reads
 * what the bar actually holds.
 */
function fakeWindow({
  fetch = async () => ({ ok: true, status: 200 }),
  href = 'https://splitter.test/'
} = {}) {
  const clock = fakeClock();
  const location = { href };
  const syncAddress = () => {
    const here = new URL(location.href);
    location.hash = here.hash;
    location.search = here.search;
  };
  syncAddress();
  return {
    location,
    history: {
      replaceState(_state, _title, url) {
        if (typeof url === 'string') location.href = new URL(url, location.href).toString();
        syncAddress();
      }
    },
    navigator: { onLine: true },
    localStorage: fakeStorage(),
    sessionStorage: fakeStorage(),
    WebSocket: FakeSocket,
    fetch,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn, delay) => clock.setTimeout(fn, delay),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, delay) => clock.setInterval(fn, delay),
    clearInterval: (id) => clock.clearInterval(id),
    clock
  };
}

/** Put a URL in the tab's address bar, exactly as a paste into it would leave it. */
function setAddress(win, url) {
  win.location.href = url;
  const here = new URL(url);
  win.location.hash = here.hash;
  win.location.search = here.search;
}

/** Whether the address bar still carries a group code in its fragment or query. */
function addressCarriesCode(win) {
  return /[#?](?:code|c)=/i.test(`${win.location.hash}${win.location.search}`);
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(rounds = 10) {
  for (let index = 0; index < rounds; index += 1) await wait(2);
}

async function until(check, what, budgetMs = 4_000) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (check()) return;
    await wait(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function seatFor(displayName = 'Asha') {
  const code = generateCode();
  const groupId = await groupIdFromCode(code);
  const secret = randomSecret();
  const memberId = await idFromSecret(secret);
  const hostId = await idFromSecret(randomSecret());
  return { code, groupId, secret, memberId, hostId, displayName };
}

async function memberBlob(seat) {
  return seal(await deriveGroupKey(seat.code), { name: seat.displayName });
}

async function cachedState(seat, { records = [] } = {}) {
  const key = await deriveGroupKey(seat.code);
  const nameBlob = await seal(key, { name: 'Goa trip' });
  return {
    schema: 1,
    savedAt: Date.now(),
    nameBlob,
    metaBlob: null,
    hostId: seat.hostId,
    memberId: seat.memberId,
    role: 'member',
    joinMode: 'approval',
    roster: [
      { id: seat.memberId, status: 'approved', nameBlob: await seal(key, { name: seat.displayName }) }
    ],
    records
  };
}

async function stateFrame(seat, { records = [] } = {}) {
  const key = await deriveGroupKey(seat.code);
  return {
    t: 'state',
    role: 'member',
    hostId: seat.hostId,
    memberId: seat.memberId,
    joinMode: 'approval',
    nameBlob: await seal(key, { name: 'Goa trip' }),
    metaBlob: null,
    roster: [
      { id: seat.memberId, status: 'approved', nameBlob: await seal(key, { name: seat.displayName }) }
    ],
    records
  };
}

async function expenseRecord(seat) {
  const id = randomSecret();
  const value = {
    description: 'Dinner',
    amountPaise: 30_000,
    paidBy: [{ memberId: seat.memberId, amountPaise: 30_000 }],
    split: { [seat.memberId]: 30_000 },
    date: '2026-11-18',
    time: '20:00',
    note: ''
  };
  const blob = await seal(await deriveGroupKey(seat.code), value, expenseAad(seat.groupId, id));
  return { id, rev: 1, deleted: false, blob, author: seat.memberId, creator: seat.memberId, at: 1 };
}

function seedSeat(win, seat, { cache = null, revs = null, outbox = null } = {}) {
  saveSession(win.localStorage, {
    groupId: seat.groupId,
    memberId: seat.memberId,
    memberSecret: seat.secret,
    displayName: seat.displayName
  });
  saveCode(win.sessionStorage, seat.groupId, seat.code);
  setLastGroup(win.localStorage, seat.groupId);
  if (cache) saveCache(win.localStorage, seat.groupId, cache);
  if (revs) saveRevs(win.localStorage, seat.groupId, revs);
  if (outbox) saveOutbox(win.localStorage, seat.groupId, outbox);
}

async function bootPage({ seed, fetch, href } = {}) {
  const doc = fakeDocument();
  const win = fakeWindow({ fetch, href });
  seed?.(win);
  init(doc, win);
  return { doc, win, element: (id) => doc.getElementById(id) };
}

/**
 * A reload of the same tab: a fresh document and a fresh script, the same two stores and the same
 * address bar. Nothing from the old page survives except what the tab itself kept.
 */
async function reloadPage(page) {
  FakeSocket.instances = [];
  const doc = fakeDocument();
  init(doc, page.win);
  return { doc, win: page.win, element: (id) => doc.getElementById(id) };
}

function latestSocket() {
  return FakeSocket.instances.at(-1);
}

function chipOf(page) {
  return { hidden: page.element('connection').hidden, text: page.element('connection').textContent };
}

/** Reserve a stored seat and wait for its socket to be created. */
async function resumePage(seat, options = {}) {
  FakeSocket.instances = [];
  const page = await bootPage({
    fetch: options.fetch,
    href: options.href,
    seed: (win) => seedSeat(win, seat, options.seed)
  });
  await until(() => FakeSocket.instances.length > 0, 'the resume socket');
  return page;
}

/** A group screen with a connection that has spoken: the chip is hidden. */
async function shownGroup(seat, options = {}) {
  const page = await resumePage(seat, { seed: { cache: await cachedState(seat) }, ...options });
  const socket = latestSocket();
  socket.emit('open');
  socket.message(await stateFrame(seat));
  await until(() => page.element('group-header').hidden === false, 'the group screen');
  await until(() => chipOf(page).hidden, 'the chip to clear');
  return { page, socket };
}

/** A group screen whose connection has just dropped: the chip says Reconnecting…. */
async function droppedGroup(seat, options = {}) {
  const { page, socket } = await shownGroup(seat, options);
  socket.drop();
  await settle();
  return { page, socket };
}

/* ------------------------------------------------------------- the chip */

test('a group screen whose socket is closed reads exactly Reconnecting…', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const page = await resumePage(seat, { seed: { cache: await cachedState(seat) } });
  const socket = latestSocket();
  socket.emit('open');
  socket.message(await stateFrame(seat));
  await until(() => chipOf(page).hidden, 'the chip after the first state frame');

  socket.drop();
  await settle();

  assert.deepEqual(
    chipOf(page),
    { hidden: false, text: RECONNECTING },
    'the closed socket on a group screen says the one sentence, exactly'
  );
});

test('an open socket with no state frame does not clear the chip', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const { page, socket } = await droppedGroup(seat);
  assert.deepEqual(chipOf(page), { hidden: false, text: RECONNECTING }, 'the drop is visible');

  page.win.clock.advance(1_500);
  await until(() => FakeSocket.instances.length === 2, 'the reconnect attempt');
  const reconnected = latestSocket();
  assert.notEqual(reconnected, socket, 'the reconnect is a new socket');
  reconnected.emit('open');
  await settle();

  assert.deepEqual(
    chipOf(page),
    { hidden: false, text: RECONNECTING },
    'an open socket is not a speaking one: only a state frame clears the chip'
  );
});

test('the first state frame hides the chip and empties it', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const { page } = await droppedGroup(seat);
  page.win.clock.advance(1_500);
  await until(() => FakeSocket.instances.length === 2, 'the reconnect attempt');
  const reconnected = latestSocket();
  reconnected.emit('open');
  await settle();
  assert.equal(chipOf(page).hidden, false, 'the chip is up before the frame');

  reconnected.message(await stateFrame(seat));
  await until(() => chipOf(page).hidden, 'the state frame to clear the chip');

  assert.deepEqual(chipOf(page), { hidden: true, text: '' }, 'the first state frame ends the wait');
});

test('record, here, conflict, pong and a wiping refusal leave the chip unchanged', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const { page } = await droppedGroup(seat);
  page.win.clock.advance(1_500);
  await until(() => FakeSocket.instances.length === 2, 'the reconnect attempt');
  const reconnected = latestSocket();
  reconnected.emit('open');
  await settle();
  assert.deepEqual(chipOf(page), { hidden: false, text: RECONNECTING }, 'the chip starts up');

  const frames = [
    {
      t: 'record',
      id: randomSecret(),
      rev: 1,
      deleted: false,
      blob: null,
      author: seat.memberId,
      creator: seat.memberId,
      at: 1
    },
    { t: 'here', ids: [seat.memberId] },
    { t: 'conflict', id: randomSecret(), current: null },
    { t: 'pong' },
    { t: 'refused', code: 'wiping' }
  ];
  for (const frame of frames) {
    reconnected.message(frame);
    await settle();
    assert.deepEqual(
      chipOf(page),
      { hidden: false, text: RECONNECTING },
      `${frame.t} is not the frame that clears the chip`
    );
  }
});

test('a second drop shows Reconnecting… again', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const { page, socket } = await shownGroup(seat);
  assert.deepEqual(chipOf(page), { hidden: true, text: '' }, 'a spoken connection is quiet');

  socket.drop();
  await settle();
  assert.deepEqual(chipOf(page), { hidden: false, text: RECONNECTING }, 'the first drop is shown');

  page.win.clock.advance(1_500);
  await until(() => FakeSocket.instances.length === 2, 'the reconnect attempt');
  const reconnected = latestSocket();
  reconnected.emit('open');
  reconnected.message(await stateFrame(seat));
  await until(() => chipOf(page).hidden, 'the state frame after the reconnect');

  reconnected.drop();
  await settle();
  assert.deepEqual(
    chipOf(page),
    { hidden: false, text: RECONNECTING },
    'the next connection is asked to speak for itself'
  );
});

test('create, join and waiting screens clear the chip', async () => {
  /* Create, from a group screen that is showing a drop. */
  FakeSocket.instances = [];
  const seat = await seatFor();
  {
    const { page } = await droppedGroup(seat);
    assert.deepEqual(chipOf(page), { hidden: false, text: RECONNECTING }, 'the setup is visible');
    page.element('show-create').click();
    await settle();
    assert.equal(page.element('create-panel').hidden, false, 'the create panel is up');
    assert.deepEqual(chipOf(page), { hidden: true, text: '' }, 'create has no connection chip');
  }

  /* Join, from the same kind of group screen. */
  {
    FakeSocket.instances = [];
    const other = await seatFor('Balan');
    const { page } = await droppedGroup(other);
    assert.deepEqual(chipOf(page), { hidden: false, text: RECONNECTING }, 'the setup is visible');
    page.element('show-join').click();
    await settle();
    assert.equal(page.element('join-panel').hidden, false, 'the join panel is up');
    assert.deepEqual(chipOf(page), { hidden: true, text: '' }, 'join has no connection chip');
  }

  /* Waiting, reached through a join that is still connecting. */
  {
    FakeSocket.instances = [];
    const joiner = await seatFor('Chitra');
    const page = await bootPage();
    page.element('show-join').click();
    page.element('join-code').value = formatCode(joiner.code);
    page.element('join-name').value = joiner.displayName;
    page.element('join-form').dispatch('submit');
    await until(() => page.element('waiting-panel').hidden === false, 'the waiting panel');
    await until(() => FakeSocket.instances.length > 0, 'the join socket');
    await settle();
    assert.deepEqual(chipOf(page), { hidden: true, text: '' }, 'waiting has no connection chip');
  }
});

/* ------------------------------------------------------------------ the end */

test('an ended frame leaves no session, code, last-group, revisions, outbox or cache', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const record = await expenseRecord(seat);
  const queuedId = randomSecret();
  const queued = [
    {
      id: queuedId,
      frame: { t: 'put', id: queuedId, base: 0, deleted: false, blob: record.blob },
      baseBlob: null
    }
  ];
  const page = await resumePage(seat, {
    seed: { cache: await cachedState(seat, { records: [record] }), revs: { [record.id]: 1 }, outbox: queued }
  });
  const socket = latestSocket();
  socket.emit('open');
  socket.message(await stateFrame(seat, { records: [record] }));
  await settle();

  socket.message({ t: 'ended' });
  await until(() => page.element('create-panel').hidden === false, 'the created panel after an end');

  assert.equal(sessionFor(page.win.localStorage, seat.groupId), null, 'the seat is forgotten');
  assert.equal(codeFor(page.win.sessionStorage, seat.groupId), null, 'the code is forgotten');
  assert.equal(lastGroup(page.win.localStorage), null, 'the last group is forgotten');
  assert.deepEqual(revsFor(page.win.localStorage, seat.groupId), {}, 'no revisions are kept');
  assert.deepEqual(outboxFor(page.win.localStorage, seat.groupId), [], 'no queued write is kept');
  assert.equal(cacheFor(page.win.localStorage, seat.groupId), null, 'no cached state is kept');
});

test('an ended frame before any state still names the stored seat', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  /* No cache: the group id is not known to the page when the end arrives, so the stored last
     group is the only name the seat has. */
  const page = await resumePage(seat, { seed: {} });
  const socket = latestSocket();
  socket.emit('open');
  await settle();

  socket.message({ t: 'ended' });
  await until(() => page.element('create-panel').hidden === false, 'the create panel');

  assert.equal(sessionFor(page.win.localStorage, seat.groupId), null, 'the fallback seat is forgotten');
  assert.equal(codeFor(page.win.sessionStorage, seat.groupId), null, 'its code is forgotten too');
  assert.equal(lastGroup(page.win.localStorage), null, 'and the last group is cleared');
  assert.equal(page.element('session-notice').textContent, ENDED, 'it ends with the one sentence');
});

test('a second ended frame adds no second explanation', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const page = await resumePage(seat, { seed: { cache: await cachedState(seat) } });
  const socket = latestSocket();
  socket.emit('open');
  socket.message(await stateFrame(seat));
  await settle();

  socket.message({ t: 'ended' });
  await until(() => page.element('create-panel').hidden === false, 'the create panel');
  socket.message({ t: 'ended' });
  await settle();

  const notice = page.element('session-notice').textContent;
  assert.equal(notice, ENDED, 'the sentence is the one the page uses');
  assert.equal(notice.split('This group has ended').length - 1, 1, 'it is said once, not appended');
});

test('the ended frame shows the create panel and hides the group, its data and its confirmation', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const record = await expenseRecord(seat);
  const page = await resumePage(seat, {
    seed: { cache: await cachedState(seat, { records: [record] }), revs: { [record.id]: 1 } }
  });
  const socket = latestSocket();
  socket.emit('open');
  socket.message(await stateFrame(seat, { records: [record] }));
  await until(() => page.element('ledger').hidden === false, 'the ledger with an expense');
  assert.equal(page.element('balances').hidden, false, 'the balances are on screen');
  assert.equal(page.element('charts').hidden, false, 'the charts are on screen');
  assert.equal(page.element('export-panel').hidden, false, 'the export is on screen');

  page.element('end-group').click();
  assert.equal(page.element('lifecycle-confirm').hidden, false, 'the confirmation is open');

  socket.message({ t: 'ended' });
  await until(() => page.element('create-panel').hidden === false, 'the create panel after an end');

  for (const id of [
    'group-header',
    'ledger',
    'balances',
    'charts',
    'export-panel',
    'offline-banner',
    'waiting-panel',
    'lifecycle-confirm'
  ]) {
    assert.equal(page.element(id).hidden, true, `${id} is gone with the group`);
  }
});

test('no reconnect after an end, however far the clock runs', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const { page, socket } = await shownGroup(seat);
  socket.message({ t: 'ended' });
  await until(() => page.element('create-panel').hidden === false, 'the create panel');
  const sockets = FakeSocket.instances.length;

  page.win.clock.advance(10 * 60_000);
  await settle();

  assert.equal(FakeSocket.instances.length, sockets, 'the clock opened no new connection');
  assert.equal(
    FakeSocket.instances.every((opened) => opened.readyState === 3),
    true,
    'every socket stays closed'
  );
});

test('ending one group leaves another group\'s seat and copies untouched', async () => {
  FakeSocket.instances = [];
  const endedSeat = await seatFor('Asha');
  const keptSeat = await seatFor('Balan');
  const keptRecord = await expenseRecord(keptSeat);
  const keptCache = await cachedState(keptSeat, { records: [keptRecord] });
  const keptQueuedId = randomSecret();
  const keptOutbox = [
    {
      id: keptQueuedId,
      frame: { t: 'put', id: keptQueuedId, base: 0, deleted: false, blob: keptRecord.blob },
      baseBlob: null
    }
  ];

  const page = await resumePage(endedSeat, { seed: { cache: await cachedState(endedSeat) } });
  /* A second seat, written after the first so the ended group is the last one opened. */
  seedSeat(page.win, keptSeat, {
    cache: keptCache,
    revs: { [keptRecord.id]: 4 },
    outbox: keptOutbox
  });
  setLastGroup(page.win.localStorage, endedSeat.groupId);

  const socket = latestSocket();
  socket.emit('open');
  socket.message(await stateFrame(endedSeat));
  await settle();
  socket.message({ t: 'ended' });
  await until(() => page.element('create-panel').hidden === false, 'the create panel');

  assert.equal(sessionFor(page.win.localStorage, keptSeat.groupId)?.memberId, keptSeat.memberId);
  assert.equal(codeFor(page.win.sessionStorage, keptSeat.groupId), keptSeat.code);
  assert.equal(cacheFor(page.win.localStorage, keptSeat.groupId)?.memberId, keptSeat.memberId);
  assert.deepEqual(outboxFor(page.win.localStorage, keptSeat.groupId), keptOutbox);
  assert.deepEqual(revsFor(page.win.localStorage, keptSeat.groupId), { [keptRecord.id]: 4 });
});

test('a gone stored seat ends the same way and a live one keeps its seat', async () => {
  FakeSocket.instances = [];
  const gone = await seatFor();
  const gonePage = await bootPage({
    fetch: async () => ({ ok: false, status: 404 }),
    seed: (win) => seedSeat(win, gone)
  });
  await until(() => gonePage.element('create-panel').hidden === false, 'the create panel');
  await settle();

  assert.equal(gonePage.element('session-notice').textContent, ENDED, 'the same ending sentence');
  assert.equal(sessionFor(gonePage.win.localStorage, gone.groupId), null, 'the gone seat is dropped');
  assert.equal(codeFor(gonePage.win.sessionStorage, gone.groupId), null, 'and its code');

  const live = await seatFor('Divya');
  const livePage = await bootPage({
    fetch: async () => ({ ok: true, status: 200 }),
    seed: (win) => seedSeat(win, live)
  });
  await until(() => livePage.element('waiting-panel').hidden === false, 'the waiting panel');
  await settle();

  assert.equal(sessionFor(livePage.win.localStorage, live.groupId)?.memberId, live.memberId, 'a live seat stays');
  assert.equal(codeFor(livePage.win.sessionStorage, live.groupId), live.code, 'and so does its code');
  assert.equal(lastGroup(livePage.win.localStorage), live.groupId, 'and the last group');
});

test('a failed wipe and a wiping refusal leave the seat, the screen and the chip alone', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const { page, socket } = await shownGroup(seat);
  const before = {
    session: sessionFor(page.win.localStorage, seat.groupId),
    code: codeFor(page.win.sessionStorage, seat.groupId),
    last: lastGroup(page.win.localStorage),
    chip: chipOf(page)
  };

  for (const frame of [{ t: 'wipe-failed' }, { t: 'refused', code: 'wiping' }]) {
    socket.message(frame);
    await settle();

    assert.deepEqual(sessionFor(page.win.localStorage, seat.groupId), before.session, `${frame.t} keeps the seat`);
    assert.equal(codeFor(page.win.sessionStorage, seat.groupId), before.code, `${frame.t} keeps the code`);
    assert.equal(lastGroup(page.win.localStorage), before.last, `${frame.t} keeps the last group`);
    assert.equal(page.element('create-panel').hidden, true, `${frame.t} stays on the group`);
    assert.equal(page.element('group-header').hidden, false, `${frame.t} keeps the screen`);
    assert.deepEqual(chipOf(page), before.chip, `${frame.t} changes no connection chip`);
  }
});

/* ------------------------------------------------- the session's last screen */

/*
 * A session ends in one of three ways: the organizer ends the group, this person leaves it, or the
 * organizer removes them. Each one has a sentence of its own and each one ends in the same place —
 * the landing screen, with that session's stores gone — and none of them reaches into another
 * group the tab also holds a seat for.
 */

test('a left frame before any state clears the seat the stored last group names', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  /* No cache: the group id is not on screen when the leave arrives, so the stored last group is
     the only name this seat has. */
  const page = await resumePage(seat, { seed: {} });
  const socket = latestSocket();
  socket.emit('open');
  await settle();

  socket.message({ t: 'left' });
  await until(() => page.element('create-panel').hidden === false, 'the landing screen');

  assert.equal(sessionFor(page.win.localStorage, seat.groupId), null, 'the seat is forgotten');
  assert.equal(codeFor(page.win.sessionStorage, seat.groupId), null, 'the code is forgotten');
  assert.equal(lastGroup(page.win.localStorage), null, 'the last-group pointer is cleared');
  assert.equal(page.element('session-notice').textContent, LEFT_MESSAGE, 'the leave sentence is said');
  assert.equal(page.element('join-panel').hidden, true, 'the landing screen, not the join sheet');
});

test('a removed frame on the resume path clears the seat and lands with the removal sentence', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const page = await resumePage(seat, { seed: { cache: await cachedState(seat) } });
  const socket = latestSocket();
  socket.emit('open');

  socket.message({ t: 'removed' });
  await until(() => page.element('create-panel').hidden === false, 'the landing screen');

  assert.equal(sessionFor(page.win.localStorage, seat.groupId), null, 'the seat is forgotten');
  assert.equal(codeFor(page.win.sessionStorage, seat.groupId), null, 'the code is forgotten');
  assert.equal(lastGroup(page.win.localStorage), null, 'the last group is forgotten');
  assert.equal(page.element('session-notice').textContent, REMOVED_MESSAGE, 'the removal sentence');
  assert.equal(page.element('join-panel').hidden, true, 'the landing screen, not the join sheet');
});

test('a removed frame on the join path clears the seat and lands with the removal sentence', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor('Chitra');
  const page = await bootPage();
  page.element('show-join').click();
  page.element('join-code').value = formatCode(seat.code);
  page.element('join-name').value = seat.displayName;
  page.element('join-form').dispatch('submit');
  await until(() => page.element('waiting-panel').hidden === false, 'the waiting panel');
  await until(() => FakeSocket.instances.length > 0, 'the join socket');

  const socket = latestSocket();
  socket.emit('open');
  socket.message({ t: 'waiting', memberId: seat.memberId });
  await until(() => sessionFor(page.win.localStorage, seat.groupId) !== null, 'the saved seat');

  socket.message({ t: 'removed' });
  await until(() => page.element('create-panel').hidden === false, 'the landing screen');

  assert.equal(sessionFor(page.win.localStorage, seat.groupId), null, 'the pending seat is forgotten');
  assert.equal(codeFor(page.win.sessionStorage, seat.groupId), null, 'the code is forgotten');
  assert.equal(lastGroup(page.win.localStorage), null, 'the last group is forgotten');
  assert.equal(page.element('session-notice').textContent, REMOVED_MESSAGE, 'the removal sentence');
  assert.equal(page.element('join-panel').hidden, true, 'the landing screen, not the join sheet');
});

test('an end, a leave and a removal each leave no group code in the address bar', async () => {
  for (const reason of ['ended', 'left', 'removed']) {
    FakeSocket.instances = [];
    const seat = await seatFor();
    const { page, socket } = await shownGroup(seat);

    /* The bar carries the invite code at the instant the session ends — the state an invite link
       opened in this tab leaves behind. */
    setAddress(page.win, `https://splitter.test/#code=${seat.code}`);
    assert.equal(addressCarriesCode(page.win), true, `${reason}: the setup carries a code`);

    socket.message({ t: reason });
    await until(() => page.element('create-panel').hidden === false, `the landing screen after ${reason}`);

    assert.equal(
      addressCarriesCode(page.win),
      false,
      `${reason} leaves no code in the address bar`
    );
  }
});

test('reloading the URL where a session ended resumes nothing, prefills nothing and says why', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const page = await resumePage(seat, {
    href: `https://splitter.test/#code=${seat.code}`,
    seed: { cache: await cachedState(seat) }
  });
  const socket = latestSocket();
  socket.emit('open');
  socket.message(await stateFrame(seat));
  await until(() => page.element('group-header').hidden === false, 'the group screen');

  socket.message({ t: 'ended' });
  await until(() => page.element('create-panel').hidden === false, 'the landing screen');
  assert.equal(addressCarriesCode(page.win), false, 'the code is gone before the reload');

  const reloaded = await reloadPage(page);
  await settle();

  assert.equal(FakeSocket.instances.length, 0, 'a reload of that URL resumes nothing');
  assert.equal(sessionFor(page.win.localStorage, seat.groupId), null, 'the seat is still gone');
  assert.equal(codeFor(page.win.sessionStorage, seat.groupId), null, 'the code is still gone');
  assert.equal(lastGroup(page.win.localStorage), null, 'no group is offered back');
  assert.equal(reloaded.element('create-panel').hidden, false, 'the landing screen');
  assert.equal(reloaded.element('join-panel').hidden, true, 'not the join sheet');
  assert.equal(reloaded.element('join-code').value, '', 'nothing is prefilled');
  assert.equal(
    reloaded.element('session-notice').textContent,
    ENDED,
    'the sentence belongs to the session that ended'
  );
});

test('a code consumed by a resume leaves the address bar and the tab still comes back to the seat', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const page = await resumePage(seat, {
    href: `https://splitter.test/#code=${seat.code}`,
    seed: { cache: await cachedState(seat) }
  });

  assert.equal(addressCarriesCode(page.win), false, 'the consumed code is out of the address bar');

  const socket = latestSocket();
  socket.emit('open');
  socket.message(await stateFrame(seat));
  await until(() => page.element('group-header').hidden === false, 'the group screen');
  assert.equal(codeFor(page.win.sessionStorage, seat.groupId), seat.code, 'the tab still holds the code');
  assert.equal(lastGroup(page.win.localStorage), seat.groupId, 'and the seat it names');

  const reloaded = await reloadPage(page);
  await until(() => FakeSocket.instances.length > 0, 'the resume socket after a reload');
  const again = latestSocket();
  again.emit('open');
  again.message(await stateFrame(seat));
  await until(() => reloaded.element('group-header').hidden === false, 'the seat after a reload');
  assert.equal(addressCarriesCode(reloaded.win), false, 'and no code came back with it');
});

test('leaving or being removed from one group leaves another group untouched', async () => {
  for (const reason of ['left', 'removed']) {
    FakeSocket.instances = [];
    const closedSeat = await seatFor('Asha');
    const keptSeat = await seatFor('Balan');
    const keptRecord = await expenseRecord(keptSeat);
    const keptCache = await cachedState(keptSeat, { records: [keptRecord] });
    const keptQueuedId = randomSecret();
    const keptOutbox = [
      {
        id: keptQueuedId,
        frame: { t: 'put', id: keptQueuedId, base: 0, deleted: false, blob: keptRecord.blob },
        baseBlob: null
      }
    ];

    const page = await resumePage(closedSeat, { seed: { cache: await cachedState(closedSeat) } });
    const socket = latestSocket();
    socket.emit('open');
    socket.message(await stateFrame(closedSeat));
    await until(() => page.element('group-header').hidden === false, 'the group screen');

    /* A second seat, written after the first so it is the group this tab would go back to. */
    seedSeat(page.win, keptSeat, {
      cache: keptCache,
      revs: { [keptRecord.id]: 4 },
      outbox: keptOutbox
    });
    setLastGroup(page.win.localStorage, keptSeat.groupId);

    socket.message({ t: reason });
    await until(() => page.element('create-panel').hidden === false, `the landing screen after ${reason}`);

    assert.equal(sessionFor(page.win.localStorage, closedSeat.groupId), null, `${reason}: the closed seat is gone`);
    assert.equal(codeFor(page.win.sessionStorage, closedSeat.groupId), null, `${reason}: and its code`);

    assert.equal(
      sessionFor(page.win.localStorage, keptSeat.groupId)?.memberId,
      keptSeat.memberId,
      `${reason} keeps the other group's seat`
    );
    assert.equal(codeFor(page.win.sessionStorage, keptSeat.groupId), keptSeat.code, 'and its code');
    assert.equal(
      cacheFor(page.win.localStorage, keptSeat.groupId)?.memberId,
      keptSeat.memberId,
      'and its cached state'
    );
    assert.deepEqual(outboxFor(page.win.localStorage, keptSeat.groupId), keptOutbox, 'and its outbox');
    assert.deepEqual(
      revsFor(page.win.localStorage, keptSeat.groupId),
      { [keptRecord.id]: 4 },
      'and its revisions'
    );
    assert.equal(
      lastGroup(page.win.localStorage),
      keptSeat.groupId,
      'the pointer to the other group is not cleared'
    );
  }
});

test('a code consumed by a join leaves the address bar and the seat is kept', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor('Devi');
  const page = await bootPage({ href: `https://splitter.test/#code=${seat.code}` });
  await settle();
  assert.equal(page.element('join-panel').hidden, false, 'the invite opens the join sheet');
  assert.equal(page.element('join-code').value, formatCode(seat.code), 'with the code in the field');
  assert.equal(addressCarriesCode(page.win), true, 'the setup carries the code');

  page.element('join-name').value = seat.displayName;
  page.element('join-form').dispatch('submit');
  await until(() => page.element('waiting-panel').hidden === false, 'the waiting panel');
  await until(() => FakeSocket.instances.length > 0, 'the join socket');

  const socket = latestSocket();
  socket.emit('open');
  socket.message({ t: 'waiting', memberId: seat.memberId });
  await until(() => sessionFor(page.win.localStorage, seat.groupId) !== null, 'the saved seat');

  assert.equal(addressCarriesCode(page.win), false, 'the consumed code is out of the address bar');
  assert.equal(codeFor(page.win.sessionStorage, seat.groupId), seat.code, 'the tab still holds it');
});

test('a re-join after a leave stores the seat again', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor('Farah');
  const { page, socket } = await shownGroup(seat);
  socket.message({ t: 'left' });
  await until(() => page.element('create-panel').hidden === false, 'the landing screen');
  assert.equal(sessionFor(page.win.localStorage, seat.groupId), null, 'the leave forgot the seat');

  page.element('show-join').click();
  page.element('join-code').value = formatCode(seat.code);
  page.element('join-name').value = seat.displayName;
  page.element('join-form').dispatch('submit');
  await until(() => page.element('waiting-panel').hidden === false, 'the waiting panel for the re-join');
  await until(() => FakeSocket.instances.length > 1, 'the re-join socket');

  const again = latestSocket();
  again.emit('open');
  again.message({ t: 'waiting', memberId: seat.memberId });
  await until(
    () => sessionFor(page.win.localStorage, seat.groupId) !== null,
    'the seat stored by the re-join'
  );

  assert.equal(codeFor(page.win.sessionStorage, seat.groupId), seat.code, 'the re-join keeps the code');
  assert.equal(lastGroup(page.win.localStorage), seat.groupId, 'and names the group');
});

test('a sentence for one session does not outlive it in the tab', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const { page, socket } = await shownGroup(seat);
  socket.message({ t: 'ended' });
  await until(() => page.element('create-panel').hidden === false, 'the landing screen');
  assert.equal(page.element('session-notice').textContent, ENDED, 'the end is said');

  /* Another session starts in the same tab: a join for a different group. */
  const other = await seatFor('Gita');
  page.element('show-join').click();
  page.element('join-code').value = formatCode(other.code);
  page.element('join-name').value = other.displayName;
  page.element('join-form').dispatch('submit');
  await until(() => page.element('waiting-panel').hidden === false, 'the waiting panel');
  await until(() => FakeSocket.instances.length > 1, 'the join socket');

  const joining = latestSocket();
  joining.emit('open');
  joining.message({ t: 'waiting', memberId: other.memberId });
  await until(() => sessionFor(page.win.localStorage, other.groupId) !== null, 'the new seat');

  /* The organizer declines: the new seat is forgotten, and a reload has nothing to resume. */
  joining.message({ t: 'refused', code: 'declined' });
  await settle();

  const reloaded = await reloadPage(page);
  await settle();
  assert.equal(
    reloaded.element('session-notice').textContent,
    '',
    'the sentence written for the ended session is not said for a later one'
  );
});

test('an end leaves no reconnecting socket, no flushed write and no late copy', async () => {
  FakeSocket.instances = [];
  const seat = await seatFor();
  const record = await expenseRecord(seat);
  const firstQueued = randomSecret();
  const secondQueued = randomSecret();
  const queued = [
    {
      id: firstQueued,
      frame: { t: 'put', id: firstQueued, base: 0, deleted: false, blob: record.blob },
      baseBlob: null
    },
    {
      id: secondQueued,
      frame: { t: 'put', id: secondQueued, base: 0, deleted: false, blob: record.blob },
      baseBlob: null
    }
  ];
  const page = await resumePage(seat, {
    seed: { cache: await cachedState(seat), outbox: queued }
  });
  const socket = latestSocket();
  socket.emit('open');
  /* The queue is paced: one write now, the second half a second later. */
  await settle();
  assert.equal(socket.sent.length, 2, 'the first write and the second are sent in turn');

  socket.message({ t: 'ended' });
  await until(() => page.element('create-panel').hidden === false, 'the landing screen');
  const sentBefore = socket.sent.length;

  page.win.clock.advance(10 * 60_000);
  await settle();

  assert.equal(FakeSocket.instances.length, 1, 'the clock opened no new connection');
  assert.equal(socket.readyState, 3, 'the socket stays closed');
  assert.equal(socket.sent.length, sentBefore, 'no queued write went out after the end');
  assert.deepEqual(outboxFor(page.win.localStorage, seat.groupId), [], 'and none was written back');

  /* A record frame in flight when the end arrived must not leave a revision or a cached copy
     behind either: the group is gone, and its stores stay gone. */
  socket.message({ t: 'record', ...record });
  await settle();
  assert.deepEqual(revsFor(page.win.localStorage, seat.groupId), {}, 'no revision is kept');
  assert.equal(cacheFor(page.win.localStorage, seat.groupId), null, 'no cached state is kept');
});
