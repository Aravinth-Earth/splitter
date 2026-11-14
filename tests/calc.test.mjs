/**
 * The split engine, in integer paise.
 *
 * The one guarantee that matters is that the parts sum exactly to the amount, for every amount and
 * every set of weights. The generated cases are not a sample of the examples — they are the
 * property, and the two pinned examples are the ones a person would check by hand.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { allocate, equal, percent, subset } from '../public/calc.js';

const ids = (count, prefix = 'm') => Array.from({ length: count }, (_, at) => `${prefix}${at}`);

function totalOf(shares) {
  return Object.values(shares).reduce((sum, paise) => sum + paise, 0);
}

test('calc: an equal split puts the remainder on the largest shares, ties by id', () => {
  assert.deepEqual(equal(1_000, ['a', 'b', 'c']), { a: 334, b: 333, c: 333 });
  assert.deepEqual(equal(100, ids(7, 'a')), {
    a0: 15,
    a1: 15,
    a2: 14,
    a3: 14,
    a4: 14,
    a5: 14,
    a6: 14
  });

  /* The order the members arrive in cannot change who receives the extra paisa. */
  assert.deepEqual(allocate(1_000, { c: 1, b: 1, a: 1 }), allocate(1_000, { a: 1, b: 1, c: 1 }));
});

test('calc: the remainder goes to the largest share, not the largest fraction', () => {
  /* 999.00 over 10 shares and 1 share: floors leave one paisa, and the larger share takes it. */
  const shares = allocate(99_900, { big: 10, small: 1 });
  assert.deepEqual(shares, { big: 90_819, small: 9_081 });
  assert.equal(totalOf(shares), 99_900);
});

test('calc: a chosen subset shares only among the chosen people', () => {
  const shares = subset(100, ['a', 'c']);
  assert.deepEqual(shares, { a: 50, c: 50 });
  assert.equal(Object.hasOwn(shares, 'b'), false);
});

test('calc: percentages must total 100, and a zero percent is left out', () => {
  assert.deepEqual(percent(10_000, { a: 33.33, b: 33.33, c: 33.34 }), {
    a: 3_333,
    b: 3_333,
    c: 3_334
  });

  assert.deepEqual(percent(101, { a: 50, b: 50 }), { a: 51, b: 50 });

  const shares = percent(100, { a: 50, b: 50, c: 0 });
  assert.equal(Object.hasOwn(shares, 'c'), false, 'a zero percentage is not a zero share');
  assert.equal(totalOf(shares), 100);

  assert.throws(() => percent(100, { a: 49.9, b: 50 }), /total 100/);
  assert.throws(() => percent(100, { a: 50.1, b: 50.1 }), /total 100/);
});

test('calc: a weight that cannot take part is refused, not guessed at', () => {
  assert.throws(() => allocate(100, {}), /at least one weight above zero/);
  assert.throws(() => allocate(100, { a: 0, b: 0 }), /at least one weight above zero/);
  assert.throws(() => allocate(100, { a: -1, b: 1 }), /non-negative/);
  assert.throws(() => allocate(100, { a: Number.NaN }), /non-negative/);
  assert.throws(() => allocate(100, []), /weights must be an object/);
  assert.throws(() => allocate(-1, { a: 1 }), /non-negative integer/);
  assert.throws(() => allocate(1.5, { a: 1 }), /non-negative integer/);
  assert.throws(() => equal(100, []), /at least one member/);
  assert.throws(() => equal(100, ['a', 'a']), /appears twice/);
  assert.throws(() => equal(100, ['a', '']), /needs an id/);
});

test('calc: two hundred generated splits never lose or invent a paisa', () => {
  let state = 0x2f6e2b1;

  function random() {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  }

  for (let sample = 0; sample < 200; sample += 1) {
    const total = Math.floor(random() * 1_000_000_000) + 1;
    const count = Math.floor(random() * 20) + 1;
    const weights = {};
    for (const id of ids(count)) weights[id] = Math.floor(random() * 100) + 1;

    const shares = allocate(total, weights);
    assert.equal(Object.keys(shares).length, count);
    assert.equal(totalOf(shares), total, `sample ${sample}: ${total} paise over ${count} members`);
    for (const paise of Object.values(shares)) {
      assert.ok(Number.isSafeInteger(paise) && paise >= 0);
    }
  }

  for (let count = 1; count <= 25; count += 1) {
    const shares = equal(1_000, ids(count));
    const values = Object.values(shares);
    assert.equal(totalOf(shares), 1_000);
    assert.ok(Math.max(...values) - Math.min(...values) <= 1, 'equal shares differ by at most a paisa');
  }
});
