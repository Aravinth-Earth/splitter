/**
 * Splitter — one Durable Object per group, and only what the server is allowed to hold.
 *
 * The group's own meta is a host id, the join mode and a revision; the name and the optional meta
 * arrive sealed and are stored exactly as they were sent. Nothing in this file can read a group,
 * and nothing in it tries: the key exists only in the browser, derived from the code.
 *
 * Storage is the key-value API on a SQLite-backed namespace: one key per record, so a later write
 * to a record cannot rewrite its neighbours, and the meta is written once.
 */

/* The shapes the edge also checks. Validating here again is not belt and braces: this is the write
   that makes a group exist, and a call that reached it with `hostId: undefined` would store a group
   nobody hosts. Both readers take the definition from one file so they cannot disagree. */
import { isId, isSealed } from './wire.js';

export const GROUP_KEY = 'meta';

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

  async fetch(request) {
    if (request.method !== 'POST') {
      /* RFC 9110: a 405 has to name the methods it does allow. */
      return json({ error: 'method' }, 405, { allow: 'POST' });
    }

    /* The pathname is compared whole, never by suffix: a URL that merely ends in `/init` (say
       `/nope/init`) would otherwise initialise this group for a caller whose intent was some other
       route. Every internal call is written in this repo, so the set of paths is closed. */
    const { pathname } = new URL(request.url);
    if (pathname !== '/init') return json({ error: 'not_found' }, 404);

    const body = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return json({ error: 'bad_request' }, 400);
    }

    const result = await this.init(body);
    return json(result, result.ok ? 200 : 400);
  }
}
