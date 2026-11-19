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
 * `get`/`put` were the whole surface a group needed while it only ever wrote; a wipe reads the key
 * set and removes each key, so `list` and `delete` are here with the shapes the real API has —
 * `list` answers a Map, `delete` answers a boolean. There is no `deleteAll`: nothing in the class
 * uses it any more, because a wipe deletes key by key so one failure can be injected mid-wipe.
 */
function makeStorage() {
  const stored = new Map();
  const writes = [];
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
    delete: async (key) => stored.delete(key)
  };
  return { api, stored, writes };
}

/**
 * A Registry stand-in: it records every call and answers what the test says it should.
 *
 * The Group reaches it as `env.REGISTRY.get(env.REGISTRY.idFromName('registry'))`, so both methods
 * are here; the recorded path and body are what the assertions read, because "released the slot"
 * means this exact call happened, not that the answer looked right. The default answer is a
 * release that freed one row — the shape `src/registry.js` answers for a slot it held — so a group
 * that reports `released: true` here is one that was told a row went.
 */
function newRegistry(answer = () => ({ status: 200, body: { ok: true, freed: 1 } })) {
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
function newGroup({ env = {}, storage = makeStorage(), id } = {}) {
  const ctx = { storage: storage.api };
  /* A Durable Object's own id: the name it was created under, which is not the slot the ledger
     holds. Tests that could be fooled by a fallback to it have to give the instance one. */
  if (id !== undefined) ctx.id = { toString: () => id };
  return { group: new Group(ctx, env), stored: storage.stored, writes: storage.writes };
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
  const { group, stored, writes } = newGroup();

  const response = await post(group, {});
  assert.equal(response.status, 400, 'an init with no host must not answer ok');
  assert.deepEqual(await response.json(), { ok: false, error: 'hostId' });
  assert.equal(stored.size, 0, 'a refused init must not write a group with no host');
  /* Nothing was put and then removed either: the refusal is before the first write, which is what
     keeps an empty body from leaving `hostId: undefined` behind a delete. */
  assert.deepEqual(writes, [], 'an empty init must not put a key at all');

  /* The refused instance is still a group nobody created. A valid init writes it, so the refusal
     did not leave a half-group that would make the next create read as a retry. */
  const valid = await post(group, { hostId: id22(), nameBlob: sealed() });
  assert.equal(valid.status, 200, 'the refusal did not poison the instance');
  assert.deepEqual(await valid.json(), { ok: true, created: true });
  assert.deepEqual(writes, [GROUP_KEY], 'a valid init writes the meta, and writes it once');
});

