/**
 * The slot ledger, without a network.
 *
 * The cap and the retry behaviour are proven end to end in create.test.mjs; this file proves the
 * other half of the ledger — that giving a slot back frees exactly one, and that a cap of nothing
 * usable falls back to the documented default rather than to zero groups.
 *
 * `ctx.storage.sql` is replaced by a five-statement stand-in. It throws on any SQL it does not
 * know, so a query the fake has not been taught cannot pass silently.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Group, GROUP_KEY } from '../src/group.js';

import {
  DEFAULT_MAX_GROUPS,
  JOIN_LIMIT,
  JOIN_WINDOW_MS,
  LIST_PAGE_LIMIT,
  Registry
} from '../src/registry.js';

/** A Registry ctx backed by one Map, plus the three statements reserve and release use. */
function fakeContext() {
  const rows = new Map();
  const joinRows = [];

  function exec(statement, ...params) {
    const text = statement.replace(/\s+/g, ' ').trim();
    if (text.startsWith('CREATE TABLE IF NOT EXISTS slots')) return { toArray: () => [] };
    if (text.startsWith('CREATE TABLE IF NOT EXISTS join_failures')) return { toArray: () => [] };
    if (text.startsWith('SELECT 1 FROM slots')) return { toArray: () => (rows.has(params[0]) ? [{}] : []) };
    if (text.startsWith('SELECT COUNT(*) AS held FROM slots')) return { toArray: () => [{ held: rows.size }] };
    /* The listing's walk: the cursor as `group_id > ?`, the page bound as a second parameter, so
       the fake answers exactly what the query asks for — a listing that ignored its bound or its
       cursor would be handed the wrong page here and fail the bound and cursor tests. One row past
       the page is what the real query fetches to know whether another page exists, so the fake
       answers that too: `slice(0, bound)` over the whole order, not `slice(from, from + bound)`. */
    if (text.startsWith('SELECT group_id FROM slots WHERE group_id > ? ORDER BY group_id LIMIT ?')) {
      const after = [...rows.keys()]
        .filter((group_id) => group_id > params[0])
        .sort()
        .slice(0, params[1]);
      return { toArray: () => after.map((group_id) => ({ group_id })) };
    }
    if (text.startsWith('INSERT INTO slots')) {
      rows.set(params[0], true);
      return { toArray: () => [] };
    }
    if (text.startsWith('DELETE FROM slots')) {
      rows.delete(params[0]);
      return { toArray: () => [] };
    }
    if (text.startsWith('DELETE FROM join_failures')) {
      for (let at = joinRows.length - 1; at >= 0; at -= 1) {
        if (joinRows[at].at <= params[0]) joinRows.splice(at, 1);
      }
      return { toArray: () => [] };
    }
    if (text.startsWith('INSERT INTO join_failures')) {
      joinRows.push({ ip: params[0], at: params[1] });
      return { toArray: () => [] };
    }
    if (text.startsWith('SELECT COUNT(*) AS n FROM join_failures')) {
      return { toArray: () => [{ n: joinRows.filter((row) => row.ip === params[0]).length }] };
    }
    throw new Error(`fake sql: ${text}`);
  }

  return {
    rows,
    joinRows,
    ctx: { storage: { sql: { exec } }, blockConcurrencyWhile: (fn) => fn() }
  };
}

const id = (n) => `${String(n).padStart(22, '0')}`;

test('registry: a repeated reserve takes one slot, and the cap refuses the next', () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });
  assert.equal(registry.maxGroups(), 2, 'the cap comes from the environment');

  assert.deepEqual(registry.reserve(id(1)), { ok: true, reserved: true });
  assert.deepEqual(registry.reserve(id(1)), { ok: true, reserved: false }, 'a retry must not take a second slot');
  assert.deepEqual(registry.reserve(id(2)), { ok: true, reserved: true });
  assert.deepEqual(registry.reserve(id(3)), { ok: false, reserved: false });

  assert.equal(rows.size, 2, 'two ids hold two slots, whatever the retries');
});

test('registry: releasing a slot frees exactly one and lets the next create in', () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });
  registry.reserve(id(1));
  registry.reserve(id(2));

  registry.release(id(1));
  assert.equal(rows.size, 1);
  assert.equal(rows.has(id(2)), true, 'releasing one id must not touch another');

  assert.deepEqual(registry.reserve(id(3)), { ok: true, reserved: true });
  assert.deepEqual(registry.reserve(id(4)), { ok: false, reserved: false });

  /* Releasing an id that holds nothing changes nothing. */
  registry.release(id(9));
  assert.equal(rows.size, 2);
});

