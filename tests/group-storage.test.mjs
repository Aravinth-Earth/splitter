/**
 * A group's storage at its bound: one small value per record, a meta with no content, and an alarm
 * that takes the whole group off the air ninety days after its last write.
 *
 * The other group tests prove behaviour one call at a time. This file fills a group to the record
 * cap — 300 records of the 4 KB blob a client writes — and inspects the storage itself: the key
 * names, the meta's fields, every value's size, and the alarm. That is the only way to see that a
 * long trip cannot grow one value past the per-value ceiling, and it is where the largest stored
 * value is measured rather than assumed.
 *
 * No network: the class is driven through `writeRecord` with the key-value API replaced by a Map.
 * The Map also holds the alarm, because on a real Durable Object the alarm is storage — it survives
 * eviction, and the second instance in these tests is that eviction.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { Group, GROUP_KEY } from '../src/group.js';

const RECORD_CAP = 300;
const BLOB_BYTES = 4 * 1024;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/* Cloudflare's per-value ceiling for Durable Object key-value storage. */
const VALUE_CEILING_BYTES = 128 * 1024;
const GROUP_BUDGET_BYTES = 2 * 1024 * 1024;

const encoder = new TextEncoder();

function sealed(bytes = 96) {
  return {
    iv: randomBytes(12).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    ct: randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  };
}

/** A 22-character base64url id, deterministic so a failure names the record it came from. */
function recordId(index) {
  return `rec${String(index).padStart(19, '0')}`;
}

function groupId() {
  return randomBytes(16).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The UTF-8 size of a stored value, which is what the storage ceiling counts. */
function storedBytes(value) {
  return encoder.encode(JSON.stringify(value)).length;
}

/**
 * The key-value half of Durable Object storage, over one Map, with the alarm in the same place: an
 * alarm is storage on a real instance, so a second `Group` over this object sees the alarm the
 * first one set. `transaction` is present because the class uses one when it moves the meta; the
 * callback receives the same API, which is what a transaction does with a single writer.
 */
function makeStorage() {
  const stored = new Map();
  const writes = [];
  let alarm = null;
  const api = {
    get: async (key) => stored.get(key),
    put: async (key, value) => {
      writes.push(key);
      stored.set(key, value);
    },
    list: async ({ prefix } = {}) => {
      const found = new Map();
      for (const [key, value] of stored) {
        if (prefix === undefined || key.startsWith(prefix)) found.set(key, value);
      }
      return found;
    },
    delete: async (key) => stored.delete(key),
    setAlarm: async (at) => {
      alarm = at;
    },
    getAlarm: async () => alarm,
    deleteAlarm: async () => {
      alarm = null;
    },
    transaction: async (change) => change(api)
  };
  return { api, stored, writes, alarmAt: () => alarm };
}

/** The Registry as the Group reaches it: every release recorded, one row freed by default. */
function newRegistry() {
  const calls = [];
  const env = {
    REGISTRY: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (url, init) => {
          calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
          return new Response(JSON.stringify({ ok: true, freed: 1 }), { status: 200 });
        }
      })
    }
  };
  return { env, calls };
}

function newGroup({ env = {}, storage = makeStorage() } = {}) {
  const ctx = { storage: storage.api };
  return { group: new Group(ctx, env), ...storage };
}

/** A host socket, attached the way the WebSocket path does once authentication answered. */
function attachHost(group, hostId) {
  const socket = { frames: [], send(text) { this.frames.push(JSON.parse(text)); }, close() {} };
  group.sockets.add(socket);
  group.identities.set(socket, { memberId: hostId, role: 'host' });
  return socket;
}