test('group: an init without a usable host id or sealed name is refused', async () => {
  const cases = [
    /* An id that is neither shape an id can hold: not 22 base64url characters, not 64 hex. */
    { payload: { hostId: 'host', nameBlob: sealed() }, error: 'hostId' },
    { payload: { hostId: null, nameBlob: sealed() }, error: 'hostId' },
    { payload: { hostId: 42, nameBlob: sealed() }, error: 'hostId' },
    /* A usable host but no group name at all. */
    { payload: { hostId: id22() }, error: 'blob' },
    /* The iv counted in the wrong unit, and an envelope with no ciphertext. */
    { payload: { hostId: id22(), nameBlob: { iv: 'A'.repeat(12), ct: 'AAAA' } }, error: 'blob' },
    { payload: { hostId: id22(), nameBlob: { iv: 'A'.repeat(16) } }, error: 'blob' },
    /* The two optional blobs are optional, not unchecked: present and unsealed is a refusal. */
    { payload: { hostId: id22(), nameBlob: sealed(), hostNameBlob: 'name' }, error: 'blob' },
    { payload: { hostId: id22(), nameBlob: sealed(), metaBlob: 'meta' }, error: 'blob' }
  ];

  for (const { payload, error } of cases) {
    const { group, stored, writes } = newGroup();
    const response = await post(group, payload);
    assert.equal(response.status, 400, `${JSON.stringify(payload)} must be refused by the write itself`);
    assert.deepEqual(
      await response.json(),
      { ok: false, error },
      `${JSON.stringify(payload)} must name ${error}, not merely fail`
    );
    assert.equal(stored.size, 0, 'a refused init must store nothing');
    assert.deepEqual(writes, [], 'and must not put a key before refusing');
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
  const { group, stored, writes } = newGroup();

  const response = await post(group, { hostId: id22(), nameBlob: sealed() }, { path: '/nope/init' });
  assert.equal(response.status, 404, 'POST /nope/init must not initialise the group');
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(stored.size, 0, 'an unrouted path must leave the group unwritten');
  assert.deepEqual(writes, [], 'and must not put a key on the way to a 404');

  /* The positive half: the route the class does serve is still served, so a 404 above is a
     routing answer and not a class that never initialises anything. */
  const routed = await post(group, { hostId: id22(), nameBlob: sealed() }, { path: '/init' });
  assert.equal(routed.status, 200, '/init itself is still the one init');
  assert.deepEqual(await routed.json(), { ok: true, created: true });
  assert.deepEqual(writes, [GROUP_KEY], 'and it wrote exactly what an init writes');
});

test('group: every write route answers a wrong method with Allow: POST', async () => {
  /* Every route this class serves as a write, not just the one the create calls: a 405 without an
     `Allow` makes a client guess, and RFC 9110 says the header is part of the answer. */
  for (const path of ['/init', '/counters', '/destroy']) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const { group, stored, writes } = newGroup();
      const response = await post(group, null, { path, method });

      assert.equal(response.status, 405, `${method} ${path} must be refused`);
      assert.equal(
        response.headers.get('allow'),
        'POST',
        `${method} ${path} must carry Allow: POST`
      );
      assert.deepEqual(await response.json(), { error: 'method' });
      assert.equal(stored.size, 0, 'a refused method must not write');
      assert.deepEqual(writes, [], 'and must not put a key');
    }
  }
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
  assert.equal(brokenBody.closed, 0, 'no socket was closed, so none may be counted as closed');
  /* The wipe never finished, so the group still exists: the socket is told exactly that — a frame
     that is not `ended` — and is left open rather than told its data is gone. */
  assert.deepEqual(watcher.frames, [{ t: 'wipe-failed' }], 'a failed wipe is announced as what it is');
  assert.deepEqual(watcher.closes, [], 'a socket whose group still exists must not be closed');
  assert.equal(halfWiped.sockets.has(watcher), true, 'and stays attached to the group');
});

test('group: a retry after a failed release frees the slot the group holds, not another', async () => {
  const groupId = id22();
  const hostId = id22();
  /* What `ctx.id` answers: a real Durable Object id string, and not the id the slot was taken
     under. A release that named this would free a row that belongs to somebody else. */
  const objectId = id22();

  /* The first release was refused — the shape a wipe that succeeded followed by a Registry error
     leaves — and the second, the retry, frees the one it names. */
  const registry = newRegistry((call) =>
    call === 1
      ? { status: 502, body: { error: 'internal' } }
      : { status: 200, body: { ok: true, freed: 1 } }
  );
  const { group, stored } = newGroup({ env: registry.env, id: objectId });

  await post(group, { groupId, hostId, nameBlob: sealed() });

  const first = await (await post(group, {}, { path: '/destroy' })).json();
  assert.equal(first.destroyed, true, 'the wipe ran, so the group is gone');
  assert.equal(first.released, false, 'a refused release did not free the slot');
  assert.equal(stored.get('slot'), groupId, 'the id that names the slot survives a refused release');
  assert.deepEqual(registry.calls.map((call) => call.body), [{ groupId }]);

  /* The retry: the meta is gone, so the slot id comes from the record the create wrote — the same
     id on every attempt, never one derived from the instance. */
  const second = await (await post(group, {}, { path: '/destroy' })).json();
  assert.equal(second.ok, true, 'the retry finished what the first call could not');
  assert.equal(second.released, true, 'the retry freed the slot the group actually holds');
  assert.deepEqual(
    registry.calls.map((call) => call.body),
    [{ groupId }, { groupId }],
    'both calls name the slot the create reserved'
  );
  assert.notEqual(objectId, groupId, 'the object id is a different string, so the assertion is not moot');
  assert.equal(stored.size, 0, 'nothing of the group is left once the slot came back');
});

