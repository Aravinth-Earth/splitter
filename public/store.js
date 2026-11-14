/**
 * Splitter — what this device keeps so a reload can come back to the same seat.
 *
 * Two stores, on purpose:
 *
 * - `localStorage` holds the member's secret and the group id. The secret names the member but
 *   cannot open the group: the server only sees its hash, and the key comes from the code.
 * - `sessionStorage` holds the group code, which is the key. It lasts as long as the tab, so a
 *   reload returns to the seat without putting the decryption key on disk indefinitely.
 *
 * Every read is defensive: a value that is not the shape this module wrote is ignored rather than
 * trusted, and a storage that throws (private mode, a quota, a policy) is treated as empty.
 */

const SESSION_KEY = 'splitter:sessions';
const CODE_KEY = 'splitter:codes';
const LAST_KEY = 'splitter:last';

const GROUP_ID = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{22}$/;
const CODE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

function read(storage, key) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    if (!raw) return {};
    const value = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function write(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isSession(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    GROUP_ID.test(value.groupId) &&
    ID.test(value.memberId) &&
    ID.test(value.memberSecret) &&
    typeof value.displayName === 'string' &&
    value.displayName.length > 0 &&
    value.displayName.length <= 30
  );
}

/** Every stored seat, keyed by group id. Invalid rows are dropped from the answer, not repaired. */
export function sessions(storage) {
  const all = read(storage, SESSION_KEY);
  return Object.fromEntries(Object.entries(all).filter(([, value]) => isSession(value)));
}

export function sessionFor(storage, groupId) {
  if (!GROUP_ID.test(groupId)) return null;
  return sessions(storage)[groupId] ?? null;
}

export function saveSession(storage, session) {
  if (!isSession(session)) return false;
  return write(storage, SESSION_KEY, { ...sessions(storage), [session.groupId]: session });
}

export function forgetSession(storage, groupId) {
  const all = sessions(storage);
  delete all[groupId];
  write(storage, SESSION_KEY, all);
  if (lastGroup(storage) === groupId) {
    try {
      storage?.removeItem(LAST_KEY);
    } catch {
      /* storage unavailable */
    }
  }
}

export function lastGroup(storage) {
  if (!storage) return null;
  try {
    const value = storage.getItem(LAST_KEY);
    return typeof value === 'string' && GROUP_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function setLastGroup(storage, groupId) {
  if (!GROUP_ID.test(groupId) || !storage) return false;
  try {
    storage.setItem(LAST_KEY, groupId);
    return true;
  } catch {
    return false;
  }
}

/** The codes for this tab, keyed by group id. */
export function codes(storage) {
  const all = read(storage, CODE_KEY);
  return Object.fromEntries(
    Object.entries(all).filter(
      ([groupId, code]) => GROUP_ID.test(groupId) && typeof code === 'string' && CODE.test(code)
    )
  );
}

export function codeFor(storage, groupId) {
  if (!GROUP_ID.test(groupId)) return null;
  return codes(storage)[groupId] ?? null;
}

export function saveCode(storage, groupId, code) {
  if (!GROUP_ID.test(groupId) || typeof code !== 'string' || !CODE.test(code)) return false;
  return write(storage, CODE_KEY, { ...codes(storage), [groupId]: code });
}

export function forgetCode(storage, groupId) {
  const all = codes(storage);
  delete all[groupId];
  write(storage, CODE_KEY, all);
}
