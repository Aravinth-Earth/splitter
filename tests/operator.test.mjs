/**
 * The operator surface: five token-gated routes on the Worker.
 *
 * The Durable Objects already answer `/stats`, `/list`, `/counters`, `/destroy` and the Registry's
 * `/release`, but nothing on the Worker reached them — `/destroy` was dead code and the ledger could
 * not be read at all. This suite pins the surface that exposes them, and the two refusals that keep
 * it closed: with no `OPERATOR_TOKEN` the routes do not exist (an unknown path's 404, not a hint that
 * something is there), and with one set a missing or wrong credential is a 401 that reaches no
 * Durable Object.
 * `/release` is the one route addressed by a ledger id rather than by a group: a row an older create
 * wrote under a 22-character id is freed there, because `/destroy` names groups only.
 *
 * No `wrangler dev`: the Worker is the real `src/index.js` and the two bindings are stand-ins that
 * record every internal call, so "the object was reached" is an observed call and not an inference
 * from a status code.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Group } from '../src/group.js';
import worker from '../src/index.js';
import { Registry } from '../src/registry.js';

import { startWorker } from './wrangler.mjs';

/** The token the deployment sets as a secret; never a value the page holds. */
const TOKEN = 'operator-1c9d-test-token';

/** A group id as crypto.js derives it: 64 lowercase hex characters, the Durable Object's name. */
function groupId(n = 1) {
  return String(n).padStart(64, '0');
}

/**
 * The two namespaces the Worker forwards to, with a log of every call.
 *
 * `answers` lets one route answer with its own status and body, so a `/destroy` that wiped the
 * group but could not free the slot (502) is asserted as forwarded rather than flattened.
 */
function fakeBindings({ token, answers = {} } = {}) {
  const calls = [];
  const reply = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  const record = (object, name) => async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ object, name, pathname, body: init?.body ? JSON.parse(init.body) : null });
    const answer = answers[pathname] ?? {};
    return reply(answer.body ?? { ok: true }, answer.status ?? 200);
  };

  const env = {
    REGISTRY: {
      idFromName: (name) => ({ name }),
      get: (object) => ({ fetch: record('registry', object?.name) })
    },
    GROUPS: {
      idFromName: (name) => ({ name }),
      get: (object) => ({ fetch: record('group', object?.name) })
    }
  };
  if (token !== undefined) env.OPERATOR_TOKEN = token;
  return { calls, env };
}

/** One request to the Worker, on the API prefix the page and the operator both use. */
async function call(env, path, { method = 'POST', token, body, type = 'application/json' } = {}) {
  const headers = {};
  if (type !== null) headers['content-type'] = type;
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const response = await worker.fetch(
    new Request(`https://splitter.test/api${path}`, {
      method,
      headers,
      body: hasBody ? (typeof body === 'string' ? body : JSON.stringify(body ?? {})) : undefined
    }),
    env
  );
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json().catch(() => null)
  };
}

/** Every operator route, with the method and body the surface documents for it. */
const ROUTES = [
  { path: '/stats', method: 'GET' },
  { path: '/list', method: 'POST', body: {} },
  { path: '/counters', method: 'POST', body: { groupId: groupId(1) } },
  { path: '/destroy', method: 'POST', body: { groupId: groupId(1) } },
  { path: '/release', method: 'POST', body: { groupId: groupId(1) } }
];

/* ------------------------------------------------ the surface exists only when it is configured */

test('operator: with no token the operator routes do not exist and reach nothing', async () => {
  for (const token of [undefined, '']) {
    for (const route of ROUTES) {
      const { calls, env } = fakeBindings({ token });
      const result = await call(env, route.path, route);

      assert.equal(result.status, 404, `${route.method} ${route.path} must not exist without a token`);
      assert.deepEqual(result.body, { error: 'not_found' }, 'an unconfigured surface is an unknown path');
      assert.equal(calls.length, 0, 'no Durable Object may be reached by an unconfigured surface');
    }
  }

  /* The same answer an unknown API path gives, so a probe cannot tell the two apart. */
  const { env } = fakeBindings({});
  const unknown = await call(env, '/nope');
  const surface = await call(env, '/stats', { method: 'GET' });
  assert.equal(surface.status, unknown.status, 'an unconfigured surface is indistinguishable from a typo');
  assert.deepEqual(surface.body, unknown.body);
});

