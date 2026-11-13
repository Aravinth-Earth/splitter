/**
 * Splitter — the page in front of a group.
 *
 * Two jobs. Create: take a group name, a currency and a display name, turn them into a code and a
 * key in this browser, and ask the Worker to reserve a slot. Join: take a code and a display name,
 * prove the code to the group's socket, and wait for the organizer. The name and the currency
 * never travel as text — they are sealed under a key derived from the code — so the request carries
 * a hash of the code, a hash of this member's secret, and sealed blobs the server cannot open.
 *
 * The code is kept in memory only. Nothing in this module writes to browser storage on purpose: a
 * reload losing the group is expected until a group can be re-opened from a code, and a code
 * written to a store is a key written to a store. A join keeps its member secret in memory for the
 * same reason, so a refresh while waiting asks again with a new member id; #506 is the task that
 * gives a member a stored seat.
 *
 * No presence chip and no "Add expense" action is rendered. Live presence and the expense sheet do
 * not exist yet, and a control that cannot do its job is a claim the code cannot keep.
 *
 * The DOM wiring sits behind a guard at the bottom, so node can import this module and test the
 * rules that decide what is allowed to be sent.
 */

import {
  deriveGroupKey,
  formatCode,
  generateCode,
  groupIdFromCode,
  idFromSecret,
  normalizeCode,
  open,
  randomSecret,
  seal
} from './crypto.js';

/** The currencies the page offers. The list is short on purpose: every pair is a rounding rule. */
export const CURRENCIES = Object.freeze(['INR', 'EUR', 'USD', 'GBP']);
export const DEFAULT_CURRENCY = 'INR';

export const GROUP_NAME_MIN = 1;
export const GROUP_NAME_MAX = 60;
export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 30;

/* The cap is the Worker's Registry default. The message names the number because a refusal that
   says only "try later" leaves the person guessing whether it is their connection. */
export const SLOT_LIMIT_MESSAGE = 'All 25 group slots are in use.';
export const OFFLINE_MESSAGE = 'Creating needs a connection.';
export const RETRY_MESSAGE = 'The group was not created. Try again.';

/* The app is the whole of its origin, so a relative path is the API on this origin and nothing
   else. */
const CREATE_PATH = 'api/create';

/**
 * Count what a person means by a character.
 *
 * `String#length` counts UTF-16 units, so a Tamil letter with a combining mark or one emoji counts
 * as two and a limit written against it would refuse a name that is well inside it. Code points are
 * the unit the rule is stated in.
 */
export function countCodePoints(value) {
  return [...value].length;
}

/**
 * A group name, or a refusal that says what to do about it.
 *
 * Surrounding whitespace is not part of a name, and a name made only of it is empty. The trimmed
 * value is what gets sealed, so the check and the payload agree on what was counted.
 *
 * @returns {{ok: true, value: string, length: number} | {ok: false, message: string}}
 */
export function validateGroupName(input) {
  if (typeof input !== 'string') return { ok: false, message: 'Enter a group name.' };

  const value = input.trim();
  const length = countCodePoints(value);
  if (length < GROUP_NAME_MIN) return { ok: false, message: 'Enter a group name.' };
  if (length > GROUP_NAME_MAX) {
    return {
      ok: false,
      message: `A group name can be at most ${GROUP_NAME_MAX} characters. Yours is ${length}.`
    };
  }
  return { ok: true, value, length };
}

/**
 * The organizer's own name, or a refusal.
 *
 * Two characters is the floor because one letter is not a name anyone can be recognised by; the
 * ceiling is the same kind of limit as the group name's.
 *
 * @returns {{ok: true, value: string, length: number} | {ok: false, message: string}}
 */
