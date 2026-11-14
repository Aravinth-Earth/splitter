/**
 * Splitter — what each person is owed, and the shortest set of transfers that clears it.
 *
 * Every amount is integer paise. A balance is `paid − owed`: a payer is credited the whole
 * expense, and every share in its split is debited. A recorded payment moves a debtor up and a
 * creditor down by the amount, so the ledger's total is always zero.
 *
 * The transfer minimiser is exact for a roster of at most ten by partitioning the non-zero balances
 * into as many zero-sum groups as possible; above ten, or when the time budget expires, it uses the
 * greedy largest-first match. Both return the same shape, so the screen can say which one it used.
 */

const EXACT_LIMIT = 10;
const DEFAULT_BUDGET_MS = 20;

function entriesOf(balances) {
  if (balances === null || typeof balances !== 'object' || Array.isArray(balances)) {
    throw new Error('splitter: balances must be an object of member id to paise');
  }
  for (const [id, value] of Object.entries(balances)) {
    if (typeof id !== 'string' || id === '') throw new Error('splitter: every balance needs a member id');
    if (!Number.isSafeInteger(value)) {
      throw new Error(`splitter: the balance for ${id} must be a whole number of paise`);
    }
  }
  return Object.entries(balances);
}

/**
 * Paid minus owed for every member, in paise.
 *
 * A member in the roster with no expenses is present with zero. A payer or share id that is not in
 * the roster (a removed member whose past entries stay) is added rather than dropped, because
 * dropping it would make the total non-zero.
 *
 * @param {string[]} members
 * @param {Array<{id: string, amountPaise: number, paidBy: string, split: Record<string, number>}>} expenses
 * @param {Array<{from: string, to: string, amountPaise: number}>} settlements Payments that happened.
 * @returns {Record<string, number>}
 */
export function balances(members, expenses = [], settlements = []) {
  if (!Array.isArray(members)) throw new Error('splitter: members must be a list');

  const result = Object.fromEntries(members.map((id) => [id, 0]));
  const add = (id, delta) => {
    if (typeof id !== 'string' || id === '') throw new Error('splitter: a balance needs a member id');
    result[id] = (result[id] ?? 0) + delta;
  };

  for (const expense of expenses) {
    if (!Number.isSafeInteger(expense.amountPaise) || expense.amountPaise <= 0) {
      throw new Error('splitter: an expense must be a positive whole number of paise');
    }
    if (typeof expense.paidBy !== 'string' || expense.paidBy === '') {
      throw new Error('splitter: an expense needs a payer');
    }

    add(expense.paidBy, expense.amountPaise);
    let shared = 0;
    for (const [id, paise] of Object.entries(expense.split ?? {})) {
      if (!Number.isSafeInteger(paise) || paise < 0) {
        throw new Error(`splitter: the share for ${id} must be a non-negative whole number of paise`);
      }
      add(id, -paise);
      shared += paise;
    }
    if (shared !== expense.amountPaise) {
      throw new Error('splitter: an expense split must total its amount');
    }
  }

  for (const payment of settlements) {
    if (!Number.isSafeInteger(payment.amountPaise) || payment.amountPaise <= 0) {
      throw new Error('splitter: a settlement must be a positive whole number of paise');
    }
    add(payment.from, payment.amountPaise);
    add(payment.to, -payment.amountPaise);
  }

  const total = Object.values(result).reduce((sum, paise) => sum + paise, 0);
  if (total !== 0) throw new Error('splitter: balances must total zero');
  return result;
}

/**
 * The greedy largest-first match: always progress, not always the fewest transfers.
 *
 * @returns {Array<{from: string, to: string, amountPaise: number}>}
 */
