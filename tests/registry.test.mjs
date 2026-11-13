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
