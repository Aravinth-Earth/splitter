/**
 * Splitter — merge a peer's saved expense into an edit made from an older revision.
 *
 * A write names the revision it started from. When that base is stale the server returns the stored
 * record instead of overwriting it; this module combines the two by field, so an edit to the
 * description does not undo an edit to the amount made on another phone.
 *
 * The money fields are merged individually, then checked as one record: the shares and payer
 * amounts must still total the amount, because the server cannot read them. A merge that would make
 * the record internally false is reported instead of written.
 *
 * No imports and no DOM: plain ES module, parsed by the page and by its tests.
 */

/** Fields an edit can carry. `kind` is not editable; it comes from the stored record. */
const FIELDS = ['description', 'amountPaise', 'paidBy', 'split', 'date', 'time', 'note'];

/** Structural equality, with object keys compared in a stable order. */
function same(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => same(entry, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (!same(leftKeys, rightKeys)) return false;
    return leftKeys.every((key) => same(left[key], right[key]));
  }
  return false;
}

/**
 * Check that an expense can be stored as written.
 *
 * @returns {null | {reason: 'amount'|'split'|'payers', fields: string[],
 *   amountPaise?: number, totalPaise?: number, detail?: string}}
 */
export function checkExpense(value) {
  const amount = value?.amountPaise;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { reason: 'amount', fields: ['amountPaise'] };
  }

  let splitTotal = 0;
  for (const paise of Object.values(value.split ?? {})) {
    if (!Number.isSafeInteger(paise) || paise < 0) {
      return { reason: 'split', fields: ['amountPaise', 'split'], amountPaise: amount, totalPaise: splitTotal };
    }
    splitTotal += paise;
  }
  if (splitTotal !== amount) {
    return {
      reason: 'split',
      fields: ['amountPaise', 'split'],
      amountPaise: amount,
      totalPaise: splitTotal
    };
  }

  const payers = Array.isArray(value.paidBy)
    ? value.paidBy
    : [{ memberId: value.paidBy, amountPaise: amount }];
  if (payers.length === 0) {
    return { reason: 'payers', fields: ['amountPaise', 'paidBy'], amountPaise: amount, totalPaise: 0 };
  }
  const seen = new Set();
  let paidTotal = 0;
  for (const payer of payers) {
    if (typeof payer?.memberId !== 'string' || payer.memberId === '' || seen.has(payer.memberId)) {
      return { reason: 'payers', fields: ['amountPaise', 'paidBy'], amountPaise: amount, detail: 'member' };
    }
    if (!Number.isSafeInteger(payer.amountPaise) || payer.amountPaise <= 0) {
      return { reason: 'payers', fields: ['amountPaise', 'paidBy'], amountPaise: amount, detail: 'amount' };
    }
    seen.add(payer.memberId);
    paidTotal += payer.amountPaise;
  }
  if (paidTotal !== amount) {
    return {
      reason: 'payers',
      fields: ['amountPaise', 'paidBy'],
      amountPaise: amount,
      totalPaise: paidTotal,
      detail: 'total'
    };
  }

  return null;
}

/**
 * Merge one edit with the record the server actually holds.
 *
 * Every field is compared against `base`, the revision the editor started from. A field only this
 * editor changed is taken from `mine`; a field only the peer changed is taken from `current`; a
 * field both changed is taken from `mine`, because this save is the later one, and is named in
 * `both` so the caller can say it in the toast.
 *
 * @param {object} base the value the editor opened
 * @param {object} mine the value this editor is trying to save
 * @param {object} current the value the server stored after someone else's save
 * @returns {{value: object, mine: string[], theirs: string[], both: string[],
 *   broken: ReturnType<typeof checkExpense>}}
 */
export function mergeDiff(base, mine, current) {
  const value = { kind: current?.kind ?? mine?.kind ?? 'expense' };
  const mineFields = [];
  const theirFields = [];
  const bothFields = [];

  for (const field of FIELDS) {
    const mineChanged = !same(mine?.[field], base?.[field]);
    const theirsChanged = !same(current?.[field], base?.[field]);
    if (mineChanged) {
      value[field] = mine[field];
      if (theirsChanged) bothFields.push(field);
      else mineFields.push(field);
    } else {
      value[field] = current?.[field];
      if (theirsChanged) theirFields.push(field);
    }
  }

  return {
    value,
    mine: mineFields,
    theirs: theirFields,
    both: bothFields,
    broken: checkExpense(value)
  };
}
