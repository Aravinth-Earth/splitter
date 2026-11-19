/**
 * The browser crypto core: the code, the group id, the key and the member ids.
 *
 * Every absence check is paired with a presence check, so a module that returns nothing
 * cannot make a test pass by making it vacuous.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  ALPHABET,
  BUCKET_BYTES,
  DOMAIN_PREFIX,
  LABELS,
  CODE_LENGTH,
  ID_LENGTH,
  ID_BYTES,
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
  padToBucket,
  seal,
  open,
  avatarFor
} from '../public/crypto.js';
/* The server's half of the same envelope. The iv was counted as 16 characters in one file and 12
   bytes in the other, so the cross-check below is the point of the import, not a detail. */
import { IV_BASE64_CHARS, isSealed } from '../src/wire.js';

/* Crockford base32: 0-9, then A-H (no I), J, K, M, N, P-T (no U), V-Z. */
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const BASE64URL_22 = /^[A-Za-z0-9_-]{22}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const SAMPLES = 200;

/* The two derivations restated from the wire format, so a test can name the bytes it expects
   instead of asking the module what it thinks they are. */
const sha256 = async (text) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const base64url = (bytes) => Buffer.from(bytes).toString('base64url');

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

  /* Distinctness is a property of the set, not of a member: checked once, outside the loop, it
     names the failure once; inside the loop it could only repeat itself three times. */
  const entries = Object.entries(LABELS);
  assert.equal(new Set(Object.values(LABELS)).size, 3, 'each derivation gets its own label');

  for (const [name, label] of entries) {
    assert.ok(label.startsWith(DOMAIN_PREFIX), `${name} label "${label}" leaves the domain`);

    /* Distinct labels are not enough. `sp1:group:` and `sp1:group:key:` differ, and the first
       still reads as the opening of the second, so one derivation's hash input can be read as
       another's — the collision the domain labels exist to make impossible. */
    for (const [otherName, otherLabel] of entries) {
      if (otherName === name) continue;
      assert.ok(
        !otherLabel.startsWith(label),
        `${name} label "${label}" prefixes the ${otherName} label "${otherLabel}"`
      );
    }
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

  /* A 15-character input whose last character upper-cases to two must not arrive as 16 and derive
     a key for a group the person did not type. */
  assert.throws(() => normalizeCode('ABCDEFGHJKMNPQ' + 'ß'), /changes length/i);
  assert.throws(() => normalizeCode('ABCDEFGHJKMNPQ' + 'ﬁ'), /changes length/i);

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
  /* HEX_64 already fixes the length at 64, so restating it proved nothing. The bytes are the
     check: drop the group label from the derivation and this id changes while keeping its shape. */
  assert.equal(id, hex(await sha256(`${LABELS.group}${normalizeCode(code)}`)));

  /* The uppercase checks this replaces could not fail: an id that matches HEX_64 carries no
     uppercase letter, so a code written upper case was never going to appear in it. The shape
     that does pass every check above is the code's own bytes hex-encoded — 32 characters, so
     twice over is 64 lowercase hex characters, deterministic, and different for every code. */
  const codeHex = Buffer.from(normalizeCode(code), 'utf8').toString('hex');
  assert.ok(!id.includes(codeHex), 'the id must not be the code hex-encoded, once or twice');

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

  /* A frame is a record: a scalar or an array is not something a caller can merge, so it is
     refused at the door rather than handed on to code that expects fields. */
  await assert.rejects(open(key, await seal(key, [1, 2, 3])), /record, not a scalar or an array/);
  await assert.rejects(open(key, await seal(key, 'a bare string')), /record, not a scalar or an array/);
  await assert.rejects(open(key, await seal(key, 42)), /record, not a scalar or an array/);
  await assert.rejects(open(key, await seal(key, null)), /record, not a scalar or an array/);
});

