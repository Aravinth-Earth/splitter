/**
 * Splitter — the one place an amount is divided.
 *
 * Everything is integer paise. A split never creates or loses a paisa: the floors of the exact
 * shares are taken first, and the remainder is given, one paisa at a time, to the largest exact
 * shares. Equal shares tie, so the tie-break is the member id — the same order on every device.
 *
 * No imports and no build step: this file is served to the browser and imported by its tests.
 */

/**
 * Validate the weights and return the entries that take part.
 *
 * A zero weight is not given a zero share: that person is left out of the split entirely, which is
 * what "a member with 0 % is excluded" means. Negative, non-finite and empty weights are refused
 * rather than guessed at.
 */
function weighted(weights) {
  if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) {
    throw new Error('splitter: weights must be an object of member id to weight');
  }

  const entries = [];
  for (const [id, weight] of Object.entries(weights)) {
    if (typeof id !== 'string' || id === '') {
      throw new Error('splitter: every weight needs a member id');
    }
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new Error(`splitter: the weight for ${id} must be a non-negative number`);
    }
    if (weight > 0) entries.push({ id, weight });
  }

  if (entries.length === 0) {
    throw new Error('splitter: a split needs at least one weight above zero');
  }

  return entries;
}

/** The same weight for each member in a list, refusing a list that names nobody or repeats one. */
function equalWeights(memberIds) {
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    throw new Error('splitter: a split needs at least one member');
  }
  const weights = {};
  for (const id of memberIds) {
    if (typeof id !== 'string' || id === '') {
      throw new Error('splitter: every member needs an id');
    }
    if (Object.hasOwn(weights, id)) {
      throw new Error(`splitter: ${id} appears twice in the split`);
    }
    weights[id] = 1;
  }
  return weights;
}

/**
 * Divide `totalPaise` by `weights`.
 *
 * @param {number} totalPaise A non-negative integer amount in paise.
 * @param {Record<string, number>} weights Member id to a positive weight; zero-weight members are
 *   omitted from the answer.
 * @returns {Record<string, number>} Member id to integer paise; the values sum to `totalPaise`.
 */
export function allocate(totalPaise, weights) {
  if (!Number.isSafeInteger(totalPaise) || totalPaise < 0) {
    throw new Error('splitter: the total must be a non-negative integer number of paise');
  }

  const entries = weighted(weights);
  const weightSum = entries.reduce((sum, entry) => sum + entry.weight, 0);

  const shares = entries.map(({ id, weight }) => {
    const exact = (totalPaise * weight) / weightSum;
    return { id, exact, paise: Math.floor(exact) };
  });

  const remainder = totalPaise - shares.reduce((sum, share) => sum + share.paise, 0);
  const order = [...shares].sort(
    (left, right) =>
      right.exact - left.exact || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );

  /* The remainder is smaller than the number of shares, because every share lost less than one
     paisa to its floor. Giving it to the largest exact shares first keeps equal shares equal and
     makes the result independent of the order the members arrived in. */
  for (let at = 0; at < remainder; at += 1) order[at].paise += 1;

  const result = {};
  for (const share of shares) result[share.id] = share.paise;
  return result;
}

/** Equal shares over every listed member. */
export function equal(totalPaise, memberIds) {
  return allocate(totalPaise, equalWeights(memberIds));
}

/** Equal shares over a chosen subset; the rest are simply not in the weights. */
export function subset(totalPaise, memberIds) {
  return allocate(totalPaise, equalWeights(memberIds));
}

/**
 * Percentages, which must total 100 to one decimal place.
 *
 * A member at 0 % is omitted from the answer rather than listed with zero. The total is rounded to
 * one decimal — the precision the sheet offers — so 99.9 % is refused while 100.0 % passes, which
 * is the refusal the story names.
 */
export function percent(totalPaise, percentages) {
  if (percentages === null || typeof percentages !== 'object' || Array.isArray(percentages)) {
    throw new Error('splitter: percentages must be an object of member id to percent');
  }

  let total = 0;
  for (const [id, value] of Object.entries(percentages)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`splitter: the percentage for ${id} must be a non-negative number`);
    }
    total += value;
  }

  if (Math.round(total * 10) !== 1_000) {
    throw new Error('splitter: percentages must total 100');
  }

  return allocate(totalPaise, percentages);
}

/** Integer shares: ten shares gets ten times what one share gets, under the same remainder rule. */
export function shares(totalPaise, weights) {
  if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) {
    throw new Error('splitter: shares must be an object of member id to a whole number');
  }

  for (const [id, value] of Object.entries(weights)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`splitter: the shares for ${id} must be a non-negative whole number`);
    }
  }

  return allocate(totalPaise, weights);
}

/**
 * Exact amounts, which must already total the expense.
 *
 * A zero amount is a member who is not part of the split and is left out; a total that differs by
 * even one paisa is refused, because the caller is the one who named the amounts.
 */
export function custom(totalPaise, amounts) {
  if (amounts === null || typeof amounts !== 'object' || Array.isArray(amounts)) {
    throw new Error('splitter: custom amounts must be an object of member id to paise');
  }

  let sum = 0;
  for (const [id, value] of Object.entries(amounts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`splitter: the amount for ${id} must be a non-negative whole number of paise`);
    }
    sum += value;
  }

  if (sum !== totalPaise) {
    throw new Error('splitter: custom amounts must total the expense');
  }

  const result = {};
  for (const [id, value] of Object.entries(amounts)) {
    if (value > 0) result[id] = value;
  }
  return result;
}
