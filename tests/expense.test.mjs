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
  splitFor,
  validateDate,
  validateDescription,
  validateNote,
  validateTime
} from '../public/expense.js';

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
  for (let count = 1; count <= 10; count += 1) {
    const ids = Array.from({ length: count }, (_, at) => `m${at}`);
    const percentages = defaultPercentages(ids);
    const total = Object.values(percentages).reduce((sum, value) => sum + value, 0);
    assert.equal(Math.round(total * 10), 1_000, `${count} members`);
    for (const value of Object.values(percentages)) {
      assert.equal(Math.round(value * 10), value * 10, 'one decimal');
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
