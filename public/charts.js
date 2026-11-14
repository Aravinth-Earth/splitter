/**
 * Splitter — who paid and who consumed, as local SVG bars.
 *
 * No chart library and no canvas: one `<svg>` with a horizontal bar per member, a value as text,
 * and a visually hidden table repeating the same numbers for assistive technology. The data is
 * computed from the same decrypted expenses the ledger renders, so a chart cannot disagree with it.
 */

/**
 * Gross paid and gross incurred per member, in paise.
 *
 * Paid is every payer's own amount (multi-payer included); incurred is every split share. A member
 * in the roster with no expenses stays in both maps at zero.
 *
 * @returns {{paid: Record<string, number>, incurred: Record<string, number>}}
 */
export function totals(members, expenses = []) {
  const paid = Object.fromEntries(members.map((id) => [id, 0]));
  const incurred = Object.fromEntries(members.map((id) => [id, 0]));
  const ensure = (map, id) => {
    if (!(id in map)) map[id] = 0;
  };

  for (const expense of expenses) {
    const payers = Array.isArray(expense.paidBy)
      ? expense.paidBy
      : [{ memberId: expense.paidBy, amountPaise: expense.amountPaise }];
    for (const payer of payers) {
      ensure(paid, payer.memberId);
      paid[payer.memberId] += payer.amountPaise;
    }

    let shared = 0;
    for (const [id, paise] of Object.entries(expense.split ?? {})) {
      ensure(incurred, id);
      incurred[id] += paise;
      shared += paise;
    }
    if (shared !== expense.amountPaise) {
      throw new Error('splitter: an expense split must total its amount');
    }
  }

  return { paid, incurred };
}

/**
 * Rows sorted by value, with a width ratio against the largest bar.
 *
 * A zero or negative value keeps its row at zero and gets no bar, rather than a bar in the other
 * direction. The totals are gross amounts, so a negative one is a malformed number, not a debit.
 *
 * @returns {{max: number, rows: Array<{id: string, value: number, ratio: number}>}}
 */
export function barRows(values) {
  const entries = Object.entries(values).map(([id, value]) => ({
    id,
    value: Number.isSafeInteger(value) && value > 0 ? value : 0
  }));
  const max = Math.max(0, ...entries.map((entry) => entry.value));
  entries.sort(
    (left, right) =>
      right.value - left.value || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
  return {
    max,
    rows: entries.map((entry) => ({
      ...entry,
      ratio: max > 0 && entry.value > 0 ? entry.value / max : 0
    }))
  };
}

const SVG = 'http:' + '//www.w3.org/2000/svg';

/**
 * Draw one chart into `container`: the SVG plus the table behind it.
 *
 * The SVG is focusable as a whole and each bar has its own focus stop and title, so a keyboard or
 * screen-reader user reaches every value. The visible label is shortened; the title and the table
 * keep the full name.
 */
export function renderChart(
  container,
  values,
  { doc = document, names = {}, title = 'Chart', format = (paise) => String(paise) } = {}
) {
  container.textContent = '';
  const { rows } = barRows(values);
  const rowHeight = 18;
  const width = 360;
  const height = Math.max(rowHeight, rows.length * rowHeight) + 8;

  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'bar-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', title);
  svg.setAttribute('tabindex', '0');

  const desc = doc.createElementNS(SVG, 'title');
  desc.textContent = title;
  svg.append(desc);

  rows.forEach((row, index) => {
    const name = names[row.id] || 'Someone';
    const y = index * rowHeight + 4;
    const group = doc.createElementNS(SVG, 'g');
    group.setAttribute('tabindex', '0');
    group.setAttribute('aria-label', `${name}: ${format(row.value)}`);

    const label = doc.createElementNS(SVG, 'text');
    label.setAttribute('x', '0');
    label.setAttribute('y', String(y + 9));
    label.setAttribute('class', 'bar-label');
    label.textContent = name.length > 16 ? `${name.slice(0, 15)}…` : name;

    const bar = doc.createElementNS(SVG, 'rect');
    bar.setAttribute('x', '96');
    bar.setAttribute('y', String(y + 1));
    bar.setAttribute('width', String(Math.round(row.ratio * 180)));
    bar.setAttribute('height', '10');
    bar.setAttribute('rx', '2');
    bar.setAttribute('class', 'bar-fill');

    const value = doc.createElementNS(SVG, 'text');
    value.setAttribute('x', '282');
    value.setAttribute('y', String(y + 9));
    value.setAttribute('class', 'bar-value');
    value.textContent = format(row.value);

    const full = doc.createElementNS(SVG, 'title');
    full.textContent = `${name}: ${format(row.value)}`;

    group.append(full, label, bar, value);
    svg.append(group);
  });

  container.append(svg);

  const table = doc.createElement('table');
  table.className = 'visually-hidden';
  const caption = doc.createElement('caption');
  caption.textContent = title;
  table.append(caption);
  const body = doc.createElement('tbody');
  for (const row of rows) {
    const tr = doc.createElement('tr');
    const who = doc.createElement('th');
    who.scope = 'row';
    who.textContent = names[row.id] || 'Someone';
    const amount = doc.createElement('td');
    amount.textContent = format(row.value);
    tr.append(who, amount);
    body.append(tr);
  }
  table.append(body);
  container.append(table);

  return svg;
}
