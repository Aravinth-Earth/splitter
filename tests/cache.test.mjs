/**
 * The durable outbox and the last-state cache, without a browser.
 *
 * Only sealed frames and opaque ids are stored. A row of the wrong shape is dropped, a broken
 * storage reads as empty, and a save that cannot fit returns false rather than throwing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CACHE_SCHEMA, cacheFor, forgetGroupCache, outboxFor, saveCache, saveOutbox } from '../public/cache.js';

const GROUP = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const ID = 'EPOcSRlhtThBdbTwu7zU9Q';
const OTHER_ID = 'Zq4mN8pR2sT6vW0xY3aB5c';
const BLOB = { iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAA' };

function fakeStorage(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    getItem: (key) => (rows.has(key) ? rows.get(key) : null),
    setItem: (key, value) => rows.set(key, String(value)),
    removeItem: (key) => rows.delete(key),
    dump: () => Object.fromEntries(rows)
  };
}

const put = (id = ID, base = 0) => ({
  id,
  frame: { t: 'put', id, base, blob: BLOB, deleted: false }
});

const state = (records = []) => ({
  nameBlob: BLOB,
  metaBlob: null,
  hostId: ID,
  memberId: ID,
  role: 'host',
  joinMode: 'approval',
  roster: [{ id: ID, status: 'approved', nameBlob: BLOB }],
  records
});

test('cache: an outbox round-trips in local order, separately per group', () => {
  const local = fakeStorage();
  assert.equal(saveOutbox(local, GROUP, [put(ID), put(OTHER_ID)]), true);
  assert.deepEqual(
    outboxFor(local, GROUP).map((entry) => entry.id),
    [ID, OTHER_ID]
  );
  assert.deepEqual(outboxFor(local, OTHER), []);

  assert.equal(saveOutbox(local, OTHER, [put(OTHER_ID, 1)]), true);
  assert.deepEqual(outboxFor(local, GROUP).map((entry) => entry.id), [ID, OTHER_ID]);
  assert.deepEqual(outboxFor(local, OTHER).map((entry) => entry.id), [OTHER_ID]);
});

test('cache: bad outbox rows are dropped, never repaired', () => {
  const local = fakeStorage({
    'splitter:outbox': JSON.stringify({
      [GROUP]: {
        schema: CACHE_SCHEMA,
        items: [
          put(ID),
          { id: 'not-an-id', frame: { t: 'put', id: 'not-an-id' } },
          { id: OTHER_ID, frame: { t: 'put', id: 'mismatch', base: 0, blob: BLOB, deleted: false } },
          { id: OTHER_ID, frame: { t: 'put', id: OTHER_ID, base: 0, blob: { iv: 1 }, deleted: false } }
        ]
      }
    })
  });
  assert.deepEqual(outboxFor(local, GROUP).map((entry) => entry.id), [ID]);
});

test('cache: three hundred sealed records round-trip with schema and time', () => {
  const local = fakeStorage();
  const records = Array.from({ length: 300 }, (_, index) => ({
    id: `record-${index}`.padEnd(22, 'A'),
    rev: index + 1,
    blob: BLOB,
    deleted: false,
    author: ID,
    creator: ID,
    at: 1_700_000_000_000 + index
  }));
  assert.equal(saveCache(local, GROUP, state(records), 1_700_000_123_456), true);
  const cached = cacheFor(local, GROUP);
  assert.equal(cached.schema, CACHE_SCHEMA);
  assert.equal(cached.savedAt, 1_700_000_123_456);
  assert.equal(cached.records.length, 300);
  assert.deepEqual(cached.records[0], records[0]);
  assert.equal(cached.role, 'host');
  assert.equal(cached.roster.length, 1);
});

test('cache: tombstones stay sealed-less and bad records are dropped', () => {
  const local = fakeStorage();
  saveCache(local, GROUP, state([
    { id: ID, rev: 2, blob: null, deleted: true, author: ID, creator: ID, at: 1 },
    { id: 'bad', rev: 1, blob: BLOB, deleted: false, author: ID, creator: ID, at: 1 }
  ]));
  const cached = cacheFor(local, GROUP);
  assert.equal(cached.records.length, 1);
  assert.equal(cached.records[0].deleted, true);
  assert.equal(cached.records[0].blob, null);
});

test('cache: corrupt JSON and a full storage read as empty and refuse saves', () => {
  assert.deepEqual(outboxFor(fakeStorage({ 'splitter:outbox': '{' }), GROUP), []);
  assert.equal(cacheFor(fakeStorage({ 'splitter:cache': '[]' }), GROUP), null);

  const full = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    }
  };
  assert.equal(saveOutbox(full, GROUP, [put()]), false);
  assert.equal(saveCache(full, GROUP, state([])), false);
  assert.deepEqual(outboxFor(full, GROUP), []);
  assert.equal(saveCache(fakeStorage(), GROUP, { ...state([]), nameBlob: null }), false);
});


test('cache: leaving or ending drops both the outbox and the state for one group', () => {
  const local = fakeStorage();
  saveOutbox(local, GROUP, [put()]);
  saveOutbox(local, OTHER, [put(OTHER_ID)]);
  saveCache(local, GROUP, state([]));
  saveCache(local, OTHER, state([]));

  assert.equal(forgetGroupCache(local, GROUP), true);
  assert.deepEqual(outboxFor(local, GROUP), []);
  assert.equal(cacheFor(local, GROUP), null);
  assert.deepEqual(outboxFor(local, OTHER).map((entry) => entry.id), [OTHER_ID]);
  assert.equal(cacheFor(local, OTHER).schema, CACHE_SCHEMA);
});
