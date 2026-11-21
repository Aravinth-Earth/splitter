/**
 * /api/create reserves a slot and initialises the group.
 *
 * The gate is behavioural, not structural: a real `wrangler dev` runs the real Worker, the real
 * Registry and real Group Durable Objects on a throwaway store, and the suite drives them over
 * HTTP exactly as the page will. Twenty-six distinct creates against a cap of twenty-five must
 * leave twenty-five groups and one refusal, and a retried create must not spend a second slot.
 *
 * Nothing here carries plaintext: the blobs are random bytes of the right size, which is all a
 * sealed name is to the server. Ids are shaped the way the client makes them — the group id comes
 * from the same derivation crypto.js uses, and one case asserts that derivation's own output shape
 * is accepted rather than refused as malformed.
 *
 * Two things are proved without a socket. The media-type gate is a refusal that must cost no slot,
 * so it is driven over HTTP with the slot count visible. The compensation path — release the slot
 * when the group cannot be initialised — cannot be reached by any HTTP request (the edge refuses
 * every body the Group refuses), so the Worker is called directly with bindings that refuse, and
 * the release is read from a call log.
 *
 * Every assertion names the guarantee, so a failure reports the promise rather than a line number.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as holdServer } from 'node:http';
import { createServer } from 'node:net';
import test from 'node:test';

import { generateCode, groupIdFromCode, randomSecret } from '../public/crypto.js';
import {
  API,
  COLD_START_UPPER_MS,
  DEFAULT_HEALTH_TIMEOUT_MS,
  PORT_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  startWorker
} from './wrangler.mjs';

/**
 * A member id: 22 characters, 16 bytes, base64url, unpadded — the shape the client sends for a
 * person. It is never a group id, so it appears here only as `hostId`.
 */
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

/** A group id as crypto.js derives it: 64 lowercase hex characters, the one shape a group has. */
function groupFixtureId() {
  return randomBytes(32).toString('hex');
}

function createBody(groupId) {
  return { groupId, hostId: id22(), nameBlob: sealed(), metaBlob: sealed() };
}

async function post(baseUrl, path, payload, { method = 'POST', raw, type = 'application/json' } = {}) {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const headers = {};
  /* `type: null` sends no content-type header of its own, which is one of the refusals under test. */
  if (type !== null) headers['content-type'] = type;
  const response = await fetch(`${baseUrl}${API}${path}`, {
    method,
    headers,
    body: hasBody ? (raw ?? JSON.stringify(payload)) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, headers: response.headers, body };
}

async function createGroup(baseUrl, payload) {
  return post(baseUrl, '/create', payload);
}

/**
 * A body sent chunk by chunk, so the request carries no `content-length` at all.
 *
 * This is the shape a declared-length check cannot see, and the one that decides whether the cap
 * is a limit on the bytes received or only on a header the client wrote.
 */
function streamedJson(payload, chunk = 8192) {
  const bytes = new TextEncoder().encode(payload);
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunk) controller.enqueue(bytes.slice(at, at + chunk));
      controller.close();
    }
  });
}

/* ------------------------------------------------------------------ the gate */

