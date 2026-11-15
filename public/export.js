/**
 * Splitter — the group as one readable JSON file, and the validator that reads it back.
 *
 * The file exists so the data survives the server, the trip and the app. It is built only from
 * decrypted values: names, descriptions and integer paise. No code, group id, member id, key,
 * ciphertext or room URL can reach it. Deleted and pending rows never leave the device.
 *
 * Reading is hostile by default: the whole file is checked before anything is written, and the
 * first failing field is named. A file that fails changes nothing.
 *
 * The money limits come from the expense model, so a file can never describe an amount the sheet
 * itself would refuse. No DOM: plain ES modules, parsed by the page and by its tests.
 */

import { DESCRIPTION_MAX, MAX_PAISE, NOTE_MAX } from './expense.js';

export const SCHEMA = 'splitter.group/1';

/** The currencies the page can display, and therefore the only ones an export may carry. */
export const CURRENCY_CODES = Object.freeze(['INR', 'EUR', 'USD', 'GBP']);

const MAX_AMOUNT = MAX_PAISE;
const MEMBER_NAME_MAX = 30;
const GROUP_NAME_MAX = 60;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const STATUSES = new Set(['approved', 'pending', 'removed']);

const pad = (value) => String(value).padStart(2, '0');

/** `splitter-2026-11-15-2036.json` — local time, and never the group name in a Downloads list. */
export function exportFileName(at = new Date()) {
  return `splitter-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(
    at.getHours()
  )}${pad(at.getMinutes())}.json`;
}

function payersOf(value) {
  return Array.isArray(value.paidBy)
    ? value.paidBy
    : [{ memberId: value.paidBy, amountPaise: value.amountPaise }];
}

/**
 * Build the file's object.
 *
 * Members are carried as name and status only. Two members may share a display name, so the
 * export suffixes the later ones (`Name (2)`) before using the name in a payer or share row:
 * the file must be readable and unambiguous before it can be imported.
 *
 * @param {{name: string, currency: string, members: Array<{id: string, name: string, status?: string}>,
 *   records: Array<{deleted?: boolean, pending?: boolean, value?: object}>, exportedAt?: Date}} group
 */
export function exportGroup({ name, currency, members, records, exportedAt = new Date() }) {
  const labels = new Map();
  const used = new Set();
  for (const member of members) {
    let label = member.name;
    let suffix = 2;
    while (used.has(label)) {
      label = `${member.name} (${suffix})`;
      suffix += 1;
    }
    used.add(label);
    labels.set(member.id, label);
  }
  const label = (id) => labels.get(id) ?? 'Someone';

  const expenses = [];
  const settlements = [];

  for (const record of records) {
    if (record.deleted || record.pending || !record.value) continue;
    const value = record.value;

    if (value.kind === 'settlement') {
      settlements.push({
        from: label(value.from),
        to: label(value.to),
        amountPaise: value.amountPaise,
        date: value.date,
        time: value.time,
        note: value.note ?? ''
      });
      continue;
    }

    expenses.push({
      description: value.description,
      amountPaise: value.amountPaise,
      paidBy: payersOf(value).map((payer) => ({
        name: label(payer.memberId),
        amountPaise: payer.amountPaise
      })),
      split: Object.entries(value.split ?? {}).map(([id, amountPaise]) => ({
        name: label(id),
        amountPaise
      })),
      date: value.date,
      time: value.time,
      note: value.note ?? ''
    });
  }

  return {
    schema: SCHEMA,
    group: { name, currency },
    members: members.map((member) => ({
      name: label(member.id),
      status: member.status ?? 'approved'
    })),
    expenses,
    settlements,
    exportedAt: exportedAt.toISOString()
  };
}

const bad = (path, rule) => ({
  ok: false,
  message: `The file is not valid: ${path} ${rule}.`
});

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function validMoney(amount) {
  return Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_AMOUNT;
}

function checkRows(rows, amountPaise, memberNames, path) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { error: bad(path, 'must be a non-empty list') };
  }
  const seen = new Set();
  let total = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const at = `${path}[${index}]`;
    if (!isPlainObject(row)) return { error: bad(at, 'must be an object') };
    if (typeof row.name !== 'string' || !memberNames.has(row.name)) {
      return { error: bad(`${at}.name`, 'must match a member name') };
    }
    if (seen.has(row.name)) return { error: bad(`${at}.name`, 'is repeated') };
    if (!validMoney(row.amountPaise)) {
      return { error: bad(`${at}.amountPaise`, 'must be a whole number of paise above zero') };
    }
    seen.add(row.name);
    total += row.amountPaise;
  }
  if (total !== amountPaise) {
    return { error: bad(path, 'must total amountPaise') };
  }
  return { rows };
}

function checkNote(value, path) {
  if (value === undefined) return { note: '' };
  if (typeof value !== 'string' || [...value].length > NOTE_MAX) {
    return { error: bad(path, `must be a string of at most ${NOTE_MAX} characters`) };
  }
  return { note: value };
}

