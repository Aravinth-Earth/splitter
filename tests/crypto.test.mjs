/**
 * The browser crypto core: the code, the group id, the key and the member ids.
 *
 * Every absence check is paired with a presence check, so a module that returns nothing
 * cannot make a test pass by making it vacuous.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALPHABET,
  DOMAIN_PREFIX,
  LABELS,
  CODE_LENGTH,
  ID_LENGTH,
  IV_BYTES,
  KEY_BITS,
  PBKDF2_ITERATIONS,
  generateCode,
  normalizeCode,
  formatCode,
  groupIdFromCode,
  deriveGroupKey,
  randomSecret,
  idFromSecret,
  seal,
  open
} from '../public/w/expense-splitter/crypto.js';

/* Crockford base32: 0-9, then A-H (no I), J, K, M, N, P-T (no U), V-Z. */
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const BASE64URL_22 = /^[A-Za-z0-9_-]{22}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const SAMPLES = 200;

test('the alphabet is Crockford base32 and the constants name the plan', () => {
  assert.equal(ALPHABET.length, 32);
  assert.equal(new Set(ALPHABET).size, 32, 'no symbol may repeat');
  assert.match(ALPHABET, /^[0-9A-HJKMNP-TV-Z]{32}$/);
  for (const lookalike of ['I', 'L', 'O', 'U']) {
    assert.ok(!ALPHABET.includes(lookalike), `${lookalike} is never a code character`);
  }

  assert.equal(DOMAIN_PREFIX, 'sp1:');
  assert.equal(CODE_LENGTH, 16);
  assert.equal(KEY_BITS, 256);
  assert.equal(IV_BYTES, 12);
  assert.equal(ID_LENGTH, 22);
  assert.equal(PBKDF2_ITERATIONS, 210_000);
});

test('every derivation label carries the sp1: domain prefix', () => {
  assert.deepEqual(Object.keys(LABELS).sort(), ['group', 'key', 'member']);
  for (const [name, label] of Object.entries(LABELS)) {
    assert.ok(label.startsWith(DOMAIN_PREFIX), `${name} label "${label}" leaves the domain`);
    assert.equal(new Set(Object.values(LABELS)).size, 3, 'each derivation gets its own label');
  }
});

test('a generated code is 16 Crockford characters, never a lookalike', () => {
  const codes = Array.from({ length: SAMPLES }, () => generateCode());
  const symbols = new Set();

  for (const code of codes) {
    assert.equal(typeof code, 'string');
    assert.match(code, CODE_PATTERN);
    assert.equal(normalizeCode(code), code, 'a generated code is already normalised');
    for (const character of code) symbols.add(character);
  }

  assert.equal(new Set(codes).size, SAMPLES, 'every draw is fresh');
  /* 3200 draws over 32 symbols: a capture of fewer than 24 proves the generator is stuck. */
  assert.ok(symbols.size >= 24, `only ${symbols.size} distinct symbols in ${SAMPLES} codes`);
});

test('normalisation folds case, spaces and dashes', () => {
  const canonical = 'ABCDEFGHJKMNPQRS';

  assert.equal(normalizeCode('abcdefghjkmnpqrs'), canonical);
  assert.equal(normalizeCode('abcd-efgh jkmn pqrs'), canonical);
  assert.equal(normalizeCode('  ABCD EFGH-JKMN PQRS  '), canonical);
  assert.equal(normalizeCode(formatCode('abcdefghjkmnpqrs')), canonical);
  assert.equal(normalizeCode(canonical), normalizeCode(normalizeCode(canonical)));

  assert.equal(formatCode(canonical), 'ABCD-EFGH-JKMN-PQRS');
  assert.equal(formatCode('abcdefgh-jkmnpqrs'), 'ABCD-EFGH-JKMN-PQRS');
});

test('I and L read as 1, O as 0 and U as V', () => {
  assert.equal(normalizeCode('IIIILLLLOOOO0000'), '1111111100000000');
  assert.equal(normalizeCode('uuuuuuuuuuuuuuuu'), 'VVVVVVVVVVVVVVVV');
  assert.equal(normalizeCode('1III-LLL1-000O-UUUU'), '111111110000VVVV');
  assert.equal(normalizeCode('iiii-oooo-uuuu-llll'), '11110000VVVV1111');
});