test('group: a destroy with no persisted slot id reports nothing released', async () => {
  const { env, calls } = newRegistry();
  /* A group stored without the id its slot was taken under — the shape a deploy before this patch
     wrote — on an instance that does have an id of its own. */
  const { group, stored } = newGroup({ env, id: id22() });
  stored.set(GROUP_KEY, {
    hostId: id22(),
    joinMode: 'approval',
    rev: 0,
    nameBlob: sealed(),
    hostNameBlob: null,
    metaBlob: null
  });

  const response = await post(group, {}, { path: '/destroy' });
  const body = await response.json();

  assert.equal(response.status, 200, 'the group is gone, so the destroy itself is not an error');
  assert.equal(body.destroyed, true);
  assert.equal(body.released, false, 'with no stored id there is nothing to claim as freed');
  assert.equal(calls.length, 0, 'the Durable Object id must never be offered to the ledger as a slot');
  assert.equal(stored.size, 0);
});

test('group: a slot the ledger freed nothing for is already free, not stuck', async () => {
  const groupId = id22();
  const registry = newRegistry(() => ({ status: 200, body: { ok: true, freed: 0 } }));
  const { group, stored } = newGroup({ env: registry.env });
  await post(group, { groupId, hostId: id22(), nameBlob: sealed() });

  const response = await post(group, {}, { path: '/destroy' });
  const body = await response.json();

  /* `freed: 0` from a registry that answered ok is a row that is not there — a compensated or lost
     create leaves exactly this — so the destroy finished: no retry could ever clear it. */
  assert.equal(response.status, 200, 'a slot the ledger no longer holds is already free');
  assert.equal(body.destroyed, true, 'the wipe ran');
  assert.equal(body.released, false, 'released means a row went, not that the call arrived');
  assert.equal(body.error, undefined, 'there is nothing left for a retry to clear');
  assert.deepEqual(registry.calls.map((call) => call.body), [{ groupId }], 'the right slot was named');
  assert.equal(stored.size, 0, 'the group and the id that named its slot are both gone');

  /* The retry of a finished destroy: 200, nothing released, and no second question to the ledger. */
  const again = await post(group, {}, { path: '/destroy' });
  assert.equal(again.status, 200, 'a retry of an already-free slot is not an error');
  assert.deepEqual(await again.json(), { ok: true, destroyed: true, released: false, closed: 0 });
  assert.equal(registry.calls.length, 1, 'the retry must not ask the Registry a second time');
});

test('group: the ended frame is sent only after the wipe has finished', async () => {
  const groupId = id22();
  const hostId = id22();
  const recordId = id22();

  /* One log for both sides: a storage delete, a frame and a release, in the order they happened, so
     "the client was told before the rows were gone" is a sequence and not an inference. */
  const events = [];
  const storage = makeStorage();
  const deleteKey = storage.api.delete;
  storage.api.delete = async (key) => {
    events.push('wipe');
    return deleteKey(key);
  };
  const registry = newRegistry(() => {
    events.push('release');
    return { status: 200, body: { ok: true, freed: 1 } };
  });
  const { group } = newGroup({ env: registry.env, storage });

  await post(group, { groupId, hostId, nameBlob: sealed() });
  storage.stored.set(`record:${recordId}`, {
    id: recordId,
    rev: 1,
    blob: sealed(),
    deleted: false,
    at: 1
  });

  const socket = newSocket();
  const send = socket.send;
  socket.send = (text) => {
    events.push(`frame:${JSON.parse(text).t}`);
    send(text);
  };
  const close = socket.close;
  socket.close = (code, reason) => {
    events.push(`close:${reason}`);
    close(code, reason);
  };
  group.sockets.add(socket);
  group.identities.set(socket, { memberId: hostId, role: 'host' });

  const response = await post(group, {}, { path: '/destroy' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, destroyed: true, released: true, closed: 1 });

  const endedAt = events.indexOf('frame:ended');
  assert.ok(endedAt > 0, 'the socket was told the group ended');
  assert.deepEqual(
    [...new Set(events.slice(0, endedAt))],
    ['wipe'],
    'every step before the frame is the wipe: nothing is announced while the rows are still there'
  );
  assert.ok(events.indexOf('close:ended') > endedAt, 'the socket is closed after it is told');
  assert.ok(events.indexOf('release') > endedAt, 'and the slot is released only after the group is off the air');
  assert.deepEqual(socket.frames, [{ t: 'ended' }], 'one terminal frame, sent once');
});