test('registry: an unusable cap falls back to the default, never to zero', () => {
  const cases = [undefined, '', '0', '-4', 'many', '2.5'];
  for (const value of cases) {
    const { ctx } = fakeContext();
    const registry = new Registry(ctx, value === undefined ? {} : { MAX_GROUPS: value });
    assert.equal(registry.maxGroups(), DEFAULT_MAX_GROUPS, `MAX_GROUPS=${String(value)}`);
  }
  assert.equal(DEFAULT_MAX_GROUPS, 25);
});

/* --------------------------------------------------------- the paths the ledger serves */

/** A request the Worker itself makes to the ledger: JSON, POST, to `path`. */
function post(registry, payload, { path, method = 'POST' } = {}) {
  return registry.fetch(
    new Request(`https://registry${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(payload)
    })
  );
}

/** A read of the ledger: GET with no body, which is the only route that takes one. */
function get(registry, path) {
  return registry.fetch(new Request(`https://registry${path}`));
}

test('registry: /reserve and /release are routed whole, so a suffix is not a route', async () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });

  const reserved = await post(registry, { groupId: id(1) }, { path: '/reserve' });
  assert.equal(reserved.status, 200);
  assert.deepEqual(await reserved.json(), { ok: true, reserved: true });
  assert.equal(rows.has(id(1)), true);

  /* `POST /nope/release` ends in `/release`. A suffix match dropped the slot for a caller whose
     intent was some other route; the whole-pathname comparison answers 404 and touches nothing. */
  const unrouted = await post(registry, { groupId: id(1) }, { path: '/nope/release' });
  assert.equal(unrouted.status, 404, 'POST /nope/release must not release a slot');
  assert.deepEqual(await unrouted.json(), { error: 'not_found' });
  assert.equal(rows.has(id(1)), true, 'an unrouted path must leave the ledger untouched');

  /* The same shape on the other write route: `/nope/reserve` ends in `/reserve`, and a suffix match
     took a slot for a caller that never asked for one. It is a 404, and no row is written. */
  const unroutedReserve = await post(registry, { groupId: id(2) }, { path: '/nope/reserve' });
  assert.equal(unroutedReserve.status, 404, 'POST /nope/reserve must not take a slot');
  assert.deepEqual(await unroutedReserve.json(), { error: 'not_found' });
  assert.equal(rows.has(id(2)), false, 'an unrouted path must reserve nothing');
  assert.equal(rows.size, 1, 'the one slot held is still the only one');

  const released = await post(registry, { groupId: id(1) }, { path: '/release' });
  assert.equal(released.status, 200);
  assert.deepEqual(await released.json(), { ok: true, freed: 1 }, 'the answer counts the row it deleted');
  assert.equal(rows.has(id(1)), false, '/release must drop the slot');
});

test('registry: /release reports the rows it deleted, so a release for no slot is not a freeing', async () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '3' });
  registry.reserve(id(1));
  registry.reserve(id(2));

  const released = await post(registry, { groupId: id(1) }, { path: '/release' });
  assert.deepEqual(await released.json(), { ok: true, freed: 1 }, 'one held slot is one row freed');
  assert.equal(rows.has(id(2)), true, 'the other slot is untouched');

  /* The state a wipe that succeeded followed by a failed release leaves behind: a retry arrives
     for a slot nobody holds. It is not an error — the ledger has nothing to drop — but it must not
     read as a freed slot, because that count is what the group reports as `released`. */
  const again = await post(registry, { groupId: id(1) }, { path: '/release' });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, freed: 0 });

  const unknown = await post(registry, { groupId: id(9) }, { path: '/release' });
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), { ok: true, freed: 0 }, 'an unknown id frees nothing');
  assert.equal(rows.size, 1, 'no release freed a slot it did not hold');
});

test('registry: a method other than POST is refused and names the method it allows', async () => {
  const { ctx } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });

  const response = await post(registry, null, { path: '/reserve', method: 'GET' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST', 'a 405 must carry Allow: POST');
  assert.deepEqual(await response.json(), { error: 'method' });
});

