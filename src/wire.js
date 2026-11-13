/**
 * Splitter — the two shapes the Worker and a Durable Object both have to agree on.
 *
 * An id and a sealed blob are checked twice: at the edge, before a slot is spent, and again inside
 * the Durable Object that stores them. Two copies of the same regex drift — the iv was counted as
 * 16 characters in one file while crypto.js writes 12 bytes — so the definitions live here once and
 * both readers import them. The Durable Object check is not redundant: it is the one that stands
 * between a group record and `hostId: undefined`, whatever called it.
 */

/* An id the client can send: a group id from crypto.js (64 lowercase hex, a hash of the code) or
   the 22-character base64url shape a member id has. Both are opaque here — the ledger and the
   Durable Object name only need to be unforgeable and stable, and neither is a secret we can read
   anything out of. */
const ID = /^(?:[A-Za-z0-9_-]{22}|[0-9a-f]{64})$/;
/* A sealed value as crypto.js writes it: {iv, ct}, unpadded base64url. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The iv as it arrives: 16 base64url characters, which is 12 bytes.
 *
 * The number is characters because the value being checked is the string a client sent, not the
 * bytes it decodes to. It is 16 because crypto.js seals under `IV_BYTES` (12, see
 * public/crypto.js), and an unpadded base64url encoding of 12 bytes is exactly
 * 16 characters — the two numbers are one number written in two units, which is why this constant
 * is derived and asserted against crypto.js in the tests rather than trusted on its own.
 */
export const IV_BASE64_CHARS = 16;

export function isId(value) {
  return typeof value === 'string' && ID.test(value);
}

/* A group id is the 64 hex characters in a hash of the code: the one id shape that names a
   Durable Object. The room in a socket URL must be this, never a member id. */
const GROUP_ID = /^[0-9a-f]{64}$/;

export function isGroupId(value) {
  return typeof value === 'string' && GROUP_ID.test(value);
}

/* The Worker never opens a blob — it cannot, and must not be able to. It checks the envelope and
   stores the bytes as they arrived. */
export function isSealed(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.iv === 'string' &&
    value.iv.length === IV_BASE64_CHARS &&
    BASE64URL.test(value.iv) &&
    typeof value.ct === 'string' &&
    value.ct.length > 0 &&
    BASE64URL.test(value.ct)
  );
}