test('create: twenty-six creates against a cap of twenty-five leave twenty-five groups', async (t) => {
  const worker = await startWorker({ vars: { MAX_GROUPS: '25' } });
  t.after(async () => {
    await worker.stop();
  });

  /* The cap is spent first, on purpose. Every malformed case below then runs against a full
     ledger, where any request that reached the ledger would be answered 429 — so a 400 is proof
     the validation refused it before a slot was asked for. */
  await t.test('26 distinct creates leave 25 ok answers and one limit', async () => {
    const ids = Array.from({ length: 26 }, () => groupFixtureId());
    assert.equal(new Set(ids).size, 26, 'the 26 ids must be distinct');

    const results = [];
    for (const groupId of ids) {
      results.push(await createGroup(worker.baseUrl, createBody(groupId)));
    }

    const ok = results.filter((result) => result.status === 200);
    const limited = results.filter((result) => result.status === 429);

    assert.equal(results.length, 26);
    assert.equal(ok.length, 25, `25 creates must be accepted, got ${ok.length}`);
    assert.equal(limited.length, 1, `exactly one create must be refused for the cap, got ${limited.length}`);
    for (const result of ok) assert.deepEqual(result.body, { ok: true, created: true });
    for (const result of limited) assert.deepEqual(result.body, { error: 'limit' });

    /* A refusal is not a slot: re-sending the refused id while the ledger is still full is
       refused again, so the refusal neither held a slot nor freed one. */
    const refusedId = ids[results.findIndex((result) => result.status === 429)];
    assert.equal((await createGroup(worker.baseUrl, createBody(refusedId))).status, 429);

    /* Idempotency: a retry of an accepted id is ok, and it does not make a slot appear. `created`
       is false because the group was already there — the answer the page uses to tell a retry of
       its own create from a code that names somebody else's group. */
    const retried = await createGroup(worker.baseUrl, createBody(ids[0]));
    assert.equal(retried.status, 200);
    assert.deepEqual(retried.body, { ok: true, created: false });

    const again = await createGroup(worker.baseUrl, createBody(ids[1]));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { ok: true, created: false });

    const fresh = await createGroup(worker.baseUrl, createBody(groupFixtureId()));
    assert.equal(fresh.status, 429, 'a retry must not free or add a slot');
    assert.deepEqual(fresh.body, { error: 'limit' });
  });

  await t.test('a body that is not JSON is refused', async () => {
    const result = await post(worker.baseUrl, '/create', null, { raw: '{"groupId":' });
    assert.equal(result.status, 400, 'unparseable body must not reach a Durable Object');
    assert.deepEqual(result.body, { error: 'body' });
  });

  await t.test('a missing or unusable sealed name is refused', async () => {
    const cases = [
      { ...createBody(groupFixtureId()), nameBlob: undefined },
      { ...createBody(groupFixtureId()), nameBlob: null },
      { ...createBody(groupFixtureId()), nameBlob: { iv: 'AAAAAAAAAAAAAAAA' } },
      { ...createBody(groupFixtureId()), nameBlob: { iv: 'AAAA', ct: 'AAAA' } },
      { ...createBody(groupFixtureId()), nameBlob: 'Ana' },
      { ...createBody(groupFixtureId()), metaBlob: { iv: 'AAAAAAAAAAAAAAAA' } }
    ];
    for (const payload of cases) {
      const result = await createGroup(worker.baseUrl, payload);
      assert.equal(result.status, 400, `nameBlob ${JSON.stringify(payload.nameBlob)} must be refused`);
      assert.deepEqual(result.body, { error: 'blob' });
    }
  });

  await t.test('a hostId that is not an id is refused', async () => {
    const result = await createGroup(worker.baseUrl, { ...createBody(groupFixtureId()), hostId: 'host' });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'hostId' });
  });

  await t.test('a method other than POST is refused, and the answer names POST', async () => {
    const result = await post(worker.baseUrl, '/create', null, { method: 'GET' });
    assert.equal(result.status, 405);
    assert.equal(result.headers.get('allow'), 'POST', 'a 405 must carry Allow: POST (RFC 9110)');
    assert.deepEqual(result.body, { error: 'method' });
  });
});

/* ---------------------------------------------------- the refusal that must cost nothing */

test('create: a bad groupId is refused before any slot is taken', async (t) => {
  /* One slot, free, and every refusal comes first: the valid create that follows taking it is
     what proves the refusals spent nothing. Run against a full ledger instead, a 400 would only
     show the validation fired before a 429 — it could not show the ledger was left alone. */
  const worker = await startWorker({ vars: { MAX_GROUPS: '1' } });
  t.after(async () => {
    await worker.stop();
  });

  const bad = [
    '',
    'not-an-id',
    /* A member id, whole: the one non-group shape a create used to accept, which made a group
       the destroy could never name. */
    id22(),
    id22().slice(0, 21),
    `${id22().slice(0, 21)}!`,
    `${id22()}A`,
    `${id22()}=`,
    '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210AA', // 66 characters
    '0FDD7A502A8BB14CF22851CD4A0C60FCA5C514FB7C8ECB391DC47E3F9BE7F786' // 64 hex, upper case
  ];

  for (const groupId of bad) {
    const result = await createGroup(worker.baseUrl, { ...createBody(groupFixtureId()), groupId });
    assert.equal(result.status, 400, `"${groupId}" must be refused before any slot is taken`);
    assert.deepEqual(result.body, { error: 'groupId' });
  }

  /* Absent and non-string ids are refused the same way. */
  for (const groupId of [undefined, 42, null]) {
    const result = await createGroup(worker.baseUrl, { ...createBody(groupFixtureId()), groupId });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'groupId' });
  }

  /* The only slot is still there to take: a refusal neither took one nor bypassed the cap. */
  const accepted = await createGroup(worker.baseUrl, createBody(groupFixtureId()));
  assert.equal(accepted.status, 200, 'the only slot must still be free after every bad groupId');
  assert.deepEqual(accepted.body, { ok: true, created: true });
});

