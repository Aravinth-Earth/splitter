/**
 * The organizer's create, end to end, across two browsers.
 *
 * This is the gate for the item "the organizer creates a group and lands inside it": every
 * acceptance criterion is driven through `init` on the real page module, against a real
 * `/api/create` contract, and the last case opens a second page holding only the code. Nothing here
 * asserts on a helper in isolation — the subject is what a person sees and what the page sends.
 *
 * The server is a small model of the Worker's contract rather than the Worker itself, because the
 * Worker's own half of this is pinned over HTTP in `create.test.mjs`. What is modelled is the part
 * the page depends on: `created` says whether the code named a new group or one that already
 * existed, and a full ledger answers `{error:'limit'}` without adding anything.
 *
 * No jsdom and no browser: the page's DOM wiring sits behind a guard, so `init` is handed a
 * stand-in document and window, the same way `lifecycle.test.mjs` and `page-actions.test.mjs` do.
 * Every assertion names the guarantee, so a failure reports the promise rather than a line.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { COLLISION_MESSAGE, OFFLINE_MESSAGE, init } from '../public/app.js';
import { formatCode } from '../public/crypto.js';

const pageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageSource = readFileSync(join(pageRoot, 'public', 'index.html'), 'utf8');

/* A group name is a name a person typed, so the fixtures below are the two scripts the page
   promises to count one character at a time. */
const TAMIL = 'தமிழ்';
const EMOJI = '🙂';

/* ------------------------------------------------------------------ the server */

const CAP = 25;

function answer(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

/**
 * `/api/create` and `/api/room`, as the page reads them.
 *
 * `groups` is the ledger: one id per live group. `collide` makes the next N creates answer the way
 * a code that already names a group does — `created: false` — and `fail` makes every create answer
 * a 500, which is the retry-able failure. `requests` is every create body received, in order, so
 * "exactly one request" and "a fresh code on the retry" are observed rather than inferred.
 */
function fakeServer({ live = 0, cap = CAP } = {}) {
  const state = {
    cap,
    groups: new Set(),
    requests: [],
    collide: 0,
    fail: false,
    roomMissing: false
  };

  for (let index = 0; index < live; index += 1) state.groups.add(`live-${index}`);

  state.fetch = async (url, init_ = {}) => {
    const href = String(url);
    if (/\/api\/room\b/.test(href)) {
      return state.roomMissing ? answer({ error: 'missing' }, 404) : answer({ ok: true });
    }

    const body = JSON.parse(init_.body);
    state.requests.push(body);

    if (state.fail) return answer({ error: 'internal' }, 500);
    /* A code that already names a group is answered before the cap: the group is already counted,
       so a retry of a live group is never "full". */
    if (state.collide > 0) {
      state.collide -= 1;
      return answer({ ok: true, created: false });
    }
    if (state.groups.has(body.groupId)) return answer({ ok: true, created: false });
    if (state.groups.size >= state.cap) return answer({ error: 'limit' }, 429);

    state.groups.add(body.groupId);
    return answer({ ok: true, created: true });
  };

  return state;
}

/* ---------------------------------------------------------------------- the DOM */

let elementCount = 0;

class FakeElement {
  constructor(tag, attributes = {}) {
    this.uid = ++elementCount;
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.hidden = Object.hasOwn(attributes, 'hidden');
    this.checked = Object.hasOwn(attributes, 'checked');
    this.disabled = Object.hasOwn(attributes, 'disabled');
    this.value = attributes.value ?? '';
    this.type = attributes.type ?? '';
    this.dataset = {};
    this.className = attributes.class ?? '';
    this.parentElement = null;
    this.childNodes = [];
    this.style = {};
    this._text = '';
    this.listeners = new Map();
  }

  get classList() {
    const self = this;
    const names = () => new Set(String(self.className).split(/\s+/).filter(Boolean));
    const write = (set) => {
      self.className = [...set].join(' ');
    };
    return {
      add: (...values) => {
        const set = names();
        values.forEach((value) => set.add(value));
        write(set);
      },
      remove: (...values) => {
        const set = names();
        values.forEach((value) => set.delete(value));
        write(set);
      },
      contains: (value) => names().has(value),
      toggle: (value, force) => {
        const set = names();
        const wanted = force ?? !set.has(value);
        if (wanted) set.add(value);
        else set.delete(value);
        write(set);
        return wanted;
      }
    };
  }

  get textContent() {
    return this._text + this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
  }

  get options() {
    return descendants(this).filter((child) => child.tagName === 'OPTION');
  }

  get selectedIndex() {
    return this.options.findIndex((option) => option.checked);
  }

  set selectedIndex(index) {
    this.options.forEach((option, position) => {
      option.checked = position === index;
    });
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

  click() {
    this.dispatch('click');
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    node.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'hidden') this.hidden = true;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'hidden') this.hidden = false;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  focus() {}

  blur() {}

  select() {}

  scrollIntoView() {}

  querySelectorAll(selector) {
    const wanted = /^([a-zA-Z][\w-]*)(?:\[name="([^"]+)"\])?$/.exec(String(selector).trim());
    if (!wanted) return [];
    return descendants(this).filter(
      (node) =>
        node.tagName === wanted[1].toUpperCase() &&
        (wanted[2] === undefined || node.attributes.name === wanted[2])
    );
  }

  querySelector() {
    return null;
  }
}

function descendants(node) {
  const nodes = [];
  for (const child of node.childNodes) {
    if (!(child instanceof FakeElement)) continue;
    nodes.push(child, ...descendants(child));
  }
  return nodes;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr'
]);

