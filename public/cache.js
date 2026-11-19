/**
 * Splitter — what this device keeps so a reload cannot lose the trip.
 *
 * Two records, both keyed by group and versioned:
 *
 * - the outbox: sealed `put` frames waiting for a socket, in local order, with the id minted before
 *   the first send so a replay is the same write;
 * - the last state: the sealed records the server sent, so a cold load can draw the ledger before
 *   the network answers. One row per group under its own key, so a save never rewrites another
 *   group's records; the single `splitter:cache` blob an older version wrote is still read.
 *
 * Neither holds a group code, a key or a readable value. A storage that throws or is full returns
 * false from saves; the page keeps working online and says what it cannot keep.
 *
 * No imports: plain ES module, parsed by the page and by its tests.
 */

export const CACHE_SCHEMA = 1;

const OUTBOX_KEY = 'splitter:outbox';
const STATE_KEY = 'splitter:cache';
const GROUP_ID = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_QUEUE = 500;

/** One state row per group, so a save never rewrites a blob that holds other groups' records. */
const stateKey = (groupId) => `${STATE_KEY}:${groupId}`;

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

function remove(storage, key) {
  if (!storage || typeof storage.removeItem !== 'function') return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function isSealed(blob) {
  return (
    blob !== null &&
    typeof blob === 'object' &&
    !Array.isArray(blob) &&
    typeof blob.iv === 'string' &&
    typeof blob.ct === 'string'
  );
}

function isFrame(frame) {
  return (
    frame !== null &&
    typeof frame === 'object' &&
    frame.t === 'put' &&
    typeof frame.id === 'string' &&
    ID.test(frame.id) &&
    Number.isSafeInteger(frame.base) &&
    frame.base >= 0 &&
    typeof frame.deleted === 'boolean' &&
    (frame.deleted ? frame.blob === null || frame.blob === undefined || isSealed(frame.blob) : isSealed(frame.blob))
  );
}

function isRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.id === 'string' &&
    ID.test(record.id) &&
    Number.isSafeInteger(record.rev) &&
    record.rev >= 0 &&
    typeof record.deleted === 'boolean' &&
    (record.deleted ? record.blob === null : isSealed(record.blob))
  );
}

/** The sealed writes waiting for a socket, in the order this device made them. */
export function outboxFor(storage, groupId) {
  if (!GROUP_ID.test(groupId)) return [];
  const all = read(storage, OUTBOX_KEY);
  const row = all[groupId];
  if (!row || row.schema !== CACHE_SCHEMA || !Array.isArray(row.items)) return [];
  return row.items
    .filter((entry) => entry && typeof entry === 'object' && isFrame(entry.frame) && entry.frame.id === entry.id)
    .slice(0, MAX_QUEUE)
    .map((entry) => ({
      id: entry.id,
      frame: entry.frame,
      baseBlob: isSealed(entry.baseBlob) ? entry.baseBlob : null
    }));
}

/** Replace a group's outbox. False means this storage cannot keep it; the caller stays online. */
export function saveOutbox(storage, groupId, entries) {
  if (!GROUP_ID.test(groupId) || !Array.isArray(entries)) return false;
  const items = entries
    .filter((entry) => entry && typeof entry === 'object' && isFrame(entry.frame) && entry.frame.id === entry.id)
    .slice(0, MAX_QUEUE)
    .map((entry) => ({
      id: entry.id,
      frame: entry.frame,
      baseBlob: isSealed(entry.baseBlob) ? entry.baseBlob : null
    }));
  return write(storage, OUTBOX_KEY, {
    ...read(storage, OUTBOX_KEY),
    [groupId]: { schema: CACHE_SCHEMA, savedAt: Date.now(), items }
  });
}

function isRosterEntry(member) {
  return (
    member !== null &&
    typeof member === 'object' &&
    typeof member.id === 'string' &&
    ID.test(member.id) &&
    (member.status === 'pending' ||
      member.status === 'approved' ||
      member.status === 'removed' ||
      member.status === 'left') &&
    isSealed(member.nameBlob)
  );
}

/**
 * The parsed state rows this tab already has, per storage.
 *
 * A save writes only its own group's key, so no read of the other groups happens and none of them
 * can be dropped by a stale copy; the memo means the second read of a row costs no parse. A row
 * another tab wrote is not seen here until a reload, which is the same staleness the one shared
 * blob had.
 */
