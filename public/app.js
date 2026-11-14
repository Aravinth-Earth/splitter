/**
 * Splitter — the page in front of a group.
 *
 * Two jobs. Create: take a group name, a currency and a display name, turn them into a code and a
 * key in this browser, and ask the Worker to reserve a slot. Join: take a code and a display name,
 * prove the code to the group's socket, and wait for the organizer. The name and the currency
 * never travel as text — they are sealed under a key derived from the code — so the request carries
 * a hash of the code, a hash of this member's secret, and sealed blobs the server cannot open.
 *
 * The seat is remembered on this device: the member secret and group id in localStorage, the
 * code — which is the key — in sessionStorage for this tab only. A reload resumes the last seat
 * without a form; losing the secret creates a new member entry rather than impersonating the old
 * one. A removed member's record is dropped with the explanation, and a group that no longer
 * exists is forgotten.
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
import {
  codeFor,
  forgetCode,
  forgetSession,
  lastGroup,
  saveCode,
  saveSession,
  sessionFor,
  setLastGroup
} from './store.js';
import {
  defaultPercentages,
  expenseAad,
  formatPaise,
  parseAmount,
  splitFor,
  validateDate,
  validateDescription,
  validateNote,
  validateTime
} from './expense.js';

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
 * The body `/api/create` reads: two ids and three sealed values, and nothing else.
 *
 * The key is derived here and used here, and is not returned: nothing on this page opens a sealed
 * value after the create, and the code — which is kept — re-derives the same key on this device.
 * What matters for the promise is that neither the code nor the key is ever written anywhere.
 *
 * @returns {Promise<{groupId: string, hostId: string, nameBlob: {iv: string, ct: string}, hostNameBlob: {iv: string, ct: string}, metaBlob: {iv: string, ct: string}}>}
 */
