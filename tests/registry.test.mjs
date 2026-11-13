/**
 * The slot ledger, without a network.
 *
 * The cap and the retry behaviour are proven end to end in create.test.mjs; this file proves the
 * other half of the ledger — that giving a slot back frees exactly one, and that a cap of nothing
 * usable falls back to the documented default rather than to zero groups.
 *
 * `ctx.storage.sql` is replaced by a five-statement stand-in. It throws on any SQL it does not
 * know, so a query the fake has not been taught cannot pass silently.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MAX_GROUPS, Registry } from '../src/registry.js';

/** A Registry ctx backed by one Map, plus the three statements reserve and release use. */
function fakeContext() {
  const rows = new Map();

  function exec(statement, ...params) {
    const text = statement.replace(/\s+/g, ' ').trim();
    if (text.startsWith('CREATE TABLE IF NOT EXISTS slots')) return { toArray: () => [] };
    if (text.startsWith('SELECT 1 FROM slots')) return { toArray: () => (rows.has(params[0]) ? [{}] : []) };
    if (text.startsWith('SELECT COUNT(*) AS held FROM slots')) return { toArray: () => [{ held: rows.size }] };
    if (text.startsWith('INSERT INTO slots')) {
      rows.set(params[0], true);
      return { toArray: () => [] };
    }
    if (text.startsWith('DELETE FROM slots')) {
      rows.delete(params[0]);
      return { toArray: () => [] };
    }
    throw new Error(`fake sql: ${text}`);
  }

  return {
    rows,
    ctx: { storage: { sql: { exec } }, blockConcurrencyWhile: (fn) => fn() }
  };
}

const id = (n) => `${String(n).padStart(22, '0')}`;

test('registry: a repeated reserve takes one slot, and the cap refuses the next', () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });
  assert.equal(registry.maxGroups(), 2, 'the cap comes from the environment');

  assert.deepEqual(registry.reserve(id(1)), { ok: true, reserved: true });
  assert.deepEqual(registry.reserve(id(1)), { ok: true, reserved: false }, 'a retry must not take a second slot');
  assert.deepEqual(registry.reserve(id(2)), { ok: true, reserved: true });
  assert.deepEqual(registry.reserve(id(3)), { ok: false, reserved: false });

  assert.equal(rows.size, 2, 'two ids hold two slots, whatever the retries');
});

test('registry: releasing a slot frees exactly one and lets the next create in', () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });
  registry.reserve(id(1));
  registry.reserve(id(2));

  registry.release(id(1));
  assert.equal(rows.size, 1);
  assert.equal(rows.has(id(2)), true, 'releasing one id must not touch another');

  assert.deepEqual(registry.reserve(id(3)), { ok: true, reserved: true });
  assert.deepEqual(registry.reserve(id(4)), { ok: false, reserved: false });

  /* Releasing an id that holds nothing changes nothing. */
  registry.release(id(9));
  assert.equal(rows.size, 2);
});

test('registry: an unusable cap falls back to the default, never to zero', () => {
  const cases = [undefined, '', '0', '-4', 'many', '2.5'];
  for (const value of cases) {
    const { ctx } = fakeContext();
    const registry = new Registry(ctx, value === undefined ? {} : { MAX_GROUPS: value });
    assert.equal(registry.maxGroups(), DEFAULT_MAX_GROUPS, `MAX_GROUPS=${String(value)}`);
  }
  assert.equal(DEFAULT_MAX_GROUPS, 25);
});

/* --------------------------------------------------------- the paths the ledger serves */

/** A request the Worker itself makes to the ledger: JSON, POST, to `path`. */
function post(registry, payload, { path, method = 'POST' } = {}) {
  return registry.fetch(
    new Request(`https://registry${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(payload)
    })
  );
}

test('registry: /reserve and /release are routed whole, so a suffix is not a route', async () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });

  const reserved = await post(registry, { groupId: id(1) }, { path: '/reserve' });
  assert.equal(reserved.status, 200);
  assert.deepEqual(await reserved.json(), { ok: true, reserved: true });
  assert.equal(rows.has(id(1)), true);

  /* `POST /nope/release` ends in `/release`. A suffix match dropped the slot for a caller whose
     intent was some other route; the whole-pathname comparison answers 404 and touches nothing. */
  const unrouted = await post(registry, { groupId: id(1) }, { path: '/nope/release' });
  assert.equal(unrouted.status, 404, 'POST /nope/release must not release a slot');
  assert.deepEqual(await unrouted.json(), { error: 'not_found' });
  assert.equal(rows.has(id(1)), true, 'an unrouted path must leave the ledger untouched');

  const released = await post(registry, { groupId: id(1) }, { path: '/release' });
  assert.equal(released.status, 200);
  assert.deepEqual(await released.json(), { ok: true });
  assert.equal(rows.has(id(1)), false, '/release must drop the slot');
});

test('registry: a method other than POST is refused and names the method it allows', async () => {
  const { ctx } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });

  const response = await post(registry, null, { path: '/reserve', method: 'GET' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST', 'a 405 must carry Allow: POST');
  assert.deepEqual(await response.json(), { error: 'method' });
});

test('registry: a release without a group id is a bad request, not a no-op success', async () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });
  registry.reserve(id(1));

  const response = await post(registry, {}, { path: '/release' });
  assert.equal(response.status, 400, 'a release that names nothing must not answer ok');
  assert.deepEqual(await response.json(), { error: 'bad_request' });
  assert.equal(rows.size, 1, 'the held slot must survive a malformed release');
});
