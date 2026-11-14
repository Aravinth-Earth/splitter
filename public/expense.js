/**
 * Splitter — expense input, money formatting and the split the sheet will save.
 *
 * The preview and the saved record come from the same `splitFor` call, so they cannot drift. All
 * amounts are integer paise; the rupee text is parsed once, here, and never with a float.
 */

import { allocate, custom, equal, percent, shares, subset } from './calc.js';

export const MAX_PAISE = 1_000_000_000; /* ₹1,00,00,000 */
export const DESCRIPTION_MAX = 120;
export const NOTE_MAX = 500;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/**
 * Read an amount of money the way a person types it, into paise.
 *
 * Commas are grouping and carry no value; at most two decimals are accepted; zero and anything
 * above one crore are refused here, before a request can exist.
 *
 * @returns {{ok: true, paise: number} | {ok: false, message: string}}
 */
export function parseAmount(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, message: 'Enter an amount.' };
  }

  const clean = input.replace(/,/g, '').trim();
  const match = clean.match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!match) {
    return { ok: false, message: 'Enter an amount in rupees, with at most two decimals.' };
  }

  const paise = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paise) || paise <= 0) {
    return { ok: false, message: 'The amount must be more than zero.' };
  }
  if (paise > MAX_PAISE) {
    return { ok: false, message: 'The amount can be at most ₹1,00,00,000.' };
  }
  return { ok: true, paise };
}

/**
 * An amount inside an exact split. Empty and zero mean "not part of this split", so this reader
 * allows them; every other rule is the same as the expense amount.
 */
export function parseCustomAmount(input) {
  if (typeof input !== 'string' || input.trim() === '') return { ok: true, paise: 0 };

  const clean = input.replace(/,/g, '').trim();
  const match = clean.match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!match) {
    return { ok: false, message: 'Enter each amount in rupees, with at most two decimals.' };
  }

  const paise = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paise) || paise > MAX_PAISE) {
    return { ok: false, message: 'Each amount must be at most ₹1,00,00,000.' };
  }
  return { ok: true, paise };
}

/** An amount for the screen; the stored value stays in paise. */
export function formatPaise(paise, currency = 'INR') {
  const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'INR';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(paise / 100);
}

/** The associated data that binds a sealed expense to its group and record id. */
export function expenseAad(groupId, id) {
  return `sp1:rec:${groupId}/kind:expense/id:${id}`;
}

/** A description as it will be stored, counted by code point like the group name. */
export function validateDescription(input) {
  if (typeof input !== 'string') return { ok: false, message: 'Enter a description.' };
  const value = input.trim();
  const length = [...value].length;
  if (length === 0) return { ok: false, message: 'Enter a description.' };
  if (length > DESCRIPTION_MAX) {
    return { ok: false, message: `A description can be at most ${DESCRIPTION_MAX} characters.` };
  }
  return { ok: true, value, length };
}

export function validateNote(input) {
  if (typeof input !== 'string') return { ok: true, value: '' };
  const value = input.trim();
  if ([...value].length > NOTE_MAX) {
    return { ok: false, message: `A note can be at most ${NOTE_MAX} characters.` };
  }
  return { ok: true, value };
}

export function validateDate(input) {
  if (typeof input !== 'string' || !DATE.test(input)) {
    return { ok: false, message: 'Choose a date.' };
  }
  return { ok: true, value: input };
}

export function validateTime(input) {
  if (typeof input !== 'string' || !TIME.test(input)) {
    return { ok: false, message: 'Choose a time.' };
  }
  return { ok: true, value: input };
}

/**
 * Percentages that add to exactly 100 by the engine's own remainder rule, in tenths of a point.
 *
 * The default keeps the sheet usable when someone switches to percentages: the sum is always
 * 100.0, so the preview is always a split rather than a refusal.
 */
/** One share each: the sheet's starting point for the shares mode. */
export function defaultShares(memberIds) {
  return Object.fromEntries(memberIds.map((id) => [id, 1]));
}

export function defaultPercentages(memberIds) {
  const tenths = allocate(
    1_000,
    Object.fromEntries(memberIds.map((id) => [id, 1]))
  );
  const percentages = {};
  for (const [id, value] of Object.entries(tenths)) percentages[id] = value / 10;
  return percentages;
}

/**
 * The one map the preview renders and the record stores.
 *
 * @returns {{ok: true, shares: Record<string, number>} | {ok: false, message: string}}
 */
export function splitFor({
  mode,
  amountPaise,
  memberIds = [],
  chosenIds = [],
  percentages = {},
  shareWeights = {},
  amounts = {}
}) {
  try {
    if (mode === 'equal') {
      return { ok: true, shares: equal(amountPaise, memberIds) };
    }
    if (mode === 'chosen') {
      if (chosenIds.length === 0) {
        return { ok: false, message: 'Choose at least one person to share this expense.' };
      }
      return { ok: true, shares: subset(amountPaise, chosenIds) };
    }
    if (mode === 'percent') {
      try {
        return { ok: true, shares: percent(amountPaise, percentages) };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error && /total 100/.test(error.message)
              ? 'Percentages must total 100 %.'
              : 'The percentages could not be used. Check them and try again.'
        };
      }
    }
    if (mode === 'shares') {
      try {
        return { ok: true, shares: shares(amountPaise, shareWeights) };
      } catch {
        return { ok: false, message: 'At least one person needs a share above zero.' };
      }
    }
    if (mode === 'custom') {
      const entries = Object.values(amounts);
      if (entries.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        return { ok: false, message: 'Enter an amount for each person, or leave it empty.' };
      }
      const sum = entries.reduce((total, value) => total + value, 0);
      if (sum !== amountPaise) {
        const delta = sum - amountPaise;
        return {
          ok: false,
          message:
            delta < 0
              ? `Short by ${formatPaise(-delta)}`
              : `Over by ${formatPaise(delta)}`
        };
      }
      try {
        return { ok: true, shares: custom(amountPaise, amounts) };
      } catch {
        return { ok: false, message: 'The amounts could not be used. Check them and try again.' };
      }
    }
    return { ok: false, message: 'Choose how to split this expense.' };
  } catch {
    return { ok: false, message: 'Choose at least one person to share this expense.' };
  }
}