export async function createPayload({
  code,
  secret,
  name,
  displayName,
  currency = DEFAULT_CURRENCY
} = {}) {
  if (typeof code !== 'string' || code === '') {
    throw new Error('splitter: a create payload needs a group code');
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('splitter: a create payload needs a member secret');
  }
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('splitter: a create payload needs a group name');
  }
  if (typeof displayName !== 'string' || displayName.trim() === '') {
    throw new Error('splitter: a create payload needs the organizer name');
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
    hostNameBlob: await seal(key, { name: displayName.trim() }),
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
  const joinModeLine = doc.getElementById('join-mode');
  const toggleModeButton = doc.getElementById('toggle-mode');
  const roster = doc.getElementById('roster');
  const rosterPending = doc.getElementById('roster-pending');
  const rosterApproved = doc.getElementById('roster-approved');
  const rosterEmpty = doc.getElementById('roster-empty');
  const codeHint = doc.getElementById('code-hint');
  const dismissHintButton = doc.getElementById('dismiss-hint');
  const emptyLedger = doc.getElementById('empty-ledger');
  const ledgerPanel = doc.getElementById('ledger');
  const ledgerList = doc.getElementById('ledger-list');
  const addExpenseButton = doc.getElementById('add-expense');
  const expensePanel = doc.getElementById('expense-panel');
  const expenseForm = doc.getElementById('expense-form');
  const expenseDescription = doc.getElementById('expense-description');
  const expenseAmount = doc.getElementById('expense-amount');
  const expensePayer = doc.getElementById('expense-payer');
  const expenseDate = doc.getElementById('expense-date');
  const expenseTime = doc.getElementById('expense-time');
  const expenseNote = doc.getElementById('expense-note');
  const expenseCurrency = doc.getElementById('expense-currency');
  const splitInputs = doc.getElementById('split-inputs');
  const splitPreview = doc.getElementById('split-preview');
  const splitNote = doc.getElementById('split-note');
  const splitModes = [...doc.querySelectorAll('input[name="split-mode"]')];
  const expenseError = doc.getElementById('expense-error');
  const expenseSave = doc.getElementById('expense-save');
  const expenseCancel = doc.getElementById('expense-cancel');

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
  const notice = doc.getElementById('session-notice');

  const local = (() => {
    try {
      return win.localStorage;
    } catch {
      return null;
    }
  })();
  const tab = (() => {
    try {
      return win.sessionStorage;
    } catch {
      return null;
    }
  })();

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
  let currentMode = 'approval';
  let resumeSession = null;
  let groupId = null;
  let groupIdPromise = null;
  let groupKeyPromise = null;
  let selfId = null;
  let selfName = '';
  let groupCurrency = DEFAULT_CURRENCY;
  let members = new Map();
  let ledger = new Map();
  let expenseSheetOpen = false;
  let expenseDraftId = null;
  let pendingExpenseId = null;
  let savingExpense = false;
  let previewShares = null;

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
  toggleModeButton.addEventListener('click', () => {
    if (!hostSocket || hostSocket.readyState !== 1) return;
    const next = currentMode === 'open' ? 'approval' : 'open';
    toggleModeButton.disabled = true;
    hostSocket.send(JSON.stringify({ t: 'mode', mode: next }));
  });

  addExpenseButton.addEventListener('click', openExpenseSheet);
  expenseForm.addEventListener('submit', (event) => {
    void saveExpense(event);
  });
  expenseCancel.addEventListener('click', closeExpenseSheet);
  splitModes.forEach((radio) => radio.addEventListener('change', renderSplit));
  splitInputs.addEventListener('input', updatePreview);
  splitInputs.addEventListener('change', updatePreview);
  expenseAmount.addEventListener('input', updatePreview);

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
        displayName: fields.displayName,
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
      showGroup({
        code,
        name: fields.name,
        displayName: fields.displayName,
        memberId: payload.hostId,
        currency: fields.currency
      });
      remember({
        groupId: payload.groupId,
        memberId: payload.hostId,
        secret,
        displayName: fields.displayName,
        code
      });
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

  /** The join mode, and the one control only the organizer may use. */
  function applyMode(mode, role) {
    currentMode = mode === 'open' ? 'open' : 'approval';
    joinModeLine.textContent =
      currentMode === 'open'
        ? 'Anyone with the code can join.'
        : 'People need approval to join.';

    const host = role === 'organizer' || role === 'host';
    if (host) {
      toggleModeButton.hidden = false;
      toggleModeButton.disabled = false;
      toggleModeButton.textContent =
        currentMode === 'open'
          ? 'Require approval again'
          : 'Open joining to anyone with the code';
    } else {
      toggleModeButton.hidden = true;
    }
  }

  /** Replace the form with the group, in place: no modal, no confirmation, no second screen. */
  function showGroup({ code, name, displayName, role = 'organizer', memberId = null, currency = DEFAULT_CURRENCY }) {
    group = { code };
    resumeSession = null;
    hideNotice();

    groupId = null;
    groupIdPromise = groupIdFromCode(code);
    void groupIdPromise.then((value) => {
      groupId = value;
    });
    groupKeyPromise = deriveGroupKey(code);
    selfId = memberId;
    selfName = displayName || 'You';
    groupCurrency = normalizeCurrency(currency);
    members = new Map();
    if (memberId) members.set(memberId, selfName);
    ledger = new Map();
    expenseDraftId = null;
    pendingExpenseId = null;
    savingExpense = false;
    closeExpenseSheet();
    renderLedger();

    groupNameDisplay.textContent = name;
    groupCode.textContent = formatCode(code);
    whoLine.textContent = displayName;
    whoLine.hidden = false;
    roleLine.textContent = role === 'organizer' ? 'you are the organizer' : 'you are a member';
    applyMode('approval', role);
    roster.hidden = role !== 'organizer';
    rosterPending.textContent = '';
    rosterApproved.textContent = '';
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

  function showNotice(message) {
    notice.textContent = message;
    notice.hidden = false;
  }

  function hideNotice() {
    notice.textContent = '';
    notice.hidden = true;
  }

  /** Keep the seat on this device: the secret locally, the code for this tab only. */
  function remember({ groupId, memberId, secret, displayName, code }) {
    saveSession(local, {
      groupId,
      memberId,
      memberSecret: secret,
      displayName
    });
    saveCode(tab, groupId, code);
    setLastGroup(local, groupId);
  }

  function forget(groupId) {
    forgetSession(local, groupId);
    forgetCode(tab, groupId);
  }

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
    const idle = resumeSession ? 'Reopen group' : 'Ask to join';
    joinButton.textContent = busy ? (resumeSession ? 'Reopening…' : 'Asking…') : idle;
  }

  /** The join sheet, with an optional code already in the field. */
  function showJoin({ code = '', error = '', resume = null } = {}) {
    closeJoinSocket();
    closeExpenseSheet();
    hideNotice();
    group = null;
    resumeSession = resume;
    ledgerPanel.hidden = true;
    createPanel.hidden = true;
    groupHeader.hidden = true;
    emptyLedger.hidden = true;
    waitingPanel.hidden = true;
    joinPanel.hidden = false;

    joinCodeInput.removeAttribute('aria-invalid');
    joinNameInput.removeAttribute('aria-invalid');
    hideJoinError();
    if (code) joinCodeInput.value = formatCode(code);
    if (resume) joinNameInput.value = resume.displayName;
    if (error) showJoinError(error);
    else if (resume) showJoinError('Enter the code to reopen your group.');
    joinButton.textContent = resume ? 'Reopen group' : 'Ask to join';

    if (code && !resume) joinNameInput.focus();
    else joinCodeInput.focus();
  }

  function showCreate() {
    closeJoinSocket();
    closeHostSocket();
    closeExpenseSheet();
    hideNotice();
    group = null;
    resumeSession = null;
    ledgerPanel.hidden = true;
    joinPanel.hidden = true;
    waitingPanel.hidden = true;
    groupHeader.hidden = true;
    emptyLedger.hidden = true;
    createPanel.hidden = false;
    hideJoinError();
    nameInput.focus();
  }

  function showWaiting(code) {
    closeExpenseSheet();
    createPanel.hidden = true;
    joinPanel.hidden = true;
    groupHeader.hidden = true;
    emptyLedger.hidden = true;
    ledgerPanel.hidden = true;
    waitingPanel.hidden = false;
    waitingCode.textContent = formatCode(code);
    waitingTitle.textContent = 'Waiting for the organizer';
    waitingCopy.textContent =
      'The organizer has to let you in. Nothing from the group is shown until they do.';
    waitingBack.hidden = false;
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

    if (resumeSession) {
      const groupId = await groupIdFromCode(code.code);
      if (groupId === resumeSession.groupId) {
        saveCode(tab, groupId, code.code);
        setLastGroup(local, groupId);
        joinPending = true;
        setJoinBusy(true);
        try {
          await resumeStored(resumeSession, code.code);
        } finally {
          joinPending = false;
          setJoinBusy(false);
        }
        return;
      }
      resumeSession = null;
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
      openJoinSocket({
        groupId,
        memberId,
        secret,
        nameBlob,
        code: code.code,
        displayName: name.value
      });
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

  /**
   * Bring back a stored seat: one socket, the secret as proof, no form.
   *
   * The room is probed first because a group that no longer exists would otherwise fail a
   * handshake with no reason a browser can read. A missing room forgets the seat and says the group
   * has ended; a refused or removed member forgets it too, with the sentence the server chose.
   */
  async function resumeStored(session, code) {
    hideNotice();
    closeJoinSocket();
    closeHostSocket();

    const groupId = await groupIdFromCode(code);
    if (groupId !== session.groupId) {
      forget(session.groupId);
      showJoin({ code, error: 'That code is for a different group.' });
      return;
    }

    const reachable = await probeRoom(groupId);
    if (reachable === 'missing') {
      forget(groupId);
      showCreate();
      showNotice('This group has ended.');
      return;
    }
    if (reachable === 'offline') {
      showJoin({ code, error: OFFLINE_MESSAGE, resume: session });
      return;
    }

    showWaiting(code);
    waitingTitle.textContent = 'Reopening your group';
    waitingCopy.textContent = 'Bringing back your seat…';
    waitingBack.hidden = true;

    const url = new URL('api/ws', win.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', groupId);

    let socket;
    try {
      socket = new win.WebSocket(url.toString());
    } catch {
      showJoin({ code, error: RETRY_MESSAGE, resume: session });
      return;
    }

    joinSocket = socket;
    const groupKey = deriveGroupKey(code);
    let settled = false;
    let shown = false;

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          t: 'auth',
          id: session.memberId,
          secret: session.memberSecret,
          mode: 'resume'
        })
      );
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
        showWaiting(code);
        remember({
          groupId,
          memberId: session.memberId,
          secret: session.memberSecret,
          displayName: session.displayName,
          code
        });
        return;
      }

      if (frame.t === 'state') {
        settled = true;
        const key = await groupKey;
        let name = 'Your group';
        try {
          const opened = await open(key, frame.nameBlob);
          if (typeof opened?.name === 'string') name = opened.name;
        } catch {
          /* a neutral label beats an unreadable blob */
        }

        if (frame.role === 'host') {
          if (!shown) {
            joinSocket = null;
            hostSocket = socket;
            showGroup({
              code,
              name,
              displayName: session.displayName,
              role: 'organizer',
              memberId: session.memberId
            });
            shown = true;
          }
          await renderRoster(frame, Promise.resolve(key));
          await applyGroupState(frame, Promise.resolve(key));
        } else {
          if (!shown) {
            showGroup({
              code,
              name,
              displayName: session.displayName,
              role: 'member',
              memberId: session.memberId
            });
            shown = true;
          }
          applyMode(frame.joinMode, 'member');
          await applyGroupState(frame, Promise.resolve(key));
        }

        remember({
          groupId,
          memberId: session.memberId,
          secret: session.memberSecret,
          displayName: session.displayName,
          code
        });
        return;
      }

      if (frame.t === 'record') {
        void handleRecordFrame(frame);
        return;
      }

      if (frame.t === 'conflict' && handleExpenseConflict(frame)) return;

      if (frame.t === 'removed') {
        settled = true;
        forget(groupId);
        closeJoinSocket();
        showJoin({ code, error: 'Removed from this group.' });
        return;
      }

      if (frame.t === 'refused') {
        if (handleExpenseRefusal(frame)) return;
        settled = true;
        closeJoinSocket();
        if (frame.code === 'rate_limited') {
          showJoin({ code, error: refusalMessage(frame.code), resume: session });
        } else {
          forget(groupId);
          showJoin({ code, error: refusalMessage(frame.code) });
        }
      }
    });

    socket.addEventListener('close', () => {
      if (hostSocket === socket) {
        hostSocket = null;
        rosterEmpty.textContent = 'Connection lost. Reload to continue.';
        rosterEmpty.hidden = false;
        expenseConnectionLost();
        return;
      }
      if (joinSocket !== socket) return;
      joinSocket = null;
      expenseConnectionLost();
      if (settled) return;
      showJoin({ code, error: 'The group could not be reached. Try again.', resume: session });
    });

    socket.addEventListener('error', () => {
      /* a close event follows */
    });
  }

  function openJoinSocket({ groupId, memberId, secret, nameBlob, code, displayName }) {
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
        remember({ groupId, memberId, secret, displayName, code });
        waitingCopy.textContent =
          'The organizer has to let you in. Nothing from the group is shown until they do.';
        return;
      }

      if (frame.t === 'state' && frame.role === 'member') {
        settled = true;

        /* A member already in the group only needs the mode when it changes; the first state after
           a join is what replaces the waiting screen. */
        if (group) {
          applyMode(frame.joinMode, 'member');
          void applyGroupState(frame, groupKeyPromise);
          return;
        }

        let name = 'Your group';
        try {
          const key = await deriveGroupKey(code);
          const opened = await open(key, frame.nameBlob);
          if (typeof opened?.name === 'string') name = opened.name;
        } catch {
          /* the name stays a neutral label rather than an unreadable blob */
        }
        showGroup({
          code,
          name,
          displayName: displayName || joinNameInput.value.trim(),
          role: 'member',
          memberId
        });
        applyMode(frame.joinMode, 'member');
        void applyGroupState(frame, groupKeyPromise);
        remember({ groupId, memberId, secret, displayName, code });
        if (frame.openAdmit) {
          setStatus("You're in — this group lets anyone with the code join.");
        }
        return;
      }

      if (frame.t === 'record') {
        void handleRecordFrame(frame);
        return;
      }

      if (frame.t === 'conflict' && handleExpenseConflict(frame)) return;

      if (frame.t === 'removed') {
        settled = true;
        forget(groupId);
        closeJoinSocket();
        showJoin({ code, error: 'Removed from this group.' });
        return;
      }

      if (frame.t === 'refused') {
        if (handleExpenseRefusal(frame)) return;
        settled = true;
        forget(groupId);
        closeJoinSocket();
        showJoin({ code, error: refusalMessage(frame.code) });
      }
    });

    socket.addEventListener('close', () => {
      if (joinSocket !== socket) return;
      joinSocket = null;
      expenseConnectionLost();
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
      toggleModeButton.disabled = true;
      socket = new win.WebSocket(url.toString());
    } catch {
      rosterEmpty.textContent = 'Could not open a connection. Reload to continue.';
      rosterEmpty.hidden = false;
      return;
    }

    hostSocket = socket;
    const key = deriveGroupKey(code);

    socket.addEventListener('open', () => {
      toggleModeButton.disabled = false;
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
        void applyGroupState(frame, key);
        return;
      }
      if (frame.t === 'record') {
        void handleRecordFrame(frame);
        return;
      }
      if (frame.t === 'conflict' && handleExpenseConflict(frame)) return;
      if (frame.t === 'refused') {
        if (handleExpenseRefusal(frame)) return;
        rosterEmpty.textContent = 'That request could not be completed.';
        rosterEmpty.hidden = false;
        toggleModeButton.disabled = false;
      }
    });

    socket.addEventListener('close', () => {
      if (hostSocket !== socket) return;
      hostSocket = null;
      rosterEmpty.textContent = 'Connection lost. Reload to continue.';
      rosterEmpty.hidden = false;
      toggleModeButton.disabled = true;
      expenseConnectionLost();
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

  /* One armed removal at a time; the second click within four seconds is the one that acts. */
  let armedMemberId = null;
  let armedButton = null;
  let armedTimer = null;

  function disarm() {
    if (armedTimer !== null) win.clearTimeout(armedTimer);
    armedTimer = null;
    armedMemberId = null;
    if (armedButton) {
      armedButton.textContent = 'Remove';
      armedButton.classList.remove('is-armed');
    }
    armedButton = null;
  }

  async function nameOf(key, blob) {
    try {
      const opened = await open(key, blob);
      return typeof opened?.name === 'string' ? opened.name : 'Someone';
    } catch {
      return 'Name could not be opened';
    }
  }

  /** The names are sealed; the host has the code, so it can open them and nobody else can. */
  async function renderRoster(frame, keyPromise) {
    if (frame.role !== 'host') return;

    const key = await keyPromise;
    const pending = frame.roster.filter((member) => member.status === 'pending');
    const approved = frame.roster.filter(
      (member) => member.status === 'approved' && member.id !== frame.memberId
    );

    applyMode(frame.joinMode, 'host');
    disarm();
    rosterPending.textContent = '';
    rosterApproved.textContent = '';
    roster.hidden = false;
    rosterEmpty.hidden = pending.length > 0;
    rosterEmpty.textContent = 'No one is waiting.';

    /* The organizer's own chip is a label, never a control: there is no member entry for the host,
       so there is nothing to remove and no button to press. */
    const self = doc.createElement('li');
    self.className = 'chip is-self';
    const selfName = doc.createElement('span');
    selfName.textContent = whoLine.textContent || 'You';
    const selfRole = doc.createElement('span');
    selfRole.className = 'muted';
    selfRole.textContent = 'organizer';
    self.append(selfName, selfRole);
    rosterApproved.append(self);

    for (const member of pending) {
      const chip = doc.createElement('li');
      chip.className = 'chip';

      const label = doc.createElement('span');
      label.textContent = await nameOf(key, member.nameBlob);

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
      rosterPending.append(chip);
    }

    for (const member of approved) {
      const chip = doc.createElement('li');
      chip.className = 'chip';

      const label = doc.createElement('span');
      label.textContent = await nameOf(key, member.nameBlob);

      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        if (armedMemberId !== member.id) {
          disarm();
          armedMemberId = member.id;
          armedButton = remove;
          remove.textContent = 'Remove? Their entries stay';
          remove.classList.add('is-armed');
          armedTimer = win.setTimeout(disarm, 4000);
          return;
        }

        disarm();
        remove.disabled = true;
        if (hostSocket) hostSocket.send(JSON.stringify({ t: 'remove', memberId: member.id }));
      });

      chip.append(label, remove);
      rosterApproved.append(chip);
    }
  }

  /* ------------------------------------------------------------- the ledger */

  function expenseMode() {
    return splitModes.find((radio) => radio.checked)?.value ?? 'equal';
  }

  function splitMembers() {
    return [...members.entries()].sort(
      (left, right) => left[1].localeCompare(right[1]) || (left[0] < right[0] ? -1 : 1)
    );
  }

  function expenseFailure(message, field) {
    expenseError.textContent = message;
    expenseError.hidden = false;
    field?.focus?.();
  }

  function todayDate() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function nowTime() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  /** The socket this page is already holding: the host's, or the member's. */
  function activeSocket() {
    if (hostSocket && hostSocket.readyState === 1) return hostSocket;
    if (joinSocket && joinSocket.readyState === 1) return joinSocket;
    return null;
  }

  async function decryptRecord(key, record, groupIdValue) {
    try {
      const value = await open(key, record.blob, expenseAad(groupIdValue, record.id));
      if (
        value === null ||
        typeof value !== 'object' ||
        typeof value.description !== 'string' ||
        !Number.isSafeInteger(value.amountPaise)
      ) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  /** The people and the ledger, rebuilt from a state frame the viewer is allowed to see. */
  async function applyGroupState(frame, keyPromise) {
    const key = await keyPromise;
    const groupIdValue = await groupIdPromise;
    if (!groupIdValue) return;
    groupId = groupIdValue;
    selfId = frame.memberId;

    if (frame.metaBlob) {
      try {
        const meta = await open(key, frame.metaBlob);
        if (meta?.currency) groupCurrency = normalizeCurrency(meta.currency);
      } catch {
        /* the selected currency stays the fallback */
      }
    }

    const previousMembers = [...members.keys()].join(',');
    const nextMembers = new Map();
    for (const member of frame.roster ?? []) {
      if (member.status !== 'approved') continue;
      nextMembers.set(member.id, await nameOf(key, member.nameBlob));
    }
    if (selfId && !nextMembers.has(selfId)) nextMembers.set(selfId, selfName || 'You');
    members = nextMembers;

    const nextLedger = new Map();
    for (const record of frame.records ?? []) {
      if (record.deleted) continue;
      const value = await decryptRecord(key, record, groupIdValue);
      if (value) nextLedger.set(record.id, { ...record, value });
    }
    ledger = nextLedger;

    renderLedger();
    if (expenseSheetOpen) {
      renderPayerOptions();
      if ([...members.keys()].join(',') !== previousMembers) renderSplit();
      else updatePreview();
    }
  }

  function renderLedger() {
    const rows = [...ledger.values()].sort(
      (left, right) => (left.at ?? 0) - (right.at ?? 0) || (left.id < right.id ? -1 : 1)
    );

    ledgerList.textContent = '';
    if (groupHeader.hidden) {
      ledgerPanel.hidden = true;
      return;
    }
    ledgerPanel.hidden = rows.length === 0;
    emptyLedger.hidden = rows.length !== 0;

    for (const record of rows) {
      const value = record.value;
      const row = doc.createElement('li');
      row.className = 'expense-row';

      const left = doc.createElement('div');
      const title = doc.createElement('h3');
      title.textContent = value.description;
      const meta = doc.createElement('p');
      meta.className = 'expense-meta';
      const payer = members.get(value.paidBy) || 'Someone';
      meta.textContent = `Paid by ${payer} · ${value.date} ${value.time}`;
      left.append(title, meta);

      const amount = doc.createElement('span');
      amount.className = 'expense-amount';
      amount.textContent = formatPaise(value.amountPaise, groupCurrency);

      row.append(left, amount);
      ledgerList.append(row);
    }
  }

  function renderPayerOptions() {
    const current = expensePayer.value;
    expensePayer.textContent = '';

    for (const [id, name] of splitMembers()) {
      const option = doc.createElement('option');
      option.value = id;
      option.textContent = name;
      expensePayer.append(option);
    }

    if (current && members.has(current)) expensePayer.value = current;
    else if (selfId && members.has(selfId)) expensePayer.value = selfId;
    else if (expensePayer.options.length > 0) expensePayer.selectedIndex = 0;
  }

  function renderSplit() {
    const entries = splitMembers();
    splitInputs.textContent = '';
    const mode = expenseMode();

    if (mode === 'equal') {
      splitNote.textContent = `Split equally between ${entries.length} ${
        entries.length === 1 ? 'person' : 'people'
      }.`;
    } else if (mode === 'chosen') {
      splitNote.textContent = 'Tick the people who share this expense.';
      for (const [id, name] of entries) {
        const label = doc.createElement('label');
        const text = doc.createElement('span');
        text.textContent = name;
        const box = doc.createElement('input');
        box.type = 'checkbox';
        box.checked = true;
        box.dataset.memberId = id;
        label.append(text, box);
        splitInputs.append(label);
      }
    } else {
      const defaults = defaultPercentages(entries.map(([id]) => id));
      splitNote.textContent = 'The percentages must total 100.';
      for (const [id, name] of entries) {
        const label = doc.createElement('label');
        const text = doc.createElement('span');
        text.textContent = name;
        const input = doc.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.max = '100';
        input.step = '0.1';
        input.value = String(defaults[id] ?? 0);
        input.dataset.memberId = id;
        label.append(text, input);
        splitInputs.append(label);
      }
    }

    updatePreview();
  }

  function currentSplit() {
    const amount = parseAmount(expenseAmount.value);
    if (!amount.ok) return { ok: false, message: amount.message };

    const entries = splitMembers();
    if (entries.length === 0) return { ok: false, message: 'No one is in the group yet.' };

    const mode = expenseMode();
    if (mode === 'equal') {
      return splitFor({
        mode,
        amountPaise: amount.paise,
        memberIds: entries.map(([id]) => id)
      });
    }
    if (mode === 'chosen') {
      const chosenIds = [...splitInputs.querySelectorAll('input[type="checkbox"]:checked')].map(
        (input) => input.dataset.memberId
      );
      return splitFor({ mode, amountPaise: amount.paise, chosenIds });
    }

    const percentages = {};
    for (const input of splitInputs.querySelectorAll('input[type="number"]')) {
      percentages[input.dataset.memberId] = Number(input.value);
    }
    return splitFor({ mode, amountPaise: amount.paise, percentages });
  }

  function updatePreview() {
    previewShares = null;
    splitPreview.textContent = '';
    const split = currentSplit();
    if (!split.ok) {
      splitNote.textContent = split.message;
      return;
    }

    previewShares = split.shares;
    const names = new Map(splitMembers());
    for (const [id, paise] of Object.entries(split.shares)) {
      const row = doc.createElement('li');
      const name = doc.createElement('span');
      name.textContent = names.get(id) || 'Someone';
      const amount = doc.createElement('span');
      amount.textContent = formatPaise(paise, groupCurrency);
      row.append(name, amount);
      splitPreview.append(row);
    }

    const total = Object.values(split.shares).reduce((sum, paise) => sum + paise, 0);
    splitNote.textContent = `${formatPaise(total, groupCurrency)} split between ${
      Object.keys(split.shares).length
    } ${Object.keys(split.shares).length === 1 ? 'person' : 'people'}.`;
  }

  function openExpenseSheet() {
    if (!group) return;
    expenseSheetOpen = true;
    expenseDraftId = randomSecret();
    pendingExpenseId = null;
    savingExpense = false;
    expenseError.hidden = true;
    expenseError.textContent = '';
    expenseDescription.value = '';
    expenseAmount.value = '';
    expenseNote.value = '';
    expenseDate.value = todayDate();
    expenseTime.value = nowTime();
    expenseSave.disabled = false;
    expenseCancel.disabled = false;
    expenseSave.textContent = 'Save expense';
    expenseCurrency.textContent = groupCurrency;
    splitModes.forEach((radio) => {
      radio.checked = radio.value === 'equal';
    });

    renderPayerOptions();
    renderSplit();
    expensePanel.hidden = false;
    expenseDescription.focus();
  }

  function closeExpenseSheet() {
    expenseSheetOpen = false;
    expensePanel.hidden = true;
    expenseError.hidden = true;
    expenseError.textContent = '';
    pendingExpenseId = null;
    savingExpense = false;
    expenseSave.disabled = false;
    expenseCancel.disabled = false;
    expenseSave.textContent = 'Save expense';
    splitInputs.textContent = '';
    splitPreview.textContent = '';
    splitNote.textContent = '';
    renderLedger();
  }

  function expenseConnectionLost() {
    if (!savingExpense) return;
    savingExpense = false;
    expenseSave.disabled = false;
    expenseCancel.disabled = false;
    expenseSave.textContent = 'Save expense';
    expenseFailure('The group is not connected. Try again.', expenseSave);
  }

  async function saveExpense(event) {
    event.preventDefault();
    if (!group || savingExpense) return;

    expenseError.hidden = true;
    const description = validateDescription(expenseDescription.value);
    if (!description.ok) return expenseFailure(description.message, expenseDescription);
    const amount = parseAmount(expenseAmount.value);
    if (!amount.ok) return expenseFailure(amount.message, expenseAmount);
    const date = validateDate(expenseDate.value);
    if (!date.ok) return expenseFailure(date.message, expenseDate);
    const time = validateTime(expenseTime.value);
    if (!time.ok) return expenseFailure(time.message, expenseTime);
    const note = validateNote(expenseNote.value);
    if (!note.ok) return expenseFailure(note.message, expenseNote);
    if (!members.has(expensePayer.value)) {
      return expenseFailure('Choose who paid.', expensePayer);
    }

    const split = currentSplit();
    if (!split.ok) return expenseFailure(split.message, splitInputs);
    previewShares = split.shares;

    const socket = activeSocket();
    if (!socket) return expenseFailure('The group is not connected. Try again.', expenseSave);

    savingExpense = true;
    expenseSave.disabled = true;
    expenseCancel.disabled = true;
    expenseSave.textContent = 'Saving…';

    try {
      const key = await groupKeyPromise;
      const groupIdValue = await groupIdPromise;
      const value = {
        description: description.value,
        amountPaise: amount.paise,
        paidBy: expensePayer.value,
        split: split.shares,
        date: date.value,
        time: time.value,
        note: note.value
      };
      const blob = await seal(key, value, expenseAad(groupIdValue, expenseDraftId));
      pendingExpenseId = expenseDraftId;
      socket.send(
        JSON.stringify({ t: 'put', id: expenseDraftId, base: 0, blob, deleted: false })
      );
    } catch {
      savingExpense = false;
      expenseSave.disabled = false;
      expenseCancel.disabled = false;
      expenseSave.textContent = 'Save expense';
      expenseFailure('The expense could not be sealed. Try again.', expenseSave);
    }
  }

  async function handleRecordFrame(frame) {
    if (!groupKeyPromise) return;
    const key = await groupKeyPromise;
    const groupIdValue = await groupIdPromise;
    if (frame.deleted) return;

    const value = await decryptRecord(key, frame, groupIdValue);
    if (!value) return;
    ledger.set(frame.id, { ...frame, value });
    renderLedger();

    if (frame.id === pendingExpenseId) {
      pendingExpenseId = null;
      savingExpense = false;
      closeExpenseSheet();
      setStatus('Expense added.');
    }
  }

  function handleExpenseRefusal(frame) {
    if (!savingExpense || frame.id !== pendingExpenseId) return false;
    savingExpense = false;
    pendingExpenseId = null;
    expenseSave.disabled = false;
    expenseCancel.disabled = false;
    expenseSave.textContent = 'Save expense';
    const message =
      frame.code === 'too_large'
        ? 'That expense is too large to save.'
        : frame.code === 'deleted'
          ? 'This expense was deleted.'
          : frame.code === 'unapproved'
            ? 'You are not approved to add expenses.'
            : 'The expense could not be saved. Try again.';
    expenseFailure(message, expenseSave);
    return true;
  }

  function handleExpenseConflict(frame) {
    if (!savingExpense || frame.id !== pendingExpenseId) return false;
    savingExpense = false;
    pendingExpenseId = null;
    expenseSave.disabled = false;
    expenseCancel.disabled = false;
    expenseSave.textContent = 'Save expense';
    expenseFailure('This expense changed elsewhere. Try again.', expenseSave);
    return true;
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

  /* An invite link opens the join sheet with the code already there; a stored seat is resumed
     before any form is shown. The fragment never reaches the server. */
  async function bootSession() {
    const invitation = win.location.hash || win.location.search || '';
    const invited = codeFromInput(invitation);

    if (invited.ok) {
      const groupId = await groupIdFromCode(invited.code);
      const stored = sessionFor(local, groupId);
      if (stored) {
        saveCode(tab, groupId, invited.code);
        setLastGroup(local, groupId);
        await resumeStored(stored, invited.code);
        return;
      }
      showJoin({ code: invited.code });
      return;
    }

    if (invitation && /[#?](?:code|c)=/i.test(invitation)) {
      showJoin();
      joinCodeInput.value = invitation;
      showJoinError(invited.message);
      return;
    }

    const groupId = lastGroup(local);
    const stored = groupId ? sessionFor(local, groupId) : null;
    if (!stored) return;

    const code = codeFor(tab, groupId);
    if (code) {
      await resumeStored(stored, code);
      return;
    }
    showJoin({ resume: stored });
  }

  doc.documentElement.dataset.splitter = 'ready';
  void bootSession().catch(() => {
    showCreate();
    showNotice('The saved seat could not be read. Enter the code to continue.');
  });
}

/* Under `node --test` there is no document, so importing this module for its pure functions wires
   nothing. In a browser the module is deferred, so the form exists by the time this line runs. */
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  init(document, window);
}
