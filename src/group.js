/**
 * Splitter — one Durable Object per group, and only what the server is allowed to hold.
 *
 * The group's own meta is a host id, the join mode and a revision; the name and the optional meta
 * arrive sealed and are stored exactly as they were sent. A member's roster entry holds the sealed
 * name that person sent and a status — pending, approved or removed — and is never deleted for a
 * removal. Nothing in this file can read a group, and nothing in it tries: the key exists only in
 * the browser, derived from the code.
 *
 * A socket is identified by its first frame, not by the room id in its URL. That frame carries the
 * member's secret, and this file keeps only the hash comparison; a pending socket receives one
 * frame and nothing else. A failed join is counted by source in the Registry, and twelve failures
 * in five minutes answer the next attempt with `rate_limited`.
 *
 * Storage is the key-value API on a SQLite-backed namespace: one key per record, so a later write
 * to a record cannot rewrite its neighbours, and the meta is written once.
 *
 * Destroy is the operator's one call out, and it runs in a fixed order: every socket, then every
 * key with the meta last, then the Registry slot. The order is the guarantee — a wipe that dies
 * part-way leaves a group that still exists, holding the slot the ledger still counts for it.
 */

/* The shapes the edge also checks. Validating here again is not belt and braces: this is the write
   that makes a group exist, and a call that reached it with `hostId: undefined` would store a group
   nobody hosts. Both readers take the definition from one file so they cannot disagree. */
import { memberIdFromSecret } from './identity.js';
import { isId, isSealed } from './wire.js';

export const GROUP_KEY = 'meta';
const MEMBER_PREFIX = 'member:';
const RECORD_PREFIX = 'record:';
/* The last accepted record write, kept in its own key rather than in the meta: a record write can
   therefore stamp it with a blind put, and cannot clobber a join mode a host changed a moment
   earlier between this write's read and its write of the meta. */
const LAST_WRITE_KEY = 'last-write';
const DEFAULT_MAX_MEMBERS = 20;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const MAX_RECORD_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** The UTF-8 size of a stored value, which is what a listing reports as a record's bytes. */
function storedBytes(value) {
  return encoder.encode(JSON.stringify(value)).length;
}

function memberKey(id) {
  return `${MEMBER_PREFIX}${id}`;
}

function recordKey(id) {
  return `${RECORD_PREFIX}${id}`;
}

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