export function greedySettle(balancesMap) {
  const entries = entriesOf(balancesMap);
  const debtors = entries
    .filter(([, paise]) => paise < 0)
    .map(([id, paise]) => ({ id, amount: -paise }))
    .sort((left, right) => right.amount - left.amount || (left.id < right.id ? -1 : 1));
  const creditors = entries
    .filter(([, paise]) => paise > 0)
    .map(([id, paise]) => ({ id, amount: paise }))
    .sort((left, right) => right.amount - left.amount || (left.id < right.id ? -1 : 1));

  const transfers = [];
  let debtor = 0;
  let creditor = 0;
  while (debtor < debtors.length && creditor < creditors.length) {
    const amount = Math.min(debtors[debtor].amount, creditors[creditor].amount);
    if (amount > 0) {
      transfers.push({ from: debtors[debtor].id, to: creditors[creditor].id, amountPaise: amount });
      debtors[debtor].amount -= amount;
      creditors[creditor].amount -= amount;
    }
    if (debtors[debtor].amount === 0) debtor += 1;
    if (creditors[creditor].amount === 0) creditor += 1;
  }
  return transfers;
}

/**
 * The exact search: partition the non-zero balances into as many zero-sum groups as possible.
 *
 * A group of k people is cleared in k−1 transfers, so more groups means fewer transfers. The DP is
 * over subsets; the deadline is checked between masks, not inside one.
 *
 * @returns {{transfers: Array<{from: string, to: string, amountPaise: number}>, exact: boolean}}
 */
export function exactSettle(balancesMap, { timeLimitMs = DEFAULT_BUDGET_MS, now = Date.now } = {}) {
  const entries = entriesOf(balancesMap).filter(([, paise]) => paise !== 0);
  if (entries.length === 0) return { transfers: [], exact: true };

  const start = now();
  const ids = entries.map(([id]) => id);
  const values = entries.map(([, paise]) => paise);
  const count = values.length;
  const size = 1 << count;

  const sums = new Array(size).fill(0);
  for (let mask = 1; mask < size; mask += 1) {
    const low = mask & -mask;
    const index = 31 - Math.clz32(low);
    sums[mask] = sums[mask ^ low] + values[index];
  }

  const groups = new Array(size).fill(-1);
  groups[0] = 0;

  for (let mask = 1; mask < size; mask += 1) {
    if (now() - start > timeLimitMs) {
      return { transfers: greedySettle(balancesMap), exact: false };
    }
    const low = mask & -mask;
    for (let sub = mask; sub > 0; sub = (sub - 1) & mask) {
      if ((sub & low) === 0 || sums[sub] !== 0) continue;
      const rest = groups[mask ^ sub];
      if (rest >= 0) groups[mask] = Math.max(groups[mask], rest + 1);
    }
  }

  const transfers = [];
  let remaining = size - 1;
  while (remaining > 0) {
    if (now() - start > timeLimitMs) {
      return { transfers: greedySettle(balancesMap), exact: false };
    }
    const low = remaining & -remaining;
    let chosen = -1;
    for (let sub = remaining; sub > 0; sub = (sub - 1) & remaining) {
      if ((sub & low) === 0 || sums[sub] !== 0) continue;
      if (groups[remaining ^ sub] < 0) continue;
      if (chosen < 0 || groups[remaining ^ sub] > groups[remaining ^ chosen]) chosen = sub;
    }
    if (chosen < 0) return { transfers: greedySettle(balancesMap), exact: false };

    const groupBalances = {};
    for (let index = 0; index < count; index += 1) {
      if (chosen & (1 << index)) groupBalances[ids[index]] = values[index];
    }
    transfers.push(...greedySettle(groupBalances));
    remaining ^= chosen;
  }

  return { transfers, exact: true };
}

/**
 * The proposal a screen renders.
 *
 * The exact search is used only when the roster is at most ten people; above that the copy says a
 * short settle-up, not the shortest. Every transfer settles a part of one debtor's balance against
 * one creditor's, so applying all of them leaves every balance at exactly zero.
 *
 * @returns {{transfers: Array<{from: string, to: string, amountPaise: number}>, exact: boolean}}
 */
