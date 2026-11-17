/**
 * Splitter — the Worker in front of the app.
 *
 * The app owns the root of its own origin (expense-splitter.332321.xyz). Two jobs: serve the
 * static SPA through the ASSETS binding (adding the site's security headers), and hand /api/*
 * to the app's own handlers.
 *
 * Nothing here can read a group: names, amounts, descriptions and splits arrive as AES-GCM
 * blobs sealed in the browser under a key derived from the group code, and the code itself is
 * never transmitted — only a hash of it is.
 */

/* The id and the sealed-blob shapes the Durable Objects check too, so the two checks cannot drift
   apart: an id the edge accepts must be one the Group stores, and vice versa. */
import { isGroupId, isId, isSealed } from './wire.js';

const API_PREFIX = '/api';
const VERSION = '0.1.0';

/* 'unsafe-inline' is needed by the pre-paint theme script in <head>; the page talks only to its
   own origin, so connect-src stays 'self' (WebSocket connections to the same origin are covered
   by connect-src). */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; '),
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=15552000; includeSubDomains; preload'
};

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

/* A missing page links back to Splitter, and one static file cannot know the origin it was served
   under — so the 404 is generated here. The app is the whole of its origin, so every path that is
   not an asset or an API route is a 404 from this Worker. */
function notFound() {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Not found</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; background: #0d1117; color: #e6edf3;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem; }
  h1 { margin: 0 0 0.5rem; font-size: 2rem; }
  p { color: #9198a1; }
  a { color: #4c8dff; }
</style>
</head>
<body>
<main>
  <h1>Not found</h1>
  <p>That page does not exist.</p>
  <p><a href="/">Back to Splitter</a></p>
</main>
</body>
</html>
`, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/* A sealed name is a few hundred bytes; a body larger than this is not a create. The cap is a
   limit on the bytes received, not on `content-length`: a chunked body carries no length header,
   and a declared one is only a claim. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Whether the create may look at this request's body at all.
 *
 * `application/json`, with a charset if one is declared, and nothing else. Any other media type is
 * a CORS-simple request: a page on another origin can send `text/plain` without a preflight, so a
 * cross-site fetch could otherwise spend a slot here with no negotiation at all. The base type is
 * compared whole rather than by prefix, so `application/json-patch+json` — a JSON type, but not the
 * one this API speaks — is refused instead of half-matching. Media types are case-insensitive, so
 * the comparison is too.
 */
function hasJsonContentType(request) {
  const header = request.headers.get('content-type');
  if (!header) return false;
  const [mediaType] = header.split(';');
  return mediaType.trim().toLowerCase() === 'application/json';
}

/**
 * The request body, refused the moment it exceeds the cap.
 *
 * `content-length` is read first because a refusal that costs no read is the cheap one, but it is
 * never trusted on its own: the body is counted as it arrives and reading stops at the cap, so an
 * unbounded body cannot be buffered and an oversized one never reaches the parser or a Durable
 * Object. The result is text, because the cap has to be decided on bytes and only then parsed.
 *
 * @returns {Promise<{text: string} | {tooLarge: true} | {failed: true}>}
 */
async function readCappedBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { tooLarge: true };
  if (!request.body) return { text: '' };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    /* The client went away mid-body: that is a bad request, not a server fault. */
    return { failed: true };
  } finally {
    reader.releaseLock?.();
  }

  return { text };
}

/**
 * One internal POST to a Durable Object.
 *
 * Both classes take their work over `fetch`, so a call is a request and there is no second calling
 * convention to keep in step. A failed call answers `ok: false` rather than throwing, so the caller
 * decides what a broken ledger means; the status travels because the operator surface passes it on
 * — a destroy that wiped the group but could not free its slot is a 502, not a 200.
 */
async function callDurable(stub, url, body) {
  const response = await stub.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.json().catch(() => ({}))
  };
}

/**
 * Reserve a slot and initialise the group.
 *
 * The body carries no plaintext: `groupId` and `hostId` are hashes, and the name and meta are
 * sealed under a key derived from the code in the browser. Everything is refused before a Durable
 * Object is touched — the method, the media type and every field — so a malformed request costs no
 * slot and no read.
 */
async function createGroup(request, env) {
  if (request.method !== 'POST') {
    /* RFC 9110: a 405 has to name the methods it does allow, or a client has to guess. */
    return json({ error: 'method' }, 405, { allow: 'POST' });
  }
  if (!hasJsonContentType(request)) return json({ error: 'body' }, 400);

  const body = await readCappedBody(request);
  if (body.tooLarge || body.failed) return json({ error: 'body' }, 400);

  let input;
  try {
    input = JSON.parse(body.text);
  } catch {
    return json({ error: 'body' }, 400);
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return json({ error: 'body' }, 400);
  }

  const { groupId, hostId, nameBlob, hostNameBlob, metaBlob } = input;
  /* One validator for a group id, and the same one `/destroy` uses: an id this route accepts but
     the destroy refuses is a group the Worker can create and never remove. */
  if (!isGroupId(groupId)) return json({ error: 'groupId' }, 400);
  if (!isId(hostId)) return json({ error: 'hostId' }, 400);
  if (!isSealed(nameBlob)) return json({ error: 'blob' }, 400);
  if (hostNameBlob !== undefined && hostNameBlob !== null && !isSealed(hostNameBlob)) {
    return json({ error: 'blob' }, 400);
  }
  if (metaBlob !== undefined && metaBlob !== null && !isSealed(metaBlob)) {
    return json({ error: 'blob' }, 400);
  }

  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
  const slot = await callDurable(registry, 'https://registry/reserve', { groupId });
  if (!slot.ok) return json({ error: 'internal' }, 500);
  if (!slot.body.ok) return json({ error: 'limit' }, 429);

  const group = env.GROUPS.get(env.GROUPS.idFromName(groupId));
  let initialised;
  try {
    initialised = await callDurable(group, 'https://group/init', {
      groupId,
      hostId,
      nameBlob,
      hostNameBlob: hostNameBlob ?? null,
      metaBlob: metaBlob ?? null
    });
  } catch {
    initialised = { ok: false };
  }

  if (!initialised.ok) {
    /* Only a call that took the slot gives it back: a retry found the group already there, and it
       must not free the slot the first create is holding.

       No HTTP request can reach this branch. The edge refuses every body the Group would refuse,
       because both read the same shapes from wire.js, so an init that the DO answers with a
       refusal cannot be produced by a request to /api/create. The path is therefore pinned by
       `create: a refused init gives its slot back` in tests/create.test.mjs, which calls this
       function with a Group binding that refuses — the release it records is this line. */
    if (slot.body.reserved) {
      await callDurable(registry, 'https://registry/release', { groupId }).catch(() => {});
    }
    return json({ error: 'internal' }, 500);
  }

  return json({ ok: true });
}

/* --------------------------------------------------------------- the operator surface */

/* The five routes that reach a Durable Object's own operator calls. The set is closed, so a path
   that merely ends in one of them is not a route. */
const OPERATOR_PATHS = new Set(['/stats', '/list', '/counters', '/destroy', '/release']);

const tokenEncoder = new TextEncoder();

/**
 * Whether two strings are the same, without the comparison saying how far it got.
 *
 * `===` on a secret stops at the first byte that differs, so the time it takes measures how much of
 * the token a caller guessed right. Both sides are hashed first — which makes the compared values
 * one length whatever was sent — and the digests are then walked byte by byte with no early exit.
 */
async function sameToken(presented, expected) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', tokenEncoder.encode(presented)),
    crypto.subtle.digest('SHA-256', tokenEncoder.encode(expected))
  ]);
  const mine = new Uint8Array(left);
  const theirs = new Uint8Array(right);
  let difference = mine.length ^ theirs.length;
  for (let at = 0; at < mine.length; at += 1) difference |= mine[at] ^ theirs[at];
  return difference === 0;
}

/**
 * Refuse this request unless it may use the operator surface; `null` means it may.
 *
 * With no `OPERATOR_TOKEN` the surface does not exist: every one of its paths answers the 404 an
 * unknown path answers, so a deployment that never configured an operator has nothing to probe.
 * With one set, the request has to carry it as `Authorization: Bearer <token>`, compared in
 * constant time; a missing, malformed or wrong credential is a 401 that names the scheme.
 */
async function operatorDenied(request, env) {
  const expected = env?.OPERATOR_TOKEN;
  if (typeof expected !== 'string' || expected === '') return json({ error: 'not_found' }, 404);

  const header = request.headers.get('authorization') ?? '';
  const space = header.indexOf(' ');
  const scheme = (space === -1 ? header : header.slice(0, space)).trim();
  const presented = space === -1 ? '' : header.slice(space + 1).trim();
  if (scheme.toLowerCase() !== 'bearer' || presented === '') {
    return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
  }
  if (!(await sameToken(presented, expected))) {
    return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
  }
  return null;
}

/**
 * The request body as a JSON object: `{}` when there is none, `null` when it is not one.
 *
 * The same cap a create is held to, and for the same reason: the body is counted as it arrives and
 * reading stops at the limit, so an oversized one is refused rather than buffered.
 */
async function jsonBody(request) {
  const body = await readCappedBody(request);
  if (body.tooLarge || body.failed) return null;
  if (body.text.trim() === '') return {};
  let input;
  try {
    input = JSON.parse(body.text);
  } catch {
    return null;
  }
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? input : null;
}

/**
 * The operator surface: what the ledger holds, what one group holds, and the two calls that give a
 * slot back.
 *
 * Every route is guarded before anything else, so nothing below can be reached without the token.
 * `/stats` and `/list` are the ledger's; `/counters` and `/destroy` act on the group the body
 * names, because the id is the only thing that names a Durable Object here; `/release` acts on the
 * ledger's row the body names. The answer is the object's own, status included: a group that wiped
 * but could not free its slot answers 502 with `released: false`, and an answer that flattened that
 * into a 200 would report a slot the ledger still holds as free.
 *
 * `/destroy` takes a group id — the 64 lowercase hexadecimal characters a create derives, which is
 * also the shape `/ws` and `/room` name a room by. It removes that group and frees the slot the
 * group holds. A ledger row that no group names — a 22-character id an older `/create` accepted,
 * which still appears in `/list` and still counts in `/stats` — is refused there (400, `groupId`)
 * and is freed by id through `/release`. That is the split between the two routes: `/destroy` names
 * a group, `/release` names a ledger row, and no route claims to take an id it cannot act on. A row
 * whose group is still live is therefore freed by `/destroy`, which removes the group as well;
 * `/release` frees the row alone and leaves the object alone, so it asks the group first and
 * refuses with a 409 when the group answers: it is the route for a row that no group answers for.
 */
async function handleOperator(request, env, path) {
  const denied = await operatorDenied(request, env);
  if (denied) return denied;

  if (path === '/stats') {
    if (request.method !== 'GET') return json({ error: 'method' }, 405, { allow: 'GET' });
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
    const answer = await callDurable(registry, 'https://registry/stats', {});
    return json(answer.body, answer.status);
  }

  if (request.method !== 'POST') return json({ error: 'method' }, 405, { allow: 'POST' });

  const input = await jsonBody(request);
  if (input === null) return json({ error: 'body' }, 400);

  if (path === '/list') {
    /* The cursor is the last id of the page before; absent or empty asks for the first page. */
    const cursor = input.cursor ?? '';
    if (typeof cursor !== 'string') return json({ error: 'cursor' }, 400);
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
    const answer = await callDurable(
      registry,
      'https://registry/list',
      cursor === '' ? {} : { cursor }
    );
    return json(answer.body, answer.status);
  }

  if (path === '/release') {
    /* A ledger row is named by its id, and nothing else: the caller is not pointing at a group, so
       the shapes a row can hold are the shapes a create ever accepted, 22 characters or 64 — not
       only the group id `/destroy` takes. `freed` is the ledger's own count, so an id it does not
       hold answers 0 rather than an error: there is nothing left to free.

       A group id is also a group, though, and a row whose group still answers is that group's
       slot: freeing the row alone would leave a live object the ledger no longer counts. The group
       is asked the same question `/counters` and `/list` ask, and anything but the 404 that says
       it holds no group is a live group — refused, nothing freed, with `/destroy` the route that
       removes the group and its row together. An id of any other shape names no group this
       surface can address (`/destroy` refuses it), so it is a ledger row and nothing more. */
    if (!isId(input.groupId)) return json({ error: 'groupId' }, 400);
    if (isGroupId(input.groupId)) {
      const group = env.GROUPS.get(env.GROUPS.idFromName(input.groupId));
      const live = await callDurable(group, 'https://group/counters', {});
      if (live.status !== 404) return json({ error: 'group_live' }, 409);
    }
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
    const answer = await callDurable(registry, 'https://registry/release', {
      groupId: input.groupId
    });
    return json(answer.body, answer.status);
  }

  /* `/counters` and `/destroy` name one group, and a group is named by its 64 hexadecimal
     characters. A ledger row an older create wrote under a 22-character id names no group, so it is
     refused here rather than half-addressed: `/release` is the route that frees a row by id. */
  if (!isGroupId(input.groupId)) return json({ error: 'groupId' }, 400);
  const group = env.GROUPS.get(env.GROUPS.idFromName(input.groupId));
  const answer = await callDurable(group, `https://group${path}`, {});
  return json(answer.body, answer.status);
}

async function handleApi(request, env, url) {
  const path = url.pathname.slice(API_PREFIX.length);
  if (path === '/health') return json({ ok: true, version: VERSION });
  if (path === '/create') return createGroup(request, env);
  if (path === '/room') return roomInfo(request, env, url);
  if (path === '/ws') return openSocket(request, env, url);
  if (OPERATOR_PATHS.has(path)) return handleOperator(request, env, path);
  return json({ error: 'not_found' }, 404);
}

/** Answer whether a room exists, without opening a socket or revealing anything it holds. */
function roomInfo(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405, { allow: 'GET' });
  const room = url.searchParams.get('room');
  if (!isGroupId(room)) return json({ error: 'room' }, 400);
  return env.GROUPS.get(env.GROUPS.idFromName(room)).fetch(request);
}

/**
 * Hand a socket to the group it names.
 *
 * The room is the group id, a hash of the code: it selects the Durable Object, and it is not a
 * credential. Authentication is the first frame, inside the group, so a URL never carries a
 * secret and a socket with no frame receives nothing.
 *
 * A browser always sends `Origin`, and a page on another site cannot forge it; when one arrives and
 * does not name this host, the upgrade is refused before it reaches the group. A non-browser client
 * may send no Origin at all — it still needs the secret in the first frame, so the missing header
 * is not a bypass.
 */
function openSocket(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405, { allow: 'GET' });

  const origin = request.headers.get('origin');
  if (origin !== null) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === url.host;
    } catch {
      sameHost = false;
    }
    if (!sameHost) return json({ error: 'origin' }, 403);
  }

  const room = url.searchParams.get('room');
  if (!isGroupId(room)) return json({ error: 'room' }, 400);

  const upgrade = request.headers.get('upgrade');
  if ((upgrade ?? '').toLowerCase() !== 'websocket') {
    return json({ error: 'upgrade' }, 426, { upgrade: 'websocket' });
  }

  return env.GROUPS.get(env.GROUPS.idFromName(room)).fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      try {
        return await handleApi(request, env, url);
      } catch {
        return json({ error: 'internal' }, 500);
      }
    }

    const assetUrl = new URL(url.pathname + url.search, url.origin);
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    const headers = new Headers(response.headers);

    if (response.status === 404) {
      const page = notFound();
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
      for (const [name, value] of page.headers) headers.set(name, value);
      return new Response(page.body, { status: 404, headers });
    }

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    if (!headers.has('cache-control')) {
      headers.set('cache-control', 'public, max-age=0, must-revalidate');
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};

/* The classes the bindings in wrangler.toml name. */
export { Group } from './group.js';
export { Registry } from './registry.js';
