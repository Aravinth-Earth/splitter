/**
 * The create form's own rules, without a browser.
 *
 * The page is a plain ES module whose DOM wiring sits behind a guard, so node can import it and
 * test what decides whether a request is made and what that request may carry. Two things these
 * tests exist for: the length limits are in code points (a Tamil name or an emoji is one
 * character, not two), and the group name must not appear in the body in any form — a test that
 * only checked the blobs exist would pass with the name still in the clear.
 *
 * Every assertion names the guarantee, so a failure reports the promise rather than a line.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  countCodePoints,
  createErrorMessage,
  createPayload,
  inviteLink,
  normalizeCurrency,
  validateDisplayName,
  validateGroupName
} from '../public/w/expense-splitter/app.js';
import {
  deriveGroupKey,
  formatCode,
  generateCode,
  open,
  randomSecret
} from '../public/w/expense-splitter/crypto.js';

/* ----------------------------------------------------------------- group name */

test('a group name is refused when it is empty or only whitespace', () => {
  const blanks = ['', ' ', '   \t\n ', '\u00a0'];

  for (const input of blanks) {
    const result = validateGroupName(input);
    assert.equal(result.ok, false, `${JSON.stringify(input)} must not be a group name`);
    assert.match(result.message, /Enter a group name/, 'the refusal must say what to do');
    assert.equal(result.value, undefined, 'a refused name must not be handed to the payload');
  }

  for (const input of [undefined, null, 42, {}]) {
    assert.equal(validateGroupName(input).ok, false, `${String(input)} is not a name a person typed`);
  }
});

test('a group name of 60 code points is accepted and 61 is refused', () => {
  const sixty = 'a'.repeat(60);
  const accepted = validateGroupName(sixty);
  assert.equal(accepted.ok, true, '60 characters is inside the limit');
  assert.equal(accepted.value, sixty);
  assert.equal(accepted.length, 60);

  const refused = validateGroupName('a'.repeat(61));
  assert.equal(refused.ok, false, '61 characters is outside the limit');
  assert.match(refused.message, /at most 60 characters/, 'the refusal must name the limit');
  assert.match(refused.message, /Yours is 61/, 'the refusal must say what was counted');
  assert.equal(refused.value, undefined);
});

test('a Tamil name and an emoji are counted by code point, not by UTF-16 unit', () => {
  /* Five code points per word, so twelve words sit exactly on the limit. */
  const tamil = 'தமிழ்'.repeat(12);
  assert.equal(countCodePoints(tamil), 60, 'the fixture must sit exactly on the limit');
  assert.equal(validateGroupName(tamil).ok, true, 'a Tamil name is counted one character at a time');

  /* One more combining mark is one more code point, and one character too many. */
  const tamilOver = `${tamil}்`;
  assert.equal(tamilOver.length, 61);
  assert.equal(validateGroupName(tamilOver).ok, false, 'a combining mark is a character of its own');

  const emoji = '🙂';
  assert.equal(emoji.length, 2, 'the fixture must be a surrogate pair');
  assert.equal(countCodePoints(emoji), 1);

  const sixtyEmoji = emoji.repeat(60);
  assert.equal(sixtyEmoji.length, 120, 'the fixture must be longer than 60 UTF-16 units');
  assert.equal(validateGroupName(sixtyEmoji).ok, true, 'sixty emoji are sixty code points');
  assert.equal(validateGroupName(emoji.repeat(61)).ok, false, 'sixty-one emoji are over the limit');

  /* 29 letters and an emoji: 30 code points, 31 units — accepted only if units are not the unit. */
  const mixed = `${'a'.repeat(29)}${emoji}`;
  assert.equal(mixed.length, 31);
  assert.equal(validateGroupName(mixed).ok, true, 'the count must not be a UTF-16 count');
  assert.equal(validateGroupName(`${'a'.repeat(60)}${emoji}`).ok, false, '61 code points is over');
});

test('a group name is sealed without its surrounding whitespace', () => {
  const result = validateGroupName('  Goa trip  ');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'Goa trip', 'what is counted must be what is sealed');
  assert.equal(result.length, 8);
});

/* --------------------------------------------------------------- display name */

test('a display name is 2 to 30 code points', () => {
  const one = validateDisplayName('A');
  assert.equal(one.ok, false, 'one character is not a name anyone can be recognised by');
  assert.match(one.message, /at least 2 characters/);

  const two = validateDisplayName('Al');
  assert.equal(two.ok, true);
  assert.equal(two.value, 'Al');

  const thirty = validateDisplayName('a'.repeat(30));
  assert.equal(thirty.ok, true, '30 characters is inside the limit');
  assert.equal(thirty.length, 30);

  const over = validateDisplayName('a'.repeat(31));
  assert.equal(over.ok, false);
  assert.match(over.message, /at most 30 characters/);
  assert.match(over.message, /Yours is 31/);

  for (const input of ['', '  ', undefined, null, 7]) {
    assert.equal(validateDisplayName(input).ok, false, `${JSON.stringify(input)} is not a display name`);
  }
});

test('a display name is counted by code point and sent trimmed', () => {
  const emoji = '🙂';
  const mixed = `${'a'.repeat(29)}${emoji}`;
  assert.equal(mixed.length, 31, 'the fixture must be longer than 30 UTF-16 units');
  assert.equal(validateDisplayName(mixed).ok, true, '30 code points is inside the limit');
  assert.equal(validateDisplayName(emoji.repeat(30)).ok, true, 'thirty emoji are thirty code points');
  assert.equal(validateDisplayName(emoji.repeat(31)).ok, false, 'thirty-one emoji are over the limit');

  assert.equal(validateDisplayName('  Ana  ').value, 'Ana');
});