/* --- End: the host's own path, held to the same order and the same slot rule as destroy. --- */

/** A socket whose frames and closes are also written to a shared event log, in the order they went. */
function loggedSocket(events) {
  const socket = newSocket();
  const send = socket.send;
  socket.send = (text) => {
    events.push(`frame:${JSON.parse(text).t}`);
    send(text);
  };
  const close = socket.close;
  socket.close = (code, reason) => {
    events.push(`close:${reason}`);
    close(code, reason);
  };
  return socket;
}

test('group: end wipes before it announces, and releases only the slot the create stored', async () => {
  const groupId = id22();
  const hostId = id22();
  const recordId = id22();
  /* A Durable Object id that is not the id the slot was taken under. */
  const objectId = id22();

  const events = [];
  const storage = makeStorage();
  const deleteKey = storage.api.delete;
  storage.api.delete = async (key) => {
    events.push('wipe');
    return deleteKey(key);
  };
  const registry = newRegistry(() => {
    events.push('release');
    return { status: 200, body: { ok: true, freed: 1 } };
  });
  const { group, stored } = newGroup({ env: registry.env, storage, id: objectId });

  await post(group, { groupId, hostId, nameBlob: sealed() });
  storage.stored.set(`record:${recordId}`, {
    id: recordId,
    rev: 1,
    blob: sealed(),
    deleted: false,
    at: 1
  });

  const socket = loggedSocket(events);
  group.sockets.add(socket);
  group.identities.set(socket, { memberId: hostId, role: 'host' });

  await group.end(socket);

  const endedAt = events.indexOf('frame:ended');
  assert.ok(endedAt > 0, 'the socket was told the group ended');
  assert.deepEqual(
    [...new Set(events.slice(0, endedAt))],
    ['wipe'],
    'every step before the frame is the wipe: nothing is announced while the rows are still there'
  );
  assert.ok(events.indexOf('close:ended') > endedAt, 'the socket is closed after it is told');
  assert.ok(events.indexOf('release') > endedAt, 'and the slot goes only after the group is off the air');
  assert.deepEqual(socket.frames, [{ t: 'ended' }], 'one terminal frame, sent once');
  assert.deepEqual(registry.calls.map((call) => call.body), [{ groupId }], 'the persisted id names the slot');
  assert.notEqual(objectId, groupId, 'the object id is a different string, so the assertion is not moot');
  assert.equal(stored.size, 0, 'the slot id goes once the release freed the row');
});

test('group: an end whose wipe failed keeps the group and its sockets', async () => {
  const hostId = id22();
  const recordId = id22();

  const storage = makeStorage();
  let deletes = 0;
  storage.api.delete = async (key) => {
    deletes += 1;
    if (deletes === 2) throw new Error('storage');
    storage.stored.delete(key);
  };
  const registry = newRegistry();
  const { group, stored } = newGroup({ env: registry.env, storage });

  await post(group, { groupId: id22(), hostId, nameBlob: sealed() });
  storage.stored.set(`record:${recordId}`, {
    id: recordId,
    rev: 1,
    blob: sealed(),
    deleted: false,
    at: 1
  });

  const host = newSocket();
  const watcher = newSocket();
  group.sockets.add(host);
  group.sockets.add(watcher);
  group.identities.set(host, { memberId: hostId, role: 'host' });
  group.identities.set(watcher, { memberId: id22(), role: 'member' });

  await group.end(host);

  assert.equal(deletes, 2, 'the wipe did stop part-way');
  for (const socket of [host, watcher]) {
    assert.deepEqual(socket.frames, [{ t: 'wipe-failed' }], 'a failed wipe is announced as what it is');
    assert.deepEqual(socket.closes, [], 'a socket whose group still exists must not be closed');
    assert.equal(group.sockets.has(socket), true, 'and stays attached to the group');
  }
  assert.equal(stored.has(GROUP_KEY), true, 'the group still exists, so the slot is still held');
  assert.equal(stored.has('slot'), true, 'and the id that names the slot is still there to retry with');
  assert.equal(registry.calls.length, 0, 'a failing wipe must never ask the Registry to free the slot');
});