test('operator: a missing, malformed or wrong credential is a 401 that reaches nothing', async () => {
  const attempts = [
    { label: 'no header', token: undefined },
    { label: 'another token', token: 'not-the-token' },
    { label: 'a prefix of the token', token: TOKEN.slice(0, -1) },
    { label: 'the token with a suffix', token: `${TOKEN}x` }
  ];

  for (const attempt of attempts) {
    for (const route of ROUTES) {
      const { calls, env } = fakeBindings({ token: TOKEN });
      const result = await call(env, route.path, { ...route, token: attempt.token });

      assert.equal(result.status, 401, `${attempt.label} on ${route.path} must be refused`);
      assert.deepEqual(result.body, { error: 'unauthorized' });
      assert.equal(result.headers.get('www-authenticate'), 'Bearer', 'a 401 must name its scheme');
      assert.equal(calls.length, 0, 'a refused credential must never reach a Durable Object');
    }
  }

  /* A header that carries the right token behind a second scheme is a wrong credential, not a
     match: the comparison is against the token alone. */
  const { calls, env } = fakeBindings({ token: TOKEN });
  const doubled = await call(env, '/stats', { method: 'GET', token: `Bearer ${TOKEN}` });
  assert.equal(doubled.status, 401, 'the scheme is part of the header, not of the token');
  assert.equal(calls.length, 0);
});

test('operator: another scheme is not the credential', async () => {
  const { calls, env } = fakeBindings({ token: TOKEN });
  const result = await worker.fetch(
    new Request('https://splitter.test/api/stats', {
      method: 'GET',
      headers: { authorization: `Basic ${TOKEN}` }
    }),
    env
  );

  assert.equal(result.status, 401, 'only the Bearer scheme carries this token');
  assert.equal((await result.json()).error, 'unauthorized');
  assert.equal(calls.length, 0);
});

/* --------------------------------------------------- the token opens the object behind each route */

test('operator: the token reaches the ledger for stats and list', async () => {
  const answers = {
    '/stats': { body: { cap: 25, reserved: 2, free: 23 } },
    '/list': { body: { limit: 10, total: 2, next: null, groups: [] } }
  };
  const { calls, env } = fakeBindings({ token: TOKEN, answers });

  const stats = await call(env, '/stats', { method: 'GET', token: TOKEN });
  assert.equal(stats.status, 200, 'the ledger was reached and answered');
  assert.deepEqual(stats.body, { cap: 25, reserved: 2, free: 23 }, 'the ledger answer is passed through');

  /* The cursor is the whole point of the listing: it travels to the ledger, and an absent one asks
     for the first page. */
  const first = await call(env, '/list', { token: TOKEN, body: {} });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { limit: 10, total: 2, next: null, groups: [] });

  const second = await call(env, '/list', { token: TOKEN, body: { cursor: groupId(10) } });
  assert.equal(second.status, 200);

  assert.deepEqual(
    calls.map((entry) => [entry.object, entry.pathname]),
    [
      ['registry', '/stats'],
      ['registry', '/list'],
      ['registry', '/list']
    ],
    'both routes are answered by the one ledger, and only by it'
  );
  assert.deepEqual(calls[1].body, {}, 'a listing with no cursor asks for the first page');
  assert.deepEqual(calls[2].body, { cursor: groupId(10) }, 'the cursor travels to the ledger');
});

test('operator: the token reaches one group for counters and destroy', async () => {
  const names = { caps: { body: { cap: 1, reserved: 1, free: 0 } } };
  const { calls, env } = fakeBindings({ token: TOKEN, answers: names });

  const counters = await call(env, '/counters', { token: TOKEN, body: { groupId: groupId(7) } });
  assert.equal(counters.status, 200);
  assert.deepEqual(counters.body, { ok: true }, 'the counters answer is passed through');

  const destroyed = await call(env, '/destroy', { token: TOKEN, body: { groupId: groupId(7) } });
  assert.equal(destroyed.status, 200);
  assert.deepEqual(destroyed.body, { ok: true });

  assert.deepEqual(
    calls.map((entry) => [entry.object, entry.pathname]),
    [
      ['group', '/counters'],
      ['group', '/destroy']
    ],
    'both routes are answered by the group the body names, not by the ledger'
  );
});

