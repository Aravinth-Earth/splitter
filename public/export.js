/**
 * Splitter — the group as one readable JSON file.
 *
 * The file exists so the data survives the server, the trip and the app. It is built only from
 * decrypted values: names, descriptions and integer paise. No code, group id, member id, key,
 * ciphertext or room URL can reach it. Deleted and pending rows never leave the device.
 *
 * No imports and no DOM: plain ES module, parsed by the page and by its tests.
 */

export const SCHEMA = 'splitter.group/1';

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
 * Members are carried as name and status only. The payer and share lists are arrays of
 * `{name, amountPaise}` so two members with the same display name cannot collide.
 *
 * @param {{name: string, currency: string, members: Array<{id: string, name: string, status?: string}>,
 *   records: Array<{deleted?: boolean, pending?: boolean, value?: object}>, exportedAt?: Date}} group
 */
export function exportGroup({ name, currency, members, records, exportedAt = new Date() }) {
  const names = new Map(members.map((member) => [member.id, member.name]));
  const label = (id) => names.get(id) ?? 'Someone';

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
      name: member.name,
      status: member.status ?? 'approved'
    })),
    expenses,
    settlements,
    exportedAt: exportedAt.toISOString()
  };
}