export function settle(balancesMap, options = {}) {
  const entries = entriesOf(balancesMap);
  const total = entries.reduce((sum, [, paise]) => sum + paise, 0);
  if (total !== 0) throw new Error('splitter: balances must total zero');

  if (entries.every(([, paise]) => paise === 0)) return { transfers: [], exact: true };
  if (entries.length > EXACT_LIMIT) {
    return { transfers: greedySettle(balancesMap), exact: false };
  }
  return exactSettle(balancesMap, options);
}


/**
 * The negative side of every member's ledger: the shares and received settlements that make them
 * owe. Only those are needed to explain a transfer; the credits (paid expenses, settlements they
 * made) are what brought the net down, not what a transfer settles.
 *
 * Each row carries the record id and the kind, so the screen can name the expense or payment.
 *
 * @returns {Record<string, Array<{recordId: string, kind: 'expense'|'settlement', amountPaise: number}>>}
 */
export function ledgerContributions(members, expenses = [], settlements = []) {
  if (!Array.isArray(members)) throw new Error('splitter: members must be a list');
  const result = Object.fromEntries(members.map((id) => [id, []]));
  const add = (id, row) => {
    if (row.amountPaise <= 0) return;
    if (!result[id]) result[id] = [];
    result[id].push(row);
  };

  for (const expense of expenses) {
    if (!Number.isSafeInteger(expense.amountPaise) || expense.amountPaise <= 0) {
      throw new Error('splitter: an expense must be a positive whole number of paise');
    }
    if (typeof expense.id !== 'string' || expense.id === '') {
      throw new Error('splitter: an expense needs an id');
    }
    let shared = 0;
    for (const [id, paise] of Object.entries(expense.split ?? {})) {
      if (!Number.isSafeInteger(paise) || paise < 0) {
        throw new Error(`splitter: the share for ${id} must be a non-negative whole number of paise`);
      }
      add(id, { recordId: expense.id, kind: 'expense', amountPaise: paise });
      shared += paise;
    }
    if (shared !== expense.amountPaise) {
      throw new Error('splitter: an expense split must total its amount');
    }
  }

  for (const payment of settlements) {
    if (!Number.isSafeInteger(payment.amountPaise) || payment.amountPaise <= 0) {
      throw new Error('splitter: a settlement must be a positive whole number of paise');
    }
    if (typeof payment.id !== 'string' || payment.id === '') {
      throw new Error('splitter: a settlement needs an id');
    }
    add(payment.to, { recordId: payment.id, kind: 'settlement', amountPaise: payment.amountPaise });
  }

  for (const rows of Object.values(result)) {
    rows.sort(
      (left, right) =>
        (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0) ||
        (left.kind < right.kind ? -1 : 1)
    );
  }
  return result;
}

/**
 * Attach the source rows to each transfer.
 *
 * Attribution walks the debtor's negative rows in record order, taking as much of each as the
 * transfer needs. The sum of every `via` amount equals the transfer exactly; the grouper decides
 * the legs, and this decides only how to explain them.
 *
 * @returns {Array<{from: string, to: string, amountPaise: number,
 *   via: Array<{recordId: string, kind: string, amountPaise: number}>}>}
 */
export function attribute(transfers, contributions) {
  const remaining = new Map();
  for (const [id, rows] of Object.entries(contributions)) {
    remaining.set(id, rows.map((row) => ({ ...row })));
  }

  return transfers.map((transfer) => {
    const rows = remaining.get(transfer.from) ?? [];
    let need = transfer.amountPaise;
    const via = [];
    while (need > 0 && rows.length > 0) {
      const row = rows[0];
      const take = Math.min(need, row.amountPaise);
      via.push({ recordId: row.recordId, kind: row.kind, amountPaise: take });
      row.amountPaise -= take;
      need -= take;
      if (row.amountPaise === 0) rows.shift();
    }
    if (need !== 0) throw new Error('splitter: a transfer exceeds the debt it explains');
    return { ...transfer, via };
  });
}
