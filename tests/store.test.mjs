/**
 * The two stores that let a reload come back to the same seat.
 *
 * The split is the point: the member secret lives in local storage and the code — the key — lives
 * in session storage. A test that only checked "a reload works" would pass with the code on disk,
 * so one of these asserts the code never reaches local storage.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codeFor,
  codes,
  forgetCode,
  forgetSession,
  lastGroup,
  saveCode,
  saveSession,
  sessionFor,
  sessions,
  setLastGroup
} from '../public/store.js';

const GROUP = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const SECRET = 'AAECAwQFBgcICQoLDA0ODw';
const ID = 'EPOcSRlhtThBdbTwu7zU9Q';
const CODE = 'ABCDEFGHJKMNPQRS';

function fakeStorage(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    getItem: (key) => (rows.has(key) ? rows.get(key) : null),
    setItem: (key, value) => rows.set(key, String(value)),
    removeItem: (key) => rows.delete(key),
    dump: () => Object.fromEntries(rows)
  };
}

const session = (overrides = {}) => ({
  groupId: GROUP,
  memberId: ID,
  memberSecret: SECRET,
  displayName: 'Aravinth',
  ...overrides
});

test('store: a session round-trips, and the last group follows it', () => {
  const local = fakeStorage();
  assert.equal(saveSession(local, session()), true);
  assert.deepEqual(sessionFor(local, GROUP), session());
  assert.equal(setLastGroup(local, GROUP), true);
  assert.equal(lastGroup(local), GROUP);

  assert.equal(saveSession(local, session({ groupId: OTHER, displayName: 'Bo' })), true);
  assert.equal(Object.keys(sessions(local)).length, 2);

  setLastGroup(local, OTHER);
  forgetSession(local, GROUP);
  assert.equal(sessionFor(local, GROUP), null);
  assert.equal(sessionFor(local, OTHER).displayName, 'Bo');
  assert.equal(lastGroup(local), OTHER, 'forgetting another group leaves the last one alone');

  forgetSession(local, OTHER);
  assert.equal(lastGroup(local), null, 'forgetting the last group clears the pointer');
});

test('store: the code is kept for the tab and never in local storage', () => {
  const local = fakeStorage();
  const tab = fakeStorage();
  saveSession(local, session());
  assert.equal(saveCode(tab, GROUP, CODE), true);

  assert.equal(codeFor(tab, GROUP), CODE);
  assert.equal(codeFor(tab, OTHER), null);
  assert.equal(forgetCode(tab, GROUP), undefined);
  assert.equal(codeFor(tab, GROUP), null);

  saveCode(tab, GROUP, CODE);
  const dump = JSON.stringify(local.dump());
  assert.ok(!dump.includes(CODE), 'the code must not be written to local storage');
  assert.ok(!dump.includes('splitter:codes'), 'the code store must not be mirrored locally');
  assert.ok(JSON.stringify(tab.dump()).includes(CODE), 'the code does live in the tab store');
});

test('store: a row of the wrong shape is ignored, not repaired', () => {
  const local = fakeStorage({
    'splitter:sessions': JSON.stringify({
      [GROUP]: session(),
      bad: { groupId: 'nope' },
      [OTHER]: session({ groupId: OTHER, memberSecret: 'short' })
    })
  });

  assert.deepEqual(Object.keys(sessions(local)), [GROUP]);
  assert.equal(sessionFor(local, 'not-a-group'), null);

  const tab = fakeStorage({
    'splitter:codes': JSON.stringify({ [GROUP]: 'lowercase', [OTHER]: CODE })
  });
  assert.deepEqual(Object.keys(codes(tab)), [OTHER]);
});

test('store: corrupt JSON and a storage that throws read as empty', () => {
  const corrupt = fakeStorage({ 'splitter:sessions': '{not json' });
  assert.deepEqual(sessions(corrupt), {});

  const hostile = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    }
  };
  assert.deepEqual(sessions(hostile), {});
  assert.equal(saveSession(hostile, session()), false);
  assert.equal(lastGroup(hostile), null);
  assert.equal(saveCode(hostile, GROUP, CODE), false);
  assert.deepEqual(sessions(null), {});
});