test('registry: every route answers a wrong method with Allow: POST', async () => {
  /* The whole set of writes, not the two a create calls: the ledger takes no GET, PUT or DELETE on
     any of them, and a 405 has to name the method it does take. `/stats` is the one read, and its
     own test covers the write methods it refuses. */
  const PATHS = ['/reserve', '/release', '/join-blocked', '/join-failure', '/list'];

  for (const path of PATHS) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const { ctx, rows, joinRows } = fakeContext();
      const registry = new Registry(ctx, { MAX_GROUPS: '2' });
      const response = await post(registry, null, { path, method });

      assert.equal(response.status, 405, `${method} ${path} must be refused`);
      assert.equal(response.headers.get('allow'), 'POST', `${method} ${path} must carry Allow: POST`);
      assert.deepEqual(await response.json(), { error: 'method' });
      assert.equal(rows.size, 0, 'a refused method must not take a slot');
      assert.equal(joinRows.length, 0, 'nor count a join failure');
    }
  }
});

test('registry: a release without a group id is a bad request, not a no-op success', async () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });
  registry.reserve(id(1));

  const response = await post(registry, {}, { path: '/release' });
  assert.equal(response.status, 400, 'a release that names nothing must not answer ok');
  assert.deepEqual(await response.json(), { error: 'bad_request' });
  assert.equal(rows.size, 1, 'the held slot must survive a malformed release');
});


test('registry: stats names the cap in force and the slots free', async () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '3' });

  registry.reserve(id(1));
  registry.reserve(id(2));

  const response = await get(registry, '/stats');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cap: 3, reserved: 2, free: 1 });
  assert.equal(rows.size, 2, 'stats must neither take nor free a slot');

  /* The third reserve fills the ledger, and the next read says zero free — the number the create
     path compares and the number this route reports are one number. */
  registry.reserve(id(3));
  assert.deepEqual(await (await get(registry, '/stats')).json(), {
    cap: 3,
    reserved: 3,
    free: 0
  });
  assert.deepEqual(registry.reserve(id(4)), { ok: false, reserved: false }, 'free 0 is a full ledger');

  /* A deploy that lowers the cap under what is already reserved must not report negative room. */
  const narrower = new Registry(ctx, { MAX_GROUPS: '2' });
  assert.deepEqual(await (await get(narrower, '/stats')).json(), {
    cap: 2,
    reserved: 3,
    free: 0
  });
  assert.deepEqual(narrower.reserve(id(5)), { ok: false, reserved: false });
});

test('registry: a malformed MAX_GROUPS falls back to 25 and says so', async () => {
  for (const value of ['many', '0', '-4', '']) {
    const { ctx } = fakeContext();
    const registry = new Registry(ctx, { MAX_GROUPS: value });

    const response = await get(registry, '/stats');
    assert.equal(response.status, 200);
    assert.deepEqual(
      await response.json(),
      { cap: DEFAULT_MAX_GROUPS, reserved: 0, free: DEFAULT_MAX_GROUPS },
      `MAX_GROUPS=${JSON.stringify(value)}`
    );
  }

  assert.equal(DEFAULT_MAX_GROUPS, 25, 'the cap in force is the documented default, never zero');
});

test('registry: stats is a GET, and a write method is refused with allow: GET', async () => {
  const { ctx, rows } = fakeContext();
  const registry = new Registry(ctx, { MAX_GROUPS: '2' });
  registry.reserve(id(1));

  /* `/stats` takes no body at all, so a read is the only method that can reach it. A ledger that
     answered a POST here would be a route a cross-site form could reach with no negotiation. */
  const read = await get(registry, '/stats');
  assert.equal(read.status, 200, 'GET /stats is the read');
  assert.deepEqual(await read.json(), { cap: 2, reserved: 1, free: 1 });

  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await post(registry, null, { path: '/stats', method });
    assert.equal(response.status, 405, `${method} /stats must be refused`);
    assert.equal(response.headers.get('allow'), 'GET', 'a 405 must carry Allow: GET');
    assert.deepEqual(await response.json(), { error: 'method' });
  }

  assert.equal(rows.size, 1, 'a refused method must not touch the ledger');
});

/* ---------------------------------------------------------------- the read-only listing */

/**
 * The GROUPS binding, over a table of answers keyed by group id.
 *
 * `asked` records every group the ledger reads, in order, so "the list stopped at its bound" can be
 * asserted on the calls that were made rather than on the answer alone. An id with no entry throws,
 * which is the shape of a binding that cannot reach the object at all.
 */
