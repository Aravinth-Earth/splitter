/**
 * Balances and the settle-up proposal, in integer paise.
 *
 * The two properties that matter: every ledger's balances sum to exactly zero, and applying every
 * proposed transfer reaches exactly zero for every member. The exact search has a small fixture
 * where it beats the greedy match, so deleting the search would fail the test rather than pass it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { balances, exactSettle, greedySettle, settle } from '../public/balance.js';
import { allocate } from '../public/calc.js';

function apply(balancesMap, transfers) {
  const next = { ...balancesMap };
  for (const transfer of transfers) {
    next[transfer.from] += transfer.amountPaise;
    next[transfer.to] -= transfer.amountPaise;
  }
  return next;
}

function allZero(balancesMap) {
  return Object.values(balancesMap).every((paise) => paise === 0);
}

test('balance: paid minus owed, and a recorded payment clears it', () => {
  const members = ['a', 'b', 'c'];
  const expenses = [
    {
      id: 'e1',
      amountPaise: 100,
      paidBy: 'a',
      split: { a: 50, b: 50 }
    }
  ];

  assert.deepEqual(balances(members, expenses), { a: 50, b: -50, c: 0 });
  assert.deepEqual(
    balances(members, expenses, [{ from: 'b', to: 'a', amountPaise: 50 }]),
    { a: 0, b: 0, c: 0 }
  );
});

test('balance: one payer and a rounding split still reach exactly zero', () => {
  const members = ['a', 'b', 'c'];
  const onePayer = balances(members, [
    { id: 'e1', amountPaise: 300, paidBy: 'a', split: { a: 100, b: 100, c: 100 } }
  ]);
  assert.deepEqual(onePayer, { a: 200, b: -100, c: -100 });
  const first = settle(onePayer);
  assert.equal(first.exact, true);
  assert.equal(first.transfers.length, 2);
  assert.ok(allZero(apply(onePayer, first.transfers)));

  const rounded = balances(members, [
    { id: 'e1', amountPaise: 100, paidBy: 'a', split: allocate(100, { a: 1, b: 1, c: 1 }) }
  ]);
  assert.equal(rounded.a, 66);
  assert.equal(rounded.b, -33);
  assert.equal(rounded.c, -33);
  const proposal = settle(rounded);
  assert.ok(allZero(apply(rounded, proposal.transfers)));
});

test('balance: a member with no expenses is present, and a settled group says so', () => {
  const result = balances(['a', 'b', 'c'], []);
  assert.deepEqual(result, { a: 0, b: 0, c: 0 });
  assert.deepEqual(settle(result), { transfers: [], exact: true });
});

test('balance: the exact search beats greedy on a crafted ledger', () => {
  const crafted = { m0: 4_804, m1: -1_294, m2: 994, m3: -8_108, m4: -3_510, m5: 7_114 };
  assert.equal(greedySettle(crafted).length, 5);
  assert.equal(exactSettle(crafted, { timeLimitMs: 1_000 }).transfers.length, 4);

  const proposal = settle(crafted);
  assert.equal(proposal.exact, true);
  assert.equal(proposal.transfers.length, 4);
  assert.ok(allZero(apply(crafted, proposal.transfers)));
});

test('balance: a roster above ten members always uses the greedy match', () => {
  const large = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`m${index}`, index === 0 ? 600 : index < 7 ? -100 : 0])
  );

  const proposal = settle(large);
  assert.equal(proposal.exact, false);
  assert.equal(proposal.transfers.length, 6);
  assert.ok(allZero(apply(large, proposal.transfers)));
});

test('balance: the deadline falls back to greedy and says it is not exact', () => {
  const crafted = { m0: 4_804, m1: -1_294, m2: 994, m3: -8_108, m4: -3_510, m5: 7_114 };
  let clock = 0;
  const proposal = settle(crafted, { timeLimitMs: 0, now: () => (clock += 100) });
  assert.equal(proposal.exact, false);
  assert.equal(proposal.transfers.length, greedySettle(crafted).length);
  assert.ok(allZero(apply(crafted, proposal.transfers)));
});

test('balance: two hundred random ledgers are zero-sum and settle to zero', () => {
  let state = 0x51ed270b;

  function random() {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  }

  for (let sample = 0; sample < 200; sample += 1) {
    const count = Math.floor(random() * 9) + 2;
    const members = Array.from({ length: count }, (_, index) => `m${index}`);
    const expenses = [];
    const settlements = [];
    const expected = Object.fromEntries(members.map((id) => [id, 0]));

    const expenseCount = Math.floor(random() * 8);
    for (let index = 0; index < expenseCount; index += 1) {
      const amount = Math.floor(random() * 100_000) + 1;
      const payer = members[Math.floor(random() * count)];
      const chosen = members.filter(() => random() < 0.7);
      if (chosen.length === 0) chosen.push(payer);
      const split = allocate(amount, Object.fromEntries(chosen.map((id) => [id, 1])));
      expenses.push({ id: `e${index}`, amountPaise: amount, paidBy: payer, split });
      expected[payer] += amount;
      for (const [id, paise] of Object.entries(split)) expected[id] -= paise;
    }

    for (let index = 0; index < 2; index += 1) {
      if (random() < 0.3) {
        const from = members[Math.floor(random() * count)];
        const to = members[Math.floor(random() * count)];
        if (from === to) continue;
        const amount = Math.floor(random() * 5_000) + 1;
        settlements.push({ from, to, amountPaise: amount });
        expected[from] += amount;
        expected[to] -= amount;
      }
    }

    const result = balances(members, expenses, settlements);
    assert.deepEqual(result, expected, `sample ${sample}`);
    assert.equal(Object.values(result).reduce((sum, paise) => sum + paise, 0), 0);

    const proposal = settle(result);
    assert.ok(allZero(apply(result, proposal.transfers)), `sample ${sample}`);
  }
});

test('balance: the exact search is never worse than greedy on two hundred vectors', () => {
  let state = 0x7f4a7c15;

  function random() {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  }

  for (let sample = 0; sample < 200; sample += 1) {
    const count = Math.floor(random() * 7) + 4;
    const map = {};
    let sum = 0;
    for (let index = 0; index < count - 1; index += 1) {
      const value = Math.floor(random() * 20_000) - 10_000;
      map[`m${index}`] = value;
      sum += value;
    }
    map[`m${count - 1}`] = -sum;

    const greedy = greedySettle(map).length;
    const exact = exactSettle(map, { timeLimitMs: 1_000 }).transfers.length;
    assert.ok(exact <= greedy, `sample ${sample}: exact ${exact} > greedy ${greedy}`);
    assert.ok(allZero(apply(map, exactSettle(map, { timeLimitMs: 1_000 }).transfers)));
  }
});
