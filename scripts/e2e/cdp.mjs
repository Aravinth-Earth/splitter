/**
 * Splitter — the smallest Chrome DevTools Protocol client the wire capture needs.
 *
 * No dependency: Node's global WebSocket and fetch reach the debugging endpoint directly. The
 * launcher asks Chromium for an ephemeral port and reads it back from `DevToolsActivePort`, so two
 * runs on one machine do not fight over 9222. `findChrome` looks at an explicit `CHROME_PATH`
 * first, then the usual system paths, then the Playwright cache.
 *
 * The only protocol calls used here are target creation/attachment, Page, Runtime and Network, all
 * of which are stable. The capture itself lives in run.mjs; this file is transport.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BINARY_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

function onPath(name) {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function playwrightCache(home) {
  const cache = join(home, '.cache', 'ms-playwright');
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache)) {
    for (const candidate of [
      join(cache, entry, 'chrome-linux64', 'chrome'),
      join(cache, entry, 'chrome-linux', 'chrome')
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** The Chromium executable this run should use, or null. */
export function findChrome() {
  const explicit = [process.env.CHROME_PATH, process.env.CHROMIUM_PATH].filter(Boolean);
  const fixed = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const path of [...explicit, ...fixed]) if (existsSync(path)) return path;
  for (const name of BINARY_NAMES) {
    const found = onPath(name);
    if (found) return found;
  }
  return playwrightCache(process.env.HOME ?? tmpdir());
}

/** One CDP connection, flat sessions included, request/response and events. */
export class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error(`cannot open the CDP socket at ${url}`)),
        { once: true }
      );
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      for (const handler of this.handlers.get(message.method) ?? []) {
        try {
          handler(message.params ?? {}, message.sessionId);
        } catch {
          /* an observer must not stop the stream */
        }
      }
    });
  }

  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
    return () =>
      this.handlers.set(
        method,
        (this.handlers.get(method) ?? []).filter((entry) => entry !== handler)
      );
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already gone */
    }
  }
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Launch headless Chromium and connect to its browser-level CDP endpoint.
 *
 * A missing or unlaunchable browser is an error a caller reports: the capture cannot be skipped,
 * because a run that scanned nothing would pass the sentinel checks vacuously.
 *
 * @returns {Promise<{cdp: Cdp, executable: string, close: () => Promise<void>}>}
 */
export async function launchChrome({ executable = findChrome(), timeoutMs = 30_000 } = {}) {
  if (!executable) {
    throw new Error(
      'no Chromium binary found; install google-chrome/chromium or set CHROME_PATH'
    );
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'splitter-e2e-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    'about:blank'
  ];

  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });

  const activePort = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let wsUrl = null;
  while (Date.now() < deadline) {
    if (existsSync(activePort)) {
      const [port, path] = readFileSync(activePort, 'utf8').split('\n');
      if (port && path) {
        wsUrl = `ws://127.0.0.1:${Number(port)}${path}`;
        break;
      }
    }
    if (child.exitCode !== null) {
      killGroup(child, 'SIGKILL');
      rmSync(userDataDir, { recursive: true, force: true });
      throw new Error(`Chromium exited (${child.exitCode}) before opening CDP\n${log}`);
    }
    await sleep(100);
  }

  if (!wsUrl) {
    killGroup(child, 'SIGKILL');
    rmSync(userDataDir, { recursive: true, force: true });
    throw new Error(`Chromium opened no CDP port within ${timeoutMs} ms\n${log}`);
  }

  const cdp = await Cdp.connect(wsUrl);

  return {
    cdp,
    executable,
    async close() {
      cdp.close();
      killGroup(child, 'SIGTERM');
      await sleep(300);
      killGroup(child, 'SIGKILL');
      rmSync(userDataDir, { recursive: true, force: true });
    }
  };
}