test('operator: a destroy that wiped but could not free the slot keeps its own status', async () => {
  const answers = {
    '/destroy': { status: 502, body: { ok: false, destroyed: true, released: false, closed: 0 } }
  };
  const { env } = fakeBindings({ token: TOKEN, answers });

  const result = await call(env, '/destroy', { token: TOKEN, body: { groupId: groupId(3) } });

  assert.equal(result.status, 502, 'a slot the ledger still holds is not a clean destroy');
  assert.equal(result.body.released, false, 'the answer must not claim a slot came back');
  assert.equal(result.body.destroyed, true, 'and must not hide that the group is gone');
});

/* ----------------------------------- the ledger row that no group names */

/** A ledger row an older create wrote: 22 characters, the id shape a member also has. */
const LEGACY_ID = 'b'.repeat(22);

test('operator: /release frees a ledger row by id and answers the rows it deleted', async () => {
  /* The row this route frees is one no group answers: the guard asks the group first, exactly as
     `/list` does, and a `404` is the answer that makes it a ledger row. */
  const countersAbsent = { '/counters': { status: 404, body: { error: 'unknown_group' } } };
  const held = fakeBindings({
    token: TOKEN,
    answers: { ...countersAbsent, '/release': { body: { ok: true, freed: 1 } } }
  });
  const freed = await call(held.env, '/release', { token: TOKEN, body: { groupId: groupId(4) } });
  assert.equal(freed.status, 200, 'the ledger was reached and answered');
  assert.deepEqual(freed.body, { ok: true, freed: 1 }, 'the row count is the ledger\'s, passed through');
  assert.deepEqual(
    held.calls.map((entry) => [entry.object, entry.pathname]),
    [
      ['group', '/counters'],
      ['registry', '/release']
    ],
    'the group is asked first, and a row it does not answer for is freed by the ledger'
  );
  assert.deepEqual(held.calls[1].body, { groupId: groupId(4) }, 'the id the caller named travels');

  /* The row this route exists for: the 22-character id an older create left in the ledger. It names
     no group any route here can address, so it is freed without a group being asked. */
  const legacy = fakeBindings({ token: TOKEN, answers: { '/release': { body: { ok: true, freed: 1 } } } });
  const legacyFreed = await call(legacy.env, '/release', { token: TOKEN, body: { groupId: LEGACY_ID } });
  assert.equal(legacyFreed.status, 200, 'an id of the other shape a row can hold is a row too');
  assert.deepEqual(legacy.calls[0].body, { groupId: LEGACY_ID }, 'the legacy id travels unchanged');

  /* An id the ledger does not hold is not an error: there is nothing to free, which is a finished
     release rather than a failed one. */
  const absent = fakeBindings({
    token: TOKEN,
    answers: { ...countersAbsent, '/release': { body: { ok: true, freed: 0 } } }
  });
  const unknown = await call(absent.env, '/release', { token: TOKEN, body: { groupId: groupId(9) } });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { ok: true, freed: 0 }, 'an unknown id frees nothing, and says so');

  const wrongMethod = await call(held.env, '/release', { method: 'GET', token: TOKEN });
  assert.equal(wrongMethod.status, 405, 'a release is a POST, not a read');
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
});

test('operator: /release refuses an id no ledger row can hold, before the ledger is asked', async () => {
  const { calls, env } = fakeBindings({ token: TOKEN });

  for (const bad of [undefined, '', 'not-an-id', 'A'.repeat(64), `${'a'.repeat(64)}0`, 42, null]) {
    const result = await call(env, '/release', {
      token: TOKEN,
      body: bad === undefined ? {} : { groupId: bad }
    });
    assert.equal(result.status, 400, `/release must refuse groupId ${JSON.stringify(bad)}`);
    assert.deepEqual(result.body, { error: 'groupId' });
  }
  assert.equal(calls.length, 0, 'nothing unnameable reaches the ledger');
});

test('operator: /destroy takes a group id, so a ledger-only id is freed through /release', async () => {
  /* The documented split between the two routes, asserted on the status a caller sees. `/destroy`
     names a group; the group is named by the 64 hexadecimal characters a create derives. A row an
     older create wrote under a 22-character id names no group, so `/destroy` refuses it and the
     row has to be freed by id, through `/release`. */
  const { calls, env } = fakeBindings({ token: TOKEN });

  const destroyed = await call(env, '/destroy', { token: TOKEN, body: { groupId: LEGACY_ID } });
  assert.equal(destroyed.status, 400, '/destroy names a group id, and this is not one');
  assert.deepEqual(destroyed.body, { error: 'groupId' });
  assert.equal(calls.length, 0, 'a refused destroy must not name a Durable Object');

  const released = await call(env, '/release', { token: TOKEN, body: { groupId: LEGACY_ID } });
  assert.equal(released.status, 200, 'the same id is a ledger row, which /release does name');
  assert.deepEqual(
    calls.map((entry) => [entry.object, entry.pathname]),
    [['registry', '/release']],
    'and it is the ledger that answers, not a group'
  );
});