/* ----------------------------------------------------------------- currency */

test('currency defaults to INR and anything else falls back to it', () => {
  assert.equal(DEFAULT_CURRENCY, 'INR');
  assert.deepEqual([...CURRENCIES], ['INR', 'EUR', 'USD', 'GBP'], 'the page offers four currencies');

  assert.equal(normalizeCurrency(undefined), 'INR', 'an absent value must not be a currency');
  assert.equal(normalizeCurrency(''), 'INR');
  assert.equal(normalizeCurrency('inr'), 'INR', 'case carries no meaning in a currency code');
  assert.equal(normalizeCurrency(' eur '), 'EUR');
  assert.equal(normalizeCurrency('JPY'), 'INR', 'a currency the page cannot round falls back');
});

/* ------------------------------------------------------------------- payload */

test('a create payload is two ids and two sealed blobs, and no plaintext name', async () => {
  const code = generateCode();
  const secret = randomSecret();
  const name = 'Zanzibar Ledger';
  const payload = await createPayload({ code, secret, name });

  assert.deepEqual(
    Object.keys(payload).sort(),
    ['groupId', 'hostId', 'metaBlob', 'nameBlob'],
    'the body has exactly the four fields the Worker reads'
  );
  assert.match(payload.groupId, /^[0-9a-f]{64}$/, 'the group id is the hash of the code');
  assert.match(payload.hostId, /^[A-Za-z0-9_-]{22}$/, 'the host id is a 22-character base64url id');

  for (const blob of [payload.nameBlob, payload.metaBlob]) {
    assert.deepEqual(Object.keys(blob).sort(), ['ct', 'iv'], 'a sealed value is {iv, ct}');
    assert.match(blob.iv, /^[A-Za-z0-9_-]{16}$/, 'the iv is 12 bytes in unpadded base64url');
  }

  /* The promise of the page, checked three ways: no field, no string, no bytes. */
  const wire = JSON.stringify(payload);
  assert.ok(!('name' in payload), 'there is no plaintext name field');
  assert.ok(!wire.includes(name), 'the name must not appear in the body as text');
  assert.ok(
    !Buffer.from(payload.nameBlob.ct, 'base64url').includes(Buffer.from(name)),
    'the sealed name must not contain the name in the clear'
  );

  const key = await deriveGroupKey(code);
  assert.deepEqual(await open(key, payload.nameBlob), { name }, 'the sealed name opens under the code');
  assert.deepEqual(
    await open(key, payload.metaBlob),
    { currency: 'INR' },
    'the currency defaults to INR in the sealed meta'
  );
});

test('the sealed meta carries the chosen currency', async () => {
  const code = generateCode();
  const payload = await createPayload({ code, secret: randomSecret(), name: 'Trip', currency: 'eur' });

  assert.deepEqual(await open(await deriveGroupKey(code), payload.metaBlob), { currency: 'EUR' });
});

test('one code is one group id, and every seal has a fresh IV', async () => {
  const code = generateCode();
  const first = await createPayload({ code, secret: randomSecret(), name: 'Trip' });
  const second = await createPayload({ code, secret: randomSecret(), name: 'Trip' });

  assert.equal(second.groupId, first.groupId, 'the same code must name the same group');
  assert.notEqual(second.hostId, first.hostId, 'two members must not share one member id');
  assert.notEqual(
    second.nameBlob.ct,
    first.nameBlob.ct,
    'sealing the same name twice must not repeat the ciphertext'
  );
  assert.notEqual(second.nameBlob.iv, first.nameBlob.iv, 'every seal needs its own IV');
});

test('a payload cannot be built from nothing', async () => {
  const code = generateCode();
  const secret = randomSecret();

  await assert.rejects(
    createPayload({ secret, name: 'Trip' }),
    /needs a group code/,
    'a payload without a code has no group to belong to'
  );
  await assert.rejects(
    createPayload({ code, name: 'Trip' }),
    /needs a member secret/,
    'a payload without a secret has no host id'
  );
  await assert.rejects(
    createPayload({ code, secret, name: '   ' }),
    /needs a group name/,
    'a blank name must not be sealed'
  );
});

/* ------------------------------------------------------------------ failures */

test('a full ledger renders exactly the cap message and nothing else', () => {
  assert.equal(
    createErrorMessage(429),
    'All 25 group slots are in use.',
    'the cap message is the whole message, not a prefix'
  );

  for (const status of [400, 500, 503, 0]) {
    assert.match(createErrorMessage(status), /try again/i, `${status} must invite a retry`);
    assert.notEqual(createErrorMessage(status), createErrorMessage(429), `${status} is not the cap`);
  }
});

/* ----------------------------------------------------------------- invitations */

test('the invite link carries the code in the fragment', () => {
  const code = 'ABCDEFGHJKMNPQRS';
  const link = inviteLink('https://example.test/w/expense-splitter/', code);

  assert.equal(link, `https://example.test/w/expense-splitter/#code=${formatCode(code)}`);
  assert.equal(formatCode(code), 'ABCD-EFGH-JKMN-PQRS', 'the fragment carries the formatted reading');

  const url = new URL(link);
  assert.equal(url.pathname, '/w/expense-splitter/', 'the code must not be in the path');
  assert.equal(url.search, '', 'the code must not be in the query string');
  assert.equal(
    url.hash,
    '#code=ABCD-EFGH-JKMN-PQRS',
    'a fragment is the one part of a URL a browser does not send to the server'
  );
});