const rowsByStorage = new WeakMap();

function rowsFor(storage) {
  let rows = rowsByStorage.get(storage);
  if (!rows) {
    rows = new Map();
    rowsByStorage.set(storage, rows);
  }
  return rows;
}

/** One group's stored row: its own key first, the pre-split `splitter:cache` blob second. */
function rowFor(storage, groupId) {
  if (!storage) return null;
  const rows = rowsFor(storage);
  if (rows.has(groupId)) return rows.get(groupId);
  const row = read(storage, stateKey(groupId))[groupId] ?? read(storage, STATE_KEY)[groupId] ?? null;
  rows.set(groupId, row);
  return row;
}

/**
 * The last state seen for a group: sealed metadata, roster and records only.
 *
 * Nothing here can draw a decrypted row until the group code is present, which lives in
 * sessionStorage and therefore only for this tab.
 */
export function cacheFor(storage, groupId) {
  if (!GROUP_ID.test(groupId)) return null;
  const row = rowFor(storage, groupId);
  if (
    !row ||
    row.schema !== CACHE_SCHEMA ||
    !isSealed(row.nameBlob) ||
    (row.metaBlob !== null && !isSealed(row.metaBlob)) ||
    typeof row.hostId !== 'string' ||
    !ID.test(row.hostId) ||
    typeof row.memberId !== 'string' ||
    !ID.test(row.memberId) ||
    (row.role !== 'host' && row.role !== 'member') ||
    (row.joinMode !== 'open' && row.joinMode !== 'approval') ||
    !Array.isArray(row.roster) ||
    !Array.isArray(row.records)
  ) {
    return null;
  }
  return {
    schema: row.schema,
    savedAt: Number.isSafeInteger(row.savedAt) ? row.savedAt : 0,
    nameBlob: row.nameBlob,
    metaBlob: row.metaBlob,
    hostId: row.hostId,
    memberId: row.memberId,
    role: row.role,
    joinMode: row.joinMode,
    roster: row.roster.filter(isRosterEntry).map((member) => ({
      ...member,
      participant: member.participant === true
    })),
    records: row.records.filter(isRecord).map((record) => ({ ...record }))
  };
}

export function saveCache(storage, groupId, state, savedAt = Date.now()) {
  if (
    !GROUP_ID.test(groupId) ||
    !state ||
    typeof state !== 'object' ||
    !isSealed(state.nameBlob) ||
    (state.metaBlob !== null && state.metaBlob !== undefined && !isSealed(state.metaBlob)) ||
    typeof state.hostId !== 'string' ||
    !ID.test(state.hostId) ||
    typeof state.memberId !== 'string' ||
    !ID.test(state.memberId) ||
    (state.role !== 'host' && state.role !== 'member') ||
    (state.joinMode !== 'open' && state.joinMode !== 'approval') ||
    !Array.isArray(state.roster) ||
    !Array.isArray(state.records)
  ) {
    return false;
  }
  const row = {
    schema: CACHE_SCHEMA,
    savedAt,
    nameBlob: state.nameBlob,
    metaBlob: state.metaBlob ?? null,
    hostId: state.hostId,
    memberId: state.memberId,
    role: state.role,
    joinMode: state.joinMode,
    roster: state.roster.filter(isRosterEntry).map((member) => ({
      ...member,
      participant: member.participant === true
    })),
    records: state.records.filter(isRecord).map((record) => ({ ...record }))
  };
  if (!write(storage, stateKey(groupId), { [groupId]: row })) return false;
  rowsFor(storage).set(groupId, row);
  return true;
}


/** Drop one group's outbox and state: leaving or ending must not leave a readable copy behind. */
export function forgetGroupCache(storage, groupId) {
  if (!GROUP_ID.test(groupId)) return false;
  const outbox = read(storage, OUTBOX_KEY);
  const cache = read(storage, STATE_KEY);
  delete outbox[groupId];
  delete cache[groupId];
  const savedOutbox = write(storage, OUTBOX_KEY, outbox);
  const savedCache = write(storage, STATE_KEY, cache);
  const savedRow = remove(storage, stateKey(groupId));
  if (storage) rowsFor(storage).delete(groupId);
  return savedOutbox && savedCache && savedRow;
}