test('group: 300 records are 300 small values, and the largest value is measured', async () => {
  const { env } = newRegistry();
  const { group, stored } = newGroup({ env });
  const hostId = groupId();
  const slotId = 'a'.repeat(64);

  const created = await group.init({
    groupId: slotId,
    hostId,
    nameBlob: sealed(),
    hostNameBlob: sealed(),
    metaBlob: sealed()
  });
  assert.equal(created.created, true);

  const host = attachHost(group, hostId);
  /* One 4 KB sealed blob, reused: the measurement is of stored value size, and a distinct random
     blob per record would only make the fixture slower without changing what is measured. */
  const blob = sealed(BLOB_BYTES);
  for (let index = 0; index < RECORD_CAP; index += 1) {
    await group.writeRecord(host, {
      id: recordId(index),
      base: 0,
      blob,
      deleted: false
    });
  }

  /* At the cap, one more key is refused and stores nothing: the group is bounded by construction,
     not only by the size of a record. */
  const overflowId = recordId(RECORD_CAP + 1);
  await group.writeRecord(host, { id: overflowId, base: 0, blob: sealed(), deleted: false });
  assert.deepEqual(
    host.frames[host.frames.length - 1],
    { t: 'refused', code: 'group_full', id: overflowId },
    'a record past the cap is refused'
  );
  assert.equal(stored.has(`r:record:${overflowId}`), false, 'the refused record is not stored');

  /* Every key is either the meta, the slot, or one `r:<kind>:<id>` record. The slot is the ledger's
     one key and the meta is the key that makes the group exist; nothing else is allowed. */
  const keys = [...stored.keys()];
  const recordKeys = keys.filter((key) => key.startsWith('r:record:'));
  assert.equal(recordKeys.length, RECORD_CAP, 'one key per record, exactly the cap');
  for (const key of keys) {
    if (key === GROUP_KEY || key === 'slot') continue;
    assert.match(key, /^r:(?:record|member|content|total):[A-Za-z0-9_-]+$/, `${key} is one tagged record`);
  }

  /* One key per record, never a blob of records: each value is one record and names its own key. */
  for (const key of recordKeys) {
    const value = stored.get(key);
    assert.equal(Array.isArray(value), false, 'a record value is an object, not a list of records');
    assert.equal(value.id, key.slice('r:record:'.length), 'the value names the key it is stored under');
    assert.equal(value.blob.ct.length, blob.ct.length, 'the record holds its own blob');
  }

  /* The meta is identity and bookkeeping only. A sealed name here would be content in the key that
     makes the group exist, and it would grow the one key no record write can replace. */
  const meta = stored.get(GROUP_KEY);
  assert.deepEqual(
    Object.keys(meta).sort(),
    ['createdAt', 'hostId', 'joinMode', 'lastWriteAt', 'rev'],
    'the meta holds five fields and no content'
  );
  for (const content of ['nameBlob', 'hostNameBlob', 'metaBlob', 'groupId']) {
    assert.equal(content in meta, false, `the meta must not carry ${content}`);
  }
  assert.equal(typeof stored.get('r:content:group-name').ct, 'string', 'the sealed name is its own record');

  /* Sizes: sum every stored value, and name the largest. The 4 KB blob at the cap must stay far
     below the per-value ceiling and the whole group below 2 MB. */
  let total = 0;
  let largest = { key: null, bytes: 0 };
  for (const [key, value] of stored) {
    const bytes = storedBytes(value);
    total += bytes;
    if (bytes > largest.bytes) largest = { key, bytes };
  }

  console.log(
    `gate: ${recordKeys.length} records, total ${total} bytes, largest ${largest.bytes} bytes (${largest.key})`
  );

  assert.equal(largest.key.startsWith('r:record:'), true, 'the largest value is one record');
  assert.ok(
    largest.bytes < VALUE_CEILING_BYTES / 2,
    `the largest value is ${largest.bytes} bytes, well under the ${VALUE_CEILING_BYTES}-byte ceiling`
  );
  assert.ok(
    total < GROUP_BUDGET_BYTES,
    `300 records of ${BLOB_BYTES} bytes total ${total} bytes, under the 2 MB budget`
  );
});

