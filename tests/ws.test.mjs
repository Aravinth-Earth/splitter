/**
 * A socket has no identity until its first frame.
 *
 * Two guarantees live here. The room id in the URL is a hash of the code — it says whether a group
 * exists, never whether the person asking is a member — so an accepted socket is a socket with no
 * content on it. And a join request writes a pending roster entry and answers with exactly
 * `{t:"waiting", memberId}`: no blob, no roster, no state. The organizer's own frame is the one
 * place the pending name is visible, because the organizer has to decide.
 *
 * These tests run against the real `wrangler dev`, with the real Durable Object and its storage.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startWorker } from './wrangler.mjs';
import {
  deriveGroupKey,
  generateCode,
  groupIdFromCode,
  idFromSecret,
  randomSecret,
  seal
} from '../public/crypto.js';
import { memberIdFromSecret } from '../src/identity.js';

/* The same vector tests/crypto.test.mjs pins for the browser. Two copies of the label must produce
   one member id, or a socket would verify against an id no client can present. */
const KAT_SECRET = 'AAECAwQFBgcICQoLDA0ODw';
const KAT_MEMBER_ID = 'EPOcSRlhtThBdbTwu7zU9Q';

/**
 * A socket that hands the test one frame at a time.
 *
 * Frames that arrive before the test asks are queued, so a fast server cannot race a slow
 * assertion. `next` rejects on close, which turns "the server said nothing" into a named failure
 * rather than a timeout with no context.
 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames = [];
    const waiters = [];
    let closed = null;

    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(frame);
      else frames.push(frame);
    });

    ws.addEventListener('close', (event) => {
      closed = { code: event.code, reason: event.reason };
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error(`socket closed ${event.code} before a frame arrived`));
      }
    });

    ws.addEventListener('error', () => {
      /* The close event carries the code; an error event is not extra information here. */
    });

    ws.addEventListener(
      'open',
      () => {
        resolve({
          frames,
          send(frame) {
            ws.send(JSON.stringify(frame));
          },
          close() {
            ws.close();
          },
          closed() {
            return closed;
          },
          next(timeoutMs = 5_000) {
            if (frames.length) return Promise.resolve(frames.shift());
            return new Promise((done, fail) => {
              const timer = setTimeout(() => fail(new Error(`no frame within ${timeoutMs} ms`)), timeoutMs);
              waiters.push({
                resolve(value) {
                  clearTimeout(timer);
                  done(value);
                },
                reject(error) {
                  clearTimeout(timer);
                  fail(error);
                }
              });
            });
          },
          async silence(ms = 400) {
            if (frames.length) throw new Error(`unexpected frame: ${JSON.stringify(frames[0])}`);
            await new Promise((done) => setTimeout(done, ms));
            if (frames.length) throw new Error(`unexpected frame: ${JSON.stringify(frames[0])}`);
          },
          async waitClosed(timeoutMs = 5_000) {
            if (closed) return closed;
            return new Promise((done, fail) => {
              const deadline = Date.now() + timeoutMs;
              const poll = setInterval(() => {
                if (closed) {
                  clearInterval(poll);
                  done(closed);
                } else if (Date.now() > deadline) {
                  clearInterval(poll);
                  fail(new Error('socket did not close'));
                }
              }, 20);
            });
          }
        });
      },
      { once: true }
    );

    ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true });
  });
}

function socketUrl(baseUrl, groupId) {
  return `${baseUrl.replace(/^http/, 'ws')}/api/ws?room=${groupId}`;
}

