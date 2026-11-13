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

export const GROUP_KEY = 'meta';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
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
   * @returns {Promise<{ok: true, created: boolean}>}
   */
  async init({ hostId, nameBlob, metaBlob = null }) {
    const existing = await this.ctx.storage.get(GROUP_KEY);
    if (existing) return { ok: true, created: false };

    await this.ctx.storage.put(GROUP_KEY, {
      hostId,
      joinMode: 'approval',
      rev: 0,
      nameBlob,
      metaBlob
    });
    return { ok: true, created: true };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'bad_request' }, 400);

    if (path.endsWith('/init')) return json(await this.init(body));
    return json({ error: 'not_found' }, 404);
  }
}
