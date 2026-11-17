/**
 * The split engine, in integer paise.
 *
 * The one guarantee that matters is that the parts sum exactly to the amount, for every amount and
 * every set of weights. The generated cases are not a sample of the examples — they are the
 * property, and the two pinned examples are the ones a person would check by hand.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { allocate, custom, equal, percent, shares, subset } from '../public/calc.js';

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

test('calc: percentages that only round to 100 are refused, not split', () => {
  /* Every one of these totals 100 at one decimal place, so a guard that rounds the total accepts
     it and the engine normalises the shares over a total that is not 100. */
  const onlyRounds = [
    { a: 33.34, b: 33.34, c: 33.34 }, /* 100.02 */
    { a: 49.96, b: 50 }, /* 99.96 */
    { a: 50.01, b: 50.01 }, /* 100.02 */
    { a: 99.96, b: 0.039 } /* 99.999 */
  ];
  for (const percentages of onlyRounds) {
    assert.throws(
      () => percent(1_000, percentages),
      /total 100/,
      `${JSON.stringify(percentages)} must be refused`
    );
  }

  /* The check is exact but not bit-exact: tenths added up carry a few units in the last place. */
  const withinTolerance = percent(1_000, { a: 50 + 1e-10, b: 50 });
  assert.deepEqual(Object.keys(withinTolerance).sort(), ['a', 'b']);
  assert.equal(totalOf(withinTolerance), 1_000);
  assert.throws(() => percent(1_000, { a: 50 + 1e-6, b: 50 }), /total 100/);
});

test('calc: an accepted percent split adds up and stays within a paisa of the exact share', () => {
  const parties = [
    { a: 100 },
    { a: 50, b: 50, c: 0 },
    { a: 33.4, b: 33.3, c: 33.3 },
    { a: 12.5, b: 12.5, c: 25, d: 50 },
    { a: 0.1, b: 0.2, c: 0.3, d: 99.4 }
  ];

  for (const percentages of parties) {
    for (const totalPaise of [1, 2, 7, 100, 101, 999, 1_000, 12_345, 1_000_000_000]) {
      const shares = percent(totalPaise, percentages);
      const at = `${JSON.stringify(percentages)} at ${totalPaise} paise`;

      assert.equal(totalOf(shares), totalPaise, at);
      for (const [id, percentage] of Object.entries(percentages)) {
        if (percentage === 0) {
          assert.equal(Object.hasOwn(shares, id), false, `${id} is left out at ${at}`);
          continue;
        }
        const exact = (totalPaise * percentage) / 100;
        assert.ok(
          Math.abs(shares[id] - exact) <= 1,
          `${id}: ${shares[id]} paise is more than a paisa from ${exact} at ${at}`
        );
      }
    }
  }
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
  assert.throws(() => percent(100, {}), /at least one weight above zero/);
  assert.throws(() => percent(100, { a: 0, b: 0 }), /at least one weight above zero/);
  assert.throws(() => percent(100, { a: -1, b: 101 }), /non-negative/);
  assert.throws(() => percent(100, []), /percentages must be an object/);
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

test('calc: integer shares follow the same remainder rule', () => {
  assert.deepEqual(shares(99_900, { big: 10, small: 1 }), { big: 90_819, small: 9_081 });
  assert.deepEqual(shares(100, { a: 0, b: 1 }), { b: 100 }, 'a zero share is left out');
  assert.throws(() => shares(100, { a: 0 }), /at least one weight above zero/);
  assert.throws(() => shares(100, { a: -1 }), /non-negative whole number/);
  assert.throws(() => shares(100, { a: 1.5 }), /non-negative whole number/);
});

test('calc: exact amounts must add to the expense, and zeros are left out', () => {
  assert.deepEqual(custom(99_900, { a: 60_000, b: 39_900 }), { a: 60_000, b: 39_900 });
  assert.deepEqual(custom(100, { a: 100, b: 0 }), { a: 100 }, 'a zero amount is not a zero share');
  assert.throws(() => custom(99_900, { a: 60_000, b: 39_899 }), /must total the expense/);
  assert.throws(() => custom(100, { a: 101 }), /must total the expense/);
  assert.throws(() => custom(100, { a: -1 }), /non-negative whole number/);
});
