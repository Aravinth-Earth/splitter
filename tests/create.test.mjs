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
 * Every assertion names the guarantee, so a failure reports the promise rather than a line number.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { generateCode, groupIdFromCode, randomSecret } from '../public/w/expense-splitter/crypto.js';
import { API, startWorker } from './wrangler.mjs';

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

function createBody(groupId) {
  return { groupId, hostId: id22(), nameBlob: sealed(), metaBlob: sealed() };
}

async function post(baseUrl, path, payload, { method = 'POST', raw } = {}) {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const response = await fetch(`${baseUrl}${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: hasBody ? (raw ?? JSON.stringify(payload)) : undefined,
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
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

  await t.test('a body that is not JSON is refused', async () => {
    const result = await post(worker.baseUrl, '/create', null, { raw: '{"groupId":' });
    assert.equal(result.status, 400, 'unparseable body must not reach a Durable Object');
    assert.deepEqual(result.body, { error: 'body' });
  });

  await t.test('a groupId that is not an id is refused', async () => {
    const bad = [
      '',
      'not-an-id',
      id22().slice(0, 21),
      `${id22().slice(0, 21)}!`,
      `${id22()}A`,
      `${id22()}=`,
      '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210AA', // 66 characters
      '0FDD7A502A8BB14CF22851CD4A0C60FCA5C514FB7C8ECB391DC47E3F9BE7F786' // 64 hex, upper case
    ];

    for (const groupId of bad) {
      const result = await createGroup(worker.baseUrl, { ...createBody(id22()), groupId });
      assert.equal(result.status, 400, `"${groupId}" must be refused before any slot is taken`);
      assert.deepEqual(result.body, { error: 'groupId' });
    }

    /* Absent and non-string ids are refused the same way. */
    for (const groupId of [undefined, 42, null]) {
      const result = await createGroup(worker.baseUrl, { ...createBody(id22()), groupId });
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: 'groupId' });
    }
  });

  await t.test('a missing or unusable sealed name is refused', async () => {
    const cases = [
      { ...createBody(id22()), nameBlob: undefined },
      { ...createBody(id22()), nameBlob: null },
      { ...createBody(id22()), nameBlob: { iv: 'AAAAAAAAAAAAAAAA' } },
      { ...createBody(id22()), nameBlob: { iv: 'AAAA', ct: 'AAAA' } },
      { ...createBody(id22()), nameBlob: 'Ana' },
      { ...createBody(id22()), metaBlob: { iv: 'AAAAAAAAAAAAAAAA' } }
    ];
    for (const payload of cases) {
      const result = await createGroup(worker.baseUrl, payload);
      assert.equal(result.status, 400, `nameBlob ${JSON.stringify(payload.nameBlob)} must be refused`);
      assert.deepEqual(result.body, { error: 'blob' });
    }
  });

  await t.test('a hostId that is not an id is refused', async () => {
    const result = await createGroup(worker.baseUrl, { ...createBody(id22()), hostId: 'host' });
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'hostId' });
  });

  await t.test('a method other than POST is refused', async () => {
    const result = await post(worker.baseUrl, '/create', null, { method: 'GET' });
    assert.equal(result.status, 405);
    assert.deepEqual(result.body, { error: 'method' });
  });

  await t.test('26 distinct creates leave 25 ok answers and one limit', async () => {
    const ids = Array.from({ length: 26 }, () => id22());
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
    for (const result of ok) assert.deepEqual(result.body, { ok: true });
    for (const result of limited) assert.deepEqual(result.body, { error: 'limit' });
    for (const result of results) assert.ok([200, 429].includes(result.status), `unexpected ${result.status}`);

    /* A refusal is not a slot: re-sending the refused id while the ledger is still full is
       refused again, so the refusal neither held a slot nor freed one. */
    const refusedId = ids[results.findIndex((result) => result.status === 429)];
    assert.equal((await createGroup(worker.baseUrl, createBody(refusedId))).status, 429);

    /* Idempotency: a retry of an accepted id is ok, and it does not make a slot appear. */
    const retried = await createGroup(worker.baseUrl, createBody(ids[0]));
    assert.equal(retried.status, 200);
    assert.deepEqual(retried.body, { ok: true });

    const again = await createGroup(worker.baseUrl, createBody(ids[1]));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { ok: true });

    const fresh = await createGroup(worker.baseUrl, createBody(id22()));
    assert.equal(fresh.status, 429, 'a retry must not free or add a slot');
    assert.deepEqual(fresh.body, { error: 'limit' });
  });
});

/* ------------------------------------------- the id the client actually sends */

test('create: an id derived by crypto.js is accepted, and the cap comes from the environment', async (t) => {
  const worker = await startWorker({ vars: { MAX_GROUPS: '1' } });
  t.after(async () => {
    await worker.stop();
  });

  /* crypto.js hashes the code into 64 lowercase hex characters — not the 22-character shape the
     ledger was specified against. A 400 here would mean the page's own group id is refused as
     malformed, so this case pins that both shapes are accepted. */
  const derived = await groupIdFromCode(generateCode());
  assert.match(derived, /^[0-9a-f]{64}$/);

  const created = await createGroup(worker.baseUrl, {
    groupId: derived,
    hostId: await randomSecret(),
    nameBlob: sealed()
  });
  assert.equal(created.status, 200, 'the id crypto.js derives must be accepted');
  assert.deepEqual(created.body, { ok: true });

  /* One slot, already taken: the cap is the number in the environment, not a constant. */
  const limited = await createGroup(worker.baseUrl, createBody(id22()));
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.body, { error: 'limit' });

  /* The same derived id again is still ok, and still one slot. */
  const retried = await createGroup(worker.baseUrl, {
    groupId: derived,
    hostId: await randomSecret(),
    nameBlob: sealed()
  });
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body, { ok: true });
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
  const payload = JSON.stringify({ groupId: id22(), hostId: id22(), nameBlob: sealed(50_000) });
  assert.ok(payload.length > 64 * 1024, 'the fixture must exceed the cap');

  const response = await fetch(`${worker.baseUrl}${API}/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: streamedJson(payload),
    duplex: 'half',
    signal: AbortSignal.timeout(15_000)
  });
  assert.equal(response.status, 400, 'the cap is on the bytes received, not on a header');
  assert.deepEqual(await response.json(), { error: 'body' });

  /* A refused body is not a create: the only slot is still free. */
  const created = await createGroup(worker.baseUrl, createBody(id22()));
  assert.equal(created.status, 200, 'an oversized body must not have taken the only slot');
  assert.deepEqual(created.body, { ok: true });
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
  const oversized = { ...createBody(id22()), nameBlob: sealed(90_000) };
  const oversizedBytes = JSON.stringify(oversized).length;
  assert.ok(oversizedBytes > 64 * 1024, `the fixture must exceed the cap, got ${oversizedBytes} bytes`);
  const refused = await createGroup(worker.baseUrl, oversized);
  assert.equal(refused.status, 400, 'a body over 64 KiB must be refused');
  assert.deepEqual(refused.body, { error: 'body' });

  /* About 53 KB: a large but legal create, comfortably inside the cap. It must still get the
     slot, so the cap cannot be satisfied by refusing everything. */
  const large = { ...createBody(id22()), nameBlob: sealed(40_000) };
  const size = JSON.stringify(large).length;
  assert.ok(size > 32 * 1024 && size < 64 * 1024, `the fixture must sit under the cap, got ${size} bytes`);
  const accepted = await createGroup(worker.baseUrl, large);
  assert.equal(accepted.status, 200, `a ${size}-byte body is under 64 KiB and must be accepted`);
  assert.deepEqual(accepted.body, { ok: true });

  /* The oversized body spent nothing and the legal one spent the one slot: hence the refusal. */
  const next = await createGroup(worker.baseUrl, createBody(id22()));
  assert.equal(next.status, 429, 'the refusal must not have taken a slot, and the acceptance must have');
  assert.deepEqual(next.body, { error: 'limit' });
});