function attributesOf(source) {
  const attributes = {};
  for (const match of String(source).matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g
  )) {
    attributes[match[1]] = match[2] ?? match[3] ?? '';
  }
  return attributes;
}

/** index.html as a real tree, so a hidden panel really hides the controls under it. */
function parsePage(source) {
  const html = new FakeElement('html');
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  html.append(head, body);

  let current = head;
  const tags = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let last = 0;
  let match;
  while ((match = tags.exec(source))) {
    const text = source.slice(last, match.index);
    if (text.trim() && current) current._text += text;
    last = tags.lastIndex;

    const [, closing, name, rawAttributes, selfClosing] = match;
    const tag = name.toLowerCase();
    if (tag === 'html' || tag === 'head') continue;
    if (tag === 'body') {
      if (!closing) current = body;
      continue;
    }
    if (tag === 'script' || tag === 'style') continue;
    if (closing) {
      let node = current;
      while (node && node !== body && node !== head && node.tagName.toLowerCase() !== tag) {
        node = node.parentElement;
      }
      if (node && node !== body && node !== head) current = node.parentElement ?? body;
      continue;
    }
    const element = new FakeElement(tag, attributesOf(rawAttributes));
    current.append(element);
    if (!VOID_TAGS.has(tag) && selfClosing !== '/') current = element;
  }

  return { html, body };
}

function fakeDocument() {
  const { html, body } = parsePage(pageSource);
  const all = () => descendants(html);
  return {
    documentElement: html,
    body,
    getElementById(id) {
      return all().find((node) => node.attributes.id === id) ?? null;
    },
    querySelectorAll(selector) {
      const wanted = /^([a-zA-Z][\w-]*)(?:\[name="([^"]+)"\])?$/.exec(String(selector).trim());
      if (!wanted) return [];
      return all().filter(
        (node) =>
          node.tagName === wanted[1].toUpperCase() &&
          (wanted[2] === undefined || node.attributes.name === wanted[2])
      );
    },
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag)
  };
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

/** Sockets this page opened, so the test can speak for the server on the page's own wire. */
function socketFactory() {
  const instances = [];

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.listeners = new Map();
      instances.push(this);
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
  }

  return { instances, Ctor: FakeSocket };
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

function fakeWindow({ server, href = 'https://splitter.test/', sockets }) {
  const location = { href, hash: new URL(href).hash, search: new URL(href).search };
  const copied = [];
  /* The page's own timers are virtual: the heartbeat and the reconnect backoff must not outlive
     the test, and the socket's queue flush sends its first frame without waiting for a gap. */
  const clock = fakeClock();
  return {
    location,
    copied,
    clock,
    history: {
      replaceState(_state, _title, url) {
        if (typeof url === 'string') location.href = new URL(url, location.href).toString();
      }
    },
    navigator: {
      onLine: true,
      clipboard: {
        writeText: async (text) => {
          copied.push(text);
        }
      }
    },
    localStorage: fakeStorage(),
    sessionStorage: fakeStorage(),
    WebSocket: sockets.Ctor,
    fetch: server.fetch,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn, delay) => clock.setTimeout(fn, delay),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, delay) => clock.setInterval(fn, delay),
    clearInterval: (id) => clock.clearInterval(id)
  };
}

