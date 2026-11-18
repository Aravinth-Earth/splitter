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
export const API = '/api';

/* The slowest cold start this harness has to survive, measured rather than guessed. The command,
   with the two ports and the store left to the harness:

     npx wrangler dev --port <free> --inspector-port <free> --ip 127.0.0.1 \
       --persist-to .wrangler/do-<pid>-<stamp> --log-level warn

   Four consecutive boots on this machine answered /api/health at 2.9 s, 3.3 s, 3.6 s and 4.0 s
   from `spawn`. Seven seconds is the bound, and both deadlines below are a multiple of it: the
   health wait ten times (a first run that has to build still passes) and a single request twice,
   so a slow machine makes a test slow rather than red. */
export const COLD_START_UPPER_MS = 7_000;

/* One request's deadline: long enough for a cold worker to answer its first request, short enough
   that a hung probe fails the attempt instead of the run. */
export const REQUEST_TIMEOUT_MS = 15_000;

/* How long a boot may take before the attempt is called dead. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;

/* How many ports to try before giving up. A bind race is worth another port; anything else fails
   the same way on every port, so three attempts is headroom, not patience. */
export const PORT_ATTEMPTS = 3;

/* What wrangler says when it cannot bind the port it was handed. */
const PORT_IN_USE = /address already in use|EADDRINUSE/i;

/**
 * A port nothing is listening on, chosen by asking the OS for one.
 *
 * The probe socket is closed before anything binds the port — it has to be, or wrangler could not
 * take it — so the port is free at this instant and not guaranteed to be free a moment later. A
 * collision surfaces as a failed start with wrangler's own message, which `startWorker` retries.
 */
async function freePort() {
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
 * One boot attempt on its own pair of ports. Returns when /api/health answers, throws when it does
 * not — the thrown error carries wrangler's log so a caller can tell a bind race from a real fault.
 *
 * `ports` is consumed in order and holds ports a caller has already reserved or wants pinned, which
 * is what makes a retry testable: when it runs out the OS is asked for one.
 */
async function startAttempt({ vars, timeoutMs, ports = [] }) {
  const port = ports.length > 0 ? ports.shift() : await freePort();
  /* Two suites that each boot a Worker would otherwise fight over the inspector socket: `wrangler
     dev` picks one by default, and the second holds it. `npm test` also runs files one at a time
     (`--test-concurrency=1`), because a suite owns a port, a store and a process group. */
  const inspectorPort = await freePort();
  const persistTo = join(ROOT, '.wrangler', `do-${process.pid}-${Date.now().toString(36)}`);
  const args = [
    'wrangler',
    'dev',
    '--port',
    String(port),
    '--inspector-port',
    String(inspectorPort),
    '--ip',
    '127.0.0.1',
    '--persist-to',
    persistTo,
    '--log-level',
    'warn'
  ];
  for (const [key, value] of Object.entries(vars)) args.push('--var', `${key}:${value}`);

  const started = Date.now();
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

  /* A failure always carries the log and the time it took: a bare "never answered" costs another
     five minutes of guessing, which is exactly what this helper exists to avoid. */
  function failure(message) {
    const error = new Error(`${message} after ${Date.now() - started} ms\n${log.trim()}`);
    error.log = log;
    return error;
  }

  async function stop() {
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

  /* The wait is a poll, not a fixed sleep: the bound is COLD_START_UPPER_MS, measured over four
     boots, and the default timeout is ten of those so a first run that has to build or fetch
     wrangler still passes. A start that took longer than usual is visible in the failure message
     rather than guessed at. */
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    /* Checked before `exited`, because wrangler's bind failure ends the process: it says it cannot
       bind and then exits, and reporting the exit would throw away the port name the retry needs. */
    if (PORT_IN_USE.test(log)) {
      await stop();
      throw failure(`wrangler dev could not bind port ${port}`);
    }
    if (exited) {
      await stop();
      throw failure(`wrangler dev exited (${exited.code ?? exited.signal})`);
    }
    try {
      const response = await fetch(`${baseUrl}${API}/health`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (response.ok) return { baseUrl, stop };
    } catch {
      /* not listening yet */
    }
    await sleep(300);
  }

  await stop();
  throw failure(`wrangler dev never answered ${API}/health on port ${port}`);
}

/**
 * Spawn the worker and wait until /api/health answers.
 *
 * @param {object} [options]
 * @param {Record<string, string|number>} [options.vars]  --var pairs for the run.
 * @param {number} [options.timeoutMs]                    how long health may take, per attempt.
 * @param {number[]} [options.ports]                      ports to try in order before asking the
 *                                                        OS for one; the array is copied.
 * @returns {Promise<{baseUrl: string, stop: () => Promise<void>}>}
 */
export async function startWorker({ vars = {}, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS, ports = [] } = {}) {
  const queue = [...ports];
  let lastError;
  for (let attempt = 1; attempt <= PORT_ATTEMPTS; attempt += 1) {
    try {
      return await startAttempt({ vars, timeoutMs, ports: queue });
    } catch (error) {
      lastError = error;
      /* A port taken between the probe in freePort() and wrangler's own bind is the only failure
         another attempt can fix. Anything else — a build error, a missing binding, a bad `--var` —
         would fail identically, so it is thrown the first time, with its log, rather than retried
         into a longer and less informative wait. */
      if (!PORT_IN_USE.test(String(error.log ?? error.message))) throw error;
    }
  }
  const error = new Error(
    `wrangler dev could not bind a port in ${PORT_ATTEMPTS} attempts: ${lastError?.message}`
  );
  /* The log travels with the aggregate error too: the last attempt's message already holds it, but
     a caller that reads `error.log` — as this file's own retry test does — must not have to parse
     prose to find wrangler's words. */
  error.log = lastError?.log ?? '';
  throw error;
}
