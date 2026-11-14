/**
 * The chart data, without a DOM.
 *
 * Paid and incurred are gross totals: every payer credited its own amount, every split share
 * counted once. The bars are proportional to the largest value, and a zero keeps its row.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { barRows, totals } from '../public/charts.js';

test('charts: paid and incurred are gross totals, multi-payer included', () => {
  const members = ['a', 'b', 'c'];
  const expenses = [
    {
      id: 'e1',
      amountPaise: 1_000,
      paidBy: [
        { memberId: 'a', amountPaise: 600 },
        { memberId: 'b', amountPaise: 400 }
      ],
      split: { a: 500, b: 500 }
    }
  ];

  assert.deepEqual(totals(members, expenses), {
    paid: { a: 600, b: 400, c: 0 },
    incurred: { a: 500, b: 500, c: 0 }
  });
});

test('charts: a split that does not total the expense is refused', () => {
  assert.throws(
    () =>
      totals(['a', 'b'], [
        { id: 'e1', amountPaise: 100, paidBy: 'a', split: { a: 50, b: 40 } }
      ]),
    /must total its amount/
  );
});

test('charts: bars are proportional, sorted, and a zero has no bar', () => {
  const { max, rows } = barRows({ a: 500, b: 1_000, c: 0, d: 250 });
  assert.equal(max, 1_000);
  assert.deepEqual(
    rows.map((row) => [row.id, row.value, row.ratio]),
    [
      ['b', 1_000, 1],
      ['a', 500, 0.5],
      ['d', 250, 0.25],
      ['c', 0, 0]
    ]
  );
});

test('charts: twenty members keep one row each, and a 90% bar is identifiable', () => {
  const values = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`m${index}`, index === 0 ? 900 : 100])
  );
  values.m19 = 0;
  const { rows, max } = barRows(values);
  assert.equal(rows.length, 20);
  assert.equal(max, 900);
  assert.equal(rows[0].id, 'm0');
  assert.equal(rows[0].ratio, 1);
  assert.equal(rows.at(-1).value, 0);
  assert.equal(rows.at(-1).ratio, 0);
});

test('charts: a negative value keeps its row at zero and draws nothing', () => {
  const { rows } = barRows({ a: -5, b: 10 });
  assert.equal(rows.find((row) => row.id === 'a').ratio, 0);
  assert.equal(rows.find((row) => row.id === 'a').value, 0);
  assert.equal(rows.find((row) => row.id === 'b').ratio, 1);
});