/* ------------------------------------------------------------------- the pages */

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, budgetMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (check()) return;
    await wait(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A few turns of the loop, for the work a handler starts that `until` saw begin but not finish. */
async function settle(rounds = 10) {
  for (let index = 0; index < rounds; index += 1) await wait(2);
}

/** The chip's sentence, without the initials on the avatars beside it. */
function chipText(page) {
  const sentence = descendants(page.element('presence')).find((node) =>
    node.className.split(' ').includes('presence-text')
  );
  return sentence ? sentence.textContent.trim() : '';
}

/** One browser: the real page wired to its own document, storage and socket list. */
function openPage(server, { href } = {}) {
  const doc = fakeDocument();
  const sockets = socketFactory();
  const win = fakeWindow({ server, href, sockets });
  init(doc, win);
  return {
    doc,
    win,
    sockets,
    element: (id) => doc.getElementById(id),
    text: (id) => doc.getElementById(id).textContent.trim()
  };
}

/** Type the three fields and press Create, exactly as the form does. */
function pressCreate(page, { name = 'Goa trip', display = 'Asha', currency = 'INR' } = {}) {
  page.element('group-name').value = name;
  page.element('display-name').value = display;
  page.element('currency').value = currency;
  page.element('create-form').dispatch('submit');
}

/* --------------------------------------------------------------------- the gate */

test('create: the name, currency and my name land in the group view with no second screen', async () => {
  const server = fakeServer();
  const page = openPage(server);

  const started = Date.now();
  pressCreate(page, { name: ' Goa trip ', display: ' Asha ' });
  await until(() => !page.element('group-header').hidden, 'the group view');
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2_000, `the group view must open within 2 s, took ${elapsed} ms`);
  assert.equal(server.requests.length, 1, 'one press of Create is one request');
  assert.equal(server.groups.size, 1, 'the request made exactly one group');

  /* No intermediate screen: the form, the join sheet and the waiting sheet are all put away in the
     same step that brings the group up. */
  assert.equal(page.element('create-panel').hidden, true, 'the create form is replaced, not covered');
  assert.equal(page.element('join-panel').hidden, true, 'the join sheet is not a step of creating');
  assert.equal(page.element('waiting-panel').hidden, true, 'an organizer never waits to be admitted');
  assert.equal(page.element('ledger').hidden, true, 'an empty group has no ledger list to show');

  /* The header: what the group is called, the code as it is read aloud, and who I am in it. */
  assert.equal(page.text('group-name-display'), 'Goa trip', 'the typed name is trimmed and shown');
  const code = page.text('group-code');
  assert.match(code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/, `the code must read as XXXX-XXXX-XXXX-XXXX, got "${code}"`);
  assert.equal(code, formatCode(code.replace(/-/g, '')), 'the header shows the code in its formatted reading');
  assert.equal(page.text('role-line'), 'you are the organizer');
  assert.equal(page.text('who-line'), 'Asha', 'the header names you');
  assert.equal(page.element('copy-code').hidden, false, 'copy-code is one of the header controls');
  assert.equal(page.element('copy-link').hidden, false, 'copy-link is one of the header controls');

  /* The seat the page keeps is the one the create made: the host id in the body it sent. The auth
     frame is what the socket sends on open, so the socket is opened first. */
  const socket = page.sockets.instances.at(-1);
  assert.ok(socket, 'creating must open the group socket, or the group would be read-only');
  socket.emit('open');
  const seat = socket.sent.find((frame) => frame.t === 'auth');
  assert.ok(seat, 'the group socket must identify itself with the seat the create made');
  assert.equal(seat.id, server.requests[0].hostId, 'the socket resumes as the host the create named');
  assert.equal(seat.mode, 'resume');

  /* The presence chip is the group's own answer, so it is hidden until the server speaks. */
  assert.equal(page.element('presence').hidden, true, 'a chip with nothing to say stays hidden');
  socket.message({ t: 'here', ids: [server.requests[0].hostId] });
  assert.equal(page.element('presence').hidden, false, 'the presence chip appears with the first hello');
  assert.equal(chipText(page), 'Just you here', 'the organizer alone here is the whole chip');

  /* The currency the form was left on is the group's: an untouched select means INR. */
  page.element('add-expense').click();
  assert.equal(page.text('expense-currency'), 'INR', 'the group carries the currency the form was left on');
});

