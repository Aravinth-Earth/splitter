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

async function handleApi(request, env, url) {
  const path = url.pathname.slice(API_PREFIX.length);
  if (path === '/health') return json({ ok: true, version: VERSION });
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