test('group: an end on a group with no persisted slot id offers the ledger nothing', async () => {
  const { env, calls } = newRegistry();
  /* A group stored without the id its slot was taken under, on an instance that does have an id. */
  const { group, stored } = newGroup({ env, id: id22() });
  const hostId = id22();
  stored.set(GROUP_KEY, {
    hostId,
    joinMode: 'approval',
    rev: 0,
    nameBlob: sealed(),
    hostNameBlob: null,
    metaBlob: null
  });

  const host = newSocket();
  group.sockets.add(host);
  group.identities.set(host, { memberId: hostId, role: 'host' });

  await group.end(host);

  assert.deepEqual(host.frames, [{ t: 'ended' }], 'the group is gone, so the socket is told it ended');
  assert.deepEqual(host.closes, [{ code: 1000, reason: 'ended' }], 'and then closed');
  assert.equal(calls.length, 0, 'the Durable Object id must never be offered to the ledger as a slot');
  assert.equal(stored.size, 0, 'the group is wiped and nothing is left');
});

/* --- Wipe: a group that is being wiped takes no writes, and keeps none that arrived. --- */

/**
 * A put delivered while the wipe is awaiting storage.
 *
 * `delete` is the only await inside a wipe, so a frame already in flight when the host ends the
 * group is handled there. The hook runs the put from inside the delete it is given, which is the
 * interleaving one Durable Object can produce, and then lets the wipe carry on unchanged.
 */
function putOnWipe(storage, { onDelete = () => {}, failAt = 0 } = {}) {
  const deleteKey = storage.api.delete;
  let deletes = 0;
  let failed = false;
  storage.api.delete = async (key) => {
    deletes += 1;
    await onDelete(deletes);
    if (!failed && failAt !== 0 && deletes === failAt) {
      failed = true;
      throw new Error('storage');
    }
    return deleteKey(key);
  };
}

test('group: a put that arrives during end is refused and does not survive the wipe', async () => {
  const groupId = id22();
  const hostId = id22();
  const earlyRecord = id22();
  const lateRecord = id22();

  const storage = makeStorage();
  const registry = newRegistry();
  const { group, stored } = newGroup({ env: registry.env, storage });

  await post(group, { groupId, hostId, nameBlob: sealed() });
  stored.set(`record:${earlyRecord}`, {
    id: earlyRecord,
    rev: 1,
    blob: sealed(),
    deleted: false,
    at: 1
  });

  const host = newSocket();
  group.sockets.add(host);
  group.identities.set(host, { memberId: hostId, role: 'host' });

  /* The frame lands on the first delete: the wipe has begun and the group is still stored. */
  let arrived = false;
  putOnWipe(storage, {
    onDelete: async () => {
      if (arrived) return;
      arrived = true;
      await group.writeRecord(host, { id: lateRecord, base: 0, blob: sealed(), deleted: false });
    }
  });

  await group.end(host);

  assert.equal(arrived, true, 'the put did arrive while the wipe was running');
  assert.deepEqual(
    host.frames[0],
    { t: 'refused', code: 'wiping', id: lateRecord },
    'a group that is being wiped takes no writes'
  );
  assert.equal(stored.has(`record:${lateRecord}`), false, 'the late put must not survive the wipe');
  assert.equal(stored.has('last-write'), false, 'and must not leave its stamp behind');
  assert.deepEqual(
    host.frames[host.frames.length - 1],
    { t: 'ended' },
    'the wipe itself still finished and still announced it'
  );
  assert.equal(stored.size, 0, 'the group is gone, and nothing arrived behind it');
});