test('create: the empty ledger names the three steps and the first expense is one tap away', async () => {
  const server = fakeServer();
  const page = openPage(server);
  pressCreate(page, { currency: 'EUR' });
  await until(() => !page.element('group-header').hidden, 'the group view');

  const empty = page.element('empty-ledger');
  assert.equal(empty.hidden, false, 'a group with no expenses must say what to do next');
  const steps = descendants(empty)
    .filter((node) => node.tagName === 'LI')
    .map((node) => node.textContent);
  assert.equal(steps.length, 3, `the empty ledger explains three steps, got ${steps.length}`);
  assert.match(steps[0], /Who paid/, 'the first step is who paid');
  assert.match(steps[1], /Split how/, 'the second step is how it was split');
  assert.match(steps[2], /Done/, 'the third step is the result');

  /* "one tap away" is a control in the empty state itself, not only in the header. */
  const first = page.element('empty-add-expense');
  assert.ok(first, 'the empty ledger must carry the first-expense control');
  first.click();
  assert.equal(page.element('expense-panel').hidden, false, 'that one tap opens the expense sheet');
  assert.equal(page.text('expense-currency'), 'EUR', 'the sheet reads the currency the group was made with');
});

test('create: the code hint is one-time, and a copy or the first expense ends it', async () => {
  const server = fakeServer();
  const page = openPage(server);
  pressCreate(page);
  await until(() => !page.element('group-header').hidden, 'the group view');

  const hint = page.element('code-hint');
  assert.equal(hint.hidden, false, 'the code is the key: the hint comes with the group');
  assert.match(hint.textContent, /code is the key/i, 'the hint says what the code is');
  assert.match(hint.textContent, /ask to join/i, 'and that holding it is enough to ask to join');

  page.element('copy-code').click();
  await until(() => page.win.copied.length > 0, 'the copy');
  await settle();
  assert.equal(page.win.copied.at(-1), page.text('group-code'), 'the copy carries the code as it reads');
  assert.equal(hint.hidden, true, 'the first copy ends the hint');

  /* One-time: the group repainting does not bring it back. */
  const socket = page.sockets.instances.at(-1);
  socket.message({ t: 'here', ids: ['someone'] });
  await wait(20);
  assert.equal(hint.hidden, true, 'the hint must not return once it is done');

  /* The other ending: the first expense. */
  const other = openPage(fakeServer());
  pressCreate(other);
  await until(() => !other.element('group-header').hidden, 'the second group view');
  assert.equal(other.element('code-hint').hidden, false, 'a fresh group starts with the hint');
  other.element('empty-add-expense').click();
  assert.equal(other.element('code-hint').hidden, true, 'the first expense ends the hint too');
});

test('create: with 25 groups live the 26th is refused and nothing is created', async () => {
  const server = fakeServer({ live: 25 });
  const page = openPage(server);
  const before = server.groups.size;

  pressCreate(page, { name: 'Twenty-sixth', display: 'Asha' });
  await until(() => !page.element('form-error').hidden, 'the refusal');

  assert.equal(page.text('form-error'), 'All 25 group slots are in use.', 'the cap message is the whole message');
  assert.equal(server.groups.size, before, 'a refused create must add nothing to the ledger');
  assert.equal(server.groups.size, 25, 'the ledger still holds the 25 that were live');
  assert.equal(page.element('group-header').hidden, true, 'a refusal is not a group view');
  assert.equal(page.element('create-panel').hidden, false, 'the form is still the screen');

  /* The refusal is retry-able: free one slot and the same form creates. */
  server.groups.delete('live-0');
  page.element('create-form').dispatch('submit');
  await until(() => !page.element('group-header').hidden, 'the group view after a slot freed');
  assert.equal(server.groups.size, 25, 'the retry took the freed slot and no more');
});

