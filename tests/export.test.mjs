/**
 * The export object and filename, without a browser.
 *
 * The file is the group's readable copy: no ids, no keys, no ciphertext. A deleted or pending row
 * must never reach it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { SCHEMA, exportFileName, exportGroup, importGroup } from '../public/export.js';

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
    { name: 'Aravinth (2)', status: 'approved' }
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
      { name: 'Aravinth (2)', amountPaise: 30_000 }
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


const fileFixture = () =>
  exportGroup({
    name: 'Goa',
    currency: 'INR',
    members,
    records,
    exportedAt
  });

test('import: a valid file normalises to the same group', () => {
  const file = fileFixture();
  const imported = importGroup(JSON.stringify(file));
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.group, file.group);
  assert.deepEqual(imported.members, file.members);
  assert.deepEqual(imported.expenses, file.expenses);
  assert.deepEqual(imported.settlements, file.settlements);
});

function regroup(imported) {
  const ids = new Map(imported.members.map((member, index) => [member.name, `member-${index}`]));
  const targetMembers = imported.members.map((member, index) => ({
    id: `member-${index}`,
    name: member.name,
    status: member.status
  }));
  const targetRecords = [
    ...imported.expenses.map((expense) => ({
      value: {
        kind: 'expense',
        description: expense.description,
        amountPaise: expense.amountPaise,
        paidBy: expense.paidBy.map((row) => ({
          memberId: ids.get(row.name),
          amountPaise: row.amountPaise
        })),
        split: Object.fromEntries(
          expense.split.map((row) => [ids.get(row.name), row.amountPaise])
        ),
        date: expense.date,
        time: expense.time,
        note: expense.note
      }
    })),
    ...imported.settlements.map((payment) => ({
      value: {
        kind: 'settlement',
        from: ids.get(payment.from),
        to: ids.get(payment.to),
        amountPaise: payment.amountPaise,
        date: payment.date,
        time: payment.time,
        note: payment.note
      }
    }))
  ];

  return exportGroup({
    name: imported.group.name,
    currency: imported.group.currency,
    members: targetMembers,
    records: targetRecords,
    exportedAt
  });
}

test('import: export, import, export is identical', () => {
  const file = fileFixture();
  const imported = importGroup(JSON.stringify(file));
  assert.equal(imported.ok, true);
  assert.deepEqual(regroup(imported), file);
});

test('import: 300 expenses with Tamil and emoji text round-trip byte-exact', () => {
  const manyMembers = [
    { id: 'one', name: 'அருண்' },
    { id: 'two', name: 'Priya' }
  ];
  const manyRecords = Array.from({ length: 300 }, (_, index) => {
    const amount = ((index % 5) + 1) * 100;
    const half = Math.floor(amount / 2);
    return {
      value: {
        kind: 'expense',
        description: `பயணம் ${index} 🚕`,
        amountPaise: amount,
        paidBy: [{ memberId: 'one', amountPaise: amount }],
        split: { one: amount - half, two: half },
        date: '2026-11-15',
        time: '10:00',
        note: index === 0 ? '😀' : ''
      }
    };
  });
  const file = exportGroup({
    name: 'பயணம்',
    currency: 'INR',
    members: manyMembers,
    records: manyRecords,
    exportedAt
  });
  assert.equal(file.expenses.length, 300);
  const imported = importGroup(JSON.stringify(file));
  assert.equal(imported.ok, true);
  assert.deepEqual(regroup(imported), file);
});

test('import: five fixture outcomes name the first failing field', () => {
  const valid = fileFixture();
  assert.equal(importGroup(JSON.stringify(valid)).ok, true);

  const wrong = structuredClone(valid);
  wrong.schema = 'splitter.group/2';
  assert.match(importGroup(JSON.stringify(wrong)).message, /schema/);

  const missing = structuredClone(valid);
  delete missing.group.currency;
  assert.match(importGroup(JSON.stringify(missing)).message, /group\.currency/);

  const badAmount = structuredClone(valid);
  badAmount.expenses[0].amountPaise = 1200.5;
  assert.match(importGroup(JSON.stringify(badAmount)).message, /expenses\[0\]\.amountPaise/);

  const empty = structuredClone(valid);
  empty.members = [{ name: 'Solo', status: 'approved' }];
  empty.expenses = [];
  empty.settlements = [];
  assert.equal(importGroup(JSON.stringify(empty)).ok, true);
});

test('import: a broken file is refused before it can change anything', () => {
  const file = fileFixture();

  const badTotal = structuredClone(file);
  badTotal.expenses[0].split[0].amountPaise = 1;
  assert.match(importGroup(JSON.stringify(badTotal)).message, /expenses\[0\]\.split/);

  const unknownName = structuredClone(file);
  unknownName.expenses[0].paidBy[0].name = 'Nobody';
  assert.match(importGroup(JSON.stringify(unknownName)).message, /paidBy\[0\]\.name/);

  const duplicate = structuredClone(file);
  duplicate.members[2].name = 'Aravinth';
  assert.match(importGroup(JSON.stringify(duplicate)).message, /members\[2\]\.name/);

  const badDate = structuredClone(file);
  badDate.expenses[0].date = '14/11/2026';
  assert.match(importGroup(JSON.stringify(badDate)).message, /expenses\[0\]\.date/);

  assert.match(importGroup('{').message, /not JSON/);
  assert.match(importGroup('[]').message, /group object/);
});


test('documentation: every field the file writes is named in the README', () => {
  const file = fileFixture();
  const paths = (value, prefix = '') => {
    if (Array.isArray(value)) return value.length === 0 ? [] : paths(value[0], `${prefix}[]`);
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, child]) =>
        paths(child, prefix === '' ? key : `${prefix}.${key}`)
      );
    }
    return [prefix];
  };
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const path of new Set(paths(file))) {
    assert.equal(readme.includes(`\`${path}\``), true, `README does not document ${path}`);
  }
});
