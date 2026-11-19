/**
 * The Group Durable Object on its own: what it refuses, and which paths it serves.
 *
 * `/api/create` proves the happy path end to end; this file proves the write itself. Two promises
 * are pinned here. First, `init` is the call that makes a group exist, so it checks the body it is
 * given — an unvalidated init stored `hostId: undefined` for an empty body, a group nobody hosts and
 * nobody can join. Second, the class routes on the whole pathname: a suffix match sent
 * `POST /nope/init` down the init branch, so a URL that merely ended in `/init` initialised a group.
 *
 * No network and no `wrangler dev`: the class is driven through its own `fetch`, with the storage
 * API replaced by a Map. The stand-in records every write, so "refused" means nothing was stored,
 * not merely that the answer looked wrong.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { Group, GROUP_KEY } from '../src/group.js';

/** 22 characters: 16 bytes, base64url, unpadded — the id shape the client sends. */
function id22() {
  return randomBytes(16).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A sealed value as crypto.js writes it: a 16-character iv (12 bytes) and a ciphertext. */
function sealed(bytes = 96) {
  return {
    iv: randomBytes(12).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    ct: randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  };
}

/**
 * The key-value half of Durable Object storage, over one Map.
 *
 * `get`/`put` were the whole surface a group needed while it only ever wrote; a destroy reads the
 * key set and removes each key, so `list` and `delete` are here with the shapes the real API has
 * — `list` answers a Map, `delete` answers a boolean. `deleteAll` is provided because the host's
 * `end` uses it; destroy itself deletes key by key, so one failure can be injected mid-wipe.
 */
function makeStorage() {
  const stored = new Map();
  const api = {
    get: async (key) => stored.get(key),
    put: async (key, value) => {
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
    deleteAll: async () => {
      stored.clear();
    }
  };
  return { api, stored };
}

/**
 * A Registry stand-in: it records every call and answers what the test says it should.
 *
 * The Group reaches it as `env.REGISTRY.get(env.REGISTRY.idFromName('registry'))`, so both methods
 * are here; the recorded path and body are what the assertions read, because "released the slot"
 * means this exact call happened, not that the answer looked right.
 */
function newRegistry(answer = () => ({ status: 200, body: { ok: true } })) {
  const calls = [];
  const env = {
    REGISTRY: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (url, init) => {
          calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
          const { status, body } = answer(calls.length);
          return new Response(JSON.stringify(body), { status });
        }
      })
    }
  };
  return { env, calls };
}

/** A Group over one Map, plus the map itself so a test can see whether anything was written. */
function newGroup({ env = {}, storage = makeStorage() } = {}) {
  const ctx = { storage: storage.api };
  return { group: new Group(ctx, env), stored: storage.stored };
}

/** A socket as the Group holds one: it records the frames sent and the close it was given. */
function newSocket() {
  const frames = [];
  const closes = [];
  return {
    frames,
    closes,
    send(text) {
      frames.push(JSON.parse(text));
    },
    close(code, reason) {
      closes.push({ code, reason });
    }
  };
}