function fakeGroups(answers = {}) {
  const asked = [];
  return {
    asked,
    env: {
      GROUPS: {
        idFromName: (name) => name,
        get: (name) => ({
          fetch: async (url, init) => {
            asked.push({ id: name, path: new URL(url).pathname, method: init?.method });
            const answer = answers[name];
            if (typeof answer !== 'function') throw new Error(`fake groups: no answer for ${name}`);
            const { status = 200, body } = answer();
            return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
          }
        })
      }
    }
  };
}

/** The counters one group answers, as `src/group.js` writes them. */
const counters = (createdAt, lastWriteAt, records, bytes) => ({
  ok: true,
  createdAt,
  lastWriteAt,
  records,
  bytes
});

test('registry: a list of three groups reports the counters each group answered', async () => {
  const { ctx } = fakeContext();
  const groups = fakeGroups({
    [id(1)]: () => ({ body: counters(1000, 2000, 2, 300) }),
    [id(2)]: () => ({ body: counters(1500, null, 0, 0) }),
    [id(3)]: () => ({ body: counters(1700, 1800, 5, 900) })
  });
  const registry = new Registry(ctx, { MAX_GROUPS: '5', ...groups.env });

  for (const n of [3, 1, 2]) assert.deepEqual(registry.reserve(id(n)), { ok: true, reserved: true });

  const response = await post(registry, {}, { path: '/list' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    limit: LIST_PAGE_LIMIT,
    total: 3,
    next: null,
    groups: [
      { id: id(1), readable: true, createdAt: 1000, lastWriteAt: 2000, records: 2, bytes: 300 },
      { id: id(2), readable: true, createdAt: 1500, lastWriteAt: null, records: 0, bytes: 0 },
      { id: id(3), readable: true, createdAt: 1700, lastWriteAt: 1800, records: 5, bytes: 900 }
    ]
  });
  assert.deepEqual(
    groups.asked.map((call) => call.id),
    [id(1), id(2), id(3)],
    'every live group is asked once, in the ledger order, and only its counters'
  );
  assert.deepEqual(
    groups.asked.map((call) => call.path),
    ['/counters', '/counters', '/counters']
  );
});

test('registry: the list stops at its bound and answers in a stable order', async () => {
  const { ctx } = fakeContext();
  const live = LIST_PAGE_LIMIT + 2;
  const answers = {};
  for (let n = 1; n <= live; n += 1) answers[id(n)] = () => ({ body: counters(n, null, 0, 0) });
  const groups = fakeGroups(answers);
  const registry = new Registry(ctx, { MAX_GROUPS: '25', ...groups.env });

  /* Reserved out of order on purpose: the ledger's rows come back in insertion order, so a listing
     that walked them as stored would answer a different page for the same ledger. */
  for (const n of [7, 3, 11, 1, 9, 5, 12, 2, 10, 4, 8, 6]) registry.reserve(id(n));

  const body = await (await post(registry, {}, { path: '/list' })).json();
  const expected = Array.from({ length: LIST_PAGE_LIMIT }, (_, index) => id(index + 1));

  assert.equal(body.limit, LIST_PAGE_LIMIT);
  assert.equal(body.total, live, 'the total is the whole ledger, not the page');
  assert.deepEqual(body.groups.map((entry) => entry.id), expected, 'the page is ordered by id');
  assert.equal(body.groups.length, LIST_PAGE_LIMIT, 'a page never reads more than its bound');
  assert.equal(groups.asked.length, LIST_PAGE_LIMIT, 'no group past the bound is even asked');
  /* A full page is not the end of the ledger: it names the id to continue from, or the eleven slots
     behind it could never be listed. */
  assert.equal(body.next, id(LIST_PAGE_LIMIT), 'a full page names its own last id as the cursor');

  /* The same ledger answers the same page: the order is the ledger's, not the groups'. */
  assert.deepEqual(await (await post(registry, {}, { path: '/list' })).json(), body);
});