/* --------------------------------------------------------------- the media type */

test('create: only application/json may reach a slot, and a refused type spends none', async (t) => {
  /* One slot, and the refusal comes first while it is free: the create that follows succeeding is
     what proves the text/plain request took nothing. A cross-site page can send `text/plain` with
     no preflight, so this is the shape a drive-by create would use. */
  const worker = await startWorker({ vars: { MAX_GROUPS: '1' } });
  t.after(async () => {
    await worker.stop();
  });

  const simple = await post(worker.baseUrl, '/create', createBody(groupFixtureId()), { type: 'text/plain' });
  assert.equal(simple.status, 400, 'a CORS-simple media type must be refused before a slot is asked for');
  assert.deepEqual(simple.body, { error: 'body' });

  /* The same body in the type the page will send: the exact type, with a charset. It takes the one
     slot — which is only possible because the request above spent nothing. */
  const accepted = await post(worker.baseUrl, '/create', createBody(groupFixtureId()), {
    type: 'application/json; charset=utf-8'
  });
  assert.equal(accepted.status, 200, 'application/json with a charset is accepted, and the slot was free');
  assert.deepEqual(accepted.body, { ok: true, created: true });

  /* The ledger is now full, so a request that reached it answers 429 and one refused before it
     answers 400. Each of these is a type this API does not speak. */
  for (const type of [
    'text/plain',
    'application/json-patch+json',
    'application/x-www-form-urlencoded',
    'Text/Plain'
  ]) {
    const refused = await post(worker.baseUrl, '/create', createBody(groupFixtureId()), { type });
    assert.equal(refused.status, 400, `content-type ${type} must be refused before the ledger is asked`);
    assert.deepEqual(refused.body, { error: 'body' });
  }

  /* A create with no content-type at all. Sent as a stream, because fetch would otherwise add a
     `text/plain` of its own and hide the case. */
  const untyped = await fetch(`${worker.baseUrl}${API}/create`, {
    method: 'POST',
    body: streamedJson(JSON.stringify(createBody(groupFixtureId()))),
    duplex: 'half',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  assert.equal(untyped.status, 400, 'a create with no media type is not JSON');
  assert.deepEqual(await untyped.json(), { error: 'body' });

  /* Media types are case-insensitive, so a mixed-case one is accepted by the gate and refused only
     by the cap — a 400 here would mean the gate compares strings case-sensitively. */
  const mixedCase = await post(worker.baseUrl, '/create', createBody(groupFixtureId()), { type: 'Application/JSON' });
  assert.equal(mixedCase.status, 429, 'a mixed-case media type is accepted and only the full ledger refuses');
  assert.deepEqual(mixedCase.body, { error: 'limit' });

  /* Nothing above freed or added a slot. */
  const next = await createGroup(worker.baseUrl, createBody(groupFixtureId()));
  assert.equal(next.status, 429, 'a refused content-type must neither take nor free a slot');
  assert.deepEqual(next.body, { error: 'limit' });
});

/* ------------------------------------------- the compensation path, without the network */

/**
 * The real Worker over two fake Durable Object namespaces.
 *
 * `calls` records every internal request in order, so "the slot was released" is an observed call
 * rather than an inference from a status code. `initRefuses` makes the Group answer the way a
 * refusing Group does; `reserved` is what the ledger says about the slot this create took.
 */
function fakeBindings({ initRefuses = false, reserved = true } = {}) {
  const calls = [];
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const registry = {
    fetch: async (url, init) => {
      const { pathname } = new URL(url);
      calls.push({ pathname, body: JSON.parse(init.body) });
      if (pathname === '/reserve') return reply({ ok: true, reserved });
      if (pathname === '/release') return reply({ ok: true });
      return reply({ error: 'not_found' }, 404);
    }
  };
  const group = {
    fetch: async (url, init) => {
      const { pathname } = new URL(url);
      calls.push({ pathname, body: JSON.parse(init.body) });
      return initRefuses ? reply({ ok: false, error: 'hostId' }, 400) : reply({ ok: true, created: true });
    }
  };

  return {
    calls,
    env: {
      REGISTRY: { idFromName: (name) => ({ name }), get: () => registry },
      GROUPS: { idFromName: (name) => ({ name }), get: () => group }
    }
  };
}

/** The request the page makes, built without a socket. */
function createRequest(payload) {
  return new Request(`https://splitter.test${API}/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

test('create: a refused init gives its slot back', async () => {
  /* This branch cannot be reached over HTTP: the edge refuses every body the Group would refuse,
     both reading the same shapes from wire.js, so no request to /api/create can make a real Group
     answer with a refusal. The Worker is therefore driven with bindings that answer the way a
     refusing Group does, and the release is what the call log shows. */
  const { default: worker } = await import('../src/index.js');
  const groupId = groupFixtureId();
  const { calls, env } = fakeBindings({ initRefuses: true });

  const response = await worker.fetch(createRequest(createBody(groupId)), env);
  assert.equal(response.status, 500, 'an init that was refused must not answer ok');
  assert.deepEqual(await response.json(), { error: 'internal' });

  assert.deepEqual(
    calls.map((call) => call.pathname),
    ['/reserve', '/init', '/release'],
    'a slot this create took must be handed back when the group cannot be initialised'
  );
  assert.deepEqual(calls[2].body, { groupId }, 'the release must name the id that was reserved');
});

test('create: an init failure after a retry frees nothing, because the retry took nothing', async () => {
  /* The same failure on a create whose id already held a slot: the ledger answered `reserved:
     false`, so this call must not free a slot the first create is still using. */
  const { default: worker } = await import('../src/index.js');
  const { calls, env } = fakeBindings({ initRefuses: true, reserved: false });

  const response = await worker.fetch(createRequest(createBody(groupFixtureId())), env);
  assert.equal(response.status, 500);
  assert.deepEqual(
    calls.map((call) => call.pathname),
    ['/reserve', '/init'],
    'a create that reserved nothing must not release'
  );
});

test('create: a successful create reserves, initialises, and releases nothing', async () => {
  const { default: worker } = await import('../src/index.js');
  const groupId = groupFixtureId();
  const body = createBody(groupId);
  const { calls, env } = fakeBindings();

  const response = await worker.fetch(createRequest(body), env);
  assert.equal(response.status, 200, 'the success body keeps its ok');
  assert.deepEqual(
    await response.json(),
    { ok: true, created: true },
    'a create that initialised the group says so, so the page knows it is the organizer'
  );
  assert.deepEqual(
    calls.map((call) => call.pathname),
    ['/reserve', '/init'],
    'a create that succeeded must not release its slot'
  );
  assert.deepEqual(calls[1].body, {
    groupId,
    hostId: body.hostId,
    nameBlob: body.nameBlob,
    hostNameBlob: null,
    metaBlob: body.metaBlob
  });
});

/* ------------------------------------------- the id the client actually sends */

test('create: an id derived by crypto.js is accepted, and the cap comes from the environment', async (t) => {
  const worker = await startWorker({ vars: { MAX_GROUPS: '1' } });
  t.after(async () => {
    await worker.stop();
  });

  /* crypto.js hashes the code into 64 lowercase hex characters. A 400 here would mean the page's
     own group id is refused as malformed, so this case pins that the derived shape is accepted —
     and the create and the destroy check the same shape, so it is also the shape the operator can
     remove. */
  const derived = await groupIdFromCode(generateCode());
  assert.match(derived, /^[0-9a-f]{64}$/);

  const created = await createGroup(worker.baseUrl, {
    groupId: derived,
    hostId: await randomSecret(),
    nameBlob: sealed()
  });
  assert.equal(created.status, 200, 'the id crypto.js derives must be accepted');
  assert.deepEqual(created.body, { ok: true, created: true });

  /* One slot, already taken: the cap is the number in the environment, not a constant. */
  const limited = await createGroup(worker.baseUrl, createBody(groupFixtureId()));
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { error: 'limit' });

  /* The same derived id again is still ok, and still one slot. */
  const retried = await createGroup(worker.baseUrl, {
    groupId: derived,
    hostId: await randomSecret(),
    nameBlob: sealed()
  });
  assert.equal(retried.status, 200);
  assert.deepEqual(
    retried.body,
    { ok: true, created: false },
    'the second create of a live id says the group was already there, which is what a collision looks like'
  );
});

/* ------------------------------------------------- storage, without the network */

test('group: the group stores its host, an approval join mode and revision zero', async () => {
  /* Imported here rather than at the top of the file: a missing class then fails this one test,
     instead of one import error hiding every HTTP case behind it. */
  const { Group } = await import('../src/group.js');

  const stored = new Map();
  const ctx = {
    storage: {
      get: async (key) => stored.get(key),
      put: async (key, value) => {
        stored.set(key, value);
      }
    }
  };

  const group = new Group(ctx, {});
  const hostId = id22();
  const nameBlob = sealed();

  const first = await group.init({ hostId, nameBlob, metaBlob: null });
  assert.equal(first.created, true);

  const meta = stored.get('meta');
  assert.ok(meta, 'init must write the group meta');
  assert.equal(meta.hostId, hostId);
  assert.equal(meta.joinMode, 'approval');
  assert.equal(meta.rev, 0);
  assert.deepEqual(meta.nameBlob, nameBlob);
  assert.equal(meta.metaBlob, null);

  /* A retry with the same id is a no-op: the first host and revision stand. */
  const second = await group.init({ hostId: id22(), nameBlob: sealed(), metaBlob: sealed() });
  assert.equal(second.created, false);
  assert.deepEqual(stored.get('meta'), meta);
  assert.equal(stored.get('meta').rev, 0);
});

/* ------------------------------------------------------- the cap on received bytes */

test('create: a body over the cap is refused without a content-length to check', async (t) => {
  /* One slot, so whether the refusal cost one is visible in the next create. */
  const worker = await startWorker({ vars: { MAX_GROUPS: '1' } });
  t.after(async () => {
    await worker.stop();
  });

  /* Just over the 64 KiB cap, and sent chunked: no content-length header exists to read. */
  const payload = JSON.stringify({ groupId: groupFixtureId(), hostId: id22(), nameBlob: sealed(50_000) });
  assert.ok(payload.length > 64 * 1024, 'the fixture must exceed the cap');

  const response = await fetch(`${worker.baseUrl}${API}/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: streamedJson(payload),
    duplex: 'half',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  assert.equal(response.status, 400, 'the cap is on the bytes received, not on a header');
  assert.deepEqual(await response.json(), { error: 'body' });

  /* A refused body is not a create: the only slot is still free. */
  const created = await createGroup(worker.baseUrl, createBody(groupFixtureId()));
  assert.equal(created.status, 200, 'an oversized body must not have taken the only slot');
  assert.deepEqual(created.body, { ok: true, created: true });
});

test('create: the body cap is a threshold, not a wall', async (t) => {
  /* Both sides of the same number, with one slot at stake so a refusal that quietly took a slot
     and an acceptance that quietly took none are both visible. The chunked case above pins the
     rule that the cap counts bytes received; this one pins the number it counts to. */
  const worker = await startWorker({ vars: { MAX_GROUPS: '1' } });
  t.after(async () => {
    await worker.stop();
  });

  /* About 120 KB: over the 64 KiB cap. */
  const oversized = { ...createBody(groupFixtureId()), nameBlob: sealed(90_000) };
  const oversizedBytes = JSON.stringify(oversized).length;
  assert.ok(oversizedBytes > 64 * 1024, `the fixture must exceed the cap, got ${oversizedBytes} bytes`);
  const refused = await createGroup(worker.baseUrl, oversized);
  assert.equal(refused.status, 400, 'a body over 64 KiB must be refused');
  assert.deepEqual(refused.body, { error: 'body' });

  /* About 53 KB: a large but legal create, comfortably inside the cap. It must still get the
     slot, so the cap cannot be satisfied by refusing everything. */
  const large = { ...createBody(groupFixtureId()), nameBlob: sealed(40_000) };
  const size = JSON.stringify(large).length;
  assert.ok(size > 32 * 1024 && size < 64 * 1024, `the fixture must sit under the cap, got ${size} bytes`);
  const accepted = await createGroup(worker.baseUrl, large);
  assert.equal(accepted.status, 200, `a ${size}-byte body is under 64 KiB and must be accepted`);
  assert.deepEqual(accepted.body, { ok: true, created: true });

  /* The oversized body spent nothing and the legal one spent the one slot: hence the refusal. */
  const next = await createGroup(worker.baseUrl, createBody(groupFixtureId()));
  assert.equal(next.status, 429, 'the refusal must not have taken a slot, and the acceptance must have');
  assert.deepEqual(next.body, { error: 'limit' });
});

/* ------------------------------------------------------------- the harness itself */

/**
 * A port another process holds: a real HTTP server that answers 503.
 *
 * Answering, rather than accepting and saying nothing, matters: a probe against a silent socket
 * would hold one request open for the whole deadline and turn a three-second bind failure into a
 * fifteen-second wait. This server is the other tenant the retry exists for.
 */
async function holdPort(t) {
  const server = holdServer((request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' });
    response.end('held by the test\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return server.address().port;
}

/**
 * A port nothing holds, asked for the way the harness asks for one: bind, read, close.
 *
 * Duplicated from tests/wrangler.mjs on purpose — the harness does not export its port chooser,
 * and a test that had to reach inside it could not tell an injected port from a chosen one.
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('wrangler: a port another process holds is retried, and the result is only baseUrl and stop', async (t) => {
  /* The first port is taken by a live server, so wrangler's own bind fails; the second is handed
     in so the successful attempt's address is known in advance. Asserting on that address is what
     makes the retry observable — a harness that ignored `ports` would pick a free port of its own,
     boot, and pass every other assertion in this test. */
  const occupied = await holdPort(t);
  const next = await freePort();
  const worker = await startWorker({ ports: [occupied, next] });
  t.after(async () => {
    await worker.stop();
  });

  assert.equal(
    worker.baseUrl,
    `http://127.0.0.1:${next}`,
    'after a lost bind the next attempt must listen on the port it was handed'
  );
  assert.deepEqual(
    Object.keys(worker).sort(),
    ['baseUrl', 'stop'],
    'the handle carries the address and the stopper, and nothing a caller could come to depend on'
  );
  const health = await fetch(`${worker.baseUrl}${API}/health`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  assert.equal(health.status, 200, 'the worker behind the retried port must really answer');
});

test('wrangler: every attempt that loses its port reports the bind, not a health timeout', async (t) => {
  const occupied = await holdPort(t);
  /* Every attempt is handed the same held port, so none can succeed: this is the aggregate error
     a caller sees when the retry budget runs out. */
  await assert.rejects(
    startWorker({ ports: Array(PORT_ATTEMPTS).fill(occupied), timeoutMs: 30_000 }),
    (error) => {
      assert.match(
        error.message,
        new RegExp(`could not bind port ${occupied}`),
        'the failure must name the port that was lost'
      );
      assert.equal(typeof error.log, 'string', "the aggregate error must carry wrangler's log");
      assert.match(error.log, /address already in use/i, "the log must be wrangler's own bind error");
      assert.match(
        error.message,
        /address already in use/i,
        'the bind must be in the message, not only in the attached log'
      );
      assert.doesNotMatch(
        error.message,
        /never answered/,
        'a lost bind must never be reported as a start that did not answer'
      );
      return true;
    }
  );
});

test('wrangler: the recorded cold start leaves the health wait and every request room', () => {
  /* Every deadline is a multiple of the recorded bound, so a boot that is slower than usual is a
     slow test rather than a flake, and a bound quietly raised to meet a deadline fails here. */
  assert.ok(COLD_START_UPPER_MS > 0, 'the cold start must have a recorded bound');
  assert.ok(
    DEFAULT_HEALTH_TIMEOUT_MS >= 10 * COLD_START_UPPER_MS,
    `a ${DEFAULT_HEALTH_TIMEOUT_MS} ms health wait must leave ten cold starts of room`
  );
  assert.ok(
    REQUEST_TIMEOUT_MS >= 2 * COLD_START_UPPER_MS,
    `a ${REQUEST_TIMEOUT_MS} ms request must leave two cold starts of room`
  );
});