/** A request the Worker itself would make: JSON, POST, to `path`. */
function post(group, payload, { path = '/init', method = 'POST', raw } = {}) {
  return group.fetch(
    new Request(`https://group${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'HEAD' ? undefined : (raw ?? JSON.stringify(payload))
    })
  );
}

test('group: an empty init body is refused and writes nothing', async () => {
  const { group, stored } = newGroup();

  const response = await post(group, {});
  assert.equal(response.status, 400, 'an init with no host must not answer ok');
  assert.deepEqual(await response.json(), { ok: false, error: 'hostId' });
  assert.equal(stored.size, 0, 'a refused init must not write a group with no host');
});

test('group: an init without a usable host id or sealed name is refused', async () => {
  const cases = [
    { hostId: 'host', nameBlob: sealed() },
    { hostId: id22() },
    { hostId: id22(), nameBlob: { iv: 'AAAAAAAAAAAAAAAA' } },
    /* 12 characters, not 16: an iv counted in bytes is refused as a sealed value. */
    { hostId: id22(), nameBlob: { iv: 'A'.repeat(12), ct: 'AAAA' } },
    { hostId: id22(), nameBlob: sealed(), metaBlob: 'meta' }
  ];

  for (const payload of cases) {
    const { group, stored } = newGroup();
    const response = await post(group, payload);
    assert.equal(response.status, 400, `${JSON.stringify(payload)} must be refused by the write itself`);
    const body = await response.json();
    assert.equal(body.ok, false, 'a refusal must be told apart from a write');
    assert.equal(stored.size, 0, 'a refused init must store nothing');
  }
});

test('group: an absent meta is allowed, and a valid init writes the meta once', async () => {
  const { group, stored } = newGroup();
  const hostId = id22();

  const first = await post(group, { hostId, nameBlob: sealed() });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, created: true });
  assert.equal(stored.get(GROUP_KEY).hostId, hostId);
  assert.equal(stored.get(GROUP_KEY).metaBlob, null, 'an absent meta is stored as null');

  /* A retry answers ok without a second write. */
  const second = await post(group, { hostId: id22(), nameBlob: sealed() });
  assert.deepEqual(await second.json(), { ok: true, created: false });
  assert.equal(stored.get(GROUP_KEY).hostId, hostId, 'the first host stands');
});

test('group: only /init is routed, so a path that merely ends in it is not an init', async () => {
  const { group, stored } = newGroup();

  const response = await post(group, { hostId: id22(), nameBlob: sealed() }, { path: '/nope/init' });
  assert.equal(response.status, 404, 'POST /nope/init must not initialise the group');
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(stored.size, 0, 'an unrouted path must leave the group unwritten');
});

test('group: a method other than POST is refused and names the method it allows', async () => {
  const { group } = newGroup();

  const response = await post(group, null, { method: 'GET' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST', 'a 405 must carry Allow: POST');
  assert.deepEqual(await response.json(), { error: 'method' });
});

test('group: a body that is not a JSON object is a bad request', async () => {
  const { group, stored } = newGroup();

  const response = await post(group, null, { raw: '[' });
  assert.equal(response.status, 400, 'an unparseable init body must not reach the write');
  assert.deepEqual(await response.json(), { error: 'bad_request' });
  assert.equal(stored.size, 0);
});

/* --- Destroy: one call takes the group off the air, in an order that keeps the slot honest. --- */

test('group: destroy closes every socket, wipes storage and releases the slot', async () => {
  const groupId = id22();
  const hostId = id22();
  const memberId = id22();
  const firstRecord = id22();
  const secondRecord = id22();
  const { env, calls } = newRegistry();
  const { group, stored } = newGroup({ env });

  await post(group, { groupId, hostId, nameBlob: sealed() });
  stored.set(`member:${memberId}`, { status: 'approved', nameBlob: sealed(), joinedAt: 1 });
  stored.set(`record:${firstRecord}`, { id: firstRecord, rev: 1, blob: sealed(), deleted: false, at: 1 });
  stored.set(`record:${secondRecord}`, { id: secondRecord, rev: 1, blob: sealed(), deleted: false, at: 2 });

  const host = newSocket();
  const member = newSocket();
  group.sockets.add(host);
  group.sockets.add(member);
  group.identities.set(host, { memberId: hostId, role: 'host' });
  group.identities.set(member, { memberId, role: 'member' });

  const response = await post(group, {}, { path: '/destroy' });
  assert.equal(response.status, 200, 'a destroy that wiped and released answers ok');
  assert.deepEqual(await response.json(), { ok: true, destroyed: true, released: true, closed: 2 });

  assert.equal(stored.size, 0, 'the meta, every member key and every record key must be gone');
  assert.equal(group.sockets.size, 0, 'no socket may be left attached to a destroyed group');

  for (const socket of [host, member]) {
    assert.deepEqual(socket.frames, [{ t: 'ended' }], 'each socket is told once that the group is gone');
    assert.deepEqual(socket.closes, [{ code: 1000, reason: 'ended' }], 'and then closed');
  }

  assert.deepEqual(
    calls,
    [{ path: '/release', body: { groupId } }],
    'the slot is handed back exactly once, for this group id'
  );
});

test('group: destroy on a group holding nothing answers ok and releases nothing extra', async () => {
  const { env, calls } = newRegistry();
  const { group, stored } = newGroup({ env });

  const response = await post(group, {}, { path: '/destroy' });
  assert.equal(response.status, 200, 'destroying a group that holds nothing is not an error');
  assert.deepEqual(await response.json(), { ok: true, destroyed: true, released: false, closed: 0 });
  assert.equal(stored.size, 0);
  assert.equal(calls.length, 0, 'an instance that holds no slot must not ask the Registry to free one');

  /* The same call again: a retried destroy is the same emptiness, not a second release. */
  const again = await post(group, {}, { path: '/destroy' });
  assert.deepEqual(await again.json(), { ok: true, destroyed: true, released: false, closed: 0 });
  assert.equal(calls.length, 0, 'a second destroy must not release a slot either');
});

test('group: a /release the registry refuses leaves the slot held and is not reported as freed', async () => {
  const groupId = id22();
  const hostId = id22();
  const refused = newRegistry(() => ({ status: 500, body: { error: 'internal' } }));
  const { group } = newGroup({ env: refused.env });
  await post(group, { groupId, hostId, nameBlob: sealed() });

  const response = await post(group, {}, { path: '/destroy' });
  const body = await response.json();
  assert.notEqual(response.status, 200, 'a refused release is not a clean destroy');
  assert.equal(body.released, false, 'a slot the Registry did not free must never be reported as freed');
  assert.equal(body.destroyed, true, 'the group is gone whether or not the slot came back');
  assert.deepEqual(refused.calls, [{ path: '/release', body: { groupId } }], 'the call was made once');

  /* The other half of the same promise, and the reason the order is fixed: a wipe that dies
     part-way must not reach the Registry at all. A group whose meta survives is still a group, and
     a slot freed under it would be a slot the ledger believes is empty. */
  const untouched = newRegistry();
  const halfWipedStorage = makeStorage();
  let deletes = 0;
  halfWipedStorage.api.delete = async (key) => {
    deletes += 1;
    if (deletes === 2) throw new Error('storage');
    halfWipedStorage.stored.delete(key);
  };
  const { group: halfWiped } = newGroup({ env: untouched.env, storage: halfWipedStorage });

  const orphanRecord = id22();
  await post(halfWiped, { groupId: id22(), hostId: id22(), nameBlob: sealed() });
  halfWipedStorage.stored.set(`record:${orphanRecord}`, { id: orphanRecord, rev: 1, blob: sealed(), at: 1 });

  const watcher = newSocket();
  halfWiped.sockets.add(watcher);
  halfWiped.identities.set(watcher, { memberId: id22(), role: 'member' });

  const broken = await post(halfWiped, {}, { path: '/destroy' });
  const brokenBody = await broken.json();
  assert.equal(broken.status, 500, 'a wipe that failed is an error, not a destroy');
  assert.equal(brokenBody.destroyed, false);
  assert.equal(brokenBody.released, false, 'nothing may be reported as freed when the wipe failed');
  assert.equal(untouched.calls.length, 0, 'a failing wipe must never ask the Registry to free the slot');
  assert.equal(deletes, 2, 'the wipe did stop part-way');
  assert.equal(halfWipedStorage.stored.has(`record:${orphanRecord}`), false, 'the record was already gone');
  assert.equal(halfWipedStorage.stored.has(GROUP_KEY), true, 'the group still exists, so the slot is still held');
  assert.deepEqual(watcher.closes, [{ code: 1000, reason: 'ended' }], 'sockets close before the wipe runs');
});

/* --- Counters: what a group answers about itself, for the operator's listing. --- */

/** The counters route, which takes no body: a POST with nothing in it is a valid read. */
function readCounters(group) {
  return post(group, {}, { path: '/counters' });
}

test('group: init stamps createdAt, and an accepted write stamps lastWriteAt', async () => {
  const { group, stored } = newGroup();
  const hostId = id22();
  await post(group, { hostId, nameBlob: sealed() });

  const meta = stored.get(GROUP_KEY);
  assert.equal(Number.isSafeInteger(meta.createdAt), true, 'the group records when it was created');

  const socket = newSocket();
  group.sockets.add(socket);
  group.identities.set(socket, { memberId: hostId, role: 'host' });

  const recordIds = [id22(), id22()];
  for (const recordId of recordIds) {
    await group.writeRecord(socket, { id: recordId, base: 0, blob: sealed(120), deleted: false });
  }

  const response = await readCounters(group);
  assert.equal(response.status, 200);
  const counters = await response.json();

  assert.equal(counters.ok, true);
  assert.equal(counters.createdAt, meta.createdAt, 'the creation time is the one init stamped');
  assert.equal(Number.isSafeInteger(counters.lastWriteAt), true, 'the write stamped a time');
  assert.ok(counters.lastWriteAt >= counters.createdAt, 'the last write cannot precede the creation');
  assert.equal(counters.records, 2, 'both stored records are counted');

  const expected = recordIds.reduce(
    (total, recordId) =>
      total + new TextEncoder().encode(JSON.stringify(stored.get(`record:${recordId}`))).length,
    0
  );
  assert.equal(counters.bytes, expected, 'bytes is the stored record values, summed in UTF-8');

  /* A retried init answers ok without a second write, so it must not move the creation time. */
  await post(group, { hostId: id22(), nameBlob: sealed() });
  assert.equal(stored.get(GROUP_KEY).createdAt, meta.createdAt, 'a retried init leaves the time alone');
});

test('group: counters answer unknown for a group stored before timestamps existed', async () => {
  const { group, stored } = newGroup();
  /* The meta a deploy before this patch wrote: no createdAt, and no last-write key at all. */
  stored.set(GROUP_KEY, {
    groupId: id22(),
    hostId: id22(),
    joinMode: 'approval',
    rev: 0,
    nameBlob: sealed(),
    hostNameBlob: null,
    metaBlob: null
  });

  const counters = await (await readCounters(group)).json();
  assert.equal(counters.ok, true, 'a group with unknown times is still a readable group');
  assert.equal(counters.createdAt, null, 'an unknown creation time is answered as unknown');
  assert.equal(counters.lastWriteAt, null, 'and so is an unknown last write');
  assert.equal(counters.records, 0);
  assert.equal(counters.bytes, 0);
});

test('group: counters on a group that was never initialised is a 404, not an empty group', async () => {
  const { group } = newGroup();

  const response = await readCounters(group);
  assert.equal(response.status, 404, 'a slot with no group behind it must not read as zero records');
  assert.deepEqual(await response.json(), { error: 'unknown_group' });
});