test('a wrong length or an impossible character throws instead of passing', () => {
  const wrongLength = [
    '',
    'ABC',
    'ABCDEFGHJKMNPQR',
    'ABCDEFGHJKMNPQRSX',
    'ABCD EFGH-JKMN-PQRS-0'
  ];
  for (const bad of wrongLength) {
    assert.throws(() => normalizeCode(bad), Error, `"${bad}" must be refused`);
  }

  const impossible = ['ABCDEFGHJKMNPQR$', 'ABCDEFGHJKMNPQRé', 'ABCDEFGHJKMNPQR\u0000'];
  for (const bad of impossible) {
    assert.throws(() => normalizeCode(bad), /not a group-code character/);
  }

  for (const notAString of [null, undefined, 1234567890123456, {}, []]) {
    assert.throws(() => normalizeCode(notAString), /must be a string/);
  }

  assert.throws(() => normalizeCode('ABCDEFGHJKMNPQR'), /16/);
});

test('the group id is 64 lowercase hex characters and does not carry the code', async () => {
  const code = generateCode();
  const id = await groupIdFromCode(code);

  assert.match(id, HEX_64);
  assert.equal(id.length, 64);

  /* The code is upper case on the wire, so it cannot appear in a lowercase hex digest. */
  assert.ok(!id.includes(normalizeCode(code)), 'the id must not carry the code');
  assert.ok(!id.includes(code.toUpperCase()), 'nor the formatted reading');

  /* Case, spacing and the formatted reading all name the same group. */
  assert.equal(await groupIdFromCode(code.toLowerCase()), id);
  assert.equal(await groupIdFromCode(formatCode(code)), id);
  assert.equal(await groupIdFromCode(` ${formatCode(code.toLowerCase())} `), id);
});

test('200 random codes give 200 distinct group ids', async () => {
  const codes = Array.from({ length: SAMPLES }, () => generateCode());
  const ids = await Promise.all(codes.map((code) => groupIdFromCode(code)));

  assert.equal(new Set(codes).size, SAMPLES);
  assert.equal(new Set(ids).size, SAMPLES, 'two codes must never share a group id');
  for (const id of ids) assert.match(id, HEX_64);

  /* Determinism: the first code derives its id again, from scratch. */
  assert.equal(await groupIdFromCode(codes[0]), ids[0]);
  assert.notEqual(await groupIdFromCode(codes[0]), ids[1]);
});

test('two derivations of one code are the same key', async () => {
  const code = generateCode();
  const first = await deriveGroupKey(code);
  const second = await deriveGroupKey(formatCode(code).toLowerCase());

  assert.equal(first.algorithm.name, 'AES-GCM');
  assert.equal(first.algorithm.length, KEY_BITS);
  assert.equal(first.extractable, false, 'the key never leaves the module as raw bytes');
  assert.deepEqual([...first.usages].sort(), ['decrypt', 'encrypt']);

  const sealed = await seal(first, { note: 'two of us' });
  assert.deepEqual(await open(second, sealed), { note: 'two of us' });
});

test('a different code derives a different key', async () => {
  const one = generateCode();
  let other = generateCode();
  while (other === one) other = generateCode();

  const keyOne = await deriveGroupKey(one);
  const keyOther = await deriveGroupKey(other);
  const sealed = await seal(keyOne, { note: 'sealed under the first code' });

  await assert.rejects(open(keyOther, sealed), /sealed under this key/);
});

test('seal and open round-trip a JS object', async () => {
  const key = await deriveGroupKey(generateCode());
  const value = {
    group: 'Flat 3',
    members: ['ana', 'bo'],
    total: 123456,
    split: { ana: 61728, bo: 61728 },
    note: '₹ and émoji 🧾',
    paid: true,
    empty: null
  };

  const sealed = await seal(key, value);
  assert.equal(typeof sealed.iv, 'string');
  assert.equal(typeof sealed.ct, 'string');
  assert.ok(sealed.ct.length > 0);

  assert.deepEqual(await open(key, sealed), value);

  const list = await seal(key, [1, 2, 3]);
  assert.deepEqual(await open(key, list), [1, 2, 3]);

  const text = await seal(key, 'a bare string');
  assert.equal(await open(key, text), 'a bare string');
});

