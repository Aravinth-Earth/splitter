/**
 * Splitter — the slot ledger.
 *
 * One instance holds every group id that is live, and that is the whole cap: a create asks here
 * first and is refused when the ledger is full. Nothing else about a group is known here — an id
 * is a hash of a code, so the ledger cannot be read into a list of anyone's groups.
 *
 * The one thing it can say about a group is what the group itself answers to `/counters`: a count
 * of records, their size, and two times. That is a walk of the ledger, bounded per request, and it
 * carries no name, amount or code — the group is asked, and it answers only numbers.
 *
 * Reserving is atomic without a transaction: `reserve` reads the row, counts and inserts with
 * synchronous SQL and never awaits between them, and a Durable Object delivers one call at a time,
 * so two concurrent creates cannot both see the last slot free.
 */

export const DEFAULT_MAX_GROUPS = 25;
export const JOIN_LIMIT = 12;
export const JOIN_WINDOW_MS = 5 * 60 * 1000;

/* How many groups one `/list` reads. Every read is a call into another Durable Object, so a page
   costs the same whatever the ledger holds: `next` names the id to continue from, and a ledger
   larger than one page is read over as many requests as it takes. */
export const LIST_PAGE_LIMIT = 10;

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

/**
 * Whether `body` is a counters answer from a group rather than a 200 carrying something else.
 *
 * A group can be missing, evicted or answering an older route, and any of those can produce a
 * status a caller reads as success. The listing must not turn such an answer into "zero records" —
 * so the shape is checked field by field, and anything else is unreadable.
 */
function isCounters(body) {
  if (typeof body !== 'object' || body === null) return false;
  const time = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  return (
    body.ok === true &&
    time(body.createdAt) &&
    time(body.lastWriteAt) &&
    count(body.records) &&
    count(body.bytes)
  );
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
   * How many slots the ledger holds.
   *
   * One statement, used by both the cap check and `/stats`, so the number create refuses on and the
   * number the refusal copy can quote cannot drift apart.
   */
  slotsHeld() {
    const [{ held }] = this.ctx.storage.sql.exec('SELECT COUNT(*) AS held FROM slots').toArray();
    return held;
  }

  /**
   * The cap in force and the slots free, read only.
   *
   * `cap` is `maxGroups()` — the value the create path already compares, so an unusable
   * `MAX_GROUPS` reads as the default here too rather than as a number nobody is enforcing. `free`
   * is floored at zero: lowering the cap under what is already reserved leaves no room, and "-2
   * slots free" would be a number a reader cannot act on.
   *
   * @returns {{cap: number, reserved: number, free: number}}
   */
  stats() {
    const cap = this.maxGroups();
    const reserved = this.slotsHeld();
    return { cap, reserved, free: Math.max(0, cap - reserved) };
  }

  /**
   * One page of the live groups, with the counters each one answers — read only.
   *
   * The walk is `WHERE group_id > ? ORDER BY group_id LIMIT ?`: `cursor` is the last id of the
   * previous page (the empty string for the first one), so a page is decided by the ledger's own
   * order and two callers with the same ledger and the same cursor read the same page. The bound
   * is the SQL's, so no group past it is read at all; one row beyond the page is fetched to decide
   * whether another page exists, and `next` is the id to ask with — `null` on the last page.
   *
   * `total` is the whole ledger rather than the page, which is what lets a caller see that a page
   * is a page and how many more there are.
   *
   * A group that cannot be read is listed as `readable: false` with no counters. It is never
   * answered as a group of zeroes: a slot with nothing behind it is the leak this listing exists
   * to make visible, and a zero would hide it.
   *
   * @returns {Promise<{limit: number, total: number, next: string|null, groups: object[]}>}
   */
  async list(cursor = '') {
    const after = typeof cursor === 'string' ? cursor : '';
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT group_id FROM slots WHERE group_id > ? ORDER BY group_id LIMIT ?',
        after,
        LIST_PAGE_LIMIT + 1
      )
      .toArray();

    const page = rows.slice(0, LIST_PAGE_LIMIT);
    const next = rows.length > LIST_PAGE_LIMIT ? page[page.length - 1].group_id : null;

    const groups = [];
    for (const row of page) {
      const counters = await this.readCounters(row.group_id);
      groups.push(
        counters === null
          ? { id: row.group_id, readable: false }
          : { id: row.group_id, readable: true, ...counters }
      );
    }

    return { limit: LIST_PAGE_LIMIT, total: this.slotsHeld(), next, groups };
  }

  /**
   * Ask one group what it holds, and answer `null` for every way that can fail.
   *
   * A throw, a non-200 and a 200 that is not counters are one answer here on purpose: from the
   * ledger they all mean "this live slot could not be read", and telling them apart in the listing
   * would invite a reader to treat one of them as zero.
   *
   * @returns {Promise<null | {createdAt: number|null, lastWriteAt: number|null, records: number, bytes: number}>}
   */
  async readCounters(groupId) {
    try {
      const response = await this.groupStub(groupId).fetch('https://group/counters', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      if (!response.ok) return null;
      const body = await response.json().catch(() => null);
      if (!isCounters(body)) return null;
      return {
        createdAt: body.createdAt,
        lastWriteAt: body.lastWriteAt,
        records: body.records,
        bytes: body.bytes
      };
    } catch {
      return null;
    }
  }

  /** The group an id names, through the same binding a create writes it through. */
  groupStub(groupId) {
    return this.env.GROUPS.get(this.env.GROUPS.idFromName(groupId));
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
    const held = this.slotsHeld();
    if (held >= this.maxGroups()) return { ok: false, reserved: false };
    sql.exec('INSERT INTO slots (group_id) VALUES (?)', groupId);
    return { ok: true, reserved: true };
  }

  /**
   * Drop a slot: the compensation for a create that reserved and then failed, and the hook destroy
   * and expiry hand a slot back through. A retry never calls it — an id that holds a slot keeps it.
   *
   * Answers the number of rows actually deleted, which is 1 or 0: the read and the delete are both
   * synchronous, so nothing can take the row between them inside one Durable Object. A caller that
   * reported "released" on the call arriving rather than on this number would announce a freed slot
   * whose row is still there.
   *
   * @returns {number}
   */
  release(groupId) {
    const sql = this.ctx.storage.sql;
    if (sql.exec('SELECT 1 FROM slots WHERE group_id = ?', groupId).toArray().length === 0) return 0;
    sql.exec('DELETE FROM slots WHERE group_id = ?', groupId);
    return 1;
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
    if (
      !['/reserve', '/release', '/join-blocked', '/join-failure', '/stats', '/list'].includes(pathname)
    ) {
      return json({ error: 'not_found' }, 404);
    }

    /* `/stats` is read before the body is parsed: it takes no input and writes nothing, so a POST
       with an empty body is not a bad request. `/list` takes an optional cursor — the last id of
       the page before — so it reads its body first: an absent body asks for the first page, and a
       body that is not a JSON object is a bad request, not a page nobody asked for. */
    if (pathname === '/stats') return json(this.stats());

    const raw = await request.text().catch(() => '');
    let body = {};
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: 'bad_request' }, 400);
      }
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return json({ error: 'bad_request' }, 400);
    }

    if (pathname === '/list') {
      const cursor = body.cursor ?? '';
      if (typeof cursor !== 'string') return json({ error: 'bad_request' }, 400);
      return json(await this.list(cursor));
    }

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

    /* `freed` is the number of rows this call deleted, so a caller can tell a slot that came back
       from a release that arrived for a slot nobody was holding. */
    return json({ ok: true, freed: this.release(body.groupId) });
  }
}
