/**
 * The mount: every request on the prefix reaches the Worker, and only the Worker.
 *
 * Two defects this suite is the gate for. First, a second prefix (`/w/expense-splitter-preview/`)
 * used to be rewritten onto the canonical one before dispatch, so a preview URL could reach the
 * production API and write to production storage while its name promised isolation. Second, a
 * slash-less path carrying a query string is not matched by a route pattern without a wildcard,
 * so it used to fall through to the origin behind the zone — a page with no CSP, no COOP and a
 * third-party script — instead of being redirected into the Worker.
 *
 * The route pattern itself can only be proven against the deployed zone; what this suite proves is
 * the Worker's half of both guarantees, against a real `wrangler dev`, without touching production.
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { startWorker } from './wrangler.mjs';

const CANONICAL = '/w/expense-splitter';
const REMOVED_PREFIX = '/w/expense-splitter-preview';

let worker;

before(async () => {
  worker = await startWorker();
});

after(async () => {
  await worker?.stop();
});

/** A request that does not follow redirects, so the status and headers are the Worker's own. */
async function get(path) {
  const response = await fetch(`${worker.baseUrl}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text().catch(() => '');
  return { status: response.status, headers: response.headers, text };
}

test('the canonical page is served with the security headers', async () => {
  const { status, headers } = await get(`${CANONICAL}/`);

  assert.equal(status, 200);
  for (const name of [
    'content-security-policy',
    'cross-origin-opener-policy',
    'permissions-policy',
    'referrer-policy',
    'x-content-type-options'
  ]) {
    assert.ok(headers.get(name), `${name} must be set by the Worker, not left to a static file`);
  }
});

test('a slash-less path redirects into the mount and keeps the query string', async () => {
  const { status, headers } = await get(`${CANONICAL}?x=1`);

  assert.equal(status, 301, 'the bare path must not be answered by whatever sits behind the zone');
  const location = new URL(headers.get('location'));
  assert.equal(location.pathname, `${CANONICAL}/`);
  assert.equal(location.search, '?x=1', 'a parameter a chat client added must survive the redirect');
});

test('a missing page is a Worker 404, with the headers and no third-party script', async () => {
  const { status, headers, text } = await get(`${CANONICAL}/nope`);

  assert.equal(status, 404);
  assert.ok(headers.get('content-security-policy'), 'the 404 carries the same CSP');
  assert.ok(headers.get('cross-origin-opener-policy'));
  assert.ok(!/https?:\/\//.test(text), 'the generated 404 loads nothing but its own prefix');
});

test('the preview prefix is gone: it answers no API call and reaches no group', async () => {
  const api = await get(`${REMOVED_PREFIX}/api/health`);
  assert.notEqual(api.status, 200, 'a preview URL must not reach the API at all');
  assert.notEqual(api.headers.get('content-type'), 'application/json; charset=utf-8');

  const page = await get(`${REMOVED_PREFIX}/`);
  assert.notEqual(page.status, 200, 'the removed mount is not an alias of the canonical one');

  const create = await fetch(`${worker.baseUrl}${REMOVED_PREFIX}/api/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000)
  });
  assert.notEqual(create.status, 200, 'a preview write must never reserve a slot');
});