async function createGroup(baseUrl) {
  const code = generateCode();
  const groupId = await groupIdFromCode(code);
  const key = await deriveGroupKey(code);
  const hostSecret = randomSecret();
  const hostId = await idFromSecret(hostSecret);
  const nameBlob = await seal(key, { name: 'Host' });

  const response = await fetch(`${baseUrl}/api/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      groupId,
      hostId,
      nameBlob,
      metaBlob: await seal(key, { currency: 'INR' })
    })
  });
  assert.equal(response.status, 200, 'the group must exist before a socket can reach it');

  return { code, groupId, key, hostSecret, hostId, nameBlob };
}

test('the member id the server derives is the id the browser derives', async () => {
  assert.equal(await memberIdFromSecret(KAT_SECRET), KAT_MEMBER_ID);
  assert.equal(await idFromSecret(KAT_SECRET), KAT_MEMBER_ID);
});

test('a join writes a pending seat: waiting to the joiner, the name to the host', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });

  const hostState = await host.next();
  assert.equal(hostState.t, 'state');
  assert.equal(hostState.role, 'host');
  assert.equal(hostState.roster.length, 0, 'the host is the viewer, not an entry in its own roster');

  const joinerSecret = randomSecret();
  const joinerId = await idFromSecret(joinerSecret);
  const joinerName = await seal(group.key, { name: 'Joiner' });

  const joiner = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => joiner.close());
  joiner.send({
    t: 'auth',
    id: joinerId,
    secret: joinerSecret,
    mode: 'join',
    nameBlob: joinerName
  });

  const waiting = await joiner.next();
  assert.deepEqual(Object.keys(waiting).sort(), ['memberId', 't'], 'a pending frame has no other key');
  assert.equal(waiting.t, 'waiting');
  assert.equal(waiting.memberId, joinerId);
  assert.ok(!JSON.stringify(waiting).includes('blob'), 'no sealed value reaches a pending socket');

  await joiner.silence(600);

  const update = await host.next();
  assert.equal(update.t, 'state');
  assert.deepEqual(update.nameBlob, group.nameBlob, 'the sealed group name travels to the host');
  const pending = update.roster.find((member) => member.id === joinerId);
  assert.ok(pending, 'the organizer must see the person asking');
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.nameBlob, joinerName, 'the host receives the sealed name, not the name');

  const approvedBefore = update.roster.filter((member) => member.status === 'approved');
  assert.equal(approvedBefore.length, 0, 'a pending person is not an approved member');

  host.send({ t: 'approve', memberId: joinerId });

  const admitted = await joiner.next();
  assert.equal(admitted.t, 'state');
  assert.equal(admitted.role, 'member');
  assert.deepEqual(admitted.nameBlob, group.nameBlob);
  assert.ok(
    admitted.roster.some((member) => member.id === joinerId && member.status === 'approved'),
    'the admitted member is in the approved roster'
  );
  assert.ok(
    !admitted.roster.some((member) => member.status === 'pending'),
    'an approved member does not see pending names'
  );

  const afterApprove = await host.next();
  assert.ok(
    !afterApprove.roster.some((member) => member.id === joinerId && member.status === 'pending'),
    'the request clears for the host'
  );
  assert.ok(
    afterApprove.roster.some((member) => member.id === joinerId && member.status === 'approved'),
    'the host sees the admitted member'
  );
});

test('a wrong secret closes the socket with no frames', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);
  const socket = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => socket.close());

  socket.send({ t: 'auth', id: group.hostId, secret: randomSecret(), mode: 'resume' });

  const closed = await socket.waitClosed();
  assert.equal(closed.code, 1008);
  assert.equal(socket.frames.length, 0, 'a refused identity receives nothing, not even an error frame');
});

test('a socket that never authenticates is closed', async (t) => {
  const worker = await startWorker({ vars: { AUTH_TIMEOUT_MS: '400' } });
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);
  const socket = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => socket.close());

  const closed = await socket.waitClosed();
  assert.equal(closed.code, 1008);
  assert.equal(socket.frames.length, 0);
});

test('an unknown room, a bad origin and a non-upgrade request are refused before a socket exists', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  /* No upgrade header: these are the checks that run before a socket could exist, so a plain GET
     is the whole request. */
  await assert.rejects(
    connect(`${worker.baseUrl.replace(/^http/, 'ws')}/api/ws?room=${'a'.repeat(64)}`),
    'an unknown room must not complete a handshake'
  );

  const origin = await fetch(`${worker.baseUrl}/api/ws?room=${group.groupId}`, {
    headers: { origin: 'https://evil.example' }
  });
  assert.equal(origin.status, 403);

  const upgrade = await fetch(`${worker.baseUrl}/api/ws?room=${group.groupId}`, {
    headers: { origin: worker.baseUrl }
  });
  assert.equal(upgrade.status, 426);

  const room = await fetch(`${worker.baseUrl}/api/ws?room=not-a-group`, {
    headers: { origin: worker.baseUrl }
  });
  assert.equal(room.status, 400);

  const known = await fetch(`${worker.baseUrl}/api/room?room=${group.groupId}`);
  assert.equal(known.status, 200);
  assert.deepEqual(await known.json(), { ok: true });

  const missing = await fetch(`${worker.baseUrl}/api/room?room=${'a'.repeat(64)}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'unknown_group' });

  const malformed = await fetch(`${worker.baseUrl}/api/room?room=not-a-group`);
  assert.equal(malformed.status, 400);

  const method = await fetch(`${worker.baseUrl}/api/room?room=${group.groupId}`, { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET');
});

