/**
 * The expense sheet's arithmetic and text rules, without a browser.
 *
 * The preview and the saved split are one call: these tests pin that call, the rupee parser, and
 * the refusals that must happen before any frame is sent.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PAISE,
  defaultPercentages,
  defaultShares,
  expenseAad,
  formatPaise,
  parseAmount,
  parseCustomAmount,
  settlementAad,
  splitFor,
  validateDate,
  validateDescription,
  validateNote,
  validateTime
} from '../public/expense.js';
import { percent } from '../public/calc.js';

test('expense: a typed amount becomes integer paise, and the edges are refused', () => {
  assert.deepEqual(parseAmount('1,234.56'), { ok: true, paise: 123_456 });
  assert.deepEqual(parseAmount(' 12 '), { ok: true, paise: 1_200 });
  assert.deepEqual(parseAmount('1.'), { ok: true, paise: 100 });
  assert.deepEqual(parseAmount('0.01'), { ok: true, paise: 1 });
  assert.deepEqual(parseAmount('1,00,00,000'), { ok: true, paise: MAX_PAISE });

  for (const bad of ['', '   ', '0', '0.00', '-1', '.5', '1.234', '1,00,00,000.01', 'abc', '1e3']) {
    const result = parseAmount(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.ok(result.message.length > 0);
  }
});

test('expense: an amount is shown in the group currency', () => {
  const shown = formatPaise(123_456, 'INR');
  assert.ok(shown.includes('1,234.56'), shown);
  assert.ok(shown.includes('₹'), shown);
  assert.ok(formatPaise(100, 'EUR').includes('1.00'));
  assert.ok(formatPaise(100, 'nonsense').includes('₹'), 'an unknown currency falls back to INR');
});

test('expense: the preview and the saved map are one call', () => {
  const equal = splitFor({ mode: 'equal', amountPaise: 1_000, memberIds: ['a', 'b', 'c'] });
  assert.deepEqual(equal, { ok: true, shares: { a: 334, b: 333, c: 333 } });

  const chosen = splitFor({ mode: 'chosen', amountPaise: 100, chosenIds: ['a', 'c'] });
  assert.deepEqual(chosen, { ok: true, shares: { a: 50, c: 50 } });
  assert.equal(
    splitFor({ mode: 'chosen', amountPaise: 100, chosenIds: [] }).ok,
    false
  );

  const percentages = defaultPercentages(['a', 'b', 'c']);
  assert.deepEqual(percentages, { a: 33.4, b: 33.3, c: 33.3 });
  const byPercent = splitFor({
    mode: 'percent',
    amountPaise: 10_000,
    percentages
  });
  assert.deepEqual(byPercent, { ok: true, shares: { a: 3_340, b: 3_330, c: 3_330 } });

  const refused = splitFor({ mode: 'percent', amountPaise: 100, percentages: { a: 49.9, b: 50 } });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /total 100/);
});

test('expense: default percentages are one decimal and sum to 100 for any group size', () => {
  for (let count = 1; count <= 25; count += 1) {
    const ids = Array.from({ length: count }, (_, at) => `m${at}`);
    const percentages = defaultPercentages(ids);
    const total = Object.values(percentages).reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(total - 100) <= 1e-9, `${count} members total ${total}`);
    for (const value of Object.values(percentages)) {
      assert.equal(Math.round(value * 10), value * 10, 'one decimal');
    }

    /* The defaults are a real split, not just a set of numbers that add up: the guard accepts
       them and the parts fit the amount. */
    const at = `${count} members`;
    const shares = percent(10_000, percentages);
    const paid = Object.values(shares).reduce((sum, paise) => sum + paise, 0);
    assert.equal(Object.keys(shares).length, count, at);
    assert.equal(paid, 10_000, at);
    for (const paise of Object.values(shares)) {
      assert.ok(Number.isSafeInteger(paise) && paise >= 0 && paise <= 10_000, at);
    }
  }
});

test('expense: a percent split that does not total 100 is refused, and 100 % is one member', () => {
  const over = splitFor({
    mode: 'percent',
    amountPaise: 1_000,
    percentages: { a: 50.01, b: 50.01 }
  });
  assert.equal(over.ok, false);
  assert.match(over.message, /total 100/);

  const short = splitFor({ mode: 'percent', amountPaise: 1_000, percentages: { a: 49.96, b: 50 } });
  assert.equal(short.ok, false);
  assert.match(short.message, /total 100/);

  const onlyRounds = splitFor({
    mode: 'percent',
    amountPaise: 1_000,
    percentages: { a: 33.34, b: 33.34, c: 33.34 }
  });
  assert.equal(onlyRounds.ok, false);

  assert.deepEqual(
    splitFor({ mode: 'percent', amountPaise: 1_000, percentages: { a: 100.02 } }),
    { ok: false, message: 'Percentages must total 100 %.' },
    'one member at 100.02 % is refused with the sentence the sheet shows'
  );

  assert.deepEqual(splitFor({ mode: 'percent', amountPaise: 1_000, percentages: { a: 100 } }), {
    ok: true,
    shares: { a: 1_000 }
  });
  assert.deepEqual(
    splitFor({ mode: 'percent', amountPaise: 1_000, percentages: { a: 100, b: 0 } }),
    { ok: true, shares: { a: 1_000 } },
    '100 % is one member; the zero is left out'
  );
});