export function validateDisplayName(input) {
  if (typeof input !== 'string') return { ok: false, message: 'Enter your name.' };

  const value = input.trim();
  const length = countCodePoints(value);
  if (length < DISPLAY_NAME_MIN) {
    return { ok: false, message: `Your name needs at least ${DISPLAY_NAME_MIN} characters.` };
  }
  if (length > DISPLAY_NAME_MAX) {
    return {
      ok: false,
      message: `Your name can be at most ${DISPLAY_NAME_MAX} characters. Yours is ${length}.`
    };
  }
  return { ok: true, value, length };
}

/**
 * The currency code the payload will carry.
 *
 * The select offers four, but a value that is not one of them is not a currency this page can
 * round: falling back to the default keeps a tampered or stale value from sealing nonsense.
 */
export function normalizeCurrency(value) {
  if (typeof value !== 'string') return DEFAULT_CURRENCY;
  const code = value.trim().toUpperCase();
  return CURRENCIES.includes(code) ? code : DEFAULT_CURRENCY;
}

/**
 * The body `/api/create` reads: two ids and two sealed values, and nothing else.
 *
 * The key is derived here and used here, and is not returned: nothing on this page opens a sealed
 * value after the create, and the code — which is kept — re-derives the same key on this device.
 * What matters for the promise is that neither the code nor the key is ever written anywhere.
 *
 * @returns {Promise<{groupId: string, hostId: string, nameBlob: {iv: string, ct: string}, metaBlob: {iv: string, ct: string}}>}
 */
export async function createPayload({ code, secret, name, currency = DEFAULT_CURRENCY } = {}) {
  if (typeof code !== 'string' || code === '') {
    throw new Error('splitter: a create payload needs a group code');
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('splitter: a create payload needs a member secret');
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('splitter: a create payload needs a group name');
  }

  const [key, groupId, hostId] = await Promise.all([
    deriveGroupKey(code),
    groupIdFromCode(code),
    idFromSecret(secret)
  ]);

  return {
    groupId,
    hostId,
    nameBlob: await seal(key, { name }),
    metaBlob: await seal(key, { currency: normalizeCurrency(currency) })
  };
}

/**
 * What to tell the person for a refused or broken create.
 *
 * Only the cap has a message of its own, because only the cap is a state rather than a fault: the
 * page must say exactly how many slots are in use, and a slot frees up without this page changing.
 */
export function createErrorMessage(status) {
  if (status === 429) return SLOT_LIMIT_MESSAGE;
  if (status === 400) return 'The server refused the request. Reload the page and try again.';
  if (status >= 500) return 'The server could not create the group. Try again.';
  return RETRY_MESSAGE;
}

/**
 * A link that carries the code in the fragment.
 *
 * The fragment is the one part of a URL a browser never sends to the server, so an invite link is
 * the code without putting the code in a request path or a query string a proxy would log.
 */
export function inviteLink(base, code) {
  return `${base}#code=${formatCode(code)}`;
}

/**
 * The code a person typed or pasted, or the reason it is not one.
 *
 * A whole invite link is accepted: the code may arrive as `#code=…` (the shape this app builds)
 * or `?c=…` (an older link), and a pasted string that contains neither is treated as a code. The
 * value is normalised by the same rules the request uses, so a lowercase, dashed or spaced code
 * resolves to the group the person meant; a wrong length is refused before a socket exists.
 *
 * @returns {{ok: true, code: string} | {ok: false, message: string}}
 */