test('create: a failed create keeps what I typed, stays on the form, and can be retried', async () => {
  const server = fakeServer();
  server.fail = true;
  const page = openPage(server);

  pressCreate(page, { name: 'Goa trip', display: 'Asha', currency: 'EUR' });
  await until(() => !page.element('form-error').hidden, 'the failure');

  const message = page.text('form-error');
  assert.match(message, /try again/i, 'a failed create must invite a retry');
  assert.notEqual(message, 'All 25 group slots are in use.', 'a fault is not the cap');
  assert.equal(page.element('group-header').hidden, true, 'a failed create must not open the group');
  assert.equal(page.element('create-panel').hidden, false, 'the form is still on screen');
  assert.equal(page.element('group-name').value, 'Goa trip', 'the group name is kept');
  assert.equal(page.element('display-name').value, 'Asha', 'the name is kept');
  assert.equal(page.element('currency').value, 'EUR', 'the currency is kept');
  assert.equal(server.groups.size, 0, 'a failed create made nothing');

  server.fail = false;
  page.element('create-form').dispatch('submit');
  await until(() => !page.element('group-header').hidden, 'the group view on the retry');
  assert.equal(page.text('form-error'), '', 'the error is cleared once the retry lands');
  assert.equal(server.groups.size, 1, 'the retry made the one group');
});

test('create: a blank name or a name past 60 characters never reaches the network', async () => {
  const server = fakeServer();
  const page = openPage(server);

  pressCreate(page, { name: '   ', display: 'Asha' });
  await until(() => !page.element('form-error').hidden, 'the blank-name refusal');
  assert.match(page.text('form-error'), /Enter a group name/, 'the refusal says what to do');
  assert.equal(server.requests.length, 0, 'a whitespace-only name must not make a request');
  assert.equal(page.element('group-header').hidden, true, 'and must not open a group');

  pressCreate(page, { name: 'a'.repeat(61), display: 'Asha' });
  await until(() => /at most 60 characters/.test(page.text('form-error')), 'the long-name refusal');
  assert.equal(server.requests.length, 0, '61 characters are refused locally, not by the server');

  pressCreate(page, { name: 'Goa', display: 'A' });
  await until(() => /at least 2 characters/.test(page.text('form-error')), 'the short-name refusal');
  assert.equal(server.requests.length, 0, 'a one-character name is refused before a request');
});

test('create: a double click makes one request and one group', async () => {
  const server = fakeServer();
  const page = openPage(server);

  page.element('group-name').value = 'Goa trip';
  page.element('display-name').value = 'Asha';
  /* Two submits in the same turn: the second must see the first's flag, not the form again. */
  page.element('create-form').dispatch('submit');
  page.element('create-form').dispatch('submit');

  await until(() => !page.element('group-header').hidden, 'the group view');
  assert.equal(server.requests.length, 1, 'a double click must not make a second request');
  assert.equal(server.groups.size, 1, 'and must not create a second group');
});

test('create: a Tamil or emoji name is accepted and counted one character at a time', async () => {
  const server = fakeServer();
  const page = openPage(server);

  const tamil = TAMIL.repeat(12);
  assert.equal([...tamil].length, 60, 'the fixture must sit exactly on the limit');
  pressCreate(page, { name: tamil });
  await until(() => !page.element('group-header').hidden, 'the group view for a Tamil name');
  assert.equal(page.text('group-name-display'), tamil, 'a Tamil name is shown exactly as typed');

  const other = openPage(fakeServer());
  const sixtyEmoji = EMOJI.repeat(60);
  assert.equal(sixtyEmoji.length, 120, 'the fixture must be longer than 60 UTF-16 units');
  pressCreate(other, { name: sixtyEmoji });
  await until(() => !other.element('group-header').hidden, 'the group view for sixty emoji');
  assert.equal(other.text('group-name-display'), sixtyEmoji, 'sixty emoji are sixty characters');

  const third = openPage(fakeServer());
  pressCreate(third, { name: EMOJI.repeat(61) });
  await until(() => /at most 60 characters/.test(third.text('form-error')), 'the emoji refusal');
  assert.equal(third.element('group-header').hidden, true, 'sixty-one emoji are over the limit');
});