test('group: a put that arrives during /destroy is refused and does not survive the wipe', async () => {
  const groupId = id22();
  const hostId = id22();
  const lateRecord = id22();

  const storage = makeStorage();
  const registry = newRegistry();
  const { group, stored } = newGroup({ env: registry.env, storage });

  await post(group, { groupId, hostId, nameBlob: sealed() });

  const host = newSocket();
  group.sockets.add(host);
  group.identities.set(host, { memberId: hostId, role: 'host' });

  let arrived = false;
  putOnWipe(storage, {
    onDelete: async () => {
      if (arrived) return;
      arrived = true;
      await group.writeRecord(host, { id: lateRecord, base: 0, blob: sealed(), deleted: false });
    }
  });

  const response = await post(group, {}, { path: '/destroy' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, destroyed: true, released: true, closed: 1 });
  assert.equal(arrived, true, 'the put did arrive while the wipe was running');
  assert.deepEqual(
    host.frames[0],
    { t: 'refused', code: 'wiping', id: lateRecord },
    'the operator route refuses writes for the same duration'
  );
  assert.equal(stored.has(`record:${lateRecord}`), false, 'the late put must not survive the wipe');
  assert.equal(stored.has('last-write'), false, 'nor its stamp');
  assert.equal(stored.size, 0, 'nothing is left behind a wipe that reported success');
});

test('group: a failed wipe clears the mark, takes writes again, and a retry finishes', async () => {
  const groupId = id22();
  const hostId = id22();
  const earlyRecord = id22();
  const lateRecord = id22();
  const afterRecord = id22();

  const storage = makeStorage();
  const registry = newRegistry();
  const { group, stored } = newGroup({ env: registry.env, storage });

  await post(group, { groupId, hostId, nameBlob: sealed() });
  stored.set(`record:${earlyRecord}`, {
    id: earlyRecord,
    rev: 1,
    blob: sealed(),
    deleted: false,
    at: 1
  });

  const host = newSocket();
  group.sockets.add(host);
  group.identities.set(host, { memberId: hostId, role: 'host' });

  /* The put arrives on the first delete and the wipe dies on the second, with the meta — the key
     that carries the mark — still stored. That is the state a retry has to be able to leave. */
  let arrived = false;
  let markDuringWipe;
  putOnWipe(storage, {
    failAt: 2,
    onDelete: async () => {
      markDuringWipe = stored.get(GROUP_KEY)?.wiping;
      if (arrived) return;
      arrived = true;
      await group.writeRecord(host, { id: lateRecord, base: 0, blob: sealed(), deleted: false });
    }
  });

  await group.end(host);

  assert.equal(markDuringWipe, true, 'the group is marked while its wipe runs');
  assert.deepEqual(
    host.frames,
    [
      { t: 'refused', code: 'wiping', id: lateRecord },
      { t: 'wipe-failed' }
    ],
    'the late put was refused, and the failure was announced as a failure'
  );
  assert.equal(stored.has(`record:${lateRecord}`), false, 'the refused put left nothing');
  assert.equal(stored.get(GROUP_KEY).wiping, undefined, 'the mark comes off when the wipe fails');

  /* The group still exists — the sockets were told so — therefore it takes writes again. */
  await group.writeRecord(host, { id: afterRecord, base: 0, blob: sealed(), deleted: false });
  assert.equal(stored.has(`record:${afterRecord}`), true, 'a write after a failed wipe is stored');

  /* And the retry, through the operator route, finishes what the failed wipe could not. */
  const retried = await post(group, {}, { path: '/destroy' });
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { ok: true, destroyed: true, released: true, closed: 1 });
  assert.equal(stored.size, 0, 'the retry takes the whole group, including the write that followed');
});

/**
 * A put whose meta read lands before the wipe's mark, and whose write lands after the wipe listed
 * its keys.
 *
 * The mark is what every write checks, so the window is a read that happened before it was set: the
 * put is admitted on a meta with no `wiping`, and it reaches storage after the wipe's key list was
 * taken — the one interleaving in which a record survives a wipe that reports success. The stale
 * read is simulated by answering the put's first meta read from the copy taken before the mark, and
 * the put itself runs inside the wipe's first delete.
 */