export class Group {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /* A socket is attached to this instance, and its identity is checked in the first message.
       Eviction drops the socket with the instance; the client reconnects, and nothing readable was
       ever waiting on the connection. */
    this.sockets = new Set();
    this.identities = new Map();
    /* The source address for the throttle, captured from Cloudflare at the upgrade and never from
       a field a client sends. One row per socket, because one DO can hold several sources. */
    this.clientIps = new Map();
  }

  /**
   * Write the group's initial meta, or confirm that it is already there.
   *
   * Idempotent on purpose: `/api/create` may be retried with the same id (a dropped response, a
   * reload), and the second call must answer ok without resetting the host, the join mode or the
   * revision. `created` says which of the two happened; the first meta stands either way.
   *
   * A body that is not a group is refused with `ok: false` and a reason, so the caller can tell a
   * refusal from a write: the create turns that into an error and hands the slot back.
   *
   * @returns {Promise<{ok: true, created: boolean} | {ok: false, error: string}>}
   */
  async init({ groupId = null, hostId, nameBlob, hostNameBlob = null, metaBlob = null } = {}) {
    if (!isId(hostId)) return { ok: false, error: 'hostId' };
    if (!isSealed(nameBlob)) return { ok: false, error: 'blob' };
    /* The host's own name is optional for a group created before it was sent; when present it is
       the host's roster entry, sealed like every other member name. */
    if (hostNameBlob !== null && hostNameBlob !== undefined && !isSealed(hostNameBlob)) {
      return { ok: false, error: 'blob' };
    }
    /* Absent meta is normal — a group can be created with only a name — but a meta that is present
       and unsealed is a caller error, not something to store half of. */
    if (metaBlob !== null && metaBlob !== undefined && !isSealed(metaBlob)) {
      return { ok: false, error: 'blob' };
    }

    const existing = await this.ctx.storage.get(GROUP_KEY);
    if (existing) return { ok: true, created: false };

    await this.ctx.storage.put(GROUP_KEY, {
      groupId: isId(groupId) ? groupId : null,
      hostId,
      joinMode: 'approval',
      rev: 0,
      createdAt: Date.now(),
      nameBlob,
      hostNameBlob: hostNameBlob ?? null,
      metaBlob: metaBlob ?? null
    });
    return { ok: true, created: true };
  }

  /**
   * The roster cap, from `MAX_MEMBERS`.
   *
   * A var arrives as a string, so it is parsed; anything that is not a small positive whole number
   * falls back to twenty rather than to "nobody may join". The host occupies one seat.
   */
  maxMembers() {
    const configured = Number(this.env?.MAX_MEMBERS);
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_MEMBERS;
  }

  /** How long a socket may stay open before its first `auth` frame. */
  authTimeoutMs() {
    const configured = Number(this.env?.AUTH_TIMEOUT_MS);
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_AUTH_TIMEOUT_MS;
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/ws') return this.openSocket(request);
    if (pathname === '/api/room') return this.roomInfo(request);

    if (request.method !== 'POST') {
      /* RFC 9110: a 405 has to name the methods it does allow. */
      return json({ error: 'method' }, 405, { allow: 'POST' });
    }

    /* Read only: this answers what the group holds, for the operator's listing. It takes no input,
       so a POST with an empty body is a valid read, and a group that holds no meta is a 404 rather
       than a group of zeroes. */
    if (pathname === '/counters') {
      const counters = await this.counters();
      return counters === null ? json({ error: 'unknown_group' }, 404) : json({ ok: true, ...counters });
    }

    /* The pathname is compared whole, never by suffix: a URL that merely ends in `/init` (say
       `/nope/init`) would otherwise initialise this group for a caller whose intent was some other
       route. Every internal call is written in this repo, so the set of paths is closed. */
    /* A group's own removal, called by the Worker on the operator surface. The body is ignored:
       the instance is the subject, so there is nothing to validate and nothing a caller could
       point it at. A wipe that failed is a 500; a slot the Registry did not take back is a 502,
       because the group is gone but the ledger still holds a row for it. */
    if (pathname === '/destroy') {
      const destroyed = await this.destroy();
      return json(destroyed, destroyed.ok ? 200 : destroyed.destroyed ? 502 : 500);
    }

    if (pathname !== '/init') return json({ error: 'not_found' }, 404);

    const body = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return json({ error: 'bad_request' }, 400);
    }

    const result = await this.init(body);
    return json(result, result.ok ? 200 : 400);
  }

  /**
   * What this group holds, as counts: no name, no amount, no code.
   *
   * `records` is how many record keys are stored and `bytes` the UTF-8 size of their stored values,
   * tombstones included — the same shape the write cap is measured on. Both times are `null` when
   * this group predates them: a group created before they were stamped has no creation time to
   * report, and a made-up one would be a claim the storage cannot support.
   *
   * @returns {Promise<null | {createdAt: number|null, lastWriteAt: number|null, records: number, bytes: number}>}
   */
  async counters() {
    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) return null;

    const lastWrite = await this.ctx.storage.get(LAST_WRITE_KEY);
    const records = await this.ctx.storage.list({ prefix: RECORD_PREFIX });
    let bytes = 0;
    for (const [, record] of records) bytes += storedBytes(record);

    return {
      createdAt: Number.isSafeInteger(meta.createdAt) ? meta.createdAt : null,
      lastWriteAt: Number.isSafeInteger(lastWrite?.at) ? lastWrite.at : null,
      records: records.size,
      bytes
    };
  }

  /**
   * Whether this room exists, for a client about to ask to join.
   *
   * The question is answered before a socket so an unknown code can say so instead of opening a
   * handshake that fails with no reason a browser can read. The room is a hash of the code: the
   * only people who can ask are the ones who already hold the code.
   */
  async roomInfo(request) {
    if (request.method !== 'GET') return json({ error: 'method' }, 405, { allow: 'GET' });
    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) return json({ error: 'unknown_group' }, 404);
    return json({ ok: true });
  }

  /**
   * Accept a socket, but give it no group content until its first frame proves a member id.
   *
   * The room id in the URL is a hash of the code: it answers "does this group exist", never "is
   * this person a member". The group's own meta is checked before the upgrade so an unknown id is
   * an HTTP refusal rather than an accepted socket that closes a moment later.
   */
  async openSocket(request) {
    const upgrade = request.headers.get('upgrade');
    if ((upgrade ?? '').toLowerCase() !== 'websocket') {
      return json({ error: 'upgrade' }, 426, { upgrade: 'websocket' });
    }

    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) return json({ error: 'unknown_group' }, 404);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.add(server);
    this.clientIps.set(server, request.headers.get('cf-connecting-ip') ?? 'local');

    server.addEventListener('message', (event) => {
      this.handleMessage(server, event.data).catch(() => this.rejectSocket(server, 'server'));
    });
    server.addEventListener('close', () => {
      this.identities.delete(server);
      this.clientIps.delete(server);
      this.sockets.delete(server);
      this.broadcastPresence();
    });
    server.addEventListener('error', () => {
      this.identities.delete(server);
      this.clientIps.delete(server);
      this.sockets.delete(server);
      this.broadcastPresence();
    });

    /* A socket that never introduces itself is closed, not left open as an anonymous reader. The
       timer runs while this instance is alive; if it is evicted first, the socket is dropped and
       the client reconnects, so no anonymous socket survives either way. */
    setTimeout(() => {
      if (this.identities.has(server)) return;
      this.rejectSocket(server, 'auth');
    }, this.authTimeoutMs());

    return new Response(null, { status: 101, webSocket: client });
  }

  /** One frame decides who this socket is; later frames are the host's actions. */
  async handleMessage(socket, message) {
    let frame;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      frame = JSON.parse(text);
    } catch {
      this.rejectSocket(socket, 'auth');
      return;
    }

    if (frame === null || typeof frame !== 'object') {
      this.rejectSocket(socket, 'auth');
      return;
    }

    try {
      if (this.identities.has(socket)) {
        await this.handleAction(socket, frame);
        return;
      }
      if (frame.t !== 'auth') {
        this.rejectSocket(socket, 'auth');
        return;
      }
      await this.authenticateSocket(socket, frame);
    } catch {
      this.rejectSocket(socket, 'server');
    }
  }

  /**
   * The host's two decisions. Every action is gated on the socket's identity, never on a field the
   * client sent: a member that forges `approve` changes nothing and is closed with `not_host`.
   */
  async handleAction(socket, frame) {
    if (frame.t === 'put') {
      await this.writeRecord(socket, frame);
      return;
    }
    if (frame.t === 'ping') {
      this.sendFrame(socket, { t: 'pong' });
      return;
    }
    if (frame.t === 'import-members') {
      await this.importMembers(socket, frame);
      return;
    }
    if (frame.t === 'leave') {
      await this.leave(socket);
      return;
    }
    if (frame.t === 'end') {
      await this.end(socket);
      return;
    }
    if (frame.t !== 'approve' && frame.t !== 'reject' && frame.t !== 'remove' && frame.t !== 'mode') {
      return;
    }

    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) return this.refuse(socket, 'unknown_group');

    const identity = this.identities.get(socket);
    if (identity?.memberId !== meta.hostId) return this.refuse(socket, 'not_host');

    if (frame.t === 'mode') {
      if (frame.mode !== 'open' && frame.mode !== 'approval') {
        this.sendRefusal(socket, 'bad_mode');
        return;
      }
      meta.joinMode = frame.mode;
      await this.ctx.storage.put(GROUP_KEY, meta);
      await this.notifyState(meta);
      return;
    }

    if (!isId(frame.memberId)) {
      this.sendRefusal(socket, 'bad_request');
      return;
    }

    const key = memberKey(frame.memberId);
    const entry = await this.ctx.storage.get(key);

    if (frame.t === 'remove') {
      if (!entry || entry.status !== 'approved') {
        this.sendRefusal(socket, 'not_member');
        return;
      }
      await this.ctx.storage.put(key, { ...entry, status: 'removed' });
      const handled = await this.notifyMember(meta, frame.memberId, 'removed');
      await this.notifyState(meta, handled);
      this.broadcastPresence();
      return;
    }

    if (!entry || entry.status !== 'pending') {
      this.sendRefusal(socket, 'not_pending');
      await this.notifyHosts(meta);
      return;
    }

    if (frame.t === 'approve') {
      await this.ctx.storage.put(key, { ...entry, status: 'approved' });
    } else {
      await this.ctx.storage.put(key, { ...entry, status: 'declined' });
    }

    const handled = await this.notifyMember(
      meta,
      frame.memberId,
      frame.t === 'approve' ? 'approved' : 'declined'
    );
    await this.notifyState(meta, handled);
    this.broadcastPresence();
  }

  /**
   * The host adds participants that came from an export.
   *
   * They are approved roster entries with a sealed name and no secret, so every device can resolve
   * the names in imported expenses and nobody can sign in as them. The whole batch is checked
   * before any entry is written: a capacity refusal leaves the roster exactly as it was.
   */
  async importMembers(socket, frame) {
    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) return this.refuse(socket, 'unknown_group');

    const identity = this.identities.get(socket);
    if (identity?.memberId !== meta.hostId) return this.refuse(socket, 'not_host');

    if (!Array.isArray(frame.members) || frame.members.length === 0) {
      this.sendRefusal(socket, 'bad_request');
      return;
    }

    const seen = new Set();
    const entries = [];
    let active = 1 + [...(await this.members()).values()].filter(
      (member) =>
        member.status !== 'removed' && member.status !== 'declined' && member.status !== 'left'
    ).length;

    for (const member of frame.members) {
      if (!member || !isId(member.memberId) || !isSealed(member.nameBlob)) {
        this.sendRefusal(socket, 'bad_request');
        return;
      }
      if (seen.has(member.memberId)) {
        this.sendRefusal(socket, 'bad_request');
        return;
      }
      seen.add(member.memberId);

      const existing = await this.ctx.storage.get(memberKey(member.memberId));
      if (existing && !existing.participant) {
        this.sendRefusal(socket, 'exists');
        return;
      }
      if (!existing || existing.status !== 'approved') active += 1;
      entries.push({
        key: memberKey(member.memberId),
        value: {
          status: 'approved',
          nameBlob: member.nameBlob,
          joinedAt: existing?.joinedAt ?? Date.now(),
          participant: true
        }
      });
    }

    if (active > this.maxMembers()) {
      this.sendRefusal(socket, 'group_full');
      return;
    }

    for (const entry of entries) await this.ctx.storage.put(entry.key, entry.value);
    await this.notifyState(meta);
    this.sendFrame(socket, { t: 'import-members-ok', memberIds: [...seen] });
  }

  /**
   * A member leaves. The row and records stay for attribution; the status changes to `left`, which
   * frees the seat. The organizer has no leave path in v1, because there is no ownership transfer.
   */
  async leave(socket) {
    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) return this.refuse(socket, 'unknown_group');

    const identity = this.identities.get(socket);
    if (!identity) return this.refuse(socket, 'unapproved');
    if (identity.memberId === meta.hostId) {
      this.sendRefusal(socket, 'host_must_end');
      return;
    }

    const key = memberKey(identity.memberId);
    const entry = await this.ctx.storage.get(key);
    if (!entry || entry.status !== 'approved') {
      this.sendRefusal(socket, 'not_member');
      return;
    }

    await this.ctx.storage.put(key, { ...entry, status: 'left' });
    this.sendFrame(socket, { t: 'left' });
    await this.notifyState(meta, new Set([socket]));
    this.broadcastPresence();
    try {
      socket.close(1000, 'left');
    } catch {
      /* already gone */
    }
  }

  /**
   * The host ends the group. Every socket is told once, then the storage and the Registry slot go.
   * A device that never reconnects keeps its own copy; the client clears it on the next contact.
   */
  async end(socket) {
    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) return this.refuse(socket, 'unknown_group');

    const identity = this.identities.get(socket);
    if (identity?.memberId !== meta.hostId) return this.refuse(socket, 'not_host');

    this.closeAll();

    await this.ctx.storage.deleteAll();
    await this.callRegistry('/release', { groupId: meta.groupId ?? this.ctx.id.toString() }).catch(() => {
      /* the slot is a reconciliation problem, not a reason to keep the group alive */
    });
  }

  /**
   * Take this group off the air in one call: sockets, then storage, then the slot.
   *
   * The order is the release-critical part. The Registry is told the slot is free only after every
   * key is gone, so a wipe that dies part-way leaves a group that still exists, holding the slot
   * the ledger still believes it holds — a state a caller can see and a retry can finish. A release
   * the Registry refuses is answered with `released: false` rather than a claim the slot is free,
   * because the ledger's row is the only truth about it.
   *
   * There is no caller-side identity check: this route is reached by the Worker, not by a browser
   * socket, and the Worker is the only thing that can name this instance.
   *
   * @returns {Promise<{ok: boolean, destroyed: boolean, released: boolean, closed: number, error?: string}>}
   */
  async destroy() {
    const meta = await this.ctx.storage.get(GROUP_KEY);
    const closed = this.closeAll();

    try {
      await this.wipe();
    } catch {
      return { ok: false, destroyed: false, released: false, closed, error: 'storage' };
    }

    /* The id the slot was reserved under, then the DO's own name as the last resort: a group
       written before `groupId` was stored still holds a slot under the name it was created with. */
    const slot = meta?.groupId ?? this.ctx.id?.toString?.() ?? null;
    if (typeof slot !== 'string' || slot === '') {
      /* Nothing here ever held a slot, so there is none to give back. */
      return { ok: true, destroyed: true, released: false, closed };
    }
    if (!(await this.releaseSlot(slot))) {
      return { ok: false, destroyed: true, released: false, closed, error: 'release' };
    }
    return { ok: true, destroyed: true, released: true, closed };
  }

  /**
   * Remove every key this group holds, the meta last, and drop any alarm.
   *
   * The meta is what makes the group exist, so it goes last: a wipe that fails between two keys
   * leaves a group that is still there — and still holds its slot — instead of a half-group whose
   * ledger entry has already been handed back. Deleting key by key rather than with `deleteAll` is
   * what makes that ordering possible.
   */
  async wipe() {
    const keys = [...(await this.ctx.storage.list()).keys()];
    const ordered = keys.filter((key) => key !== GROUP_KEY);
    if (keys.includes(GROUP_KEY)) ordered.push(GROUP_KEY);
    for (const key of ordered) await this.ctx.storage.delete(key);
    /* No alarm is set anywhere in this Worker today; the guard is what keeps this call true if one
       is ever added, instead of an unconditional call that would throw on a storage without it. */
    if (typeof this.ctx.storage.deleteAlarm === 'function') await this.ctx.storage.deleteAlarm();
  }

  /** Tell every attached socket the group is gone, close it, forget it; answer how many there were. */
  closeAll() {
    let closed = 0;
    for (const socket of this.sockets) {
      this.sendFrame(socket, { t: 'ended' });
      try {
        socket.close(1000, 'ended');
      } catch {
        /* already gone */
      }
      closed += 1;
    }
    this.sockets.clear();
    this.identities.clear();
    this.clientIps.clear();
    return closed;
  }

  /**
   * Ask the Registry to drop the slot, and say whether it actually did.
   *
   * `false` covers a refusal, a non-200 and an unreachable Registry alike: from here they are one
   * answer — the slot is not known to be free — and reporting otherwise would tell the operator a
   * slot came back that the ledger still holds.
   */
  async releaseSlot(groupId) {
    try {
      const response = await this.registryStub().fetch('https://registry/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId })
      });
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.ok === true;
    } catch {
      return false;
    }
  }

  /** One frame per change: the member ids with an approved socket right now. Ids only. */
  presenceFrame() {
    const here = new Set();
    for (const socket of this.sockets) {
      const identity = this.identities.get(socket);
      if (!identity) continue;
      if (identity.role === 'host' || identity.role === 'member') here.add(identity.memberId);
    }
    return { t: 'presence', here: [...here] };
  }

  broadcastPresence() {
    const frame = JSON.stringify(this.presenceFrame());
    for (const socket of this.sockets) {
      const identity = this.identities.get(socket);
      if (!identity || (identity.role !== 'host' && identity.role !== 'member')) continue;
      try {
        socket.send(frame);
      } catch {
        /* a socket that is already gone is not a reason to stop telling the others */
      }
    }
  }

  /** A decision reaches the person waiting, if they still have a socket. */
  async notifyMember(meta, memberId, outcome) {
    const handled = new Set();
    for (const socket of this.sockets) {
      if (this.identities.get(socket)?.memberId !== memberId) continue;
      handled.add(socket);
      if (outcome === 'approved') {
        this.identities.set(socket, { memberId, role: 'member' });
        socket.send(JSON.stringify(await this.rosterFrame(meta, memberId, 'member')));
        continue;
      }
      try {
        if (outcome === 'removed') {
          socket.send(JSON.stringify({ t: 'removed' }));
          socket.close(1008, 'removed');
        } else {
          socket.send(JSON.stringify({ t: 'refused', code: 'declined' }));
          socket.close(1008, 'declined');
        }
      } catch {
        /* already gone */
      }
    }
    return handled;
  }

  /** Verify the secret, then attach a role and answer with only what that role may see. */
  async authenticateSocket(socket, frame) {
    const derived = await memberIdFromSecret(frame.secret);
    if (!derived || derived !== frame.id) {
      this.rejectSocket(socket, 'auth');
      return;
    }

    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) {
      this.rejectSocket(socket, 'unknown_group');
      return;
    }

    if (frame.id === meta.hostId) {
      this.identities.set(socket, { memberId: frame.id, role: 'host' });
      socket.send(JSON.stringify(await this.rosterFrame(meta, frame.id, 'host')));
      this.broadcastPresence();
      return;
    }

    const entry = await this.ctx.storage.get(memberKey(frame.id));
    if (entry) {
      if (entry.status === 'approved') {
        this.identities.set(socket, { memberId: frame.id, role: 'member' });
        socket.send(JSON.stringify(await this.rosterFrame(meta, frame.id, 'member')));
        this.broadcastPresence();
        return;
      }
      if (entry.status === 'pending') {
        this.identities.set(socket, { memberId: frame.id, role: 'pending' });
        socket.send(JSON.stringify({ t: 'waiting', memberId: frame.id }));
        return;
      }
      this.rejectSocket(socket, 'removed');
      return;
    }

    if (frame.mode !== 'join') {
      this.rejectSocket(socket, 'auth');
      return;
    }

    const ip = this.clientIps.get(socket) ?? 'local';
    /* Fail open on a Registry fault: the throttle is anti-abuse, not the lock on the door, and a
       Registry outage must not stop every legitimate join. */
    const gate = await this.callRegistry('/join-blocked', { ip }).catch(() => ({ blocked: false }));
    if (gate.blocked) {
      this.refuse(socket, 'rate_limited');
      return;
    }

    if (!isSealed(frame.nameBlob)) {
      await this.noteJoinFailure(ip);
      this.rejectSocket(socket, 'blob');
      return;
    }

    const roster = await this.members();
    const occupied =
      1 +
      [...roster.values()].filter(
        (member) =>
          member.status !== 'removed' && member.status !== 'declined' && member.status !== 'left'
      ).length;
    if (occupied >= this.maxMembers()) {
      await this.noteJoinFailure(ip);
      this.refuse(socket, 'group_full');
      return;
    }

    await this.ctx.storage.put(memberKey(frame.id), {
      status: 'pending',
      nameBlob: frame.nameBlob,
      joinedAt: Date.now()
    });

    if (meta.joinMode === 'open') {
      await this.ctx.storage.put(memberKey(frame.id), {
        status: 'approved',
        nameBlob: frame.nameBlob,
        joinedAt: Date.now()
      });
      this.identities.set(socket, { memberId: frame.id, role: 'member' });
      socket.send(
        JSON.stringify({
          ...(await this.rosterFrame(meta, frame.id, 'member')),
          openAdmit: true
        })
      );
      await this.notifyState(meta, new Set([socket]));
      this.broadcastPresence();
      return;
    }

    await this.ctx.storage.put(memberKey(frame.id), {
      status: 'pending',
      nameBlob: frame.nameBlob,
      joinedAt: Date.now()
    });

    this.identities.set(socket, { memberId: frame.id, role: 'pending' });
    socket.send(JSON.stringify({ t: 'waiting', memberId: frame.id }));
    await this.notifyHosts(meta);
  }

  /**
   * One accepted write to one record.
   *
   * The server assigns the revision; the client names the revision it wrote from. A stale base is a
   * conflict carrying the stored ciphertext, which only a key holder can open. A tombstone is final:
   * a later put against it is refused rather than resurrecting an expense the group deleted.
   */
  async writeRecord(socket, frame) {
    const identity = this.identities.get(socket);
    const refusedId = typeof frame.id === 'string' ? frame.id : null;
    if (!identity || (identity.role !== 'host' && identity.role !== 'member')) {
      this.sendFrame(socket, { t: 'refused', code: 'unapproved', id: refusedId });
      return;
    }
    if (typeof frame.id !== 'string' || !isId(frame.id)) {
      this.sendFrame(socket, { t: 'refused', code: 'bad_request', id: refusedId });
      return;
    }
    if (!Number.isSafeInteger(frame.base) || frame.base < 0) {
      this.sendFrame(socket, { t: 'refused', code: 'bad_request', id: frame.id });
      return;
    }
    if (typeof frame.deleted !== 'boolean') {
      this.sendFrame(socket, { t: 'refused', code: 'bad_request', id: frame.id });
      return;
    }
    if (frame.deleted) {
      if (frame.blob !== undefined && frame.blob !== null && !isSealed(frame.blob)) {
        this.sendFrame(socket, { t: 'refused', code: 'bad_request', id: frame.id });
        return;
      }
    } else if (!isSealed(frame.blob)) {
      this.sendFrame(socket, { t: 'refused', code: 'bad_request', id: frame.id });
      return;
    }
    if (JSON.stringify(frame).length > MAX_RECORD_BYTES) {
      this.sendFrame(socket, { t: 'refused', code: 'too_large', id: frame.id });
      return;
    }

    const key = recordKey(frame.id);
    const existing = await this.ctx.storage.get(key);
    if (existing?.deleted) {
      this.sendFrame(socket, { t: 'refused', code: 'deleted', id: frame.id });
      return;
    }

    const rev = existing?.rev ?? 0;
    if (frame.base !== rev) {
      this.sendFrame(socket, {
        t: 'conflict',
        id: frame.id,
        current: existing ? { ...existing } : null
      });
      return;
    }

    const record = {
      id: frame.id,
      rev: rev + 1,
      blob: frame.deleted ? null : frame.blob,
      deleted: frame.deleted,
      author: identity.memberId,
      creator: existing?.creator ?? existing?.author ?? identity.memberId,
      at: Date.now()
    };

    await this.ctx.storage.put(key, record);
    /* A blind put of the time alone: nothing here read the meta, so nothing here can write one back
       stale. A write rejected above never reaches this line, so the time is the last *accepted*
       write. */
    await this.ctx.storage.put(LAST_WRITE_KEY, { at: record.at });
    await this.broadcastRecord(record);
  }

  /** Every accepted write reaches every approved socket, including the author's other tabs. */
  async broadcastRecord(record) {
    const frame = JSON.stringify({ t: 'record', ...record });
    for (const socket of this.sockets) {
      const identity = this.identities.get(socket);
      if (!identity || (identity.role !== 'host' && identity.role !== 'member')) continue;
      try {
        socket.send(frame);
      } catch {
        /* a socket that is already gone is not a reason to stop telling the others */
      }
    }
  }

  sendFrame(socket, frame) {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      /* already gone */
    }
  }

  /** The one Registry instance, however a caller here reaches it. */
  registryStub() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName('registry'));
  }

  /** Ask the Registry, the one singleton that can count across groups. */
  async callRegistry(path, body) {
    const registry = this.registryStub();
    const response = await registry.fetch(`https://registry${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return response.json();
  }

  async noteJoinFailure(ip) {
    await this.callRegistry('/join-failure', { ip }).catch(() => {});
  }

  /** Every roster entry, keyed by member id; the host lives in the meta, not here. */
  async members() {
    return this.ctx.storage.list({ prefix: MEMBER_PREFIX });
  }

  /**
   * The frame a role may see: the host sees pending names because it must decide; an approved
   * member sees only the approved roster. A pending member never receives this frame at all.
   */
  async rosterFrame(meta, memberId, role) {
    /* The host is the viewer here, not an entry in its own roster. The group name in meta is the
       group's, not a person's, and putting it in a member slot would name the organizer after the
       group. The host's own name is the one the page already holds. */
    const roster = [];
    if (isSealed(meta.hostNameBlob)) {
      roster.push({ id: meta.hostId, status: 'approved', nameBlob: meta.hostNameBlob });
    }
    const members = await this.members();
    for (const [key, entry] of members) {
      const id = key.slice(MEMBER_PREFIX.length);
      /* A removed member's name blob and status still travel: their expenses remain in the
         ledger, and a payer whose name no longer opens would render as nobody. Pending names
         still go only to the host, who has to decide. */
      if (entry.status === 'pending' && role !== 'host') continue;
      if (entry.status === 'declined') continue;
      roster.push({
        id,
        status: entry.status,
        nameBlob: entry.nameBlob,
        participant: entry.participant === true
      });
    }
    const records = [];
    if (role === 'host' || role === 'member') {
      const stored = await this.ctx.storage.list({ prefix: RECORD_PREFIX });
      for (const [, record] of stored) records.push({ ...record });
      records.sort((left, right) => left.at - right.at || (left.id < right.id ? -1 : 1));
    }

    return {
      t: 'state',
      rev: meta.rev,
      memberId,
      role,
      joinMode: meta.joinMode === 'open' ? 'open' : 'approval',
      nameBlob: meta.nameBlob,
      metaBlob: meta.metaBlob ?? null,
      hostId: meta.hostId,
      roster,
      records
    };
  }

  /**
   * Send the state each socket is allowed to see: the host its full roster, an approved member the
   * approved one. Pending sockets receive nothing here — waiting is the only frame they may get.
   */
  async notifyState(meta, skip = new Set()) {
    for (const socket of this.sockets) {
      if (skip.has(socket)) continue;
      const identity = this.identities.get(socket);
      if (!identity || (identity.role !== 'host' && identity.role !== 'member')) continue;
      try {
        socket.send(JSON.stringify(await this.rosterFrame(meta, identity.memberId, identity.role)));
      } catch {
        /* a socket that is already gone is not a reason to stop telling the others */
      }
    }
  }

  async notifyHosts(meta) {
    const frame = JSON.stringify(await this.rosterFrame(meta, meta.hostId, 'host'));
    for (const socket of this.sockets) {
      if (this.identities.get(socket)?.role !== 'host') continue;
      try {
        socket.send(frame);
      } catch {
        /* a socket that is already gone is not a reason to stop telling the others */
      }
    }
  }

  rejectSocket(socket, code) {
    try {
      socket.close(1008, code);
    } catch {
      /* already gone */
    }
  }

  sendRefusal(socket, code) {
    try {
      socket.send(JSON.stringify({ t: 'refused', code }));
    } catch {
      /* already gone */
    }
  }

  refuse(socket, code) {
    try {
      socket.send(JSON.stringify({ t: 'refused', code }));
      socket.close(1008, code);
    } catch {
      /* already gone */
    }
  }
}