/**
 * The real Worker over the real Registry and the real Group, with the ledger's tables in one Map.
 *
 * No `wrangler dev` here, because the row this case needs cannot be produced over HTTP any more:
 * `/api/create` refuses a 22-character group id at the edge, which is exactly the shape an older
 * create left in the ledger. The row is therefore written the way that create wrote it — a reserve
 * through the Registry binding — and every step after it is the real Worker, the real route, and
 * the real ledger and group code, including the SQL the listing and the stats read.
 */
function realLedger() {
  const rows = new Map();
  const sql = {
    exec(statement, ...params) {
      const text = statement.replace(/\s+/g, ' ').trim();
      if (text.startsWith('CREATE TABLE')) return { toArray: () => [] };
      if (text.startsWith('SELECT 1 FROM slots')) {
        return { toArray: () => (rows.has(params[0]) ? [{}] : []) };
      }
      if (text.startsWith('SELECT COUNT(*) AS held FROM slots')) {
        return { toArray: () => [{ held: rows.size }] };
      }
      if (text.startsWith('SELECT group_id FROM slots WHERE group_id > ?')) {
        const page = [...rows.keys()].filter((id) => id > params[0]).sort().slice(0, params[1]);
        return { toArray: () => page.map((group_id) => ({ group_id })) };
      }
      if (text.startsWith('INSERT INTO slots')) {
        rows.set(params[0], true);
        return { toArray: () => [] };
      }
      if (text.startsWith('DELETE FROM slots')) {
        rows.delete(params[0]);
        return { toArray: () => [] };
      }
      throw new Error(`fake sql: ${text}`);
    }
  };

  const instances = new Map();

  const groups = {
    idFromName: (name) => name,
    get: (name) => ({
      fetch: (url, init) => {
        if (!instances.has(name)) {
          const stored = new Map();
          const storage = {
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
            delete: async (key) => stored.delete(key)
          };
          instances.set(name, { group: new Group({ storage }, env), stored });
        }
        return instances.get(name).group.fetch(new Request(url, init));
      }
    })
  };

  const env = {
    OPERATOR_TOKEN: TOKEN,
    REGISTRY: {
      idFromName: () => 'registry',
      get: () => ({ fetch: (url, init) => registry.fetch(new Request(url, init)) })
    },
    GROUPS: groups
  };

  const registry = new Registry(
    { storage: { sql }, blockConcurrencyWhile: (work) => work() },
    { MAX_GROUPS: '2', GROUPS: groups }
  );

  return { env, rows, instances };
}

