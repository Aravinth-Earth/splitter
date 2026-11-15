/**
 * The export object and filename, without a browser.
 *
 * The file is the group's readable copy: no ids, no keys, no ciphertext. A deleted or pending row
 * must never reach it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SCHEMA, exportFileName, exportGroup } from '../public/export.js';

const ID_A = 'EPOcSRlhtThBdbTwu7zU9Q';
const ID_B = 'Zq4mN8pR2sT6vW0xY3aB5c';
const ID_C = 'Jk7nQ1rS5tV9wX2yZ4aB6c';

const members = [
  { id: ID_A, name: 'Aravinth' },
  { id: ID_B, name: 'Priya' },
  { id: ID_C, name: 'Aravinth' }
];

const records = [
  {
    id: 'record-one',
    rev: 2,
    value: {
      kind: 'expense',
      description: 'Dinner',
      amountPaise: 120_000,
      paidBy: [
        { memberId: ID_A, amountPaise: 80_000 },
        { memberId: ID_B, amountPaise: 40_000 }
      ],
      split: { [ID_A]: 60_000, [ID_B]: 30_000, [ID_C]: 30_000 },
      date: '2026-11-14',
      time: '20:30',
      note: 'card'
    }
  },
  {
    id: 'record-two',
    rev: 1,
    value: {
      kind: 'settlement',
      from: ID_B,
      to: ID_A,
      amountPaise: 40_000,
      date: '2026-11-15',
      time: '09:00',
      note: ''
    }
  },
  {
    id: 'record-deleted',
    rev: 3,
    deleted: true,
    value: {
      kind: 'expense',
      description: 'Gone',
      amountPaise: 1,
      paidBy: [{ memberId: ID_A, amountPaise: 1 }],
      split: { [ID_A]: 1 },
      date: '2026-11-14',
      time: '21:00',
      note: ''
    }
  },
  {
    id: 'record-pending',
    rev: 0,
    pending: true,
    value: {
      kind: 'expense',
      description: 'Waiting to sync',
      amountPaise: 2,
      paidBy: [{ memberId: ID_A, amountPaise: 2 }],
      split: { [ID_A]: 2 },
      date: '2026-11-14',
      time: '22:00',
      note: ''
    }
  }
];

const exportedAt = new Date(Date.UTC(2026, 10, 15, 9, 7));

test('export: the file carries only readable group data', () => {
  const file = exportGroup({
    name: 'Goa',
    currency: 'INR',
    members,
    records,
    exportedAt
  });

  assert.equal(file.schema, SCHEMA);
  assert.deepEqual(file.group, { name: 'Goa', currency: 'INR' });
  assert.deepEqual(file.members, [
    { name: 'Aravinth', status: 'approved' },
    { name: 'Priya', status: 'approved' },
    { name: 'Aravinth', status: 'approved' }
  ]);
  assert.equal(file.exportedAt, '2026-11-15T09:07:00.000Z');
  assert.deepEqual(Object.keys(file).sort(), [
    'expenses',
    'exportedAt',
    'group',
    'members',
    'schema',
    'settlements'
  ]);

  assert.equal(file.expenses.length, 1);
  assert.deepEqual(file.expenses[0], {
    description: 'Dinner',
    amountPaise: 120_000,
    paidBy: [
      { name: 'Aravinth', amountPaise: 80_000 },
      { name: 'Priya', amountPaise: 40_000 }
    ],
    split: [
      { name: 'Aravinth', amountPaise: 60_000 },
      { name: 'Priya', amountPaise: 30_000 },
      { name: 'Aravinth', amountPaise: 30_000 }
    ],
    date: '2026-11-14',
    time: '20:30',
    note: 'card'
  });
  assert.deepEqual(file.settlements, [
    {
      from: 'Priya',
      to: 'Aravinth',
      amountPaise: 40_000,
      date: '2026-11-15',
      time: '09:00',
      note: ''
    }
  ]);
});

test('export: deleted and pending rows never reach the file', () => {
  const file = exportGroup({
    name: 'Goa',
    currency: 'INR',
    members,
    records,
    exportedAt
  });
  const text = JSON.stringify(file);
  assert.equal(text.includes('Gone'), false);
  assert.equal(text.includes('Waiting to sync'), false);
  assert.equal(file.expenses.length, 1);
});

test('export: no id, code, key, ciphertext or room URL appears', () => {
  const file = exportGroup({
    name: 'Goa',
    currency: 'INR',
    members,
    records,
    exportedAt
  });
  const text = JSON.stringify(file);
  for (const forbidden of [ID_A, ID_B, ID_C, 'record-one', 'record-two', 'groupId', 'blob', 'code']) {
    assert.equal(text.includes(forbidden), false, `the file must not contain ${forbidden}`);
  }
  assert.match(text, /"amountPaise":120000/);
});

test('export: a legacy single payer becomes one named payer row', () => {
  const file = exportGroup({
    name: 'Goa',
    currency: 'INR',
    members,
    records: [
      {
        value: {
          kind: 'expense',
          description: 'Taxi',
          amountPaise: 30_000,
          paidBy: ID_A,
          split: { [ID_A]: 30_000 },
          date: '2026-11-14',
          time: '08:00',
          note: ''
        }
      }
    ],
    exportedAt
  });
  assert.deepEqual(file.expenses[0].paidBy, [{ name: 'Aravinth', amountPaise: 30_000 }]);
});

test('export: an empty group still produces a valid file', () => {
  const file = exportGroup({
    name: 'Empty',
    currency: 'EUR',
    members: [],
    records: [],
    exportedAt
  });
  assert.deepEqual(file.expenses, []);
  assert.deepEqual(file.settlements, []);
  assert.deepEqual(file.members, []);
});

test('export: the filename is local time and never the group name', () => {
  assert.equal(exportFileName(new Date(2026, 10, 5, 9, 7)), 'splitter-2026-11-05-0907.json');
  assert.match(
    exportFileName(new Date(2026, 0, 31, 23, 59)),
    /^splitter-\d{4}-\d{2}-\d{2}-\d{4}\.json$/
  );
});
