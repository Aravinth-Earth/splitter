/**
 * Splitter — the one module that turns a group code into a key.
 *
 * A group code is 16 Crockford base32 characters and it is the secret: it is stretched with
 * PBKDF2-SHA256 into an AES-256-GCM key, and only a hash of the code ever reaches the server.
 * Every derivation is domain-separated with an `sp1:` label, so a hash of the code, a key salt
 * and a member id can never be confused with one another.
 *
 * Plain ES module, no build step, no import: WebCrypto is `globalThis.crypto` in a browser and
 * under `node --test`, and this file uses nothing else.
 */

export const DOMAIN_PREFIX = 'sp1:';

/* Every hash input starts with one of these, and no label prefixes another. */
export const LABELS = Object.freeze({
  group: `${DOMAIN_PREFIX}group:`,
  key: `${DOMAIN_PREFIX}key:`,
  member: `${DOMAIN_PREFIX}member:`
});

/* Crockford base32: no I, L, O or U, so a code read off a screen cannot be mistyped. */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 16;
export const CODE_GROUP = 4;
export const PBKDF2_ITERATIONS = 210_000;
export const KEY_BITS = 256;
export const IV_BYTES = 12;
export const ID_BYTES = 16;
export const ID_LENGTH = 22; /* 16 bytes, base64url, unpadded */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text, what) {
  if (typeof text !== 'string' || text === '' || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`splitter: ${what} is not base64url`);
  }
  const padding = (4 - (text.length % 4)) % 4;
  let binary;
  try {
    if (padding === 3) throw new Error('impossible length');
    binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding));
  } catch {
    throw new Error(`splitter: ${what} is not base64url`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

function toHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

/** A fresh 16-character code, uniform over the 32 symbols. */
export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  /* 32 divides 256, so five bits of a byte are uniform — no rejection sampling needed. */
  for (const byte of bytes) code += ALPHABET[byte & 31];
  return code;
}

/**
 * Fold what a person typed into the canonical form, or refuse it.
 *
 * Case, spaces and dashes carry no meaning; I and L read as 1, O as 0 and U as V, which is the
 * Crockford reading. A length or a character outside the alphabet throws instead of silently
 * deriving a key for a group that is not the one the person meant.
 */
export function normalizeCode(input) {
  if (typeof input !== 'string') throw new Error('splitter: a group code must be a string');

  const folded = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');

  if (folded.length !== CODE_LENGTH) {
    throw new Error(`splitter: a group code is ${CODE_LENGTH} characters, got ${folded.length}`);
  }
  for (const character of folded) {
    if (!ALPHABET.includes(character)) {
      throw new Error(`splitter: "${character}" is not a group-code character`);
    }
  }
  return folded;
}

/** The canonical code in the four groups a person reads aloud. */
export function formatCode(input) {
  const code = normalizeCode(input);
  const groups = [];
  for (let at = 0; at < code.length; at += CODE_GROUP) {
    groups.push(code.slice(at, at + CODE_GROUP));
  }
  return groups.join('-');
}

/** 64 lowercase hex characters: the only thing about a code the server ever holds. */
export async function groupIdFromCode(input) {
  const code = normalizeCode(input);
  return toHex(await sha256(`${LABELS.group}${code}`));
}

/**
 * The group's AES-256-GCM key. Non-extractable: it exists to seal and open, never as bytes.
 * The salt is a hash of the group id, so it is deterministic per group and carries no secret
 * the server does not already have.
 */
export async function deriveGroupKey(input) {
  const code = normalizeCode(input);
  const salt = await sha256(`${LABELS.key}${await groupIdFromCode(code)}`);
  const material = await crypto.subtle.importKey('raw', encoder.encode(code), 'PBKDF2', false, [
    'deriveKey'
  ]);

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['encrypt', 'decrypt']
  );
}

/** A member's own secret, 22 base64url characters, unrelated to any group code. */
export function randomSecret() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}

/**
 * The member id the server sees: a hash of the member's secret, never of the code, so two
 * members of one group cannot collide and one id says nothing about the group.
 */
export async function idFromSecret(secret) {
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('splitter: a member secret must be a non-empty string');
  }
  const digest = await sha256(`${LABELS.member}${secret}`);
  return toBase64Url(digest.slice(0, ID_BYTES));
}

/** Seal a JSON value under a group key, with a fresh 12-byte IV every time. */
export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(value))
  );
  return { iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ciphertext)) };
}

/**
 * Open a sealed value, or throw. The GCM tag is what decides: a flipped bit anywhere in the
 * ciphertext, the IV or the tag is a refusal, never a partial read.
 */
export async function open(key, sealed) {
  if (!sealed || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') {
    throw new Error('splitter: a sealed value carries an iv and a ct');
  }

  const iv = fromBase64Url(sealed.iv, 'the iv');
  if (iv.length !== IV_BYTES) {
    throw new Error(`splitter: a sealed value carries a ${IV_BYTES}-byte iv`);
  }
  const ciphertext = fromBase64Url(sealed.ct, 'the ciphertext');

  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ciphertext);
  } catch {
    throw new Error('splitter: this value was not sealed under this key');
  }

  try {
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('splitter: a sealed value carries JSON');
  }
}