test('operator: a legacy row is listed, refused by /destroy, and freed by /release', async () => {
  assert.match(LEGACY_ID, /^[A-Za-z0-9_-]{22}$/, 'the fixture is the id shape an older create took');
  assert.notEqual(LEGACY_ID.length, 64, 'and it is not a group id, which is the point');

  const { env, rows, instances } = realLedger();

  /* What the old create did: the slot, then the group under that same id. */
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
  const reserved = await registry.fetch(
    new Request('https://registry/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId: LEGACY_ID })
    })
  );
  assert.deepEqual(await reserved.json(), { ok: true, reserved: true }, 'the ledger holds the row');

  const initialised = await env.GROUPS.get(LEGACY_ID).fetch(
    new Request('https://group/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        groupId: LEGACY_ID,
        hostId: 'c'.repeat(22),
        nameBlob: { iv: 'A'.repeat(16), ct: 'B'.repeat(24) }
      })
    })
  );
  assert.equal(initialised.status, 200, 'and the group behind it exists');

  const listed = await call(env, '/list', { token: TOKEN, body: {} });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.groups.map((entry) => entry.id), [LEGACY_ID], 'the occupied slot is listed');
  assert.equal(listed.body.groups[0].readable, true, 'and the group behind it answers its counters');
  assert.equal(listed.body.total, 1);

  /* The documented split: `/destroy` names groups only, so this row is refused there — which is
     the slot an operator could see and not free before this route existed. */
  const destroyed = await call(env, '/destroy', { token: TOKEN, body: { groupId: LEGACY_ID } });
  assert.equal(destroyed.status, 400, '/destroy takes a group id');
  assert.deepEqual(destroyed.body, { error: 'groupId' });
  assert.equal(rows.has(LEGACY_ID), true, 'so the row is still there to be freed');

  const freed = await call(env, '/release', { token: TOKEN, body: { groupId: LEGACY_ID } });
  assert.equal(freed.status, 200);
  assert.deepEqual(freed.body, { ok: true, freed: 1 }, 'one row, freed by id');

  const after = await call(env, '/list', { token: TOKEN, body: {} });
  assert.deepEqual(after.body.groups, [], 'the row is gone from the listing');
  assert.equal(after.body.total, 0);

  const stats = await call(env, '/stats', { method: 'GET', token: TOKEN });
  assert.deepEqual(stats.body, { cap: 2, reserved: 0, free: 2 }, 'and the slot is free again');

  /* The listing above read a real group, so its emptiness is a ledger with no rows, not a harness
     that never had one. */
  assert.equal(instances.size, 1, 'the group was read for the listing before the release');
  assert.deepEqual(
    after.body.groups,
    [],
    'listing it again after the release reads nothing, because there is nothing to read'
  );
});

test('operator: /release refuses a live group row, and frees a row no group answers', async () => {
  /* A live group's row is that group's slot: freeing the row alone strands the object with none,
     so the route asks the group — the `/counters` question `/list` asks — and refuses. The row is
     freed by `/destroy`, which removes the group as well. A row with no group behind it, the state
     a lost create leaves, is what this route is for, and it is freed there. */
  const { env, rows } = realLedger();
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));

  const reserve = (id) =>
    registry.fetch(
      new Request('https://registry/reserve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId: id })
      })
    );
  const init = (id) =>
    env.GROUPS.get(id).fetch(
      new Request('https://group/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          groupId: id,
          hostId: 'c'.repeat(22),
          nameBlob: { iv: 'A'.repeat(16), ct: 'B'.repeat(24) }
        })
      })
    );

  const live = groupId(6);
  assert.deepEqual(await (await reserve(live)).json(), { ok: true, reserved: true });
  assert.equal((await init(live)).status, 200, 'the group behind the row exists');

  const refused = await call(env, '/release', { token: TOKEN, body: { groupId: live } });
  assert.equal(refused.status, 409, 'a live group is not a row to free');
  assert.deepEqual(refused.body, { error: 'group_live' });
  assert.equal(rows.has(live), true, 'the row survives, so the group still holds its slot');

  const destroyed = await call(env, '/destroy', { token: TOKEN, body: { groupId: live } });
  assert.equal(destroyed.status, 200, 'the route that frees a live group row removes the group too');
  assert.equal(rows.has(live), false, 'and the row went with it');

  const orphan = groupId(7);
  assert.deepEqual(await (await reserve(orphan)).json(), { ok: true, reserved: true });
  const freed = await call(env, '/release', { token: TOKEN, body: { groupId: orphan } });
  assert.equal(freed.status, 200, 'a row no group answers is freed by this route');
  assert.deepEqual(freed.body, { ok: true, freed: 1 });
  assert.equal(rows.has(orphan), false, 'and the ledger no longer holds it');
});

/* ------------------------------------------------------------------------ refusals of the input */

test('operator: a wrong method is refused with the method it allows', async () => {
  const { calls, env } = fakeBindings({ token: TOKEN });

  const statsPost = await call(env, '/stats', { token: TOKEN, body: {} });
  assert.equal(statsPost.status, 405, 'stats is a read, not a POST');
  assert.equal(statsPost.headers.get('allow'), 'GET');
  assert.deepEqual(statsPost.body, { error: 'method' });

  const listGet = await call(env, '/list', { method: 'GET', token: TOKEN });
  assert.equal(listGet.status, 405, 'a listing needs a body for its cursor');
  assert.equal(listGet.headers.get('allow'), 'POST');
  assert.equal(calls.length, 0, 'a refused method must reach no Durable Object');

  /* Every route, not just the two above: `/counters` and `/destroy` answer a 405 too, and a client
     that reads it must be told which method those two take. `/stats` is the only GET. */
  for (const route of ROUTES) {
    for (const wrong of route.method === 'GET' ? ['POST', 'PUT'] : ['GET', 'PUT']) {
      const result = await call(env, route.path, { method: wrong, token: TOKEN, body: {} });

      assert.equal(result.status, 405, `${wrong} ${route.path} must be refused`);
      assert.equal(
        result.headers.get('allow'),
        route.method,
        `${wrong} ${route.path} must carry Allow: ${route.method}`
      );
      assert.deepEqual(result.body, { error: 'method' });
    }
  }
  assert.equal(calls.length, 0, 'no wrong method may reach a Durable Object');
});

