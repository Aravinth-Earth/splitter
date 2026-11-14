/**
 * Splitter — one group socket that reconnects and keeps what it was asked to send.
 *
 * A socket drop is normal on a phone. The browser's WebSocket does not reconnect, so this wrapper
 * owns the loop: open, authenticate with the first frame, flush the queue, and on a close wait
 * with exponential backoff before trying again. A frame sent while the socket is down is queued;
 * a frame with an id stays queued until the caller acknowledges the server's answer, so a drop
 * between the write and its broadcast does not lose it.
 *
 * No imports and no build step: plain ES module, parsed by the page and by its tests.
 */

export const MIN_DELAY_MS = 500;
export const MAX_DELAY_MS = 10_000;
export const PING_EVERY_MS = 45_000;
export const PONG_WAIT_MS = 10_000;

/** The wait before attempt `attempt` (0-based), with jitter and a hard ceiling. */
export function backoffDelay(attempt, random = Math.random) {
  const base = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** Math.min(attempt, 20));
  const jittered = base * (0.8 + random() * 0.4);
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(jittered)));
}

export class GroupSocket {
  /**
   * @param {{url: string, auth: object, win?: object, Ctor?: Function,
   *   onFrame: (frame: object) => void, onStatus?: (status: string) => void}} options
   */
  constructor({ url, auth, win = globalThis, Ctor, onFrame, onStatus = () => {} }) {
    this.url = url;
    this.auth = auth;
    this.win = win;
    this.Ctor = Ctor ?? win.WebSocket;
    this.onFrame = onFrame;
    this.onStatus = onStatus;

    this.queue = [];
    this.socket = null;
    this.attempt = 0;
    this.closed = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;

    this.handleOnline = () => this.connect();
    this.handleOffline = () => this.onStatus('offline');
    win.addEventListener?.('online', this.handleOnline);
    win.addEventListener?.('offline', this.handleOffline);
  }

  get isOpen() {
    return this.socket?.readyState === 1;
  }

  connect() {
    if (this.closed || this.isOpen) return;
    if (this.reconnectTimer !== null) {
      this.win.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.open();
  }

  /** A frame without an id is a one-off action: sent when open, never replayed. A frame with an
   * id stays in the queue until `ack(id)`, so a reconnect can send it again. */
  send(frame, { id = null } = {}) {
    if (id !== null) this.queue.push({ id, frame });
    if (!this.isOpen) return;
    try {
      this.socket.send(JSON.stringify(frame));
    } catch {
      /* the close event will schedule the retry */
    }
  }

  ack(id) {
    this.queue = this.queue.filter((entry) => entry.id !== id);
  }

  close() {
    this.closed = true;
    this.stopTimers();
    this.win.removeEventListener?.('online', this.handleOnline);
    this.win.removeEventListener?.('offline', this.handleOffline);
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
  }

  open() {
    if (this.closed) return;
    this.onStatus('connecting');

    let socket;
    try {
      socket = new this.Ctor(this.url);
    } catch {
      this.schedule();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.onStatus('open');
      try {
        socket.send(JSON.stringify(this.auth));
      } catch {
        socket.close();
        return;
      }
      for (const entry of this.queue) {
        try {
          socket.send(JSON.stringify(entry.frame));
        } catch {
          break;
        }
      }
      this.startHeartbeat();
    });

    socket.addEventListener('message', (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame?.t === 'pong') {
        this.clearPong();
        return;
      }
      this.onFrame(frame);
    });

    socket.addEventListener('close', (event) => {
      this.stopTimers();
      if (this.socket === socket) this.socket = null;
      if (this.closed) return;
      if (event?.code === 1008) {
        /* The server refused the identity or the seat. Retrying the same frame cannot help. */
        this.closed = true;
        this.onStatus('closed');
        return;
      }
      this.onStatus('reconnecting');
      this.schedule();
    });

    socket.addEventListener('error', () => {
      /* a close event follows */
    });
  }

  schedule() {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = this.win.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  startHeartbeat() {
    this.stopTimers();
    this.pingTimer = this.win.setInterval(() => {
      if (!this.isOpen) return;
      try {
        this.socket.send(JSON.stringify({ t: 'ping' }));
      } catch {
        return;
      }
      this.clearPong();
      this.pongTimer = this.win.setTimeout(() => {
        if (this.isOpen) this.socket.close();
      }, PONG_WAIT_MS);
    }, PING_EVERY_MS);
  }

  clearPong() {
    if (this.pongTimer !== null) this.win.clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  stopTimers() {
    if (this.reconnectTimer !== null) this.win.clearTimeout(this.reconnectTimer);
    if (this.pingTimer !== null) this.win.clearInterval(this.pingTimer);
    this.clearPong();
    this.reconnectTimer = null;
    this.pingTimer = null;
  }
}
