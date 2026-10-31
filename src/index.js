/**
 * Splitter — the Worker in front of the app.
 *
 * Two jobs: serve the static SPA through the ASSETS binding (adding the site's security
 * headers), and hand /api/* to the app's own handlers.
 *
 * Nothing here can read a group: names, amounts, descriptions and splits arrive as AES-GCM
 * blobs sealed in the browser under a key derived from the group code, and the code itself is
 * never transmitted — only a hash of it is.
 */

const CANONICAL = '/w/expense-splitter';
const PREVIEW = '/w/expense-splitter-preview';
const API_PREFIX = `${CANONICAL}/api`;
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function redirect(url, pathname) {
  const target = new URL(url);
  target.pathname = pathname;
  return new Response(null, {
    status: 301,
    headers: { location: target.toString(), 'cache-control': 'no-store' }
  });
}

/* A missing page has to link back to the prefix that served it, and one static file cannot know
   which prefix that was — so the 404 is generated here, where the prefix is known. */
function notFound(prefix) {
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
  <p><a href="${prefix}/">Back to Splitter</a></p>
</main>
</body>
</html>
`, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/* An id the client can send: a group id from crypto.js (64 lowercase hex, a hash of the code) or
   the 22-character base64url shape a member id has. Both are opaque here — the ledger and the
   Durable Object name only need to be unforgeable and stable, and neither is a secret we can read
   anything out of. */
const ID = /^(?:[A-Za-z0-9_-]{22}|[0-9a-f]{64})$/;
/* A sealed value as crypto.js writes it: {iv, ct}, unpadded base64url, the iv 12 bytes. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const IV_LENGTH = 16;
/* A sealed name is a few hundred bytes; a body larger than this is not a create. */
const MAX_BODY_BYTES = 64 * 1024;

function isId(value) {
  return typeof value === 'string' && ID.test(value);
}

/* The Worker never opens a blob — it cannot, and must not be able to. It checks the envelope and
   stores the bytes as they arrived. */
function isSealed(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.iv === 'string' &&
    value.iv.length === IV_LENGTH &&
    BASE64URL.test(value.iv) &&
    typeof value.ct === 'string' &&
    value.ct.length > 0 &&
    BASE64URL.test(value.ct)
  );
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
 * Object is touched, so a malformed request costs no slot.
 */
async function createGroup(request, env) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json({ error: 'body' }, 400);

  let input;
  try {
    input = await request.json();
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
       must not free the slot the first create is holding. */
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
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const prefix =
      url.pathname === PREVIEW || url.pathname.startsWith(`${PREVIEW}/`) ? PREVIEW : CANONICAL;

    /* The preview route serves the canonical asset tree, so a file is never moved at cutover:
       /w/expense-splitter-preview/style.css reads /w/expense-splitter/style.css. */
    if (url.pathname === PREVIEW) return redirect(url, `${PREVIEW}/`);
    if (url.pathname.startsWith(`${PREVIEW}/`)) {
      url.pathname = CANONICAL + url.pathname.slice(PREVIEW.length);
    }

    if (url.pathname === CANONICAL) return redirect(url, `${CANONICAL}/`);

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
      const page = notFound(prefix);
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