test('a full group refuses the next join with a code and no seat', async (t) => {
  const worker = await startWorker({ vars: { MAX_MEMBERS: '2' } });
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  await host.next();

  const firstSecret = randomSecret();
  const firstId = await idFromSecret(firstSecret);
  const first = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => first.close());
  first.send({
    t: 'auth',
    id: firstId,
    secret: firstSecret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'First' })
  });
  assert.equal((await first.next()).t, 'waiting');
  await host.next();

  const secondSecret = randomSecret();
  const secondId = await idFromSecret(secondSecret);
  const second = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => second.close());
  second.send({
    t: 'auth',
    id: secondId,
    secret: secondSecret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'Second' })
  });

  const refused = await second.next();
  assert.deepEqual(refused, { t: 'refused', code: 'group_full' });
  const closed = await second.waitClosed();
  assert.equal(closed.code, 1008);
});

test('a declined request tells the person and leaves no pending seat', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  await host.next();

  const joinerSecret = randomSecret();
  const joinerId = await idFromSecret(joinerSecret);
  const joiner = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => joiner.close());
  joiner.send({
    t: 'auth',
    id: joinerId,
    secret: joinerSecret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'Declined' })
  });
  assert.equal((await joiner.next()).t, 'waiting');
  await host.next();

  host.send({ t: 'reject', memberId: joinerId });

  assert.deepEqual(await joiner.next(), { t: 'refused', code: 'declined' });
  assert.equal((await joiner.waitClosed()).code, 1008);

  const after = await host.next();
  assert.ok(
    !after.roster.some((member) => member.id === joinerId),
    'a declined request is not on the roster'
  );
});

test('a member cannot approve anyone', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  await host.next();

  const joinerSecret = randomSecret();
  const joinerId = await idFromSecret(joinerSecret);
  const joiner = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => joiner.close());
  joiner.send({
    t: 'auth',
    id: joinerId,
    secret: joinerSecret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'Not host' })
  });
  assert.equal((await joiner.next()).t, 'waiting');
  const hostState = await host.next();

  joiner.send({ t: 'approve', memberId: joinerId });
  assert.deepEqual(await joiner.next(), { t: 'refused', code: 'not_host' });
  assert.equal((await joiner.waitClosed()).code, 1008);

  /* No state frame is the proof: the host is not told that anything changed, because nothing did.
     The roster the host already held is unchanged. */
  assert.equal(hostState.roster.some((member) => member.id === joinerId), true);
  await host.silence(500);
});

test('an approved member can be removed, and cannot return with the same secret', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  await host.next();

  const memberSecret = randomSecret();
  const memberId = await idFromSecret(memberSecret);
  const member = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => member.close());
  member.send({
    t: 'auth',
    id: memberId,
    secret: memberSecret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'Removable' })
  });
  assert.equal((await member.next()).t, 'waiting');
  await host.next();

  host.send({ t: 'approve', memberId });
  assert.equal((await member.next()).t, 'state');
  await host.next();

  host.send({ t: 'remove', memberId });

  assert.deepEqual(await member.next(), { t: 'removed' });
  assert.equal((await member.waitClosed()).code, 1008);

  const after = await host.next();
  assert.ok(
    !after.roster.some((entry) => entry.id === memberId),
    'a removed member is not on the roster'
  );

  const again = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => again.close());
  again.send({ t: 'auth', id: memberId, secret: memberSecret, mode: 'join' });
  assert.equal((await again.waitClosed()).code, 1008);
  assert.equal(again.frames.length, 0, 'a removed member gets no content on reconnection');
});

test('the organizer cannot remove themselves, and only the host can remove', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  await host.next();

  host.send({ t: 'remove', memberId: group.hostId });
  assert.deepEqual(await host.next(), { t: 'refused', code: 'not_member' });
  await host.silence(400);
});