test('registry: twelve slots are listed across two pages that meet exactly', async () => {
  const { ctx } = fakeContext();
  const answers = {};
  for (let n = 1; n <= 12; n += 1) answers[id(n)] = () => ({ body: counters(n, null, 0, 0) });
  const groups = fakeGroups(answers);
  const registry = new Registry(ctx, { MAX_GROUPS: '12', ...groups.env });
  for (let n = 12; n >= 1; n -= 1) registry.reserve(id(n));

  const first = await (await post(registry, {}, { path: '/list' })).json();
  assert.deepEqual(
    first.groups.map((entry) => entry.id),
    Array.from({ length: LIST_PAGE_LIMIT }, (_, index) => id(index + 1)),
    'the first page is the first ten slots, in ledger order'
  );
  assert.equal(first.total, 12, 'the total is the whole ledger, so the second page is visibly missing');
  assert.equal(first.next, id(LIST_PAGE_LIMIT), 'the cursor is the id the first page ended on');

  const second = await (await post(registry, { cursor: first.next }, { path: '/list' })).json();
  assert.deepEqual(
    second.groups.map((entry) => entry.id),
    [id(11), id(12)],
    'the second page starts where the first ended, with nothing repeated and nothing skipped'
  );
  assert.equal(second.next, null, 'the last page names no cursor');
  assert.equal(second.total, 12, 'each page reports the whole ledger, not the rows behind it');

  /* The two pages partition the ledger: twelve slots, twelve distinct ids, twelve group reads. */
  const listed = [...first.groups, ...second.groups].map((entry) => entry.id);
  assert.equal(listed.length, 12);
  assert.equal(new Set(listed).size, 12, 'no slot may be listed twice across the pages');
  assert.equal(groups.asked.length, 12, 'each live group is read once, across the two pages');

  /* A cursor at the end of the ledger is an empty page, not a second copy of the first. It also must
     not read a group to prove it: the bound is the SQL's. */
  const askedBefore = groups.asked.length;
  const beyond = await (await post(registry, { cursor: id(12) }, { path: '/list' })).json();
  assert.deepEqual(beyond.groups, []);
  assert.equal(beyond.next, null, 'there is nothing after the last slot');
  assert.equal(groups.asked.length, askedBefore, 'an empty page reads no group');
});

test('registry: a cursor that is not a string is a bad request', async () => {
  const { ctx } = fakeContext();
  const groups = fakeGroups({ [id(1)]: () => ({ body: counters(1, null, 0, 0) }) });
  const registry = new Registry(ctx, { MAX_GROUPS: '2', ...groups.env });
  registry.reserve(id(1));

  for (const cursor of [42, {}, ['x'], true]) {
    const response = await post(registry, { cursor }, { path: '/list' });
    assert.equal(response.status, 400, `a cursor of ${JSON.stringify(cursor)} is not a page boundary`);
    assert.deepEqual(await response.json(), { error: 'bad_request' });
  }
  assert.equal(groups.asked.length, 0, 'a refused page must not read a single group');

  /* An absent cursor is the first page, and an empty body is the same request: a read takes no
     input, so a POST with nothing in it is not a bad request. */
  const bare = await registry.fetch(
    new Request('https://registry/list', { method: 'POST', headers: { 'content-type': 'application/json' } })
  );
  assert.equal(bare.status, 200);
  assert.equal((await bare.json()).next, null);
});

test('registry: a group that throws is reported unreadable, not as zero', async () => {
  const { ctx } = fakeContext();
  const groups = fakeGroups({
    [id(1)]: () => ({ body: counters(1000, 1000, 1, 10) }),
    [id(2)]: () => {
      throw new Error('unreachable');
    },
    [id(3)]: () => ({ status: 500, body: { error: 'internal' } }),
    [id(4)]: () => ({ body: '<html>not json</html>' }),
    /* A 200 that is JSON but not counters is a bad answer too, not a group holding nothing. */
    [id(5)]: () => ({ body: { ok: true } })
  });
  const registry = new Registry(ctx, { MAX_GROUPS: '9', ...groups.env });
  for (const n of [1, 2, 3, 4, 5]) registry.reserve(id(n));

  const body = await (await post(registry, {}, { path: '/list' })).json();
  assert.deepEqual(body.groups, [
    { id: id(1), readable: true, createdAt: 1000, lastWriteAt: 1000, records: 1, bytes: 10 },
    { id: id(2), readable: false },
    { id: id(3), readable: false },
    { id: id(4), readable: false },
    { id: id(5), readable: false }
  ]);
  for (const entry of body.groups.slice(1)) {
    assert.equal('records' in entry, false, 'an unreadable group must not answer a record count');
    assert.equal('bytes' in entry, false, 'an unreadable group must not answer a byte count');
    assert.equal('createdAt' in entry, false, 'nor a creation time');
  }
  assert.equal(body.total, 5, 'an unreadable group is still a live slot');
});

