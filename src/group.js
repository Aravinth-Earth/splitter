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
 * Destroy is the operator's one call out, and the host's end is the same act from a socket: both run
 * in one fixed order — every key with the meta last, then every socket, then the Registry slot. The
 * order is the guarantee: a wipe that dies part-way leaves a group that still exists, holding the
 * slot the ledger still counts for it, and its sockets are told the wipe failed rather than that the
 * group ended. The group is marked as wiping before the first key goes, so a write that arrives
 * while the wipe is running is refused instead of being stored behind it.
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
/* The id the Registry slot was taken under, in its own key rather than in the meta. The meta is the
   key a wipe removes last and the key that makes the group exist, so a destroy that wiped the group
   and then failed to free the slot would otherwise lose the only record of which slot to retry. */
const SLOT_KEY = 'slot';
/* The running total of record bytes and record keys, kept in its own key rather than in the meta: a
   write moves it in one small read-and-put, so nothing there can write a meta read back stale.
   Reading the total is what keeps `/counters` from walking every `record:` key, and the value is
   repaired from the records when a group predates the key. */
const TOTALS_KEY = 'totals';
const DEFAULT_MAX_MEMBERS = 20;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
/* A socket is only here while it is speaking: the heartbeat re-announces the present set, and a
   socket that has been quiet for longer than this is no longer in it. */