test('operator: a body that is not a JSON object is a bad request', async () => {
  const { calls, env } = fakeBindings({ token: TOKEN });

  for (const path of ['/list', '/counters', '/destroy']) {
    const result = await call(env, path, { token: TOKEN, body: '[', type: 'application/json' });
    assert.equal(result.status, 400, `${path} with an unparseable body must be refused`);
    assert.deepEqual(result.body, { error: 'body' });
  }
  assert.equal(calls.length, 0, 'nothing unreadable may reach a Durable Object');
});

test('operator: a group id that is not a group id is refused before any object is asked', async () => {
  const { calls, env } = fakeBindings({ token: TOKEN });

  for (const bad of [undefined, '', 'not-an-id', 'A'.repeat(64), `${groupId(1)}0`]) {
    for (const path of ['/counters', '/destroy']) {
      const result = await call(env, path, { token: TOKEN, body: bad === undefined ? {} : { groupId: bad } });
      assert.equal(result.status, 400, `${path} must refuse groupId ${JSON.stringify(bad)}`);
      assert.deepEqual(result.body, { error: 'groupId' });
    }
  }
  assert.equal(calls.length, 0, 'an id no group can hold must not name an object');
});

/** The body `/api/create` takes for a given group id: a sealed name, and ids in the shapes it checks. */
function createBody(groupId) {
  return {
    groupId,
    hostId: 'b'.repeat(22),
    nameBlob: { iv: 'A'.repeat(16), ct: 'B'.repeat(24) }
  };
}

test('operator: a group id the create accepts is a group id the destroy accepts', async () => {
  /* The two routes have to name a group the same way: an id the create accepts and the destroy
     refuses is a group nobody can ever remove. Both routes therefore check one shape — the 64
     lowercase hex characters a group id is — and this drives them over the same id. */
  const id = groupId(7);
  const { calls, env } = fakeBindings({ token: TOKEN });

  const created = await call(env, '/create', { body: createBody(id) });
  assert.equal(created.status, 200, 'the id crypto.js derives is a creatable group id');

  const destroyed = await call(env, '/destroy', { token: TOKEN, body: { groupId: id } });
  assert.equal(destroyed.status, 200, 'and the same id removes the group it created');

  const onTheGroup = calls.filter((entry) => entry.object === 'group');
  assert.deepEqual(
    onTheGroup.map((entry) => [entry.pathname, entry.name]),
    [
      ['/init', id],
      ['/destroy', id]
    ],
    'both routes addressed the one Durable Object named by that id'
  );
});

test('operator: an id that is not a group id is refused by both routes with the same status', async () => {
  /* Every shape that is not a group id, including the 22-character member id: refused before a
     slot is spent or an object is asked, and refused by create and destroy alike. */
  const shapes = [
    'a'.repeat(22),
    'a'.repeat(63),
    `${'a'.repeat(64)}0`,
    'A'.repeat(64),
    'not-an-id'
  ];

  for (const shape of shapes) {
    const creator = fakeBindings({ token: TOKEN });
    const destroyer = fakeBindings({ token: TOKEN });
    const created = await call(creator.env, '/create', { body: createBody(shape) });
    const destroyed = await call(destroyer.env, '/destroy', { token: TOKEN, body: { groupId: shape } });

    assert.equal(created.status, 400, `"${shape}" must not be created`);
    assert.equal(destroyed.status, created.status, 'both routes must answer the same status for it');
    assert.deepEqual(created.body, { error: 'groupId' });
    assert.deepEqual(destroyed.body, { error: 'groupId' });
    assert.equal(creator.calls.length, 0, 'a refused create takes no slot and names no object');
    assert.equal(destroyer.calls.length, 0, 'a refused destroy names no object');
  }
});