test('group: a put admitted before the wipe mark is undone by the write itself', async () => {
  const groupId = id22();
  const hostId = id22();
  const earlyRecord = id22();
  const lateRecord = id22();

  const storage = makeStorage();
  const registry = newRegistry();
  const { group, stored } = newGroup({ env: registry.env, storage });

  await post(group, { groupId, hostId, nameBlob: sealed() });
  stored.set(`record:${earlyRecord}`, {
    id: earlyRecord,
    rev: 1,
    blob: sealed(),
    deleted: false,
    at: 1
  });
  const beforeMark = { ...stored.get(GROUP_KEY) };

  const host = newSocket();
  group.sockets.add(host);
  group.identities.set(host, { memberId: hostId, role: 'host' });

  let arrived = false;
  let admittedOn;
  putOnWipe(storage, {
    onDelete: async () => {
      if (arrived) return;
      arrived = true;
      /* The put's first meta read is answered from the copy taken before the mark; every later
         read — including the one the write makes after its own put — sees what is stored. */
      const storedGet = storage.api.get;
      let stale = true;
      storage.api.get = async (key) => {
        if (stale && key === GROUP_KEY) {
          stale = false;
          /* What the put is admitted on: the meta as it stood before the mark. */
          admittedOn = beforeMark.wiping;
          return beforeMark;
        }
        return storedGet(key);
      };
      await group.writeRecord(host, { id: lateRecord, base: 0, blob: sealed(), deleted: false });
      storage.api.get = storedGet;
    }
  });

  const response = await post(group, {}, { path: '/destroy' });

  assert.equal(response.status, 200, 'the wipe that ran still answers for itself');
  assert.equal(arrived, true, 'the put arrived while the wipe was running');
  assert.equal(admittedOn, undefined, 'the put was admitted on a meta that had no mark');
  assert.deepEqual(
    host.frames,
    [
      { t: 'refused', code: 'wiping', id: lateRecord },
      { t: 'ended' }
    ],
    'a record stored behind the wipe is refused, not announced, and the wipe still ends the socket'
  );
  assert.deepEqual([...stored.keys()], [], 'nothing the put wrote is left behind the wipe');
});

/* --- The slot key: the one key a wipe leaves, and a delete of it that fails. --- */