test('expense: every mode that reports ok splits the amount exactly', () => {
  const memberIds = ['a', 'b', 'c'];

  for (const amountPaise of [1, 2, 7, 100, 101, 999, 1_000, 12_345, 99_999, MAX_PAISE]) {
    const attempts = [
      { mode: 'equal', memberIds },
      { mode: 'chosen', chosenIds: ['b', 'c'] },
      { mode: 'percent', percentages: defaultPercentages(memberIds) },
      { mode: 'percent', percentages: { a: 50, b: 25, c: 25 } },
      { mode: 'shares', shareWeights: { a: 3, b: 2, c: 0 } },
      { mode: 'custom', amounts: { a: amountPaise, b: 0, c: 0 } }
    ];

    for (const attempt of attempts) {
      const at = `${attempt.mode} at ${amountPaise} paise`;
      const result = splitFor({ amountPaise, ...attempt });
      assert.equal(result.ok, true, at);

      const total = Object.values(result.shares).reduce((sum, paise) => sum + paise, 0);
      assert.equal(total, amountPaise, at);
      for (const paise of Object.values(result.shares)) {
        assert.ok(Number.isSafeInteger(paise) && paise >= 0, at);
      }
    }
  }
});

test('expense: the associated data binds the group and the record', () => {
  const groupId = 'a'.repeat(64);
  assert.equal(expenseAad(groupId, 'r1'), `sp1:rec:${groupId}/kind:expense/id:r1`);
  assert.notEqual(expenseAad(groupId, 'r1'), expenseAad(groupId, 'r2'));
  assert.notEqual(expenseAad(groupId, 'r1'), expenseAad('b'.repeat(64), 'r1'));
});

test('expense: description, note, date and time are validated before a save', () => {
  assert.deepEqual(validateDescription('  Dinner  '), { ok: true, value: 'Dinner', length: 6 });
  assert.equal(validateDescription('   ').ok, false);
  assert.equal(validateDescription('x'.repeat(120)).ok, true);
  assert.equal(validateDescription('x'.repeat(121)).ok, false);
  assert.equal(validateDescription('க'.repeat(120)).ok, true, 'code points, not UTF-16 units');
  assert.equal(validateDescription('க'.repeat(121)).ok, false);

  assert.deepEqual(validateNote('  after the show  '), { ok: true, value: 'after the show' });
  assert.equal(validateNote('x'.repeat(501)).ok, false);
  assert.equal(validateNote(undefined).ok, true);

  assert.deepEqual(validateDate('2026-11-14'), { ok: true, value: '2026-11-14' });
  assert.equal(validateDate('14/11/2026').ok, false);
  assert.deepEqual(validateTime('20:15'), { ok: true, value: '20:15' });
  assert.equal(validateTime('8pm').ok, false);
});

test('expense: shares and exact amounts feed the same preview and save', () => {
  assert.deepEqual(defaultShares(['a', 'b']), { a: 1, b: 1 });

  const byShares = splitFor({
    mode: 'shares',
    amountPaise: 99_900,
    shareWeights: { big: 10, small: 1 }
  });
  assert.deepEqual(byShares, { ok: true, shares: { big: 90_819, small: 9_081 } });

  const byAmounts = splitFor({
    mode: 'custom',
    amountPaise: 99_900,
    amounts: { a: 60_000, b: 39_900 }
  });
  assert.deepEqual(byAmounts, { ok: true, shares: { a: 60_000, b: 39_900 } });

  const short = splitFor({
    mode: 'custom',
    amountPaise: 99_900,
    amounts: { a: 60_000, b: 39_899 }
  });
  assert.equal(short.ok, false);
  assert.match(short.message, /Short by ₹0\.01/);

  const over = splitFor({
    mode: 'custom',
    amountPaise: 100,
    amounts: { a: 101 }
  });
  assert.equal(over.ok, false);
  assert.match(over.message, /Over by ₹0\.01/);

  assert.deepEqual(
    splitFor({ mode: 'shares', amountPaise: 100, shareWeights: { a: 0, b: 0 } }).ok,
    false
  );
});

test('expense: a custom amount may be blank or zero, and no amount leaves the sheet', () => {
  assert.deepEqual(parseCustomAmount(''), { ok: true, paise: 0 });
  assert.deepEqual(parseCustomAmount('0'), { ok: true, paise: 0 });
  assert.deepEqual(parseCustomAmount('600'), { ok: true, paise: 60_000 });
  assert.deepEqual(parseCustomAmount('1.5'), { ok: true, paise: 150 });
  assert.equal(parseCustomAmount('1.234').ok, false);
  assert.equal(parseCustomAmount('-1').ok, false);
  assert.equal(parseCustomAmount('1,00,00,000.01').ok, false);
});


test('expense: a settlement cannot be opened as an expense', async () => {
  const code = 'ABCDEFGHJKMNPQRS';
  const groupId = 'a'.repeat(64);
  const id = 'record1';
  const { deriveGroupKey, open, seal } = await import('../public/crypto.js');
  const key = await deriveGroupKey(code);
  const value = { kind: 'settlement', from: 'a', to: 'b', amountPaise: 500 };
  const sealed = await seal(key, value, settlementAad(groupId, id));

  assert.deepEqual(await open(key, sealed, settlementAad(groupId, id)), value);
  await assert.rejects(open(key, sealed, expenseAad(groupId, id)), /sealed under this key/);
  assert.notEqual(settlementAad(groupId, id), expenseAad(groupId, id));
});
