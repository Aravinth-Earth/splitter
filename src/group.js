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
 * frame and nothing else.
 *
 * Storage is the key-value API on a SQLite-backed namespace: one key per record, so a later write
 * to a record cannot rewrite its neighbours, and the meta is written once.
 */

/* The shapes the edge also checks. Validating here again is not belt and braces: this is the write
   that makes a group exist, and a call that reached it with `hostId: undefined` would store a group
   nobody hosts. Both readers take the definition from one file so they cannot disagree. */
import { memberIdFromSecret } from './identity.js';
import { isId, isSealed } from './wire.js';

export const GROUP_KEY = 'meta';
const MEMBER_PREFIX = 'member:';
const DEFAULT_MAX_MEMBERS = 20;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

function memberKey(id) {
  return `${MEMBER_PREFIX}${id}`;
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
  async init({ hostId, nameBlob, metaBlob = null } = {}) {
    if (!isId(hostId)) return { ok: false, error: 'hostId' };
    if (!isSealed(nameBlob)) return { ok: false, error: 'blob' };
    /* Absent meta is normal — a group can be created with only a name — but a meta that is present
       and unsealed is a caller error, not something to store half of. */
    if (metaBlob !== null && metaBlob !== undefined && !isSealed(metaBlob)) {
      return { ok: false, error: 'blob' };
    }

    const existing = await this.ctx.storage.get(GROUP_KEY);
    if (existing) return { ok: true, created: false };

    await this.ctx.storage.put(GROUP_KEY, {
      hostId,
      joinMode: 'approval',
      rev: 0,
      nameBlob,
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

    if (request.method !== 'POST') {
      /* RFC 9110: a 405 has to name the methods it does allow. */
      return json({ error: 'method' }, 405, { allow: 'POST' });
    }

    /* The pathname is compared whole, never by suffix: a URL that merely ends in `/init` (say
       `/nope/init`) would otherwise initialise this group for a caller whose intent was some other
       route. Every internal call is written in this repo, so the set of paths is closed. */
    if (pathname !== '/init') return json({ error: 'not_found' }, 404);

    const body = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return json({ error: 'bad_request' }, 400);
    }

    const result = await this.init(body);
    return json(result, result.ok ? 200 : 400);
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

    server.addEventListener('message', (event) => {
      this.handleMessage(server, event.data).catch(() => this.rejectSocket(server, 'server'));
    });
    server.addEventListener('close', () => {
      this.identities.delete(server);
      this.sockets.delete(server);
    });
    server.addEventListener('error', () => {
      this.identities.delete(server);
      this.sockets.delete(server);
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

  /** One frame decides who this socket is. Later frames belong to a protocol not served yet. */
  async handleMessage(socket, message) {
    if (this.identities.has(socket)) return;

    let frame;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      frame = JSON.parse(text);
    } catch {
      this.rejectSocket(socket, 'auth');
      return;
    }

    if (frame === null || typeof frame !== 'object' || frame.t !== 'auth') {
      this.rejectSocket(socket, 'auth');
      return;
    }

    try {
      await this.authenticateSocket(socket, frame);
    } catch {
      this.rejectSocket(socket, 'server');
    }
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
      return;
    }

    const entry = await this.ctx.storage.get(memberKey(frame.id));
    if (entry) {
      if (entry.status === 'approved') {
        this.identities.set(socket, { memberId: frame.id, role: 'member' });
        socket.send(JSON.stringify(await this.rosterFrame(meta, frame.id, 'member')));
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
    if (!isSealed(frame.nameBlob)) {
      this.rejectSocket(socket, 'blob');
      return;
    }

    const roster = await this.members();
    const occupied = 1 + [...roster.values()].filter((member) => member.status !== 'removed').length;
    if (occupied >= this.maxMembers()) {
      this.refuse(socket, 'group_full');
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
    const members = await this.members();
    for (const [key, entry] of members) {
      const id = key.slice(MEMBER_PREFIX.length);
      if (role === 'host' || entry.status === 'approved') {
        roster.push({ id, status: entry.status, nameBlob: entry.nameBlob });
      }
    }
    return { t: 'state', rev: meta.rev, memberId, role, roster };
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

  refuse(socket, code) {
    try {
      socket.send(JSON.stringify({ t: 'refused', code }));
      socket.close(1008, code);
    } catch {
      /* already gone */
    }
  }
}
