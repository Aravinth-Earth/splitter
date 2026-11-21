/**
 * The wire scanner, without a browser.
 *
 * scripts/e2e/run.mjs records a real Chromium session and scans it with these functions. This file
 * proves the decision itself: a clean capture passes, every sentinel fails when it appears in a
 * frame or a body, a sentinel hidden inside a base64url value fails, and an invented free-form
 * string fails closed. The empty-capture case is here on purpose — a gate that sees nothing must
 * fail its own non-zero counts, not pass vacuously.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyString,
  decodedBase64Url,
  isAllowedLeaf,
  reportLine,
  scanCapture,
  scanValue,
  withPlaintext
} from '../scripts/e2e/scan.mjs';

const ID = 'A'.repeat(22);
const GROUP_ID = 'a'.repeat(64);
const IV = 'A'.repeat(16);
const CT = 'q83vq83vq83vq83v';

const SENTINELS = [
  { label: 'group name', value: 'Quasar Ledger Sentinel' },
  { label: 'host name', value: 'Zelda Quasar' },
  { label: 'member name', value: 'Yorvik Nimbus' },
  { label: 'description', value: 'Sentinel Dinner' },
  { label: 'description', value: 'Sentinel Ferry' },
  { label: 'amount', value: '987654321' },
  { label: 'code', value: '0123456789ABCDEF' }
];

function blob(ct = CT) {
  return { iv: IV, ct };
}

function cleanRecord(overrides = {}) {
  return {
    t: 'record',
    id: ID,
    rev: 1,
    blob: blob(),
    deleted: false,
    author: ID,
    creator: ID,
    at: 1,
    ...overrides
  };
}

function cleanState() {
  return {
    t: 'state',
    rev: 0,
    memberId: ID,
    role: 'host',
    joinMode: 'approval',
    nameBlob: blob(),
    metaBlob: null,
    hostId: ID,
    roster: [{ id: ID, status: 'approved', nameBlob: blob(), participant: false }],
    records: [cleanRecord()]
  };
}

function cleanCapture() {
  return {
    frames: [
      {
        direction: 'sent',
        payload: JSON.stringify({
          t: 'auth',
          id: ID,
          secret: ID,
          mode: 'join',
          nameBlob: blob()
        })
      },
      { direction: 'received', payload: JSON.stringify(cleanState()) },
      { direction: 'received', payload: JSON.stringify({ t: 'here', ids: [ID] }) }
    ],
    bodies: [
      {
        url: '/api/create',
        body: JSON.stringify({
          groupId: GROUP_ID,
          hostId: ID,
          nameBlob: blob(),
          hostNameBlob: blob(),
          metaBlob: blob()
        })
      }
    ]
  };
}

test('a clean capture is accepted, and the scan really saw leaves', () => {
  const result = scanCapture(cleanCapture(), SENTINELS);

  assert.deepEqual(result.violations, [], 'a protocol-only capture must scan clean');
  assert.equal(result.frames, 3);
  assert.equal(result.bodies, 1);
  assert.ok(result.frames > 0, 'the gate must have frames to speak about');
  assert.ok(result.bodies > 0, 'the gate must have bodies to speak about');
  assert.ok(result.leaves > 0, 'a scan over no leaves proves nothing');
  assert.equal(reportLine(result), '3 frames, 1 bodies scanned');
});

test('every sentinel fails when it appears in a frame', () => {
  for (const sentinel of SENTINELS) {
    const capture = cleanCapture();
    capture.frames.push({
      direction: 'received',
      payload: JSON.stringify(cleanRecord({ leak: sentinel.value }))
    });

    const result = scanCapture(capture, SENTINELS);
    const reasons = result.violations.map((violation) => violation.reason);

    assert.ok(
      reasons.some((reason) => reason.includes(sentinel.label)),
      `a frame carrying ${sentinel.label} must fail, got ${JSON.stringify(reasons)}`
    );
  }
});

test('every sentinel fails when it appears in a request body', () => {
  for (const sentinel of SENTINELS) {
    const capture = cleanCapture();
    capture.bodies.push({
      url: '/api/create',
      body: JSON.stringify({ groupId: GROUP_ID, leak: sentinel.value })
    });

    const result = scanCapture(capture, SENTINELS);
    assert.ok(
      result.violations.some((violation) => violation.reason.includes(sentinel.label)),
      `a body carrying ${sentinel.label} must fail`
    );
  }
});

test('a sentinel hidden inside a base64url value is decoded and caught', () => {
  const hidden = Buffer.from(`prefix ${SENTINELS[0].value} suffix`, 'latin1').toString('base64url');
  assert.ok(!hidden.includes(SENTINELS[0].value), 'the fixture must hide the sentinel');

  const capture = cleanCapture();
  capture.frames.push({
    direction: 'received',
    payload: JSON.stringify(cleanRecord({ leak: hidden }))
  });

  const result = scanCapture(capture, SENTINELS);
  assert.ok(
    result.violations.some((violation) => violation.reason === 'group name appears inside a base64url value'),
    JSON.stringify(result.violations)
  );
});

test('a plaintext mutant makes the scan fail, so the gate can fail', () => {
  const clean = scanValue(cleanRecord(), SENTINELS);
  assert.deepEqual(clean.violations, [], 'the base value must be clean before it is mutated');

  const mutated = scanValue(withPlaintext(cleanRecord(), SENTINELS[1]), SENTINELS);
  assert.ok(
    mutated.violations.some((violation) => violation.reason === 'host name appears in the clear'),
    'the mutant must be caught'
  );
});

test('a free-form string is refused, and the protocol shapes are allowed', () => {
  assert.equal(classifyString('Dinner at the pier'), 'unknown');
  assert.equal(isAllowedLeaf('Dinner at the pier'), false);

  for (const value of [ID, GROUP_ID, 'refused', IV, 42, true, null]) {
    assert.equal(isAllowedLeaf(value), true, `${JSON.stringify(value)} is a protocol value`);
  }

  const result = scanValue(cleanRecord({ note: 'Dinner at the pier' }), []);
  assert.deepEqual(result.violations, [
    { path: '$.note', reason: 'unrecognised free-form string' }
  ]);
});

test('an empty capture scans to zero counts and zero leaves', () => {
  const result = scanCapture({ frames: [], bodies: [] }, SENTINELS);
  assert.equal(result.frames, 0);
  assert.equal(result.bodies, 0);
  assert.equal(result.leaves, 0);
  assert.deepEqual(result.violations, []);
  assert.equal(reportLine(result), '0 frames, 0 bodies scanned');
});

test('leaves are counted at every depth, including arrays', () => {
  const result = scanValue({ a: 1, b: 'host', c: [ID, null] }, SENTINELS);
  assert.equal(result.leaves, 4);
});

test('a non-base64url or impossible-length string has no decoded bytes', () => {
  assert.equal(decodedBase64Url('####'), null);
  assert.equal(decodedBase64Url('abcde'), null);
  assert.notEqual(decodedBase64Url('AAAA'), null);
});

test('every frame shape the protocol defines scans clean', () => {
  const clientFrames = [
    { t: 'auth', id: ID, secret: ID, mode: 'resume' },
    { t: 'auth', id: ID, secret: ID, mode: 'join', nameBlob: blob() },
    { t: 'put', id: ID, base: 0, blob: blob(), deleted: false },
    { t: 'put', id: ID, base: 1, blob: null, deleted: true },
    { t: 'ping' },
    { t: 'mode', mode: 'open' },
    { t: 'mode', mode: 'approval' },
    { t: 'approve', memberId: ID },
    { t: 'reject', memberId: ID },
    { t: 'remove', memberId: ID },
    { t: 'leave' },
    { t: 'end' },
    { t: 'import-members', members: [{ memberId: ID, nameBlob: blob() }] }
  ];

  const serverFrames = [
    { t: 'waiting', memberId: ID },
    {
      t: 'state',
      rev: 0,
      memberId: ID,
      role: 'member',
      joinMode: 'open',
      nameBlob: blob(),
      metaBlob: blob(),
      hostId: ID,
      roster: [{ id: ID, status: 'pending', nameBlob: blob(), participant: false }],
      records: []
    },
    { t: 'here', ids: [ID] },
    { t: 'record', id: ID, rev: 2, blob: blob(), deleted: false, author: ID, creator: ID, at: 2 },
    {
      t: 'conflict',
      id: ID,
      current: { id: ID, rev: 2, blob: blob(), deleted: false, author: ID, creator: ID, at: 2 }
    },
    { t: 'refused', code: 'group_full' },
    { t: 'refused', code: 'not_host', id: ID },
    { t: 'import-members-ok', memberIds: [ID] },
    { t: 'left' },
    { t: 'removed' },
    { t: 'ended' },
    { t: 'wipe-failed' }
  ];

  const result = scanCapture(
    {
      frames: [...clientFrames, ...serverFrames].map((frame) => ({
        direction: 'either',
        payload: JSON.stringify(frame)
      })),
      bodies: []
    },
    SENTINELS
  );

  assert.deepEqual(result.violations, [], 'every protocol string must be in the allowlist');
  assert.equal(result.frames, clientFrames.length + serverFrames.length);
});
