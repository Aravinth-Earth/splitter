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
export const JOIN_LIMIT = 12;
export const JOIN_WINDOW_MS = 5 * 60 * 1000;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    }
  });
}

export class Registry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /* No call is delivered until the table exists. */
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS slots (group_id TEXT PRIMARY KEY)');
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS join_failures (ip TEXT NOT NULL, at INTEGER NOT NULL)'
      );
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

  /** Drop counters outside the window; there is no alarm, so every read and write prunes first. */
  pruneJoinFailures(now) {
    this.ctx.storage.sql.exec('DELETE FROM join_failures WHERE at <= ?', now - JOIN_WINDOW_MS);
  }

  /**
   * Whether this source has already failed to join twelve times in five minutes.
   *
   * The address is Cloudflare's `cf-connecting-ip`, never a field the client sends. Counts are
   * global rather than per group on purpose: a per-group allowance would multiply by the number of
   * live groups.
   *
   * @returns {{blocked: boolean, count: number}}
   */
  joinBlocked(ip, now = Date.now()) {
    this.pruneJoinFailures(now);
    const [{ n }] = this.ctx.storage.sql
      .exec('SELECT COUNT(*) AS n FROM join_failures WHERE ip = ?', ip)
      .toArray();
    return { blocked: n >= JOIN_LIMIT, count: n };
  }

  /** Record one failed join attempt, then prune the window again. */
  noteJoinFailure(ip, now = Date.now()) {
    this.pruneJoinFailures(now);
    this.ctx.storage.sql.exec('INSERT INTO join_failures (ip, at) VALUES (?, ?)', ip, now);
    const [{ n }] = this.ctx.storage.sql
      .exec('SELECT COUNT(*) AS n FROM join_failures WHERE ip = ?', ip)
      .toArray();
    return { count: n };
  }

  async fetch(request) {
    if (request.method !== 'POST') {
      /* RFC 9110: a 405 has to name the methods it does allow. */
      return json({ error: 'method' }, 405, { allow: 'POST' });
    }

    /* Compared whole, never by suffix: `/nope/release` ends in `/release`, and a suffix match would
       drop a slot for a caller that never asked to release one. Every internal call is written in
       this repo, so the set of paths is closed. */
    const { pathname } = new URL(request.url);
    if (!['/reserve', '/release', '/join-blocked', '/join-failure'].includes(pathname)) {
      return json({ error: 'not_found' }, 404);
    }

    const body = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null) return json({ error: 'bad_request' }, 400);

    if (pathname === '/join-blocked' || pathname === '/join-failure') {
      if (typeof body.ip !== 'string' || body.ip === '' || body.ip.length > 64) {
        return json({ error: 'bad_request' }, 400);
      }
      return pathname === '/join-blocked'
        ? json(this.joinBlocked(body.ip))
        : json(this.noteJoinFailure(body.ip));
    }

    if (typeof body.groupId !== 'string') return json({ error: 'bad_request' }, 400);
    if (pathname === '/reserve') return json(this.reserve(body.groupId));

    this.release(body.groupId);
    return json({ ok: true });
  }
}
