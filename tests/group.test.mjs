/**
 * The Group Durable Object on its own: what it refuses, and which paths it serves.
 *
 * `/api/create` proves the happy path end to end; this file proves the write itself. Two promises
 * are pinned here. First, `init` is the call that makes a group exist, so it checks the body it is
 * given — an unvalidated init stored `hostId: undefined` for an empty body, a group nobody hosts and
 * nobody can join. Second, the class routes on the whole pathname: a suffix match sent
 * `POST /nope/init` down the init branch, so a URL that merely ended in `/init` initialised a group.
 *
 * No network and no `wrangler dev`: the class is driven through its own `fetch`, with the storage
 * API replaced by a Map. The stand-in records every write, so "refused" means nothing was stored,
 * not merely that the answer looked wrong.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { Group, GROUP_KEY } from '../src/group.js';

/** 22 characters: 16 bytes, base64url, unpadded — the id shape the client sends. */
function id22() {
  return randomBytes(16).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A sealed value as crypto.js writes it: a 16-character iv (12 bytes) and a ciphertext. */
function sealed(bytes = 96) {
  return {
    iv: randomBytes(12).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    ct: randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  };
}

/** A Group over one Map, plus the map itself so a test can see whether anything was written. */
function newGroup() {
  const stored = new Map();
  const ctx = {
    storage: {
      get: async (key) => stored.get(key),
      put: async (key, value) => {
        stored.set(key, value);
      }
    }
  };
  return { group: new Group(ctx, {}), stored };
}

/** A request the Worker itself would make: JSON, POST, to `path`. */
function post(group, payload, { path = '/init', method = 'POST', raw } = {}) {
  return group.fetch(
    new Request(`https://group${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'HEAD' ? undefined : (raw ?? JSON.stringify(payload))
    })
  );
}

test('group: an empty init body is refused and writes nothing', async () => {
  const { group, stored } = newGroup();

  const response = await post(group, {});
  assert.equal(response.status, 400, 'an init with no host must not answer ok');
  assert.deepEqual(await response.json(), { ok: false, error: 'hostId' });
  assert.equal(stored.size, 0, 'a refused init must not write a group with no host');
});

test('group: an init without a usable host id or sealed name is refused', async () => {
  const cases = [
    { hostId: 'host', nameBlob: sealed() },
    { hostId: id22() },
    { hostId: id22(), nameBlob: { iv: 'AAAAAAAAAAAAAAAA' } },
    /* 12 characters, not 16: an iv counted in bytes is refused as a sealed value. */
    { hostId: id22(), nameBlob: { iv: 'A'.repeat(12), ct: 'AAAA' } },
    { hostId: id22(), nameBlob: sealed(), metaBlob: 'meta' }
  ];

  for (const payload of cases) {
    const { group, stored } = newGroup();
    const response = await post(group, payload);
    assert.equal(response.status, 400, `${JSON.stringify(payload)} must be refused by the write itself`);
    const body = await response.json();
    assert.equal(body.ok, false, 'a refusal must be told apart from a write');
    assert.equal(stored.size, 0, 'a refused init must store nothing');
  }
});

test('group: an absent meta is allowed, and a valid init writes the meta once', async () => {
  const { group, stored } = newGroup();
  const hostId = id22();

  const first = await post(group, { hostId, nameBlob: sealed() });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, created: true });
  assert.equal(stored.get(GROUP_KEY).hostId, hostId);
  assert.equal(stored.get(GROUP_KEY).metaBlob, null, 'an absent meta is stored as null');

  /* A retry answers ok without a second write. */
  const second = await post(group, { hostId: id22(), nameBlob: sealed() });
  assert.deepEqual(await second.json(), { ok: true, created: false });
  assert.equal(stored.get(GROUP_KEY).hostId, hostId, 'the first host stands');
});

test('group: only /init is routed, so a path that merely ends in it is not an init', async () => {
  const { group, stored } = newGroup();

  const response = await post(group, { hostId: id22(), nameBlob: sealed() }, { path: '/nope/init' });
  assert.equal(response.status, 404, 'POST /nope/init must not initialise the group');
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(stored.size, 0, 'an unrouted path must leave the group unwritten');
});

test('group: a method other than POST is refused and names the method it allows', async () => {
  const { group } = newGroup();

  const response = await post(group, null, { method: 'GET' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST', 'a 405 must carry Allow: POST');
  assert.deepEqual(await response.json(), { error: 'method' });
});

test('group: a body that is not a JSON object is a bad request', async () => {
  const { group, stored } = newGroup();

  const response = await post(group, null, { raw: '[' });
  assert.equal(response.status, 400, 'an unparseable init body must not reach the write');
  assert.deepEqual(await response.json(), { error: 'bad_request' });
  assert.equal(stored.size, 0);
});
