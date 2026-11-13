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
 * decides what a broken ledger means.
 */
async function callDurable(stub, url, body) {
  const response = await stub.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { ok: response.ok, body: await response.json().catch(() => ({})) };
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

  const { groupId, hostId, nameBlob, metaBlob } = input;
  if (!isId(groupId)) return json({ error: 'groupId' }, 400);
  if (!isId(hostId)) return json({ error: 'hostId' }, 400);
  if (!isSealed(nameBlob)) return json({ error: 'blob' }, 400);
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
      hostId,
      nameBlob,
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

async function handleApi(request, env, url) {
  const path = url.pathname.slice(API_PREFIX.length);
  if (path === '/health') return json({ ok: true, version: VERSION });
  if (path === '/create') return createGroup(request, env);
  if (path === '/ws') return openSocket(request, env, url);
  return json({ error: 'not_found' }, 404);
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