test('a frame carrying a prototype key is refused', async () => {
  const key = await deriveGroupKey(generateCode());

  /* The frame is real on the wire: `JSON.parse` gives `__proto__` back as an own property, so any
     member — who holds the group key — can seal exactly this. Without the guard the next
     `Object.assign({}, opened)` would set the target's prototype instead of copying a field. */
  const trap = JSON.parse('{"__proto__":{"polluted":1}}');

  await assert.rejects(open(key, await seal(key, trap)), /__proto__/);

  const nested = { split: JSON.parse('{"__proto__":{"polluted":1}}') };
  await assert.rejects(open(key, await seal(key, nested)), /__proto__/, 'a trap one level down');

  /* The guard refuses a key, not a word: an ordinary record that mentions it still opens. */
  const ordinary = { note: '__proto__ is a string here' };
  assert.deepEqual(await open(key, await seal(key, ordinary)), ordinary);
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

test('the server counts the iv in the same twelve bytes the client writes', async () => {
  /* The Worker used to check 16 under the name IV_LENGTH, which reads as a byte count and disagreed
     with the IV_BYTES crypto.js exports. IV_BASE64_CHARS is the same number in the unit that arrives
     on the wire; this case is what stops the two files drifting apart again, because it takes the
     server's constant and measures a real frame against it. */
  assert.equal(IV_BASE64_CHARS, 16, 'an unpadded base64url encoding of 12 bytes is 16 characters');

  const key = await deriveGroupKey(generateCode());
  const frame = await seal(key, { amount: 1 });
  assert.equal(frame.iv.length, IV_BASE64_CHARS, 'a sealed iv is exactly what the server expects');
  assert.equal(Buffer.from(frame.iv, 'base64url').length, IV_BYTES, 'and those characters are 12 bytes');
});

test('the wire accepts a 16-character iv and refuses a 12-character one', async () => {
  /* The server stores an envelope only if `isSealed` says so, so this is the check a real create
     passes through. Both directions are asserted: a refusal alone could be a validator that
     refuses everything, and an acceptance alone could be one that accepts anything. */
  const key = await deriveGroupKey(generateCode());
  const frame = await seal(key, { amount: 1 });

  assert.equal(isSealed(frame), true, 'a frame the browser actually sealed must be storable');
  assert.equal(isSealed({ iv: 'A'.repeat(16), ct: frame.ct }), true, '16 characters is the iv');

  /* 12 characters is the byte count written in the wrong unit: it is what a constant that reads as
     `IV_LENGTH = 12` would accept, and it is not an iv any frame carries. */
  assert.equal(isSealed({ iv: 'A'.repeat(12), ct: frame.ct }), false, '12 characters is not an iv');
  assert.equal(isSealed({ iv: frame.iv.slice(0, 15), ct: frame.ct }), false, 'nor is a short one');
  assert.equal(isSealed({ iv: `${frame.iv}A`, ct: frame.ct }), false, 'nor a long one');

  /* The number is the one the client's bytes produce, not a coincidence of the fixture. */
  assert.equal(Buffer.from('A'.repeat(IV_BASE64_CHARS), 'base64url').length, IV_BYTES);
});

test('the iv has one constant on each side, and none of them is named IV_LENGTH', () => {
  /* A second definition is how the two units drifted apart before: `IV_LENGTH = 16` in the Worker
     read as bytes and disagreed with the browser's `IV_BYTES = 12`. The scan runs over the server's
     modules and the browser's alike — a stray definition on either side, used or not, is the
     finding — so the two constants that remain are the two units of the same number. */
  const trees = [
    { name: 'src', dir: new URL('../src/', import.meta.url), expected: 'src/wire.js: IV_BASE64_CHARS =' },
    { name: 'public', dir: new URL('../public/', import.meta.url), expected: 'public/crypto.js: IV_BYTES =' }
  ];

  const definitions = [];
  const mentions = [];
  for (const tree of trees) {
    const files = readdirSync(tree.dir).filter((name) => name.endsWith('.js'));
    assert.ok(files.length >= 5, `the scan reads the ${tree.name} modules, found ${files.join(', ')}`);

    for (const name of files) {
      const text = readFileSync(new URL(name, tree.dir), 'utf8');
      for (const match of text.matchAll(/\bIV_[A-Z0-9_]+\s*=/g)) {
        definitions.push(`${tree.name}/${name}: ${match[0].trim()}`);
      }
      for (const match of text.matchAll(/\bIV_LENGTH\b/g)) {
        mentions.push(`${tree.name}/${name}: ${match[0]}`);
      }
    }
  }

  assert.deepEqual(
    mentions,
    [],
    'IV_LENGTH is the name that read as bytes and counted characters; it may not come back'
  );
  assert.deepEqual(
    definitions.sort(),
    trees.map((tree) => tree.expected).sort(),
    'one iv constant per side, each in the module the other side already imports'
  );
  assert.ok(
    definitions.includes('public/crypto.js: IV_BYTES ='),
    'the scan found the browser constant the server constant is measured against'
  );
  assert.ok(
    definitions.includes('src/wire.js: IV_BASE64_CHARS ='),
    'and the server constant both the edge and the Durable Object import'
  );
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

  /* BASE64URL_22 on both of the values above already fixes both lengths, so stating them again
     could only fail on the same run as the shape check. The bytes are what is left to check. */
  assert.notEqual(id, secret, 'the id must not be the secret');
  assert.equal(
    id,
    base64url((await sha256(`${LABELS.member}${secret}`)).subarray(0, ID_BYTES)),
    'the member id is the first 16 bytes of the member derivation, in base64url'
  );

  /* And the label has to be `member`, not `group`. Read alike, the id is the first 16 bytes of
     the group derivation of the same input — same shape, same length, same uniqueness — and no
     check above this line can see it. */
  const decoded = Buffer.from(id, 'base64url');
  const groupDerivation = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${LABELS.group}${secret}`))
  );
  assert.notEqual(
    decoded.toString('hex'),
    groupDerivation.subarray(0, decoded.length).toString('hex'),
    'a member id must not be the group derivation of the same secret'
  );

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

/*
 * A known-answer vector. The three labels, the salt recipe and the iteration count are already in
 * browsers: move one and every group id and every key in the wild moves with it, so a group opens
 * to nothing and its records are unreadable. Consistency checks cannot see that — each derivation
 * still agrees with itself — so the bytes themselves are pinned here.
 */
const KAT_CODE = 'ABCDEFGHJKMNPQRS';
const KAT_GROUP_ID = '0fdd7a502a8bb14cf22851cd4a0c60fca5c514fb7c8ecb391dc47e3f9be7f786';
const KAT_SECRET = 'AAECAwQFBgcICQoLDA0ODw';
const KAT_MEMBER_ID = 'EPOcSRlhtThBdbTwu7zU9Q';
/* Sealed by deriveGroupKey(KAT_CODE) as `{ k: 'v' }`. The key is non-extractable, so a stored frame
 * is the only way to pin the key bytes: only the same derivation opens it. */
const KAT_SEALED = { iv: 'fFRYFfYESFER6uba', ct: 'fdsVHoSPWVNEb_XO7thHzCEDtVTtvR4KKA' };

test('the derivation is pinned to known bytes', async () => {
  assert.deepEqual(
    { ...LABELS },
    { group: 'sp1:group:', key: 'sp1:key:', member: 'sp1:member:' },
    'a label is wire format: moving one moves every group id and every key'
  );

  assert.equal(await groupIdFromCode(KAT_CODE), KAT_GROUP_ID);
  assert.equal(
    await groupIdFromCode(formatCode(KAT_CODE).toLowerCase()),
    KAT_GROUP_ID,
    'the vector names the same group through the formatted reading'
  );
  assert.equal(await idFromSecret(KAT_SECRET), KAT_MEMBER_ID);
  assert.deepEqual(
    await open(await deriveGroupKey(KAT_CODE), KAT_SEALED),
    { k: 'v' },
    'a key derived differently must not open a frame sealed before the change'
  );
});

test('a seal can bind the record it belongs to', async () => {
  const key = await deriveGroupKey(generateCode());
  const bound = 'sp1:rec:g:73e7f14/kind:expense/id:7';
  const sealed = await seal(key, { amount: 100 }, bound);

  assert.deepEqual(await open(key, sealed, bound), { amount: 100 });
  assert.deepEqual(
    Object.keys(sealed).sort(),
    ['ct', 'iv'],
    'the binding is authenticated, not carried in the frame'
  );

  await assert.rejects(
    open(key, sealed, 'sp1:rec:g:73e7f14/kind:expense/id:8'),
    /sealed under this key/,
    'another record id must not open it'
  );
  await assert.rejects(
    open(key, sealed),
    /sealed under this key/,
    'an unbound open must not accept a bound frame'
  );
  await assert.rejects(open(key, sealed, 7), /associated data must be a string/);
  await assert.rejects(seal(key, { amount: 100 }, null), /associated data must be a string/);
});

/* ------------------------------------------------------------------------ padding to a bucket */

/*
 * Every sealed value is padded to a whole number of 256-byte buckets before it is encrypted, so a
 * frame's length says which bucket a record fell in and nothing about how big the record is. The
 * padding is spaces: trailing whitespace is insignificant in JSON, so the bytes still parse to the
 * value that went in and `open` needs no unpadding step of its own.
 */
const GCM_TAG_BYTES = 16;
const SPACE = 0x20;

test('padToBucket rounds a byte length up to the smallest 256-byte bucket', () => {
  assert.equal(BUCKET_BYTES, 256, 'the bucket is the block the ciphertext length is measured in');

  /* 256 and 512 are in the table because a table of non-multiples alone cannot tell "at or above"
     from "strictly above": both readings agree on 1, 257, 511 and 513. */
  const table = [
    [1, 256],
    [256, 256],
    [257, 512],
    [511, 512],
    [512, 512],
    [513, 768]
  ];

  for (const [length, bucket] of table) {
    const bytes = new Uint8Array(length).fill(0x41);
    const padded = padToBucket(bytes);

    assert.equal(padded.length, bucket, `${length} bytes take the ${bucket}-byte bucket`);
    assert.ok(padded.length >= length, 'the bucket always holds the input');
    /* One bucket less would not hold it, which is what "the smallest" means. */
    assert.ok(length > bucket - BUCKET_BYTES, `${bucket} is the first bucket that fits ${length} bytes`);
  }
});

test('padding leaves every record byte unchanged and fills the rest with spaces', () => {
  const json = JSON.stringify({ amount: 500, note: 'rent for october' });
  const bytes = new TextEncoder().encode(json);
  const before = [...bytes];

  const padded = padToBucket(bytes);
  assert.ok(padded.length > bytes.length, 'the fixture sits inside a bucket, so there is a tail to fill');

  assert.deepEqual([...padded.subarray(0, bytes.length)], before, 'every record byte is copied verbatim');
  assert.deepEqual([...bytes], before, 'the input is not filled through in place');
  assert.notEqual(padded.buffer, bytes.buffer, 'the result is its own buffer');

  for (let at = bytes.length; at < padded.length; at += 1) {
    assert.equal(padded[at], SPACE, `byte ${at} of the tail is a space`);
  }
  /* A zero-filled tail would pass every length check above and fail here: 0x00 is not JSON
     whitespace, so the frame would open to a parse error instead of the record. */
  assert.equal(padded[bytes.length], SPACE, 'the tail is spaces, not NUL bytes');

  /* An input that already fills its bucket is copied as it stands, with no tail to add. */
  const exact = new Uint8Array(BUCKET_BYTES).fill(0x42);
  const copy = padToBucket(exact);
  assert.equal(copy.length, BUCKET_BYTES);
  assert.deepEqual([...copy], [...exact]);
});

test('the padded bytes still decode and parse to the value that went in', () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const values = [
    { kind: 'expense', amount: 500, group: 'Flat 3' },
    { amount: 1, note: 'x'.repeat(200) },
    { total: 50000000, split: { ana: 25000000, bo: 25000000 } }
  ];

  for (const value of values) {
    const json = JSON.stringify(value);
    const bytes = encoder.encode(json);
    const padded = padToBucket(bytes);
    const text = decoder.decode(padded);

    assert.equal(text.slice(0, json.length), json, 'the JSON text is unchanged');
    assert.equal(
      text.slice(json.length),
      ' '.repeat(padded.length - bytes.length),
      'the tail decodes as the spaces it was filled with'
    );
    assert.deepEqual(JSON.parse(text), value, 'trailing spaces are insignificant to JSON.parse');
    assert.ok(!text.includes('\u0000'), 'a NUL would be a parse error, not padding');
    assert.ok(!text.includes('\uFFFD'), 'the tail decodes as itself, not as a replacement character');
  }
});

test('records in one bucket seal to one ciphertext length, bound or unbound', async () => {
  const key = await deriveGroupKey(generateCode());
  const bound = 'sp1:rec:g:73e7f14/kind:expense/id:7';
  const small = { amount: 1 }; /* 12 bytes of JSON */
  const large = { amount: 1, note: 'x'.repeat(200) }; /* 222 bytes: the same bucket */

  const frames = [
    await seal(key, small),
    await seal(key, large),
    await seal(key, small, bound),
    await seal(key, large, bound)
  ];
  const lengths = frames.map((frame) => Buffer.from(frame.ct, 'base64url').length);

  assert.equal(
    new Set(lengths).size,
    1,
    `four records in one bucket, one length: ${lengths.join(', ')}`
  );
  assert.equal(
    lengths[0],
    BUCKET_BYTES + GCM_TAG_BYTES,
    'the padding fills the bucket and GCM adds its tag'
  );

  /* The length is blind to size, not to the record: the two frames must still be different bytes. */
  assert.notEqual(frames[0].ct, frames[1].ct, 'equal lengths must not mean equal ciphertexts');

  assert.deepEqual(await open(key, frames[0]), small);
  assert.deepEqual(await open(key, frames[1]), large);
  assert.deepEqual(await open(key, frames[2], bound), small, 'the bound frame opens under its binding');
  assert.deepEqual(await open(key, frames[3], bound), large);
});

test('a record past 256 bytes seals longer than one inside the first bucket', async () => {
  const key = await deriveGroupKey(generateCode());
  const inside = { amount: 1 };
  const past = { amount: 1, note: 'y'.repeat(300) }; /* 322 bytes of JSON */

  const short = await seal(key, inside);
  const long = await seal(key, past);
  const shortLength = Buffer.from(short.ct, 'base64url').length;
  const longLength = Buffer.from(long.ct, 'base64url').length;

  assert.equal(shortLength, BUCKET_BYTES + GCM_TAG_BYTES);
  assert.equal(longLength, 2 * BUCKET_BYTES + GCM_TAG_BYTES, 'one bucket more, not one byte more');
  assert.ok(longLength > shortLength, 'a record past the bucket is visibly longer on the wire');

  assert.deepEqual(await open(key, short), inside);
  assert.deepEqual(await open(key, long), past);
});

test('the five-rupee and the five-million-paise record seal to one length and both open', async () => {
  const key = await deriveGroupKey(generateCode());
  /* In paise: 500 is five rupees and 50000000 is five lakh rupees — the same field, five orders of
     magnitude apart, and both far inside the first bucket. */
  const fiveRupees = { amount: 500 };
  const fiveLakhRupees = { amount: 50000000 };

  const one = await seal(key, fiveRupees);
  const two = await seal(key, fiveLakhRupees);
  const oneLength = Buffer.from(one.ct, 'base64url').length;
  const twoLength = Buffer.from(two.ct, 'base64url').length;

  assert.equal(oneLength, twoLength, 'one bucket, one length, whatever the amount');
  assert.equal(oneLength, BUCKET_BYTES + GCM_TAG_BYTES);
  assert.notEqual(one.ct, two.ct, 'the amounts are different records');

  assert.deepEqual(await open(key, one), fiveRupees);
  assert.deepEqual(await open(key, two), fiveLakhRupees);
  assert.equal((await open(key, two)).amount, 50000000, 'the amount survives the padding, not just the shape');
});

test('a Tamil name round-trips to the same code points, never U+FFFD', async () => {
  const key = await deriveGroupKey(generateCode());
  const name = 'கார்த்திக்'; /* 10 code points, 30 UTF-8 bytes */
  const group = 'தமிழ்';
  const value = { name, group };

  const opened = await open(key, await seal(key, value));
  assert.deepEqual(opened, value);

  for (const field of ['name', 'group']) {
    assert.deepEqual(
      [...opened[field]].map((character) => character.codePointAt(0)),
      [...value[field]].map((character) => character.codePointAt(0)),
      `${field} keeps its code points`
    );
    assert.ok(!opened[field].includes('\uFFFD'), `${field} carries no replacement character`);
  }

  /* The bytes as well as the round trip: TextDecoder writes U+FFFD where a sequence is cut, so a
     pad that fell inside a three-byte character would show up here even if a lenient reader
     repaired the name afterwards. */
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const text = new TextDecoder().decode(padToBucket(bytes));
  assert.ok(!text.includes('\uFFFD'), 'the padded bytes decode without a replacement character');
  assert.deepEqual(JSON.parse(text), value);
});

test('a value short in characters but long in bytes takes the bigger bucket', async () => {
  const key = await deriveGroupKey(generateCode());
  /* 130 Tamil characters: 130 code points and 390 UTF-8 bytes, so the record's JSON is 401 bytes.
     A bucket chosen by character count would put it in the first bucket; its bytes need the
     second. */
  const tamil = 'ம'.repeat(130);
  const value = { note: tamil };
  const bytes = new TextEncoder().encode(JSON.stringify(value));

  assert.equal(tamil.length, 130);
  assert.equal([...tamil].length, 130, 'one code point per character, so only the byte count grows');
  assert.ok(bytes.length > BUCKET_BYTES, `the fixture must pass the first bucket, got ${bytes.length} bytes`);
  assert.equal(
    padToBucket(bytes).length,
    2 * BUCKET_BYTES,
    'the bytes, not the characters, choose the bucket'
  );

  const sealed = await seal(key, value);
  assert.equal(Buffer.from(sealed.ct, 'base64url').length, 2 * BUCKET_BYTES + GCM_TAG_BYTES);
  assert.equal((await open(key, sealed)).note, tamil, 'and the characters come back whole');
});

test('a padded frame carries its iv and its ct and nothing else', async () => {
  const key = await deriveGroupKey(generateCode());
  const frame = await seal(key, { amount: 500 });

  assert.deepEqual(Object.keys(frame).sort(), ['ct', 'iv'], 'padding adds no field to the frame');
  assert.equal(frame.iv.length, IV_BASE64_CHARS, 'the iv is the 16 characters the wire expects');
  assert.equal(Buffer.from(frame.iv, 'base64url').length, IV_BYTES);
  assert.equal(Buffer.from(frame.ct, 'base64url').length, BUCKET_BYTES + GCM_TAG_BYTES);
  assert.equal(isSealed(frame), true, 'a padded frame is storable');

  /* The same validator, on the same padded ct: 16 characters is an iv and 12 is the byte count
     written in the wrong unit, whatever the ciphertext behind it measures. */
  assert.equal(isSealed({ iv: 'A'.repeat(16), ct: frame.ct }), true);
  assert.equal(isSealed({ iv: 'A'.repeat(12), ct: frame.ct }), false);

  assert.deepEqual(await open(key, frame), { amount: 500 });
});

test('a padded frame still binds the kind, the group and the record it belongs to', async () => {
  const key = await deriveGroupKey(generateCode());
  const bound = 'sp1:rec:g:73e7f14/kind:expense/id:7';
  const frame = await seal(key, { amount: 500 }, bound);

  assert.deepEqual(await open(key, frame, bound), { amount: 500 });
  assert.deepEqual(Object.keys(frame).sort(), ['ct', 'iv'], 'the binding stays out of the frame');

  const elsewhere = [
    'sp1:rec:g:73e7f14/kind:settlement/id:7', /* another kind */
    'sp1:rec:g:73e7f15/kind:expense/id:7', /* another group */
    'sp1:rec:g:73e7f14/kind:expense/id:8' /* another record */
  ];
  for (const other of elsewhere) {
    await assert.rejects(
      open(key, frame, other),
      /sealed under this key/,
      `${other} must not open a frame bound to ${bound}`
    );
  }
  await assert.rejects(open(key, frame), /sealed under this key/, 'nor does an unbound open');
});

/* ----------------------------------------------------------------------------------- avatars */

/*
 * An avatar is drawn from what the page already has: the member id and the display name. It is a
 * hash, not a secret and not a random draw — the same pair keeps one avatar across reloads, two
 * different people get two different ones, and nothing about it is ever sent anywhere.
 */

const AVATAR = /^(hsl\(\d{1,3} \d{1,3}% \d{1,3}%\))$/;
/* 200 draws over 6 shapes and 360 hues: most of them are distinct, and a hash that only ever drew
   one face would land far below this. */
const AVATAR_SPREAD = 160;

test('an avatar is a deterministic function of the id and the name', () => {
  const avatar = avatarFor(KAT_MEMBER_ID, 'Asha');

  assert.deepEqual(Object.keys(avatar).sort(), ['background', 'ink', 'shape']);
  assert.deepEqual(avatarFor(KAT_MEMBER_ID, 'Asha'), avatar, 'the same pair draws the same avatar');

  /* Shape is a word a stylesheet can carry as a class; the two colours are CSS colours. */
  assert.match(avatar.shape, /^[a-z]+$/, 'a shape is a lowercase word');
  assert.match(avatar.background, AVATAR, 'a background is one hsl() colour');
  assert.match(avatar.ink, AVATAR, 'and so is the ink drawn on it');
  assert.notEqual(avatar.background, avatar.ink, 'the letter is not drawn in its own background');

  for (const field of ['background', 'ink']) {
    const [hue, saturation, lightness] = avatar[field]
      .slice(4, -1)
      .split(' ')
      .map((part) => Number(part.replace('%', '')));
    assert.ok(hue >= 0 && hue < 360, `${field} hue ${hue} is on the wheel`);
    assert.ok(saturation > 0 && saturation <= 100, `${field} saturation ${saturation} is a percentage`);
    assert.ok(lightness >= 0 && lightness <= 100, `${field} lightness ${lightness} is a percentage`);
  }

  /* The drawing carries neither the id nor the name as itself. */
  const drawn = JSON.stringify(avatar);
  assert.ok(!drawn.includes(KAT_MEMBER_ID), 'the avatar does not carry the id');
  assert.ok(!drawn.includes('Asha'), 'nor the name');
});

test('the id and the name both choose the avatar, so no two people are handed one face', () => {
  const pairs = (avatars) => avatars.map((avatar) => `${avatar.shape} ${avatar.background}`);
  const ids = Array.from({ length: SAMPLES }, (_, at) => `member-${at}`);
  const names = Array.from({ length: SAMPLES }, (_, at) => `Name ${at}`);

  const byId = pairs(ids.map((id) => avatarFor(id, 'Asha')));
  assert.ok(
    new Set(byId).size >= AVATAR_SPREAD,
    `${SAMPLES} ids over one name gave only ${new Set(byId).size} distinct avatars`
  );

  const byName = pairs(names.map((name) => avatarFor(KAT_MEMBER_ID, name)));
  assert.ok(
    new Set(byName).size >= AVATAR_SPREAD,
    `${SAMPLES} names under one id gave only ${new Set(byName).size} distinct avatars`
  );

  /* A rename is a different avatar, because the name is part of what is hashed: the same person
     under another display name is not the same drawing. */
  assert.notDeepEqual(avatarFor(KAT_MEMBER_ID, 'Asha'), avatarFor(KAT_MEMBER_ID, 'Balan'));
  assert.deepEqual(
    avatarFor(KAT_MEMBER_ID, ''),
    avatarFor(KAT_MEMBER_ID),
    'no name is the empty name, not a different one'
  );

  /* The shapes are a small fixed set, so a stylesheet can carry a rule for each; a hash that
     only ever drew one shape would pass every uniqueness check above. */
  const shapes = new Set([...byId, ...byName].map((pairName) => pairName.split(' ')[0]));
  assert.ok(shapes.size >= 4, `the hash draws several shapes, found ${shapes.size}`);
  for (const shape of shapes) assert.match(shape, /^[a-z]+$/);
});