test('operator: a group id that is not a string is refused by both routes before any object', async () => {
  for (const bad of [undefined, 42, null, ['a'.repeat(64)], { id: 'a' }]) {
    const creator = fakeBindings({ token: TOKEN });
    const destroyer = fakeBindings({ token: TOKEN });
    const created = await call(creator.env, '/create', { body: createBody(bad) });
    const destroyed = await call(destroyer.env, '/destroy', { token: TOKEN, body: { groupId: bad } });

    assert.equal(created.status, 400, `a group id of ${JSON.stringify(bad)} is not a name`);
    assert.equal(destroyed.status, created.status, 'the two routes refuse it alike');
    assert.deepEqual(created.body, { error: 'groupId' });
    assert.deepEqual(destroyed.body, { error: 'groupId' });
    assert.equal(creator.calls.length + destroyer.calls.length, 0, 'nothing unnameable reaches an object');
  }
});

test('operator: a cursor that is not a string is refused, and an empty one asks for page one', async () => {
  const { calls, env } = fakeBindings({ token: TOKEN });

  for (const cursor of [42, {}, ['x']]) {
    const result = await call(env, '/list', { token: TOKEN, body: { cursor } });
    assert.equal(result.status, 400, `a cursor of ${JSON.stringify(cursor)} is not a page boundary`);
    assert.deepEqual(result.body, { error: 'cursor' });
  }
  assert.equal(calls.length, 0);

  const empty = await call(env, '/list', { token: TOKEN, body: { cursor: '' } });
  assert.equal(empty.status, 200, 'an empty cursor is the start of the ledger');
  assert.deepEqual(calls[0].body, {}, 'and it is not sent to the ledger as a boundary');
});

/* ------------------------------------------------- against a real Worker and real storage */

test('operator: the four routes reach real Durable Objects over HTTP', async (t) => {
  /* The unit cases above prove the guard and the forwarding; this one proves the routes against
     the real `wrangler dev`, the real Registry SQL and a real Group, because `/destroy`,
     `/counters`, `/stats` and `/list` had no caller at all before.
  */
  const worker = await startWorker({ vars: { OPERATOR_TOKEN: TOKEN, MAX_GROUPS: '2' } });
  t.after(async () => {
    await worker.stop();
  });

  async function send(path, { method = 'POST', token = TOKEN, body } = {}) {
    const headers = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const response = await fetch(`${worker.baseUrl}/api${path}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000)
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  const groupId = 'a'.repeat(64);
  const created = await send('/create', {
    body: { groupId, hostId: groupId.slice(0, 22), nameBlob: { iv: 'A'.repeat(16), ct: 'B'.repeat(24) } }
  });
  assert.equal(created.status, 200, 'a group created over the real API is what the surface reads');

  const stats = await send('/stats', { method: 'GET' });
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.body, { cap: 2, reserved: 1, free: 1 }, 'the ledger holds the one slot');

  const counters = await send('/counters', { body: { groupId } });
  assert.equal(counters.status, 200, 'the group answers through the Worker');
  assert.equal(counters.body.ok, true);
  assert.equal(counters.body.records, 0);
  assert.equal(Number.isSafeInteger(counters.body.createdAt), true, 'and it is the real group answering');

  const list = await send('/list', { body: {} });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.deepEqual(list.body.groups.map((entry) => entry.id), [groupId]);
  assert.equal(list.body.next, null, 'one group on a page of ten is the last page');

  const destroyed = await send('/destroy', { body: { groupId } });
  assert.equal(destroyed.status, 200, 'the destroy ran on the real group');
  assert.deepEqual(destroyed.body, { ok: true, destroyed: true, released: true, closed: 0 });

  /* The slot really came back, and a second destroy has nothing left to free: the group is gone,
     so the answer must not claim a row was deleted. */
  assert.deepEqual((await send('/stats', { method: 'GET' })).body, { cap: 2, reserved: 0, free: 2 });
  const again = await send('/destroy', { body: { groupId } });
  assert.equal(again.body.destroyed, true);
  assert.equal(again.body.released, false, 'a group holding no slot frees none');
  assert.deepEqual((await send('/list', { body: {} })).body.groups, []);

  /* The guard is the same over HTTP: a wrong token opens nothing. */
  const refused = await send('/stats', { method: 'GET', token: 'not-the-token' });
  assert.equal(refused.status, 401);
  assert.deepEqual(refused.body, { error: 'unauthorized' });
});
