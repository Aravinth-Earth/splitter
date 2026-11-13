/**
 * Boot a throwaway `wrangler dev` for one suite.
 *
 * The worker under test is the real one — src/index.js, its bindings and the ASSETS tree — so a
 * suite talks to the same routes the deployed app does. Everything is local: a free port chosen
 * here, `--persist-to` a directory under `.wrangler/` that is deleted when the suite stops, and
 * `--var` pairs for limits a suite has to reach in seconds rather than in ninety days.
 *
 * No dependencies: `npx wrangler` is the repo's own dev tool, not a test one.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const API = '/w/expense-splitter/api';

/** A port nothing is listening on, chosen by asking the OS for one. */
export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Spawn the worker and wait until /api/health answers.
 *
 * @param {object} [options]
 * @param {Record<string, string|number>} [options.vars]  --var pairs for the run.
 * @param {number} [options.timeoutMs]                    how long health may take.
 * @returns {Promise<{baseUrl: string, port: number, stop: () => Promise<void>, output: () => string}>}
 */
export async function startWorker({ vars = {}, timeoutMs = 120_000 } = {}) {
  const port = await freePort();
  const persistTo = join(ROOT, '.wrangler', `do-${process.pid}-${Date.now().toString(36)}`);
  const args = [
    'wrangler',
    'dev',
    '--port',
    String(port),
    '--ip',
    '127.0.0.1',
    '--persist-to',
    persistTo,
    '--log-level',
    'warn'
  ];
  for (const [key, value] of Object.entries(vars)) args.push('--var', `${key}:${value}`);

  const child = spawn('npx', args, {
    cwd: ROOT,
    // Its own process group: wrangler forks workerd, and only the group kill takes both down.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' }
  });

  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  async function stopWorker() {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      const until = Date.now() + 10_000;
      while (!exited && Date.now() < until) await sleep(100);
      // wrangler can exit before the workerd it started does, so the group gets the signal again
      // whether or not the parent has gone.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* the whole group is gone */
      }
    }
    if (existsSync(persistTo)) await rm(persistTo, { recursive: true, force: true });
  }

  const deadline = Date.now() + timeoutMs;
  let healthy = false;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`wrangler dev exited (${exited.code ?? exited.signal})\n${log.trim()}`);
    try {
      const response = await fetch(`${baseUrl}${API}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(300);
  }
  if (!healthy) {
    await stopWorker();
    throw new Error(`wrangler dev never answered /api/health on port ${port}\n${log.trim()}`);
  }

  return { baseUrl, port, stop: stopWorker, output: () => log };
}