export function codeFromInput(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, message: 'Enter a group code.' };
  }

  let value = input.trim();
  const embedded = value.match(/[#?](?:code|c)=([^&\s]+)/i);
  if (embedded) {
    try {
      value = decodeURIComponent(embedded[1]);
    } catch {
      return { ok: false, message: 'That link does not carry a readable group code.' };
    }
  }

  try {
    return { ok: true, code: normalizeCode(value) };
  } catch {
    return { ok: false, message: 'A group code is 16 characters. Check it and try again.' };
  }
}

/**
 * Ask the browser's share sheet for an invite link, when it has one.
 *
 * Returns `shared` when the sheet completed, `cancelled` when the person dismissed it, `failed`
 * when the platform refused, and `unsupported` when `navigator.share` is absent. Only `failed` and
 * `unsupported` fall back to copying: a cancellation is a decision, not an error, and re-copying
 * behind the person's back would be a second action they did not ask for.
 *
 * @returns {Promise<'shared' | 'cancelled' | 'failed' | 'unsupported'>}
 */
export async function shareInvite(win, link) {
  const share = win?.navigator?.share;
  if (typeof share !== 'function') return 'unsupported';

  try {
    await share.call(win.navigator, {
      title: 'Splitter invite',
      text: 'Join my Splitter group',
      url: link
    });
    return 'shared';
  } catch (error) {
    return error?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

/**
 * Put text on the clipboard, or report that it did not happen.
 *
 * A boolean rather than an exception, because the caller has a visible field waiting: a denied
 * permission is answered by showing the text and selecting it, not by a hidden retry. There is
 * deliberately no `execCommand('copy')` fallback -- a hidden textarea that reports success leaves
 * the person with no way to see what was copied, and no way to copy it again by hand.
 */
export async function writeClipboardText(win, text) {
  try {
    if (typeof win?.navigator?.clipboard?.writeText !== 'function') return false;
    await win.navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the page */

/**
 * Wire the page to the elements in index.html.
 *
 * Returns nothing and is not called under `node --test`; everything the tests need is above this
 * line. The state it keeps is one object in this closure, so a reload starts from nothing.
 */
export function init(doc = document, win = window) {
  const form = doc.getElementById('create-form');
  if (!form) return;

  const nameInput = doc.getElementById('group-name');
  const displayInput = doc.getElementById('display-name');
  const currencySelect = doc.getElementById('currency');
  const createButton = doc.getElementById('create-btn');
  const formError = doc.getElementById('form-error');

  const createPanel = doc.getElementById('create-panel');
  const groupHeader = doc.getElementById('group-header');
  const groupNameDisplay = doc.getElementById('group-name-display');
  const groupCode = doc.getElementById('group-code');
  const copyCodeButton = doc.getElementById('copy-code');
  const copyLinkButton = doc.getElementById('copy-link');
  const copyStatus = doc.getElementById('copy-status');
  const copyFallback = doc.getElementById('copy-fallback');
  const copyFallbackField = doc.getElementById('copy-fallback-field');
  const whoLine = doc.getElementById('who-line');
  const roleLine = doc.getElementById('role-line');
  const roster = doc.getElementById('roster');
  const rosterList = doc.getElementById('roster-list');
  const rosterEmpty = doc.getElementById('roster-empty');
  const codeHint = doc.getElementById('code-hint');
  const dismissHintButton = doc.getElementById('dismiss-hint');
  const emptyLedger = doc.getElementById('empty-ledger');

  const joinPanel = doc.getElementById('join-panel');
  const joinForm = doc.getElementById('join-form');
  const joinCodeInput = doc.getElementById('join-code');
  const joinNameInput = doc.getElementById('join-name');
  const joinButton = doc.getElementById('join-btn');
  const joinError = doc.getElementById('join-error');
  const showJoinButton = doc.getElementById('show-join');
  const showCreateButton = doc.getElementById('show-create');
  const waitingPanel = doc.getElementById('waiting-panel');
  const waitingTitle = doc.getElementById('waiting-title');
  const waitingCopy = doc.getElementById('waiting-copy');
  const waitingCode = doc.getElementById('waiting-code');
  const waitingBack = doc.getElementById('waiting-back');

  const createUrl = new URL(CREATE_PATH, win.location.href).toString();
  const pageBase = () => {
    const here = new URL(win.location.href);
    here.hash = '';
    here.search = '';
    return here.toString();
  };

  /* In memory only: the code, which re-derives the key and names the group. A reload starts from
     no group at all, and nothing here is written to a store. */
  let group = null;
  let pending = false;
  let joinPending = false;
  let joinSocket = null;
  let hostSocket = null;

  form.addEventListener('submit', (event) => {
    /* A form with no action would still navigate, and a navigation is a lost create. */
    event.preventDefault();
    void submit();
  });

  dismissHintButton.addEventListener('click', hideHint);
  copyCodeButton.addEventListener('click', () => {
    if (!group) return;
    void copy(formatCode(group.code), 'Code copied.');
  });
  copyLinkButton.addEventListener('click', () => {
    if (!group) return;
    void shareOrCopy(inviteLink(pageBase(), group.code));
  });

  /* The button names the action the browser will actually take. `navigator.share` is the phone's
     own share sheet; without it the same control copies. */
  if (typeof win.navigator?.share === 'function') {
    copyLinkButton.textContent = 'Share invite link';
  }

  showJoinButton.addEventListener('click', () => showJoin());
  showCreateButton.addEventListener('click', () => showCreate());
  waitingBack.addEventListener('click', () => showJoin());
  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitJoin();
  });

  /**
   * Submit once, or explain why not.
   *
   * The pending flag is set before the first await, so a double click or a held Enter key cannot
   * produce a second request: the second submit sees the flag, and the button is already disabled.
   */
  async function submit() {
    if (pending) return;

    const fields = readFields();
    if (!fields.ok) {
      showError(fields.message);
      fields.field.focus();
      return;
    }

    if (win.navigator && win.navigator.onLine === false) {
      showError(OFFLINE_MESSAGE);
      return;
    }

    pending = true;
    setBusy(true);

    try {
      const code = generateCode();
      const secret = randomSecret();
      const payload = await createPayload({
        code,
        secret,
        name: fields.name,
        currency: fields.currency
      });

      const response = await win.fetch(createUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        /* The form and its values stay exactly as they were: a full ledger frees up later, and a
           fault may not repeat. */
        showError(createErrorMessage(response.status));
        return;
      }

      hideError();
      showGroup({ code, name: fields.name, displayName: fields.displayName });
      openHostSocket({ groupId: payload.groupId, memberId: payload.hostId, secret, code });
    } catch {
      showError(RETRY_MESSAGE);
    } finally {
      pending = false;
      setBusy(false);
    }
  }

  /** Validate both text fields against the same rules the payload is built from. */
  function readFields() {
    nameInput.removeAttribute('aria-invalid');
    displayInput.removeAttribute('aria-invalid');

    const name = validateGroupName(nameInput.value);
    if (!name.ok) {
      nameInput.setAttribute('aria-invalid', 'true');
      return { ok: false, message: name.message, field: nameInput };
    }

    const display = validateDisplayName(displayInput.value);
    if (!display.ok) {
      displayInput.setAttribute('aria-invalid', 'true');
      return { ok: false, message: display.message, field: displayInput };
    }

    return {
      ok: true,
      name: name.value,
      displayName: display.value,
      currency: normalizeCurrency(currencySelect.value)
    };
  }

  /** Replace the form with the group, in place: no modal, no confirmation, no second screen. */
  function showGroup({ code, name, displayName, role = 'organizer' }) {
    group = { code };

    groupNameDisplay.textContent = name;
    groupCode.textContent = formatCode(code);
    whoLine.textContent = displayName;
    whoLine.hidden = false;
    roleLine.textContent = role === 'organizer' ? 'you are the organizer' : 'you are a member';
    roster.hidden = role !== 'organizer';
    rosterList.textContent = '';
    rosterEmpty.hidden = role !== 'organizer';
    rosterEmpty.textContent = 'No one is waiting.';
    copyStatus.textContent = '';
    hideFallback();
    codeHint.hidden = false;

    createPanel.hidden = true;
    joinPanel.hidden = true;
    waitingPanel.hidden = true;
    groupHeader.hidden = false;
    emptyLedger.hidden = false;

    /* The hint is a one-time note: a copy dismisses it, and so does anything else done in the
       header. The listener is added now so the click that created the group does not count. */
    groupHeader.addEventListener('click', hideHint, { once: true });
    groupNameDisplay.focus();
  }

  function hideHint() {
    codeHint.hidden = true;
  }

  function setBusy(busy) {
    createButton.disabled = busy;
    if (busy) {
      createButton.setAttribute('aria-busy', 'true');
      createButton.textContent = 'Creating…';
    } else {
      createButton.removeAttribute('aria-busy');
      createButton.textContent = 'Create group';
    }
  }

  function showError(message) {
    formError.textContent = message;
    formError.hidden = false;
  }

  function hideError() {
    formError.textContent = '';
    formError.hidden = true;
  }

  /* --------------------------------------------------------------- joining */

  function showJoinError(message) {
    joinError.textContent = message;
    joinError.hidden = false;
  }

  function hideJoinError() {
    joinError.textContent = '';
    joinError.hidden = true;
  }

  function setJoinBusy(busy) {
    joinButton.disabled = busy;
    joinButton.textContent = busy ? 'Asking…' : 'Ask to join';
  }

  /** The join sheet, with an optional code already in the field. */
  function showJoin({ code = '', error = '' } = {}) {
    closeJoinSocket();
    createPanel.hidden = true;
    groupHeader.hidden = true;
    emptyLedger.hidden = true;
    waitingPanel.hidden = true;
    joinPanel.hidden = false;

    joinCodeInput.removeAttribute('aria-invalid');
    joinNameInput.removeAttribute('aria-invalid');
    hideJoinError();
    if (code) joinCodeInput.value = formatCode(code);
    if (error) showJoinError(error);

    if (code) joinNameInput.focus();
    else joinCodeInput.focus();
  }

  function showCreate() {
    closeJoinSocket();
    joinPanel.hidden = true;
    waitingPanel.hidden = true;
    groupHeader.hidden = true;
    emptyLedger.hidden = true;
    createPanel.hidden = false;
    hideJoinError();
    nameInput.focus();
  }

  function showWaiting(code) {
    createPanel.hidden = true;
    joinPanel.hidden = true;
    groupHeader.hidden = true;
    emptyLedger.hidden = true;
    waitingPanel.hidden = false;
    waitingCode.textContent = formatCode(code);
    waitingCopy.textContent =
      'The organizer has to let you in. Nothing from the group is shown until they do.';
    waitingTitle.focus();
  }

  async function submitJoin() {
    if (joinPending) return;

    joinCodeInput.removeAttribute('aria-invalid');
    joinNameInput.removeAttribute('aria-invalid');
    hideJoinError();

    const code = codeFromInput(joinCodeInput.value);
    if (!code.ok) {
      joinCodeInput.setAttribute('aria-invalid', 'true');
      showJoinError(code.message);
      joinCodeInput.focus();
      return;
    }

    const name = validateDisplayName(joinNameInput.value);
    if (!name.ok) {
      joinNameInput.setAttribute('aria-invalid', 'true');
      showJoinError(name.message);
      joinNameInput.focus();
      return;
    }

    if (win.navigator && win.navigator.onLine === false) {
      showJoinError(OFFLINE_MESSAGE);
      return;
    }

    joinPending = true;
    setJoinBusy(true);

    try {
      const groupId = await groupIdFromCode(code.code);
      const reachable = await probeRoom(groupId);
      if (reachable === 'missing') {
        showJoinError('No live group with that code.');
        return;
      }
      if (reachable === 'offline') {
        showJoinError(OFFLINE_MESSAGE);
        return;
      }

      const key = await deriveGroupKey(code.code);
      const secret = randomSecret();
      const memberId = await idFromSecret(secret);
      const nameBlob = await seal(key, { name: name.value });

      showWaiting(code.code);
      openJoinSocket({ groupId, memberId, secret, nameBlob, code: code.code });
    } catch {
      showJoinError(RETRY_MESSAGE);
    } finally {
      joinPending = false;
      setJoinBusy(false);
    }
  }

  /** Whether the group exists, asked before a socket so an unknown code has an answer. */
  async function probeRoom(groupId) {
    try {
      const url = new URL('api/room', win.location.href);
      url.searchParams.set('room', groupId);
      const response = await win.fetch(url.toString(), { cache: 'no-store' });
      if (response.status === 404) return 'missing';
      return response.ok ? 'ok' : 'offline';
    } catch {
      return 'offline';
    }
  }

  function openJoinSocket({ groupId, memberId, secret, nameBlob, code }) {
    closeJoinSocket();

    const url = new URL('api/ws', win.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', groupId);

    let socket;
    try {
      socket = new win.WebSocket(url.toString());
    } catch {
      waitingCopy.textContent = 'Could not open a connection. Try again.';
      return;
    }

    joinSocket = socket;
    let settled = false;

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ t: 'auth', id: memberId, secret, mode: 'join', nameBlob }));
    });

    socket.addEventListener('message', async (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }

      if (frame.t === 'waiting') {
        settled = true;
        waitingCopy.textContent =
          'The organizer has to let you in. Nothing from the group is shown until they do.';
        return;
      }

      if (frame.t === 'state' && frame.role === 'member') {
        settled = true;
        let name = 'Your group';
        try {
          const key = await deriveGroupKey(code);
          const opened = await open(key, frame.nameBlob);
          if (typeof opened?.name === 'string') name = opened.name;
        } catch {
          /* the name stays a neutral label rather than an unreadable blob */
        }
        showGroup({ code, name, displayName: joinNameInput.value.trim(), role: 'member' });
        return;
      }

      if (frame.t === 'refused') {
        settled = true;
        closeJoinSocket();
        showJoin({ code, error: refusalMessage(frame.code) });
      }
    });

    socket.addEventListener('close', () => {
      if (joinSocket !== socket) return;
      joinSocket = null;
      if (settled) return;
      waitingCopy.textContent = 'The connection closed before the group answered. Try again.';
    });

    socket.addEventListener('error', () => {
      /* A close event follows, and that is where the message is set. */
    });
  }

  function closeJoinSocket() {
    if (!joinSocket) return;
    const socket = joinSocket;
    joinSocket = null;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }

  function refusalMessage(code) {
    if (code === 'group_full') return 'That group already has 20 people in it.';
    if (code === 'rate_limited') return 'Too many attempts from here.';
    if (code === 'unknown_group') return 'No live group with that code.';
    if (code === 'declined') return 'The organizer did not let you in.';
    return 'The group could not take the request. Try again.';
  }

  /* ------------------------------------------------------------ the organizer */

  function openHostSocket({ groupId, memberId, secret, code }) {
    closeHostSocket();

    const url = new URL('api/ws', win.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', groupId);

    let socket;
    try {
      socket = new win.WebSocket(url.toString());
    } catch {
      rosterEmpty.textContent = 'Could not open a connection. Reload to continue.';
      rosterEmpty.hidden = false;
      return;
    }

    hostSocket = socket;
    const key = deriveGroupKey(code);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ t: 'auth', id: memberId, secret, mode: 'resume' }));
    });

    socket.addEventListener('message', (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }

      if (frame.t === 'state') {
        void renderRoster(frame, key);
        return;
      }
      if (frame.t === 'refused') {
        rosterEmpty.textContent = 'That request could not be completed.';
        rosterEmpty.hidden = false;
      }
    });

    socket.addEventListener('close', () => {
      if (hostSocket !== socket) return;
      hostSocket = null;
      rosterEmpty.textContent = 'Connection lost. Reload to continue.';
      rosterEmpty.hidden = false;
    });

    socket.addEventListener('error', () => {
      /* the close event follows */
    });
  }

  function closeHostSocket() {
    if (!hostSocket) return;
    const socket = hostSocket;
    hostSocket = null;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }

  /** The names are sealed; the host has the code, so it can open them and nobody else can. */
  async function renderRoster(frame, keyPromise) {
    if (frame.role !== 'host') return;

    const key = await keyPromise;
    const pending = frame.roster.filter((member) => member.status === 'pending');

    rosterList.textContent = '';
    roster.hidden = false;
    rosterEmpty.hidden = pending.length > 0;
    rosterEmpty.textContent = 'No one is waiting.';

    for (const member of pending) {
      let name = 'Someone';
      try {
        const opened = await open(key, member.nameBlob);
        if (typeof opened?.name === 'string') name = opened.name;
      } catch {
        name = 'Name could not be opened';
      }

      const chip = doc.createElement('li');
      chip.className = 'chip';

      const label = doc.createElement('span');
      label.textContent = name;

      const allow = doc.createElement('button');
      allow.type = 'button';
      allow.className = 'secondary';
      allow.textContent = 'Let in';

      const decline = doc.createElement('button');
      decline.type = 'button';
      decline.className = 'secondary';
      decline.textContent = 'No';

      const act = (type) => {
        allow.disabled = true;
        decline.disabled = true;
        if (hostSocket) hostSocket.send(JSON.stringify({ t: type, memberId: member.id }));
      };
      allow.addEventListener('click', () => act('approve'));
      decline.addEventListener('click', () => act('reject'));

      chip.append(label, allow, decline);
      rosterList.append(chip);
    }
  }

  /* A short message in the live region, cleared after a few seconds. */
  let statusTimer = null;

  function setStatus(message) {
    copyStatus.textContent = message;
    copyStatus.classList.toggle('toast', message !== '');
    if (statusTimer !== null) win.clearTimeout(statusTimer);
    statusTimer = null;
    if (!message) return;
    statusTimer = win.setTimeout(() => {
      copyStatus.textContent = '';
      copyStatus.classList.remove('toast');
      statusTimer = null;
    }, 4000);
  }

  function hideFallback() {
    copyFallback.hidden = true;
    copyFallbackField.value = '';
  }

  /** Show the string in a visible field, selected, so a denied clipboard still has a way out. */
  function showFallback(text) {
    copyFallbackField.value = text;
    copyFallback.hidden = false;
    copyFallbackField.focus();
    copyFallbackField.select();
    setStatus('Copy it from here.');
  }

  async function copy(text, done) {
    hideFallback();
    const copied = await writeClipboardText(win, text);
    if (!copied) {
      showFallback(text);
      return;
    }
    setStatus(done);
    hideHint();
  }

  /** Use the phone's share sheet for the link when there is one, otherwise copy it. */
  async function shareOrCopy(link) {
    if (typeof win.navigator?.share !== 'function') {
      await copy(link, 'Invite link copied — it carries the code.');
      return;
    }

    hideFallback();
    const outcome = await shareInvite(win, link);
    if (outcome === 'shared') {
      setStatus('Invite link shared.');
      hideHint();
      return;
    }
    if (outcome === 'cancelled') return;
    await copy(link, 'Invite link copied — it carries the code.');
  }

  /* An invite link opens the join sheet with the code already there; the fragment never reaches
     the server. A malformed one shows the sheet and the reason rather than doing nothing. */
  const invitation = win.location.hash || win.location.search || '';
  if (invitation) {
    const invited = codeFromInput(invitation);
    if (invited.ok) {
      showJoin({ code: invited.code });
    } else if (/[#?](?:code|c)=/i.test(invitation)) {
      showJoin();
      joinCodeInput.value = invitation;
      showJoinError(invited.message);
    }
  }
}

/* Under `node --test` there is no document, so importing this module for its pure functions wires
   nothing. In a browser the module is deferred, so the form exists by the time this line runs. */
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  init(document, window);
}
