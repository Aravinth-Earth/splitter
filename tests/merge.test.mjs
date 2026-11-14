/**
 * The field-diff merge, without a DOM.
 *
 * A stale base means someone saved first. The merge must keep their field and mine, name every
 * field that was decided, and never produce an expense whose shares or payers do not total it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkExpense, mergeDiff } from '../public/merge.js';

const base = {
  kind: 'expense',
  description: 'Dinner',
  amountPaise: 1_000,
  paidBy: [{ memberId: 'a', amountPaise: 1_000 }],
  split: { a: 500, b: 500 },
  date: '2026-11-14',
  time: '20:00',
  note: ''
};

test('merge: a description edit and an amount edit both survive', () => {
  const mine = { ...base, description: 'Dinner and tip' };
  const current = {
    ...base,
    amountPaise: 1_200,
    paidBy: [{ memberId: 'a', amountPaise: 1_200 }],
    split: { a: 600, b: 600 }
  };

  const result = mergeDiff(base, mine, current);
  assert.equal(result.value.description, 'Dinner and tip');
  assert.equal(result.value.amountPaise, 1_200);
  assert.deepEqual(result.value.split, { a: 600, b: 600 });
  assert.deepEqual(result.mine, ['description']);
  assert.deepEqual(result.theirs, ['amountPaise', 'paidBy', 'split']);
  assert.deepEqual(result.both, []);
  assert.equal(result.broken, null);
});

test('merge: the same holds when the amount edit is the one that conflicts', () => {
  const mine = {
    ...base,
    amountPaise: 1_200,
    paidBy: [{ memberId: 'a', amountPaise: 1_200 }],
    split: { a: 600, b: 600 }
  };
  const current = { ...base, description: 'Dinner and tip' };

  const result = mergeDiff(base, mine, current);
  assert.equal(result.value.description, 'Dinner and tip');
  assert.equal(result.value.amountPaise, 1_200);
  assert.deepEqual(result.mine, ['amountPaise', 'paidBy', 'split']);
  assert.deepEqual(result.theirs, ['description']);
  assert.deepEqual(result.both, []);
  assert.equal(result.broken, null);
});

test('merge: a field both changed takes the later save and says so', () => {
  const mine = {
    ...base,
    amountPaise: 1_200,
    paidBy: [{ memberId: 'a', amountPaise: 1_200 }],
    split: { a: 600, b: 600 }
  };
  const current = {
    ...base,
    amountPaise: 1_100,
    paidBy: [{ memberId: 'a', amountPaise: 1_100 }],
    split: { a: 550, b: 550 }
  };

  const result = mergeDiff(base, mine, current);
  assert.equal(result.value.amountPaise, 1_200);
  assert.deepEqual(result.value.split, { a: 600, b: 600 });
  assert.deepEqual(result.both, ['amountPaise', 'paidBy', 'split']);
  assert.equal(result.broken, null);
});

test('merge: an amount and a split that do not total are reported, not written', () => {
  const mine = { ...base, amountPaise: 1_200, paidBy: [{ memberId: 'a', amountPaise: 1_200 }] };
  const current = { ...base, split: { a: 700, b: 300 } };

  const result = mergeDiff(base, mine, current);
  assert.equal(result.value.amountPaise, 1_200);
  assert.deepEqual(result.value.split, { a: 700, b: 300 });
  assert.equal(result.broken.reason, 'split');
  assert.equal(result.broken.amountPaise, 1_200);
  assert.equal(result.broken.totalPaise, 1_000);
});

test('merge: fields nobody touched come from the stored record', () => {
  const mine = { ...base, note: 'card' };
  const current = { ...base, date: '2026-11-15' };

  const result = mergeDiff(base, mine, current);
  assert.equal(result.value.note, 'card');
  assert.equal(result.value.date, '2026-11-15');
  assert.deepEqual(result.mine, ['note']);
  assert.deepEqual(result.theirs, ['date']);
  assert.equal(result.broken, null);
});

test('merge: no field differs leaves the stored value and no names', () => {
  const result = mergeDiff(base, { ...base }, { ...base });
  assert.deepEqual(result.value, base);
  assert.deepEqual(result.mine, []);
  assert.deepEqual(result.theirs, []);
  assert.deepEqual(result.both, []);
  assert.equal(result.broken, null);
});

test('merge: a legacy single payer still checks against the amount', () => {
  assert.equal(checkExpense({ ...base, paidBy: 'a' }), null);
  assert.equal(
    checkExpense({ ...base, amountPaise: 900, paidBy: [{ memberId: 'a', amountPaise: 900 }], split: { a: 400, b: 500 } }),
    null
  );
});

test('merge: invalid money is reported with the fields that disagree', () => {
  assert.equal(checkExpense({ ...base, amountPaise: 0 }).reason, 'amount');
  assert.equal(checkExpense({ ...base, split: { a: 500, b: 400 } }).reason, 'split');
  assert.equal(
    checkExpense({ ...base, paidBy: [{ memberId: 'a', amountPaise: 400 }, { memberId: 'a', amountPaise: 600 }] }).detail,
    'member'
  );
  assert.equal(
    checkExpense({ ...base, paidBy: [{ memberId: 'a', amountPaise: 400 }] }).detail,
    'total'
  );
  assert.equal(
    checkExpense({ ...base, paidBy: [{ memberId: 'a', amountPaise: 1_000 }, { memberId: 'b', amountPaise: 0 }] }).detail,
    'amount'
  );
});