test('create: offline says so, and the form stays filled', async () => {
  const server = fakeServer();
  const page = openPage(server);
  page.win.navigator.onLine = false;

  pressCreate(page, { name: 'Goa trip', display: 'Asha' });
  await until(() => !page.element('form-error').hidden, 'the offline notice');

  assert.equal(page.text('form-error'), OFFLINE_MESSAGE, 'offline is named as itself');
  assert.equal(OFFLINE_MESSAGE, 'Creating needs a connection.');
  assert.equal(server.requests.length, 0, 'an offline create must not reach the network');
  assert.equal(page.element('group-name').value, 'Goa trip', 'the name is still there');
  assert.equal(page.element('display-name').value, 'Asha', 'so is the display name');
  assert.equal(page.element('group-header').hidden, true, 'and no group opened');
});

test('create: a code that already names a group is regenerated once, then refused plainly', async () => {
  const server = fakeServer();
  server.collide = 1;
  const page = openPage(server);

  pressCreate(page, { name: 'Goa trip', display: 'Asha' });
  await until(() => !page.element('group-header').hidden, 'the group view after one collision');

  assert.equal(server.requests.length, 2, 'a collision must be retried exactly once');
  assert.notEqual(
    server.requests[1].groupId,
    server.requests[0].groupId,
    'the retry must carry a freshly generated code'
  );
  assert.equal(server.groups.size, 1, 'the retry made the one group');
  assert.equal(page.text('group-name-display'), 'Goa trip', 'and it is the group that opens');

  /* Twice in a row is not a retry loop: it is a plain refusal that keeps the form. */
  const again = fakeServer();
  again.collide = 99;
  const second = openPage(again);
  pressCreate(second, { name: 'Collide twice', display: 'Asha' });
  await until(() => !second.element('form-error').hidden, 'the plain collision error');

  assert.equal(again.requests.length, 2, 'two collisions must not become a third attempt');
  assert.equal(second.text('form-error'), COLLISION_MESSAGE, 'a second collision is a plain error');
  assert.match(COLLISION_MESSAGE, /already in use/i, 'the error says what happened');
  assert.equal(second.element('group-header').hidden, true, 'a refused create opens nothing');
  assert.equal(second.element('group-name').value, 'Collide twice', 'what was typed is kept');
  assert.equal(again.groups.size, 0, 'nothing was created by either attempt');
});

test('create: a second browser holding the code asks to join the group the organizer made', async () => {
  const server = fakeServer();
  const organizer = openPage(server);
  pressCreate(organizer, { name: 'Goa trip', display: 'Asha' });
  await until(() => !organizer.element('group-header').hidden, 'the organizer group view');

  const hostId = server.requests[0].hostId;
  const code = organizer.text('group-code');

  /* The invite link is the code in the fragment: opening it is the whole of "I was sent this". */
  const joiner = openPage(server, { href: `https://splitter.test/#code=${code}` });
  await until(() => joiner.element('join-code').value !== '', 'the code to arrive in the join form');
  assert.equal(joiner.element('join-code').value, code, 'the link fills the code, not a copy of it');

  joiner.element('join-name').value = 'Balan';
  joiner.element('join-form').dispatch('submit');
  await until(() => joiner.sockets.instances.length > 0, 'the asking socket');
  const asking = joiner.sockets.instances.at(-1);
  asking.emit('open');
  const request = asking.sent.find((frame) => frame.t === 'auth');
  assert.ok(request, 'asking to join is an auth frame on the group socket');
  assert.equal(request.mode, 'join', 'the browser asks; it does not claim a seat');
  assert.notEqual(request.id, hostId, 'the asking member is not the organizer');

  asking.message({ t: 'waiting' });
  await until(() => !joiner.element('waiting-panel').hidden, 'the waiting sheet');
  assert.equal(joiner.element('group-header').hidden, true, 'nothing of the group is shown yet');

  /* The organizer's side of the same moment: the chip counts the person who asked. */
  const host = organizer.sockets.instances.at(-1);
  host.emit('open');
  host.message({ t: 'here', ids: [hostId, request.id] });
  assert.match(
    chipText(organizer),
    /^2 here/,
    `the presence chip must count both of them, got "${chipText(organizer)}"`
  );
});