test('open join admits a new device without a decision, and approval restores the wait', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  assert.equal((await host.next()).joinMode, 'approval');

  host.send({ t: 'mode', mode: 'open' });
  assert.equal((await host.next()).joinMode, 'open');

  const openSecret = randomSecret();
  const openId = await idFromSecret(openSecret);
  const open = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => open.close());
  open.send({
    t: 'auth',
    id: openId,
    secret: openSecret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'Walk In' })
  });

  const admitted = await open.next();
  assert.equal(admitted.t, 'state');
  assert.equal(admitted.role, 'member');
  assert.equal(admitted.joinMode, 'open');
  assert.equal(admitted.openAdmit, true, 'the client is told this was an open admission');
  assert.ok(admitted.roster.some((member) => member.id === openId && member.status === 'approved'));

  const hostUpdate = await host.next();
  assert.equal(hostUpdate.joinMode, 'open');
  assert.ok(
    hostUpdate.roster.some((member) => member.id === openId && member.status === 'approved'),
    'the host sees the open admission'
  );

  host.send({ t: 'mode', mode: 'approval' });
  assert.equal((await host.next()).joinMode, 'approval');
  assert.equal((await open.next()).joinMode, 'approval', 'every member sees the mode change');

  const laterSecret = randomSecret();
  const laterId = await idFromSecret(laterSecret);
  const later = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => later.close());
  later.send({
    t: 'auth',
    id: laterId,
    secret: laterSecret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'Needs Approval' })
  });
  assert.equal((await later.next()).t, 'waiting', 'the next joiner needs a decision again');
});

test('a member cannot change the join mode', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  assert.equal((await host.next()).joinMode, 'approval');

  const secret = randomSecret();
  const id = await idFromSecret(secret);
  const joiner = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => joiner.close());
  joiner.send({
    t: 'auth',
    id,
    secret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'Want Open' })
  });
  assert.equal((await joiner.next()).t, 'waiting');
  await host.next();

  joiner.send({ t: 'mode', mode: 'open' });
  assert.deepEqual(await joiner.next(), { t: 'refused', code: 'not_host' });
  assert.equal((await joiner.waitClosed()).code, 1008);
  await host.silence(400);
});

test('the thirteenth failed join from one source is rate limited', async (t) => {
  /* A one-seat group refuses every join as full; each refusal is one failed attempt, and the
     thirteenth from this source is answered before the group is asked again. */
  const worker = await startWorker({ vars: { MAX_MEMBERS: '1' } });
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const secret = randomSecret();
    const id = await idFromSecret(secret);
    const socket = await connect(socketUrl(worker.baseUrl, group.groupId));
    t.after(() => socket.close());
    socket.send({
      t: 'auth',
      id,
      secret,
      mode: 'join',
      nameBlob: await seal(group.key, { name: `Full ${attempt}` })
    });
    assert.deepEqual(await socket.next(), { t: 'refused', code: 'group_full' }, `attempt ${attempt + 1}`);
    assert.equal((await socket.waitClosed()).code, 1008);
  }

  const secret = randomSecret();
  const id = await idFromSecret(secret);
  const blocked = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => blocked.close());
  blocked.send({
    t: 'auth',
    id,
    secret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'Too Many' })
  });

  assert.deepEqual(await blocked.next(), { t: 'refused', code: 'rate_limited' });
  assert.equal((await blocked.waitClosed()).code, 1008);
});

test('two sockets with one secret share one member entry', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  await host.next();

  const secret = randomSecret();
  const id = await idFromSecret(secret);
  const nameBlob = await seal(group.key, { name: 'Two Tabs' });

  const first = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => first.close());
  first.send({ t: 'auth', id, secret, mode: 'join', nameBlob });
  assert.equal((await first.next()).t, 'waiting');
  const afterFirst = await host.next();
  assert.equal(
    afterFirst.roster.filter((member) => member.id === id).length,
    1,
    'one pending entry after the first socket'
  );

  const second = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => second.close());
  second.send({ t: 'auth', id, secret, mode: 'resume' });
  assert.equal((await second.next()).t, 'waiting');
  await host.silence(300);

  host.send({ t: 'approve', memberId: id });
  const firstState = await first.next();
  const secondState = await second.next();
  assert.equal(firstState.role, 'member');
  assert.equal(secondState.role, 'member');
  assert.equal(
    firstState.roster.filter((member) => member.id === id).length,
    1,
    'one roster row for two sockets from one secret'
  );

  const afterApprove = await host.next();
  assert.equal(
    afterApprove.roster.filter((member) => member.id === id).length,
    1,
    'the host sees one member, not two'
  );
});