test('registry: a group with no timestamp is listed as unknown, never as a number', async () => {
  const { ctx } = fakeContext();
  const groups = fakeGroups({ [id(1)]: () => ({ body: counters(null, null, 3, 42) }) });
  const registry = new Registry(ctx, { MAX_GROUPS: '2', ...groups.env });
  registry.reserve(id(1));

  const body = await (await post(registry, {}, { path: '/list' })).json();
  const [entry] = body.groups;

  assert.equal(entry.readable, true, 'a group created before timestamps existed is still readable');
  assert.equal(entry.createdAt, null, 'an unknown creation time is answered as unknown');
  assert.equal(entry.lastWriteAt, null, 'and so is an unknown last write');
  assert.equal(entry.records, 3, 'the counters that are known still travel');
  assert.equal(entry.bytes, 42);
  assert.notEqual(typeof entry.createdAt, 'number', 'an absence is never invented as a time');
});

test('registry: a list of real groups matches the counters their own API created', async () => {
  const { ctx } = fakeContext();
  const instances = new Map();

  /* A GROUPS binding over real Group instances: the ledger's reading of a counters answer is only
     proven against the file that writes that answer this way. A key the two files disagreed on —
     the name of a counter, or the key the last write lives under — fails here. */
  const env = {
    GROUPS: {
      idFromName: (name) => name,
      get: (name) => {
        if (!instances.has(name)) {
          const stored = new Map();
          const api = {
            get: async (key) => stored.get(key),
            put: async (key, value) => {
              stored.set(key, value);
            },
            list: async ({ prefix } = {}) => {
              const found = new Map();
              for (const [key, value] of stored) {
                if (prefix === undefined || key.startsWith(prefix)) found.set(key, value);
              }
              return found;
            },
            delete: async (key) => stored.delete(key),
            deleteAll: async () => stored.clear()
          };
          instances.set(name, { group: new Group({ storage: api }, {}), stored });
        }
        const instance = instances.get(name);
        return { fetch: (url, init) => instance.group.fetch(new Request(url, init)) };
      }
    }
  };
  const registry = new Registry(ctx, { MAX_GROUPS: '9', ...env });

  const blob = { iv: 'A'.repeat(16), ct: 'B'.repeat(24) };
  const groups = [1, 2, 3].map((n) => ({
    id: id(n),
    hostId: id(100 + n),
    recordId: id(200 + n)
  }));

  for (const entry of groups) {
    registry.reserve(entry.id);
    const created = await env.GROUPS.get(entry.id).fetch('https://group/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId: entry.id, hostId: entry.hostId, nameBlob: blob })
    });
    assert.deepEqual(await created.json(), { ok: true, created: true });

    /* One accepted write each, so no group here can be read as one that was never written. */
    const { group } = instances.get(entry.id);
    const socket = { send() {}, close() {} };
    group.sockets.add(socket);
    group.identities.set(socket, { memberId: entry.hostId, role: 'host' });
    await group.writeRecord(socket, { id: entry.recordId, base: 0, blob, deleted: false });
  }

  const body = await (await post(registry, {}, { path: '/list' })).json();
  assert.equal(body.total, 3);
  assert.equal(body.groups.length, 3);

  for (const [index, entry] of groups.entries()) {
    const { stored } = instances.get(entry.id);
    const listed = body.groups[index];
    const record = stored.get(`record:${entry.recordId}`);

    assert.equal(listed.id, entry.id);
    assert.equal(listed.readable, true, 'a created group is readable through the ledger');
    assert.equal(listed.createdAt, stored.get(GROUP_KEY).createdAt, 'the time the group stamped');
    assert.equal(listed.lastWriteAt, stored.get('last-write').at, 'the time of its one write');
    assert.equal(listed.records, 1);
    assert.equal(listed.bytes, new TextEncoder().encode(JSON.stringify(record)).length);
  }
});

test('registry: twelve failed joins from one address block it, and the window clears', () => {
  const { ctx, joinRows } = fakeContext();
  const registry = new Registry(ctx, {});
  const now = 1_000_000;

  for (let count = 0; count < JOIN_LIMIT; count += 1) {
    assert.equal(registry.noteJoinFailure('203.0.113.9', now).count, count + 1);
  }

  assert.deepEqual(registry.joinBlocked('203.0.113.9', now), {
    blocked: true,
    count: JOIN_LIMIT
  });
  assert.deepEqual(
    registry.joinBlocked('198.51.100.4', now),
    { blocked: false, count: 0 },
    'another source is not affected'
  );

  assert.equal(
    registry.joinBlocked('203.0.113.9', now + JOIN_WINDOW_MS).blocked,
    false,
    'the window expires'
  );
  assert.equal(joinRows.length, 0, 'the expired rows are pruned');
});