test('every seal carries a fresh 12-byte iv', async () => {
  const key = await deriveGroupKey(generateCode());
  const one = await seal(key, { amount: 1 });
  const two = await seal(key, { amount: 1 });

  assert.equal(Buffer.from(one.iv, 'base64url').length, IV_BYTES);
  assert.equal(Buffer.from(two.iv, 'base64url').length, IV_BYTES);
  assert.notEqual(one.iv, two.iv, 'the same value must not seal to the same bytes');
  assert.notEqual(one.ct, two.ct);
});

test('the sealed bytes carry no plaintext', async () => {
  const key = await deriveGroupKey(generateCode());
  const sealed = await seal(key, { note: 'rent for october', amount: 987654 });
  const onTheWire = `${sealed.iv}.${sealed.ct}`;

  assert.ok(onTheWire.length > 32, 'the capture is not empty');
  assert.ok(!onTheWire.includes('rent'));
  assert.ok(!onTheWire.includes('987654'));
  assert.ok(!Buffer.from(sealed.ct, 'base64url').toString('latin1').includes('rent'));
});

test('a flipped byte fails the auth tag instead of returning garbage', async () => {
  const key = await deriveGroupKey(generateCode());
  const sealed = await seal(key, { amount: 4999 });
  const original = Buffer.from(sealed.ct, 'base64url');

  assert.ok(original.length > 16, 'a GCM tag alone is 16 bytes; the capture is real');

  for (const at of [0, Math.floor(original.length / 2), original.length - 1]) {
    const tampered = Buffer.from(original);
    tampered[at] ^= 0x01;
    await assert.rejects(
      open(key, { iv: sealed.iv, ct: tampered.toString('base64url') }),
      /sealed under this key/,
      `a flip at byte ${at} must be refused`
    );
  }

  const iv = Buffer.from(sealed.iv, 'base64url');
  iv[0] ^= 0xff;
  await assert.rejects(open(key, { iv: iv.toString('base64url'), ct: sealed.ct }));

  const truncated = original.subarray(0, 8);
  await assert.rejects(open(key, { iv: sealed.iv, ct: truncated.toString('base64url') }));
});

test('a malformed sealed value is refused, not half-read', async () => {
  const key = await deriveGroupKey(generateCode());
  const sealed = await seal(key, { amount: 1 });

  await assert.rejects(open(key, null), /iv and a ct/);
  await assert.rejects(open(key, {}), /iv and a ct/);
  await assert.rejects(open(key, { iv: sealed.iv }), /iv and a ct/);
  await assert.rejects(open(key, { iv: 'not base64url!', ct: sealed.ct }), /base64url/);
  await assert.rejects(
    open(key, { iv: Buffer.alloc(8).toString('base64url'), ct: sealed.ct }),
    /12-byte iv/
  );
});

test('a member id is 22 base64url characters derived from a secret, not the code', async () => {
  const secret = randomSecret();
  assert.match(secret, BASE64URL_22);

  const id = await idFromSecret(secret);
  assert.match(id, BASE64URL_22);
  assert.equal(id.length, ID_LENGTH);
  assert.notEqual(id, secret, 'the id must not be the secret');
  assert.ok(!id.includes(secret));

  /* Derived, not random: the same secret names the same member every time. */
  assert.equal(await idFromSecret(secret), id);
});

test('200 secrets give 200 member ids, so two members cannot collide', async () => {
  const secrets = Array.from({ length: SAMPLES }, () => randomSecret());
  const ids = await Promise.all(secrets.map((secret) => idFromSecret(secret)));

  assert.equal(new Set(secrets).size, SAMPLES, 'no repeated secret');
  assert.equal(new Set(ids).size, SAMPLES, 'no repeated member id');
  for (const id of ids) assert.match(id, BASE64URL_22);

  await assert.rejects(idFromSecret(''), /non-empty string/);
  await assert.rejects(idFromSecret(null), /non-empty string/);
});

test('prints the derived group id shape', async (t) => {
  const code = generateCode();
  const id = await groupIdFromCode(code);
  const key = await deriveGroupKey(code);
  const sealed = await seal(key, { gate: 'crypto' });

  t.diagnostic(
    [
      `code=${formatCode(code)}`,
      `groupId=${id} (${id.length} hex)`,
      `key=AES-GCM ${key.algorithm.length}`,
      `ivBytes=${Buffer.from(sealed.iv, 'base64url').length}`,
      `memberId=${await idFromSecret(randomSecret())} (${ID_LENGTH} base64url)`
    ].join(' ')
  );

  assert.match(id, HEX_64);
  assert.equal(key.algorithm.length, KEY_BITS);
});