const DEFAULT_SILENCE_MS = 90_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
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
    /* When each socket last sent a frame. Freshness is per socket, not per member: two tabs of one
       person each have to keep themselves alive, and the person is here while either of them is. */
    this.lastSeen = new Map();
    /* The one presence timer. It is a self-scheduling timeout rather than an interval so it can
       wake at the next beat or at the first socket's silence deadline, whichever is sooner. */
    this.heartbeatTimer = null;
    this.beatAt = null;
    /* The source address for the throttle, captured from Cloudflare at the upgrade and never from
       a field a client sends. One row per socket, because one DO can hold several sources. */
    this.clientIps = new Map();
    /* The running total of record bytes is a read, a move and a write; this queue is what stops two
       writes accepted in the same window from reading the same baseline and losing one of them. */
    this.totalsChain = Promise.resolve();
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

    /* The slot is written first and only once: a retried create finds the meta and returns above,
       so the id the ledger was asked for cannot be rewritten by a second caller. */
    if (isId(groupId)) await this.ctx.storage.put(SLOT_KEY, groupId);

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

  /** How long a socket may stay quiet before it is no longer counted as here. */
  presenceSilenceMs() {
    const configured = Number(this.env?.SILENCE_MS);
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_SILENCE_MS;
  }

  /** How often presence is re-sent when nothing about the present set changed. */
  heartbeatMs() {
    const configured = Number(this.env?.HEARTBEAT_MS);
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_HEARTBEAT_MS;
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
       point it at. A wipe that failed is a 500; a group that is gone but whose bookkeeping did not
       finish — a slot the Registry did not take back, an id that could not be cleared — is a 502,
       because the group is gone and the ledger's side of it is not clean. */
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
   * tombstones included — the same shape the write cap is measured on. Both are answered from the
   * running total the group keeps beside its records, so a read costs one small key instead of the
   * whole ledger. Both times are `null` when this group predates them: a group created before they
   * were stamped has no creation time to report, and a made-up one would be a claim the storage
   * cannot support.
   *
   * @returns {Promise<null | {createdAt: number|null, lastWriteAt: number|null, records: number, bytes: number}>}
   */
  async counters() {
    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) return null;

    const lastWrite = await this.ctx.storage.get(LAST_WRITE_KEY);
    const totals = await this.recordTotals();

    return {
      createdAt: Number.isSafeInteger(meta.createdAt) ? meta.createdAt : null,
      lastWriteAt: Number.isSafeInteger(lastWrite?.at) ? lastWrite.at : null,
      records: totals.records,
      bytes: totals.bytes
    };
  }

  /**
   * The running total of record keys and their stored bytes.
   *
   * A group created before the total existed has no key to read, and neither has one whose wipe died
   * part-way and took the key with it. Both are repaired here by summing the records once — the same
   * sum `counters` used to do on every read — and, on the read route, the answer is stored so the
   * next read is one key. A stored total that is not the shape this file writes is treated the same
   * way as an absent one, because a value nobody can read is no better than no value.
   *
   * `backfill` is how the write route asks for the baseline without storing it: the total there is
   * written once the write has been accepted, so a write refused during a wipe leaves no key behind.
   *
   * @returns {Promise<{records: number, bytes: number}>}
   */
  async recordTotals({ backfill = true } = {}) {
    const stored = await this.ctx.storage.get(TOTALS_KEY);
    if (stored && Number.isSafeInteger(stored.records) && Number.isSafeInteger(stored.bytes)) {
      return { records: stored.records, bytes: stored.bytes };
    }

    const records = await this.ctx.storage.list({ prefix: RECORD_PREFIX });
    let bytes = 0;
    for (const [, record] of records) bytes += storedBytes(record);
    const totals = { records: records.size, bytes };
    if (backfill) await this.ctx.storage.put(TOTALS_KEY, totals);
    return totals;
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
    server.addEventListener('close', async () => {
      await this.socketGone(server);
    });
    server.addEventListener('error', async () => {
      await this.socketGone(server);
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

    /* Any frame from an authenticated socket is the socket speaking, so it is here: freshness is
       refreshed before the frame is handled, and a second tab speaking on its own keeps the member
       in presence just as their first tab would. Unknown frame types count too — they are still a
       live connection — and a ping is therefore enough to stay here. */
    this.lastSeen.set(socket, Date.now());
    this.scheduleHeartbeat();

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

    /* The same rule as a record write: a group that is being wiped takes no host decisions either,
       or an approval arriving behind the wipe would leave a member entry in it. */
    if (meta.wiping === true) return this.sendRefusal(socket, 'wiping');

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
      await this.broadcastPresence();
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
    await this.broadcastPresence();
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
    if (meta.wiping === true) return this.sendRefusal(socket, 'wiping');

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
    if (meta.wiping === true) return this.sendRefusal(socket, 'wiping');
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
    /* Left is not attached: the row is no longer approved, and the socket that said so goes with
       it. Their other tab is still attached, and presence has to stop naming them anyway. */
    this.forget(socket);
    this.sendFrame(socket, { t: 'left' });
    await this.notifyState(meta, new Set([socket]));
    await this.broadcastPresence();
    this.scheduleHeartbeat();
    try {
      socket.close(1000, 'left');
    } catch {
      /* already gone */
    }
  }

  /**
   * The host ends the group: the same act as `destroy`, so the same fixed order and the same slot.
   *
   * The wipe goes first, then the sockets, then the slot the create persisted. Sending `ended` on
   * the way in would tell every client the group ended while its meta and records were still
   * stored, and a wipe that then failed would leave a group that exists with clients who believe it
   * does not. A wipe that fails sends `wipe-failed` and leaves the sockets attached, because the
   * group they are attached to is still there.
   *
   * The slot is named by the id the create persisted, never by this instance: a release that used
   * the Durable Object's own id names a row this group never held.
   */
  async end(socket) {
    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) return this.refuse(socket, 'unknown_group');

    const identity = this.identities.get(socket);
    if (identity?.memberId !== meta.hostId) return this.refuse(socket, 'not_host');

    const slot = await this.persistedSlot(meta);

    try {
      await this.wipe();
    } catch {
      this.notifyWipeFailed();
      return;
    }

    this.closeAll();

    if (slot === null) return;
    /* The wipe is already done, so a release the Registry refused is not a reason to keep anything
       alive: the slot id stays, which is what lets the operator's destroy finish the release. */
    if ((await this.releaseSlot(slot)) === 'refused') return;
    /* The sockets were told the group ended a moment ago, so there is no caller left to report a
       slot key that will not go: the row is free either way, and a later destroy finds the ledger
       row already gone and clears the key then. */
    await this.ctx.storage.delete(SLOT_KEY).catch(() => {});
  }

  /**
   * Take this group off the air in one call: storage, then sockets, then the slot.
   *
   * The order is the release-critical part. Every key goes first, so a wipe that dies part-way
   * leaves a group that still exists, holding the slot the ledger still believes it holds — a state
   * a caller can see and a retry can finish. The sockets are told only once the wipe has finished:
   * `ended` is the frame that says the data is gone, and sending it before the rows were removed
   * told every client the group ended while its records were still stored. A wipe that fails sends
   * `wipe-failed` instead and leaves the sockets open, because the group they are attached to still
   * exists.
   *
   * The slot is named by the id the create persisted, never derived from this instance: a retry
   * after a wipe found no meta would otherwise resolve a slot the group never held. A release the
   * Registry did not actually free a row for is answered `released: false` rather than a claim the
   * slot is free, because the ledger's row is the only truth about it — and a ledger that answers
   * `freed: 0` is a row that is already gone, which is a finished destroy, not a stuck one.
   *
   * There is no caller-side identity check: this route is reached by the Worker, not by a browser
   * socket, and the Worker is the only thing that can name this instance.
   *
   * @returns {Promise<{ok: boolean, destroyed: boolean, released: boolean, closed: number, error?: string}>}
   */
  async destroy() {
    /* Read before the wipe: it is the wipe that removes the meta, and a retried destroy has only
       the persisted slot id to go on. */
    const meta = await this.ctx.storage.get(GROUP_KEY);
    const slot = await this.persistedSlot(meta);

    try {
      await this.wipe();
    } catch {
      this.notifyWipeFailed();
      return { ok: false, destroyed: false, released: false, closed: 0, error: 'storage' };
    }

    const closed = this.closeAll();

    if (slot === null) {
      /* Nothing here ever held a slot, so there is none to give back. */
      return { ok: true, destroyed: true, released: false, closed };
    }
    const outcome = await this.releaseSlot(slot);
    if (outcome === 'refused') {
      /* A genuine refusal: the ledger may still hold the row, so the id that names it stays and a
         retry can still clear it. */
      return { ok: false, destroyed: true, released: false, closed, error: 'release' };
    }
    /* The slot is free — deleted by this call, or already gone — so the id that named it is no
       longer worth keeping, and a retry has nothing left to free. A storage that refuses this
       delete therefore changes nothing about the group: it is wiped and its sockets are closed, so
       the answer reports that, the ledger's own count, and the one key that stayed. */
    try {
      await this.ctx.storage.delete(SLOT_KEY);
    } catch {
      return { ok: false, destroyed: true, released: outcome === 'freed', closed, error: 'slot' };
    }
    return { ok: true, destroyed: true, released: outcome === 'freed', closed };
  }

  /**
   * The Registry slot id this group was created under, or `null` when it never held one.
   *
   * The persisted key is read first, because the wipe removes the meta and a retried destroy has
   * only that key to go on; a group written before the key existed kept the id in its meta. This
   * instance's own id is never a candidate: it names a Durable Object, not a row in the ledger.
   *
   * @returns {Promise<string|null>}
   */
  async persistedSlot(meta) {
    const storedSlot = await this.ctx.storage.get(SLOT_KEY);
    if (typeof storedSlot === 'string') return storedSlot;
    return isId(meta?.groupId) ? meta.groupId : null;
  }

  /**
   * Remove every key this group holds, the meta last, and drop any alarm.
   *
   * The meta is what makes the group exist, so it goes last: a wipe that fails between two keys
   * leaves a group that is still there — and still holds its slot — instead of a half-group whose
   * ledger entry has already been handed back. Deleting key by key rather than with `deleteAll` is
   * what makes that ordering possible.
   *
   * The group is marked as wiping in the meta before the first key goes, and every write reads that
   * mark: a frame already in flight when the host ended the group — a put, a join, an approval —
   * is refused for the whole duration of the wipe instead of being stored behind it. The mark lives
   * in the meta, the key that goes last, so it is still there when the wipe is half done, and it is
   * removed again when the wipe fails: a group whose sockets were told it still exists must still
   * take writes.
   *
   * A write that had already read the meta before the mark was set is the one case the read alone
   * cannot catch, so such a write reads the meta again after storing its record and removes the
   * record it just wrote: the window between a write's read and its put cannot leave a record in a
   * group the wipe has already listed.
   *
   * The slot id is the one key the wipe leaves: it is what a destroy that could not free the slot
   * needs on its retry, and it is removed by `destroy` once the release has actually freed a row.
   */
  async wipe() {
    try {
      const meta = await this.ctx.storage.get(GROUP_KEY);
      if (meta) await this.ctx.storage.put(GROUP_KEY, { ...meta, wiping: true });

      const keys = [...(await this.ctx.storage.list()).keys()];
      const ordered = keys.filter((key) => key !== GROUP_KEY && key !== SLOT_KEY);
      if (keys.includes(GROUP_KEY)) ordered.push(GROUP_KEY);
      for (const key of ordered) await this.ctx.storage.delete(key);
      /* No alarm is set anywhere in this Worker today; the guard is what keeps this call true if
         one is ever added, instead of an unconditional call that would throw on a storage without
         it. */
      if (typeof this.ctx.storage.deleteAlarm === 'function') await this.ctx.storage.deleteAlarm();
    } catch (error) {
      /* The wipe stopped part-way, so the mark has to come off again. The failing storage is the
         failure the caller reports; a clear that could not be written leaves the group marked, and
         a retry of the wipe is what finishes it. */
      await this.clearWipeMark().catch(() => {});
      throw error;
    }
  }

  /**
   * Take the wiping mark off a group whose wipe did not finish.
   *
   * The meta is read again rather than rewritten from the copy the wipe held: a join mode changed
   * between the two would otherwise be undone by taking the mark off. A meta that is already gone
   * needs nothing — the group does not exist to write to.
   */
  async clearWipeMark() {
    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta || meta.wiping !== true) return;
    const cleared = { ...meta };
    delete cleared.wiping;
    await this.ctx.storage.put(GROUP_KEY, cleared);
  }

  /**
   * Tell every attached socket the group is gone, close it, forget it; answer how many there were.
   *
   * The presence timer goes first: a group that has ended has no present set to announce, and a
   * wake that fired after the wipe would tell sockets about a group that no longer exists.
   */
  closeAll() {
    this.stopHeartbeat();
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
    this.lastSeen.clear();
    this.clientIps.clear();
    return closed;
  }

  /**
   * Tell every attached socket that the wipe failed, and leave all of them open.
   *
   * The group still exists — the wipe stopped before the meta — so the sockets still have a group
   * to talk to. `ended` is not sent: it is the frame that says the data is gone, and sending it
   * while the rows were still stored is the one lie this path must not tell.
   */
  notifyWipeFailed() {
    for (const socket of this.sockets) this.sendFrame(socket, { t: 'wipe-failed' });
  }

  /**
   * Ask the Registry to drop the slot, and say what its answer means.
   *
   * `freed` is what the ledger deleted, so `ok: true` alone is not the answer. Three outcomes:
   * `freed` when a row went, `absent` when the ledger answered `ok: true, freed: 0` — the row is
   * already gone, which is what a compensated or lost create leaves, and no retry could ever clear
   * it — and `refused` for everything else: a non-200, an unreachable Registry or a body that is
   * not the shape this call documents. Only `refused` means the ledger may still hold the row.
   *
   * @returns {Promise<'freed'|'absent'|'refused'>}
   */
  async releaseSlot(groupId) {
    try {
      const response = await this.registryStub().fetch('https://registry/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ groupId })
      });
      if (!response.ok) return 'refused';
      const body = await response.json().catch(() => null);
      if (body?.ok !== true || !Number.isSafeInteger(body.freed)) return 'refused';
      return body.freed > 0 ? 'freed' : 'absent';
    } catch {
      return 'refused';
    }
  }

  /**
   * The presence frame: who is here, as ids and nothing else.
   *
   * The set is the approved roster intersected with the sockets that are still speaking. The
   * roster read is what makes a member who left (or was removed) absent even while their other
   * tab is still attached — their row is no longer approved — and the per-socket freshness is
   * what makes a member absent once their last tab stops speaking, without a close. Two sockets
   * for one member are one id: the ids are a Set.
   *
   * @returns {Promise<{t: 'here', ids: string[]}>}
   */
  async presenceFrame() {
    const meta = await this.ctx.storage.get(GROUP_KEY);
    const approved = new Set();
    if (meta) {
      approved.add(meta.hostId);
      for (const [key, entry] of await this.members()) {
        if (entry?.status === 'approved') approved.add(key.slice(MEMBER_PREFIX.length));
      }
    }

    const now = Date.now();
    const silence = this.presenceSilenceMs();
    const ids = new Set();
    for (const socket of this.sockets) {
      const identity = this.identities.get(socket);
      if (!identity || (identity.role !== 'host' && identity.role !== 'member')) continue;
      if (!approved.has(identity.memberId)) continue;
      const seen = this.lastSeen.get(socket);
      if (!Number.isFinite(seen) || seen <= now - silence) continue;
      ids.add(identity.memberId);
    }
    return { t: 'here', ids: [...ids] };
  }

  /** One frame per change and per beat: the same shape, to every socket that may see it. */
  async broadcastPresence() {
    const frame = JSON.stringify(await this.presenceFrame());
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

  /**
   * Schedule the next presence wake.
   *
   * The timer is what tells the others that a socket has gone quiet, because nothing else happens
   * when silence begins. It wakes at the next beat, or at the first present socket's silence
   * deadline when that is sooner, so a departure is announced as it happens rather than at the end
   * of a beat interval. The beat clock is kept apart from the deadline (`beatAt`): a frame arriving
   * sooner only shortens this wait, it never postpones the beat, so steady traffic cannot starve
   * the heartbeat. One timer per instance — rescheduling replaces it, never adds a second.
   */
  scheduleHeartbeat() {
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;

    if (this.sockets.size === 0) {
      this.beatAt = null;
      return;
    }

    const now = Date.now();
    if (!Number.isFinite(this.beatAt) || this.beatAt <= now) this.beatAt = now + this.heartbeatMs();

    const silence = this.presenceSilenceMs();
    let wakeAt = this.beatAt;
    for (const socket of this.sockets) {
      const identity = this.identities.get(socket);
      if (!identity || (identity.role !== 'host' && identity.role !== 'member')) continue;
      const seen = this.lastSeen.get(socket);
      if (!Number.isFinite(seen)) continue;
      /* A millisecond past the deadline: waking at the instant itself could still see the socket
         inside its window, and the next wake after that would be a whole beat away. */
      const deadline = seen + silence + 1;
      if (deadline > now && deadline < wakeAt) wakeAt = deadline;
    }

    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.sockets.size === 0) {
        this.beatAt = null;
        return;
      }
      /* A wake at a silence deadline is not a beat, so the beat clock survives it. */
      if (Date.now() >= this.beatAt) this.beatAt = null;
      this.broadcastPresence()
        .catch(() => {})
        .finally(() => this.scheduleHeartbeat());
    }, Math.max(1, wakeAt - now));
  }

  /** Stop the presence timer: a group with no sockets has nothing to announce. */
  stopHeartbeat() {
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.beatAt = null;
  }

  /**
   * Drop a socket's identity and freshness: on close, error, leave, removal and decline.
   *
   * Its source address goes with it, so a reconnect is counted as the new socket it is.
   */
  forget(socket) {
    this.identities.delete(socket);
    this.lastSeen.delete(socket);
    this.clientIps.delete(socket);
    this.sockets.delete(socket);
  }

  /** A socket left for any reason: forget it, tell whoever is left, and re-arm the timer. */
  async socketGone(socket) {
    this.forget(socket);
    await this.broadcastPresence().catch(() => {});
    this.scheduleHeartbeat();
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
      /* The decision is final for this socket: removed or declined, its identity goes, so no beat
         can name it again while the close is still in flight. */
      this.forget(socket);
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
    /* A group in the middle of its wipe takes no joins: the member entry a join writes would
       otherwise be stored after the wipe read its key set. The socket is refused, not closed, so a
       wipe that then fails leaves it attached to a group that still exists. */
    if (meta.wiping === true) {
      this.sendRefusal(socket, 'wiping');
      return;
    }

    if (frame.id === meta.hostId) {
      this.identities.set(socket, { memberId: frame.id, role: 'host' });
      socket.send(JSON.stringify(await this.rosterFrame(meta, frame.id, 'host')));
      await this.broadcastPresence();
      this.scheduleHeartbeat();
      return;
    }

    const entry = await this.ctx.storage.get(memberKey(frame.id));
    if (entry) {
      if (entry.status === 'approved') {
        this.identities.set(socket, { memberId: frame.id, role: 'member' });
        socket.send(JSON.stringify(await this.rosterFrame(meta, frame.id, 'member')));
        await this.broadcastPresence();
        this.scheduleHeartbeat();
        return;
      }
      if (entry.status === 'pending') {
        this.identities.set(socket, { memberId: frame.id, role: 'pending' });
        socket.send(JSON.stringify({ t: 'waiting', memberId: frame.id }));
        this.scheduleHeartbeat();
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
      await this.broadcastPresence();
      this.scheduleHeartbeat();
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
    this.scheduleHeartbeat();
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

    /* The group's own state is read before every accepted write, unlike the blind stamp below: a
       group that is being wiped takes no records. A frame already in flight when the host ended the
       group would otherwise be stored after the wipe read its key set, leaving a record and its
       stamp behind in a group the wipe then reported as gone. The read is not written back, so
       nothing here can put a stale meta in place of a join mode changed a moment earlier. */
    const meta = await this.ctx.storage.get(GROUP_KEY);
    if (!meta) {
      this.sendFrame(socket, { t: 'refused', code: 'unknown_group', id: frame.id });
      return;
    }
    if (meta.wiping === true) {
      this.sendFrame(socket, { t: 'refused', code: 'wiping', id: frame.id });
      return;
    }

    /* The socket's role was decided when it authenticated; the roster row is what decides it now.
       A member who left or was removed is no longer approved, and their other tab is still holding
       a socket that authenticated as a member — so the row is read before every accepted write,
       and a write from a seat that is no longer approved is refused instead of stored and
       broadcast. The host has no roster row: the meta names it. */
    if (identity.memberId !== meta.hostId) {
      const sender = await this.ctx.storage.get(memberKey(identity.memberId));
      if (!sender || sender.status !== 'approved') {
        this.sendFrame(socket, { t: 'refused', code: 'unapproved', id: frame.id });
        return;
      }
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

    /* The record and the total that counts it are one change: the total is read, moved and written
       in the queue, and the record is stored between the read and the write so the baseline is the
       ledger as it stood before it. A Durable Object interleaves requests at every await, and two
       writes accepted a moment apart would otherwise read the same baseline and drop each other's
       bytes; queued, each sees the total the one before it left. The value is replaced rather than
       added to when the key was already there, so a revision moves the bytes by the difference. */
    await this.moveTotals(async () => {
      const totals = await this.recordTotals({ backfill: false });
      const prior = await this.ctx.storage.get(key);
      await this.ctx.storage.put(key, record);
      await this.ctx.storage.put(TOTALS_KEY, {
        records: totals.records + (prior ? 0 : 1),
        bytes: totals.bytes + storedBytes(record) - (prior ? storedBytes(prior) : 0)
      });
    });
    /* The meta above was read before this write, so a wipe that set its mark in between listed its
       keys without this record in them, and the record would outlive a wipe that reported success.
       Read it again: a group that is being wiped now removes the record this write has just stored
       and refuses it, so nothing is stored behind the wipe whatever order the two arrive in. The
       stamp is not written in that case, for the same reason. */
    const current = await this.ctx.storage.get(GROUP_KEY);
    if (current?.wiping === true) {
      /* The record goes, and the total that counted it goes with it: a group that is being wiped
         takes no new key, and a total left behind would be a counter for records that are gone. A
         wipe that then fails leaves a group with no total, which the next counters read repairs. */
      await this.moveTotals(async () => {
        await this.ctx.storage.delete(key);
        await this.ctx.storage.delete(TOTALS_KEY);
      });
      this.sendFrame(socket, { t: 'refused', code: 'wiping', id: frame.id });
      return;
    }
    /* A blind put of the time alone: nothing here read the meta, so nothing here can write one back
       stale. A write rejected above never reaches this line, so the time is the last *accepted*
       write. */
    await this.ctx.storage.put(LAST_WRITE_KEY, { at: record.at });
    await this.broadcastRecord(record);
  }

  /**
   * Run one change to the running total after the one before it has finished.
   *
   * The total is a read, a move and a write, and the Durable Object lets a second request in at
   * every await: queued here, two accepted writes cannot both read the same baseline and lose one
   * of them. A change that throws is skipped over by the next, so a storage fault costs one update
   * and never wedges the queue.
   */
  moveTotals(change) {
    const run = this.totalsChain.then(change);
    this.totalsChain = run.catch(() => {});
    return run;
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