/**
 * Validate a `splitter.group/1` file.
 *
 * Returns the normalised group, or `{ok: false, message}` naming the first field that failed.
 * Nothing here writes; the caller can only act on `ok: true`.
 */
export function importGroup(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The file is not JSON.' };
  }
  if (!isPlainObject(file)) return bad('the file', 'must be a group object');
  if (file.schema !== SCHEMA) {
    return bad('schema', `must be "${SCHEMA}"`);
  }
  if (!isPlainObject(file.group)) return bad('group', 'must be an object');
  if (
    typeof file.group.name !== 'string' ||
    file.group.name.trim() === '' ||
    [...file.group.name].length > GROUP_NAME_MAX
  ) {
    return bad('group.name', `must be text of at most ${GROUP_NAME_MAX} characters`);
  }
  if (!CURRENCY_CODES.includes(file.group.currency)) {
    return bad('group.currency', `must be one of ${CURRENCY_CODES.join(', ')}`);
  }

  if (!Array.isArray(file.members) || file.members.length === 0) {
    return bad('members', 'must be a non-empty list');
  }
  const members = [];
  const names = new Set();
  for (let index = 0; index < file.members.length; index += 1) {
    const member = file.members[index];
    const at = `members[${index}]`;
    if (!isPlainObject(member)) return bad(at, 'must be an object');
    const name = typeof member.name === 'string' ? member.name : '';
    if (name.trim() === '' || [...name].length > MEMBER_NAME_MAX) {
      return bad(`${at}.name`, `must be text of at most ${MEMBER_NAME_MAX} characters`);
    }
    if (names.has(name)) return bad(`${at}.name`, 'is repeated; export suffixes duplicates');
    if (!STATUSES.has(member.status)) {
      return bad(`${at}.status`, 'must be approved, pending or removed');
    }
    names.add(name);
    members.push({ name, status: member.status });
  }

  if (!Array.isArray(file.expenses)) return bad('expenses', 'must be a list');
  const expenses = [];
  for (let index = 0; index < file.expenses.length; index += 1) {
    const expense = file.expenses[index];
    const at = `expenses[${index}]`;
    if (!isPlainObject(expense)) return bad(at, 'must be an object');
    if (
      typeof expense.description !== 'string' ||
      expense.description.trim() === '' ||
      [...expense.description].length > DESCRIPTION_MAX
    ) {
      return bad(`${at}.description`, `must be text of at most ${DESCRIPTION_MAX} characters`);
    }
    if (!validMoney(expense.amountPaise)) {
      return bad(`${at}.amountPaise`, 'must be a whole number of paise above zero');
    }
    const paid = checkRows(expense.paidBy, expense.amountPaise, names, `${at}.paidBy`);
    if (paid.error) return paid.error;
    const split = checkRows(expense.split, expense.amountPaise, names, `${at}.split`);
    if (split.error) return split.error;
    if (typeof expense.date !== 'string' || !DATE.test(expense.date)) {
      return bad(`${at}.date`, 'must be a YYYY-MM-DD date');
    }
    if (typeof expense.time !== 'string' || !TIME.test(expense.time)) {
      return bad(`${at}.time`, 'must be an HH:MM time');
    }
    const note = checkNote(expense.note, `${at}.note`);
    if (note.error) return note.error;
    expenses.push({
      description: expense.description,
      amountPaise: expense.amountPaise,
      paidBy: paid.rows.map((row) => ({ name: row.name, amountPaise: row.amountPaise })),
      split: split.rows.map((row) => ({ name: row.name, amountPaise: row.amountPaise })),
      date: expense.date,
      time: expense.time,
      note: note.note
    });
  }

  if (!Array.isArray(file.settlements)) return bad('settlements', 'must be a list');
  const settlements = [];
  for (let index = 0; index < file.settlements.length; index += 1) {
    const payment = file.settlements[index];
    const at = `settlements[${index}]`;
    if (!isPlainObject(payment)) return bad(at, 'must be an object');
    if (typeof payment.from !== 'string' || !names.has(payment.from)) {
      return bad(`${at}.from`, 'must match a member name');
    }
    if (typeof payment.to !== 'string' || !names.has(payment.to)) {
      return bad(`${at}.to`, 'must match a member name');
    }
    if (payment.from === payment.to) return bad(`${at}.from`, 'must differ from to');
    if (!validMoney(payment.amountPaise)) {
      return bad(`${at}.amountPaise`, 'must be a whole number of paise above zero');
    }
    if (typeof payment.date !== 'string' || !DATE.test(payment.date)) {
      return bad(`${at}.date`, 'must be a YYYY-MM-DD date');
    }
    if (typeof payment.time !== 'string' || !TIME.test(payment.time)) {
      return bad(`${at}.time`, 'must be an HH:MM time');
    }
    const note = checkNote(payment.note, `${at}.note`);
    if (note.error) return note.error;
    settlements.push({
      from: payment.from,
      to: payment.to,
      amountPaise: payment.amountPaise,
      date: payment.date,
      time: payment.time,
      note: note.note
    });
  }

  return {
    ok: true,
    group: { name: file.group.name, currency: file.group.currency },
    members,
    expenses,
    settlements
  };
}