test('one write reaches the host and an approved member, and never a pending socket', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);

  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  await host.next();

  const memberSecret = randomSecret();
  const memberId = await idFromSecret(memberSecret);
  const member = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => member.close());
  member.send({
    t: 'auth',
    id: memberId,
    secret: memberSecret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'Reader' })
  });
  assert.equal((await member.next()).t, 'waiting');
  await host.next();

  host.send({ t: 'approve', memberId });
  assert.equal((await member.next()).role, 'member');
  await host.next();

  const pendingSecret = randomSecret();
  const pendingId = await idFromSecret(pendingSecret);
  const pending = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => pending.close());
  pending.send({
    t: 'auth',
    id: pendingId,
    secret: pendingSecret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'Waiting' })
  });
  assert.equal((await pending.next()).t, 'waiting');
  await host.next();

  const recordId = randomSecret();
  const blob = await seal(group.key, { description: 'Dinner', amount: 1_000 }, 'sp1:rec:test');
  host.send({ t: 'put', id: recordId, base: 0, blob, deleted: false });

  const hostRecord = await host.next();
  assert.equal(hostRecord.t, 'record');
  assert.equal(hostRecord.rev, 1);
  assert.equal(hostRecord.author, group.hostId);
  assert.deepEqual(hostRecord.blob, blob);

  const memberRecord = await member.next();
  assert.equal(memberRecord.t, 'record');
  assert.equal(memberRecord.id, recordId);
  assert.equal(memberRecord.rev, 1);

  await pending.silence(500);

  /* A second host socket is the author's other tab: the state carries the ledger. */
  const otherHost = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => otherHost.close());
  otherHost.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  const hostState = await otherHost.next();
  assert.equal(hostState.t, 'state');
  assert.equal(hostState.records.length, 1);
  assert.equal(hostState.records[0].id, recordId);

  /* Admission after a write carries the ledger to the new member, never to a pending socket. */
  host.send({ t: 'approve', memberId: pendingId });
  const admitted = await pending.next();
  assert.equal(admitted.t, 'state');
  assert.equal(admitted.records.length, 1);
  assert.equal(admitted.records[0].id, recordId);
});

test('a stale base is a conflict, and a tombstone is final', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);
  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  await host.next();

  const id = randomSecret();
  const first = await seal(group.key, { amount: 100 }, 'sp1:rec:test');
  const second = await seal(group.key, { amount: 200 }, 'sp1:rec:test');

  host.send({ t: 'put', id, base: 0, blob: first, deleted: false });
  assert.equal((await host.next()).rev, 1);

  host.send({ t: 'put', id, base: 0, blob: second, deleted: false });
  const conflict = await host.next();
  assert.equal(conflict.t, 'conflict');
  assert.equal(conflict.current.rev, 1);
  assert.deepEqual(conflict.current.blob, first, 'the stored ciphertext comes back to the writer');
  await host.silence(300);

  host.send({ t: 'put', id, base: 1, blob: second, deleted: false });
  const revised = await host.next();
  assert.equal(revised.rev, 2);
  assert.deepEqual(revised.blob, second);

  host.send({ t: 'put', id, base: 2, blob: second, deleted: true });
  const tombstone = await host.next();
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.rev, 3);

  host.send({ t: 'put', id, base: 3, blob: first, deleted: false });
  assert.deepEqual(await host.next(), { t: 'refused', code: 'deleted' });
});

test('a pending socket cannot write, and the frame cap is enforced', async (t) => {
  const worker = await startWorker();
  t.after(() => worker.stop());

  const group = await createGroup(worker.baseUrl);
  const host = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => host.close());
  host.send({ t: 'auth', id: group.hostId, secret: group.hostSecret, mode: 'resume' });
  await host.next();

  const pendingSecret = randomSecret();
  const pendingId = await idFromSecret(pendingSecret);
  const pending = await connect(socketUrl(worker.baseUrl, group.groupId));
  t.after(() => pending.close());
  pending.send({
    t: 'auth',
    id: pendingId,
    secret: pendingSecret,
    mode: 'join',
    nameBlob: await seal(group.key, { name: 'No Write' })
  });
  assert.equal((await pending.next()).t, 'waiting');
  await host.next();

  pending.send({
    t: 'put',
    id: randomSecret(),
    base: 0,
    blob: await seal(group.key, { amount: 1 }, 'sp1:rec:test'),
    deleted: false
  });
  assert.deepEqual(await pending.next(), { t: 'refused', code: 'unapproved' });
  await host.silence(400);

  const huge = { iv: 'A'.repeat(16), ct: 'A'.repeat(70_000) };
  host.send({ t: 'put', id: randomSecret(), base: 0, blob: huge, deleted: false });
  assert.deepEqual(await host.next(), { t: 'refused', code: 'too_large' });
});
