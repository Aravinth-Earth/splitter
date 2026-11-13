/**
 * Splitter — the slot ledger.
 *
 * One instance holds every group id that is live, and that is the whole cap: a create asks here
 * first and is refused when the ledger is full. Nothing else about a group is known here — an id
 * is a hash of a code, so the ledger cannot be read into a list of anyone's groups.
 *
 * Reserving is atomic without a transaction: `reserve` reads the row, counts and inserts with
 * synchronous SQL and never awaits between them, and a Durable Object delivers one call at a time,
 * so two concurrent creates cannot both see the last slot free.
 */

export const DEFAULT_MAX_GROUPS = 25;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export class Registry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /* No call is delivered until the table exists. */
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS slots (group_id TEXT PRIMARY KEY)');
    });
  }

  /**
   * The cap, from `MAX_GROUPS`.
   *
   * A var arrives as a string, so it is parsed; anything that is not a positive whole number falls
   * back to the default rather than to "no group may be created".
   */
  maxGroups() {
    const configured = Number(this.env?.MAX_GROUPS);
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_GROUPS;
  }

  /**
   * Take a slot for `groupId`, or refuse because the ledger is full.
   *
   * A retry of an id that already holds a slot answers ok and takes nothing: that is what keeps a
   * repeated create from spending a second slot. `reserved` says whether *this* call is the one
   * that must give the slot back if the group cannot be initialised.
   *
   * @returns {{ok: boolean, reserved: boolean}}
   */
  reserve(groupId) {
    const sql = this.ctx.storage.sql;
    if (sql.exec('SELECT 1 FROM slots WHERE group_id = ?', groupId).toArray().length > 0) {
      return { ok: true, reserved: false };
    }
    const [{ held }] = sql.exec('SELECT COUNT(*) AS held FROM slots').toArray();
    if (held >= this.maxGroups()) return { ok: false, reserved: false };
    sql.exec('INSERT INTO slots (group_id) VALUES (?)', groupId);
    return { ok: true, reserved: true };
  }

  /**
   * Drop a slot: the compensation for a create that reserved and then failed, and the hook destroy
   * and expiry hand a slot back through. A retry never calls it — an id that holds a slot keeps it.
   */
  release(groupId) {
    this.ctx.storage.sql.exec('DELETE FROM slots WHERE group_id = ?', groupId);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const body = await request.json().catch(() => null);
    if (!body || typeof body.groupId !== 'string') return json({ error: 'bad_request' }, 400);

    if (path.endsWith('/reserve')) return json(this.reserve(body.groupId));
    if (path.endsWith('/release')) {
      this.release(body.groupId);
      return json({ ok: true });
    }
    return json({ error: 'not_found' }, 404);
  }
}
