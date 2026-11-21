/**
 * Splitter — the scanner the end-to-end capture runs over everything the page put on the wire.
 *
 * A capture is only worth something if it can fail. This module is the decision: every string leaf
 * of every WebSocket frame and every HTTP request body is checked for a sentinel — the group name,
 * the member names, the descriptions, the amount digits and the group code — first as sent and
 * again after a base64url decode, because a readable value can hide inside a blob-shaped field.
 *
 * A leaf that is not a sentinel is still only accepted when it is an id, a protocol enum, a number
 * or a base64url value. Anything else is a string the page invented, and an invented free-form
 * string is exactly the thing this item says must not reach the server: the scanner fails closed.
 *
 * No imports and no DOM, so tests/wire-scan.test.mjs can drive it under `node --test` without a
 * browser. The capture runner (scripts/e2e/run.mjs) is the only caller that needs Chromium.
 */

/** A group id (64 hex) or a member/record id (22 base64url characters), the two id shapes on the wire. */
export const WIRE_ID = /^(?:[A-Za-z0-9_-]{22}|[0-9a-f]{64})$/;
/** The alphabet a sealed value and an id share. */
export const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Every fixed string the protocol carries. A list, not a pattern: a loose shape would also accept
 * a lowercase plaintext name, which is the value this scan exists to refuse.
 *
 * It holds both directions — the frames the page sends and the frames the Worker sends — because
 * the capture records both and neither may carry a readable value.
 */
export const PROTOCOL_STRINGS = Object.freeze(
  new Set([
    /* client → server frame types */
    'auth',
    'put',
    'ping',
    'import-members',
    'leave',
    'end',
    'approve',
    'reject',
    'remove',
    'mode',
    /* server → client frame types */
    'pong',
    'waiting',
    'state',
    'here',
    'record',
    'conflict',
    'refused',
    'import-members-ok',
    'ended',
    'wipe-failed',
    'left',
    'removed',
    /* roles, statuses and modes */
    'host',
    'member',
    'pending',
    'approved',
    'declined',
    'open',
    'approval',
    'join',
    'resume',
    /* the refusal codes a `refused` frame can name */
    'unknown_group',
    'wiping',
    'bad_mode',
    'bad_request',
    'not_member',
    'not_pending',
    'not_host',
    'exists',
    'group_full',
    'unapproved',
    'deleted',
    'too_large',
    'rate_limited',
    'server',
    'blob'
  ])
);

/** Whether `text` is unpadded base64url of a possible byte length. */
export function isBase64Url(text) {
  return (
    typeof text === 'string' &&
    text.length > 0 &&
    text.length % 4 !== 1 &&
    BASE64URL.test(text)
  );
}

/**
 * The bytes a base64url value decodes to, as latin1, or null when it is not base64url.
 *
 * latin1 rather than UTF-8 on purpose: a sentinel is ASCII, and latin1 reads every byte without
 * turning an invalid sequence into U+FFFD and losing the match.
 */
export function decodedBase64Url(text) {
  if (!isBase64Url(text)) return null;
  try {
    return Buffer.from(text, 'base64url').toString('latin1');
  } catch {
    return null;
  }
}

/**
 * What a string leaf is, or `unknown` when it is none of the shapes the protocol allows.
 *
 * @returns {'id'|'enum'|'base64url'|'unknown'}
 */
export function classifyString(value) {
  if (WIRE_ID.test(value)) return 'id';
  if (PROTOCOL_STRINGS.has(value)) return 'enum';
  if (isBase64Url(value)) return 'base64url';
  return 'unknown';
}

/** Whether a leaf is a value the protocol may carry without being readable. */
export function isAllowedLeaf(value) {
  if (value === null) return true;
  if (typeof value === 'number') return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') return classifyString(value) !== 'unknown';
  return false;
}

/**
 * Scan one `{label, value}` sentinel against one string at one path.
 *
 * Two checks: the text as sent, and the bytes it decodes to when it is base64url. A sentinel is a
 * long, unique token, so a chance substring in ciphertext is not a practical concern (and the
 * amount sentinel is nine digits for the same reason).
 */
export function scanString(text, sentinels, path) {
  const violations = [];
  const decoded = decodedBase64Url(text);
  for (const sentinel of sentinels) {
    if (!sentinel || typeof sentinel.value !== 'string' || sentinel.value === '') continue;
    const label = sentinel.label ?? sentinel.value;
    if (text.includes(sentinel.value)) {
      violations.push({ path, reason: `${label} appears in the clear` });
    }
    if (decoded !== null && decoded.includes(sentinel.value)) {
      violations.push({ path, reason: `${label} appears inside a base64url value` });
    }
  }
  return violations;
}

/**
 * Walk a parsed frame or body and return every violation and the number of string leaves seen.
 *
 * The leaf count is what a caller asserts is non-zero: a scan over nothing would pass every
 * sentinel check vacuously, which is the failure this module exists to prevent.
 *
 * @returns {{violations: Array<{path: string, reason: string}>, leaves: number}}
 */
export function scanValue(value, sentinels, path = '$') {
  const violations = [];
  let leaves = 0;

  const visit = (node, at) => {
    if (typeof node === 'string') {
      leaves += 1;
      violations.push(...scanString(node, sentinels, at));
      if (classifyString(node) === 'unknown') {
        violations.push({ path: at, reason: 'unrecognised free-form string' });
      }
      return;
    }
    if (node === null || typeof node === 'number' || typeof node === 'boolean') {
      leaves += 1;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${at}[${index}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) visit(child, `${at}.${key}`);
    }
  };

  visit(value, path);
  return { violations, leaves };
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Scan a whole capture: the WebSocket frames and the HTTP request bodies, both as text.
 *
 * A payload that is not JSON is still scanned as text for the sentinels and counted as one leaf,
 * because a protocol the app did not intend is not a reason to look away.
 *
 * @returns {{frames: number, bodies: number, leaves: number, violations: Array}}
 */
export function scanCapture({ frames = [], bodies = [] } = {}, sentinels) {
  const violations = [];
  let leaves = 0;

  for (let index = 0; index < frames.length; index += 1) {
    const payload = frames[index]?.payload ?? '';
    const parsed = parseJson(payload);
    if (parsed.ok) {
      const result = scanValue(parsed.value, sentinels, `frames[${index}]`);
      leaves += result.leaves;
      violations.push(...result.violations);
    } else {
      leaves += 1;
      violations.push(...scanString(payload, sentinels, `frames[${index}]`));
    }
  }

  for (let index = 0; index < bodies.length; index += 1) {
    const body = bodies[index]?.body ?? '';
    const parsed = parseJson(body);
    if (parsed.ok) {
      const result = scanValue(parsed.value, sentinels, `bodies[${index}]`);
      leaves += result.leaves;
      violations.push(...result.violations);
    } else {
      leaves += 1;
      violations.push(...scanString(body, sentinels, `bodies[${index}]`));
    }
  }

  return { frames: frames.length, bodies: bodies.length, leaves, violations };
}

/** Put one sentinel into a copy of a parsed value, so a caller can prove the scan can fail. */
export function withPlaintext(value, sentinel) {
  const copy = JSON.parse(JSON.stringify(value));
  copy.plaintext = sentinel.value;
  return copy;
}

/** The line the gate prints before it decides: both counts, always. */
export function reportLine(result) {
  return `${result.frames} frames, ${result.bodies} bodies scanned`;
}