test('group: a slot key that cannot be deleted answers a defined destroy, not a 500', async () => {
  const groupId = id22();
  const hostId = id22();

  const storage = makeStorage();
  const registry = newRegistry();
  const { group, stored } = newGroup({ env: registry.env, storage });

  await post(group, { groupId, hostId, nameBlob: sealed() });
  assert.equal(stored.get('slot'), groupId, 'the create persisted the id its slot was taken under');

  const host = newSocket();
  group.sockets.add(host);
  group.identities.set(host, { memberId: hostId, role: 'host' });

  /* The group is wiped and the slot is freed; only the key that named the slot refuses to go. */
  const deleteKey = storage.api.delete;
  storage.api.delete = async (key) => {
    if (key === 'slot') throw new Error('storage');
    return deleteKey(key);
  };

  const response = await post(group, {}, { path: '/destroy' });

  assert.equal(response.status, 502, 'a group that is gone is not an internal error');
  assert.deepEqual(
    await response.json(),
    { ok: false, destroyed: true, released: true, closed: 1, error: 'slot' },
    'the answer reports the wipe, the sockets and the slot key that could not be cleared'
  );
  assert.deepEqual(host.frames, [{ t: 'ended' }], 'the sockets were told the group ended');
  assert.equal(stored.has(GROUP_KEY), false, 'and the group itself is gone');
  assert.equal(stored.get('slot'), groupId, 'the id the error reports is the key that survived');

  /* A retry finds the group empty and the ledger row already gone, and this time the key goes. */
  storage.api.delete = deleteKey;
  const retried = await post(group, {}, { path: '/destroy' });
  assert.equal(retried.status, 200, 'the retry finishes what the first call could not');
  assert.equal(stored.size, 0, 'and leaves nothing behind');
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

/**
 * Attach a socket to the instance as the WebSocket path would, with an identity and a last frame
 * at `seen`. The presence frame reads exactly these three maps, so a test can place a socket at a
 * chosen age without waiting ninety seconds for one.
 */
function attach(group, { memberId, role, seen }) {
  const socket = newSocket();
  group.sockets.add(socket);
  if (memberId !== null) group.identities.set(socket, { memberId, role });
  if (seen !== null) group.lastSeen.set(socket, seen);
  return socket;
}

test('group: presence defaults are 90 s of silence and a 30 s beat, and a socket past that is absent', async () => {
  const { group, stored } = newGroup();
  const hostId = id22();
  await post(group, { hostId, nameBlob: sealed() });

  /* No SILENCE_MS or HEARTBEAT_MS in the environment: both numbers are the code's own, so a
     deploy that forgets the vars still gets a heartbeat rather than silence or a tight loop. */
  assert.equal(group.presenceSilenceMs(), 90_000, 'a socket quiet beyond 90 s is no longer here');
  assert.equal(group.heartbeatMs(), 30_000, 'presence is re-announced every 30 s');

  const memberId = id22();
  const quietId = id22();
  const pendingId = id22();
  stored.set(`member:${memberId}`, { status: 'approved', nameBlob: sealed(), joinedAt: 0 });
  stored.set(`member:${quietId}`, { status: 'approved', nameBlob: sealed(), joinedAt: 0 });
  stored.set(`member:${pendingId}`, { status: 'pending', nameBlob: sealed(), joinedAt: 0 });

  const now = Date.now();
  attach(group, { memberId: hostId, role: 'host', seen: now });
  /* One second inside the default window: still here. */
  attach(group, { memberId, role: 'member', seen: now - 89_000 });
  /* One second past it: the silence default, not a var, is what drops them. */
  const quiet = attach(group, { memberId: quietId, role: 'member', seen: now - 91_000 });
  /* Neither of these may be named: a pending row is not approved, and an unauthenticated socket
     has no identity at all. */
  attach(group, { memberId: pendingId, role: 'pending', seen: now });
  attach(group, { memberId: null, role: null, seen: now });

  const frame = await group.presenceFrame();
  assert.deepEqual(frame, { t: 'here', ids: [hostId, memberId] }, 'only the speaking approved sockets');

  /* The quiet socket is still attached and still fresh in the map; it is the age alone that
     leaves it out, and a frame a second later does not bring it back. */
  assert.equal(group.sockets.has(quiet), true, 'nothing closed the quiet socket');
  const later = await group.presenceFrame();
  assert.equal(later.ids.includes(quietId), false, 'a socket past the silence window stays absent');
});

/* --- State frames: a roster change is pushed as the roster, not as the whole ledger. --- */

test('group: a pushed state frame carries the roster, and only a fresh authentication carries the ledger', async () => {
  const { group, stored } = newGroup();
  const hostId = id22();
  const memberId = id22();
  await post(group, { hostId, nameBlob: sealed(), hostNameBlob: sealed() });

  const recordIds = [id22(), id22(), id22()];
  recordIds.forEach((id, index) => {
    stored.set(`record:${id}`, {
      id,
      rev: 1,
      blob: sealed(),
      deleted: false,
      author: hostId,
      creator: hostId,
      at: index + 1
    });
  });
  stored.set(`member:${memberId}`, { status: 'approved', nameBlob: sealed(), joinedAt: 0 });

  const meta = stored.get(GROUP_KEY);

  /* The frame a socket is answered with when it authenticates: the whole ledger, because that is
     the one moment a device may be holding nothing. */
  const full = await group.rosterFrame(meta, hostId, 'host');
  assert.deepEqual(
    full.records.map((record) => record.id),
    recordIds,
    'authentication carries every stored row, in write order'
  );

  /* Every frame pushed after a roster change: the roster and the meta, no records key at all. The
     ledger did not change, so the push has no business carrying it — and an empty list would read
     as "this group holds nothing" to a client that merges it. */
  const host = attach(group, { memberId: hostId, role: 'host', seen: Date.now() });
  const member = attach(group, { memberId, role: 'member', seen: Date.now() });
  await group.notifyState(meta);

  for (const socket of [host, member]) {
    assert.equal(socket.frames.length, 1, 'one state frame per attached socket');
    const [pushed] = socket.frames;
    assert.equal(pushed.t, 'state');
    assert.equal('records' in pushed, false, 'a roster push must not serialise the ledger');
    assert.equal(
      pushed.roster.some((entry) => entry.id === memberId && entry.status === 'approved'),
      true,
      'the roster change still travels'
    );
    assert.equal(pushed.roster.some((entry) => entry.id === hostId), true, 'so does the sealed host name');
  }

  /* A join the host has to decide is answered the same way: the pending name travels, the ledger
     does not. */
  await group.notifyHosts(meta);
  assert.equal(host.frames.length, 2, 'the host is told once more');
  assert.equal('records' in host.frames[1], false, 'and that frame is a roster push too');
  assert.equal(member.frames.length, 1, 'a member is not told about a host-only frame');
});