test('group: the expiry alarm survives an eviction, re-arms on a write, and frees the slot once', async () => {
  const { env, calls } = newRegistry();
  const storage = makeStorage();
  const hostId = groupId();
  const slotId = 'b'.repeat(64);

  const first = new Group({ storage: storage.api }, env);
  const created = await first.init({ groupId: slotId, hostId, nameBlob: sealed() });
  assert.equal(created.created, true);

  const metaAfterInit = storage.stored.get(GROUP_KEY);
  assert.equal(
    storage.alarmAt(),
    metaAfterInit.lastWriteAt + RETENTION_MS,
    'a created group is armed ninety days after its creation, which is its first last-write'
  );

  const host = attachHost(first, hostId);
  const firstRecord = recordId(1);
  await first.writeRecord(host, { id: firstRecord, base: 0, blob: sealed(BLOB_BYTES), deleted: false });

  const afterWrite = storage.stored.get(GROUP_KEY);
  assert.equal(afterWrite.lastWriteAt >= metaAfterInit.lastWriteAt, true, 'the write moves the clock');
  assert.equal(
    storage.alarmAt(),
    afterWrite.lastWriteAt + RETENTION_MS,
    'and the alarm re-arms from the accepted write'
  );

  /* Eviction: a new instance over the same storage. The alarm is storage, so the deadline is still
     there, and the next write moves it forward. */
  const evicted = new Group({ storage: storage.api }, env);
  assert.equal(
    await storage.api.getAlarm(),
    afterWrite.lastWriteAt + RETENTION_MS,
    'the alarm survives the instance that set it'
  );

  const secondHost = attachHost(evicted, hostId);
  const secondRecord = recordId(2);
  await evicted.writeRecord(secondHost, {
    id: secondRecord,
    base: 0,
    blob: sealed(BLOB_BYTES),
    deleted: false
  });
  const afterSecond = storage.stored.get(GROUP_KEY);
  assert.equal(
    storage.alarmAt(),
    afterSecond.lastWriteAt + RETENTION_MS,
    'the next write after an eviction re-arms the alarm'
  );
  assert.equal(storage.alarmAt() >= afterWrite.lastWriteAt + RETENTION_MS, true, 'forward, never back');

  /* A wake before the deadline is not the deadline: it re-arms and leaves the group alone. */
  await evicted.alarm();
  assert.equal(storage.stored.has(GROUP_KEY), true, 'an early alarm does not wipe the group');
  assert.equal(storage.stored.has(`r:record:${firstRecord}`), true);
  assert.equal(calls.length, 0, 'and it asks the ledger for nothing');
  assert.equal(
    storage.alarmAt(),
    afterSecond.lastWriteAt + RETENTION_MS,
    'the early wake re-arms for the real deadline'
  );

  /* Now stand the stored clock ninety-one days back, which is what reaching the deadline looks
     like. The alarm destroys the group: every key, the sockets, and the Registry slot. */
  const expired = { ...storage.stored.get(GROUP_KEY), lastWriteAt: Date.now() - RETENTION_MS - 24 * 60 * 60 * 1000 };
  storage.stored.set(GROUP_KEY, expired);

  await evicted.alarm();
  assert.equal(storage.stored.size, 0, 'the group is wiped, content and records and meta');
  assert.equal(storage.alarmAt(), null, 'the alarm is gone with the group');
  assert.deepEqual(calls, [{ path: '/release', body: { groupId: slotId } }], 'the slot is freed exactly once');

  /* A second delivery of the same alarm: the group and the slot id are gone, so this is a no-op —
     not a second release of a slot somebody else may hold by now. */
  await evicted.alarm();
  assert.equal(calls.length, 1, 'a repeated alarm never frees the slot twice');
  assert.equal(storage.stored.size, 0, 'and writes nothing back');
});

test('group: an alarm on a group whose release was refused retries it, and only once succeeds', async () => {
  const { env, calls } = newRegistry();
  /* The first release is refused — the group is wiped but the ledger may still hold the row — and
     the second answers with a freed row. */
  let release = 0;
  env.REGISTRY = {
    idFromName: (name) => name,
    get: () => ({
      fetch: async (url, init) => {
        release += 1;
        calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
        return release === 1
          ? new Response(JSON.stringify({ error: 'internal' }), { status: 502 })
          : new Response(JSON.stringify({ ok: true, freed: 1 }), { status: 200 });
      }
    })
  };

  const { group, stored, api } = newGroup({ env });
  const hostId = groupId();
  const slotId = 'c'.repeat(64);
  await group.init({ groupId: slotId, hostId, nameBlob: sealed() });
  stored.set(GROUP_KEY, { ...stored.get(GROUP_KEY), lastWriteAt: Date.now() - RETENTION_MS - 1 });

  await group.alarm();
  assert.equal(stored.has(GROUP_KEY), false, 'the wipe ran even though the release did not');
  assert.equal(stored.get('slot'), slotId, 'the id that names the slot stays for the retry');

  await group.alarm();
  assert.equal(calls.length, 2, 'the second delivery retries the release');
  assert.equal(stored.has('slot'), false, 'and the slot id goes once a row was freed');
  assert.equal(stored.size, 0);

  await group.alarm();
  assert.equal(calls.length, 2, 'a third delivery has nothing left to ask for');
  assert.equal(await api.getAlarm(), null);
});
