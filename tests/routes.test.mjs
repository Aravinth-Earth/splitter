/**
 * The origin: the app answers the root of its own host, and no path from the old site mount does.
 *
 * Two defects this suite is the gate for. First, a second prefix (`/w/expense-splitter-preview/`)
 * used to be rewritten onto the canonical one before dispatch, so a preview URL could reach the
 * production API and write to production storage while its name promised isolation. Second, the
 * app used to share the main site's origin under `/w/expense-splitter/`, so the site's own files
 * and the app's security headers lived on one host. It now owns its origin outright, and the old
 * path is a static page in the site repository, not an alias of this Worker.
 *
 * The route pattern itself can only be proven against the deployed zone; what this suite proves is
 * the Worker's half of both guarantees, against a real `wrangler dev`, without touching production.
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { startWorker } from './wrangler.mjs';

const REMOVED_PREFIX = '/w/expense-splitter-preview';
const OLD_SITE_MOUNT = '/w/expense-splitter';

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

test('the page is served at the root with the security headers', async () => {
  const { status, headers } = await get('/');

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

test('a missing page is a Worker 404, with the headers and no third-party script', async () => {
  const { status, headers, text } = await get('/nope');

  assert.equal(status, 404);
  assert.ok(headers.get('content-security-policy'), 'the 404 carries the same CSP');
  assert.ok(headers.get('cross-origin-opener-policy'));
  assert.ok(!/https?:\/\//.test(text), 'the generated 404 loads nothing but its own origin');
});

test('the preview prefix is gone: it answers no API call and reaches no group', async () => {
  const api = await get(`${REMOVED_PREFIX}/api/health`);
  assert.notEqual(api.status, 200, 'a preview URL must not reach the API at all');
  assert.notEqual(api.headers.get('content-type'), 'application/json; charset=utf-8');

  const page = await get(`${REMOVED_PREFIX}/`);
  assert.notEqual(page.status, 200, 'the removed mount is not an alias of the app');

  const create = await fetch(`${worker.baseUrl}${REMOVED_PREFIX}/api/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000)
  });
  assert.notEqual(create.status, 200, 'a preview write must never reserve a slot');
});

test('the old site mount is not an alias: the site owns that path now', async () => {
  const page = await get(`${OLD_SITE_MOUNT}/`);
  assert.equal(page.status, 404, 'the app must not answer the main site path');

  const api = await get(`${OLD_SITE_MOUNT}/api/health`);
  assert.notEqual(api.status, 200, 'the old path must not reach the API');
  assert.notEqual(api.headers.get('content-type'), 'application/json; charset=utf-8');

  const create = await fetch(`${worker.baseUrl}${OLD_SITE_MOUNT}/api/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000)
  });
  assert.notEqual(create.status, 200, 'an old-path write must never reserve a slot');
});
