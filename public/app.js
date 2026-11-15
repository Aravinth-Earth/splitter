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
  forgetRevs,
  lastGroup,
  revsFor,
  saveCode,
  saveRevs,
  saveSession,
  sessionFor,
  setLastGroup
} from './store.js';
import { GroupSocket, RevGuard } from './sync.js';
import { attribute, balances, ledgerContributions, settle } from './balance.js';
import { renderChart, totals as chartTotals } from './charts.js';
import { mergeDiff } from './merge.js';
import { exportFileName, exportGroup, importGroup } from './export.js';
import { cacheFor, forgetGroupCache, outboxFor, saveCache, saveOutbox } from './cache.js';
import {
  defaultPercentages,
  defaultShares,
  expenseAad,
  formatPaise,
  parseAmount,
  parseCustomAmount,
  settlementAad,
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
export const OFFLINE_FIRST_MESSAGE =
  'Open this group once with a connection; after that it works offline.';
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
  const connection = doc.getElementById('connection');
  const pendingCount = doc.getElementById('pending-count');
  const offlineBanner = doc.getElementById('offline-banner');
  const offlineText = doc.getElementById('offline-text');
  const offlineRetry = doc.getElementById('offline-retry');
  const leaveGroupButton = doc.getElementById('leave-group');
  const endGroupButton = doc.getElementById('end-group');
  const lifecycleConfirm = doc.getElementById('lifecycle-confirm');
  const lifecycleText = doc.getElementById('lifecycle-text');
  const lifecycleCancel = doc.getElementById('lifecycle-cancel');
  const lifecycleConfirmButton = doc.getElementById('lifecycle-confirm-button');
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
  const balancesPanel = doc.getElementById('balances');
  const balanceList = doc.getElementById('balance-list');
  const transferList = doc.getElementById('transfer-list');
  const settleNote = doc.getElementById('settle-note');
  const chartsPanel = doc.getElementById('charts');
  const chartHost = doc.getElementById('chart-host');
  const chartModes = [...doc.querySelectorAll('input[name="chart-view"]')];
  const exportPanel = doc.getElementById('export-panel');
  const exportButton = doc.getElementById('export-json');
  const exportStatus = doc.getElementById('export-status');
  const importButton = doc.getElementById('import-json');
  const importFile = doc.getElementById('import-file');
  const importConfirm = doc.getElementById('import-confirm');
  const importConfirmText = doc.getElementById('import-confirm-text');
  const importConfirmButton = doc.getElementById('import-confirm-button');
  const importCancelButton = doc.getElementById('import-cancel-button');
  const importStatus = doc.getElementById('import-status');
  const paymentList = doc.getElementById('payment-list');
  const recordPaymentButton = doc.getElementById('record-payment');
  const settlementPanel = doc.getElementById('settlement-panel');
  const settlementForm = doc.getElementById('settlement-form');
  const settleFrom = doc.getElementById('settle-from');
  const settleTo = doc.getElementById('settle-to');
  const settleAmount = doc.getElementById('settle-amount');
  const settleDate = doc.getElementById('settle-date');
  const settleTime = doc.getElementById('settle-time');
  const settleNoteInput = doc.getElementById('settle-note');
  const settleError = doc.getElementById('settle-error');
  const settleSave = doc.getElementById('settle-save');
  const settleCancel = doc.getElementById('settle-cancel');
  const addExpenseButton = doc.getElementById('add-expense');
  const expensePanel = doc.getElementById('expense-panel');
  const expenseForm = doc.getElementById('expense-form');
  const expenseDescription = doc.getElementById('expense-description');
  const expenseAmount = doc.getElementById('expense-amount');
  const expensePayer = doc.getElementById('expense-payer');
  const payerSingle = doc.getElementById('payer-single');
  const addPayerButton = doc.getElementById('add-payer');
  const payerRows = doc.getElementById('payer-rows');
  const payerTotal = doc.getElementById('payer-total');
  const addAnotherWrap = doc.getElementById('add-another-wrap');
  const addAnotherPayerButton = doc.getElementById('add-another-payer');
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
  let groupRole = 'organizer';
  let outboxWarningShown = false;
  let groupCurrency = DEFAULT_CURRENCY;
  let members = new Map();
  let removedMembers = new Set();
  let leftMembers = new Set();
  let ledger = new Map();
  let recordGuard = new RevGuard();
  let guardGroupId = null;
  let expenseSheetOpen = false;
  let expenseDraftId = null;
  let pendingExpenseId = null;
  let pendingExpenseEdit = false;
  let editingBaseValue = null;
  let pendingExpenseValue = null;
  let mergeNotice = null;
  let mergeNoticeFields = [];
  let mergeRetryId = null;
  let pendingImport = null;
  let importJob = null;
  let cachedBase = null;
  let cachedRecords = new Map();
  let cacheTimer = null;
  let cachedSavedAt = 0;
  let connectionStatus = 'offline';
  let queuedEditBases = new Map();
  let queuedEditRetries = new Set();
  let lifecycleAction = null;
  let endedHandledFor = null;
  let pendingDeleteId = null;
  let editingExpense = null;
  let customSeed = null;
  let lastBalances = {};
  let lastChartIds = [];
  let lastChartNames = new Map();
  let lastChartExpenses = [];
  let multiPayer = false;
  let settlementDraftId = null;
  let pendingSettlementId = null;
  let savingSettlement = false;
  let savingExpense = false;
  let previewShares = null;
  let armedDeleteId = null;
  let armedDeleteButton = null;
  let deleteTimer = null;

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
    if (!hostSocket?.isOpen) return;
    const next = currentMode === 'open' ? 'approval' : 'open';
    toggleModeButton.disabled = true;
    hostSocket.send({ t: 'mode', mode: next });
  });

  addExpenseButton.addEventListener('click', () => openExpenseSheet());
  expenseForm.addEventListener('submit', (event) => {
    void saveExpense(event);
  });
  expenseCancel.addEventListener('click', closeExpenseSheet);
  splitModes.forEach((radio) => radio.addEventListener('change', renderSplit));
  splitInputs.addEventListener('input', updatePreview);
  splitInputs.addEventListener('change', updatePreview);
  expenseAmount.addEventListener('input', () => {
    updatePreview();
    updatePayerTotal();
  });
  chartModes.forEach((radio) => radio.addEventListener('change', renderCharts));
  exportButton.addEventListener('click', downloadExport);
  leaveGroupButton.addEventListener('click', () => openLifecycle('leave'));
  endGroupButton.addEventListener('click', () => openLifecycle('end'));
  lifecycleCancel.addEventListener('click', closeLifecycle);
  lifecycleConfirmButton.addEventListener('click', confirmLifecycle);
  offlineRetry.addEventListener('click', () => {
    const socket = groupSocket();
    if (!socket) return;
    offlineRetry.disabled = true;
    socket.connect();
  });
  importButton.addEventListener('click', () => {
    if (importJob) return;
    importFile.value = '';
    importFile.click();
  });
  importFile.addEventListener('change', () => {
    void chooseImportFile();
  });
  importConfirmButton.addEventListener('click', () => {
    const chosen = pendingImport;
    pendingImport = null;
    importConfirm.hidden = true;
    if (chosen) void beginImport(chosen);
  });
  importCancelButton.addEventListener('click', () => {
    pendingImport = null;
    importConfirm.hidden = true;
    importStatus.textContent = 'Import cancelled.';
  });
  addPayerButton.addEventListener('click', expandPayers);
  addAnotherPayerButton.addEventListener('click', () => addPayerRow());
  payerRows.addEventListener('input', updatePayerTotal);
  recordPaymentButton.addEventListener('click', () => openSettlement(null));
  settlementForm.addEventListener('submit', (event) => {
    void saveSettlement(event);
  });
  settleCancel.addEventListener('click', closeSettlementSheet);

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

  /** The connection is a state a person can see, not a toast that disappears mid-drop. */
  /** 120 queued writes a minute is the budget the flush paces itself to. */
  const WRITE_GAP_MS = 500;

  function renderPendingCount() {
    const count = groupSocket()?.queueEntries().length ?? 0;
    pendingCount.hidden = count === 0;
    pendingCount.textContent =
      count === 0 ? '' : `${count} ${count === 1 ? 'change' : 'changes'} waiting`;
    if (!offlineBanner.hidden) renderOfflineBanner(connectionStatus);
  }

  /**
   * The cached ledger stays on screen while the socket is down, with its age and the queue size.
   * Retry starts the same reconnect loop without a reload.
   */
  function renderOfflineBanner(status) {
    connectionStatus = status;
    if (
      !cachedBase ||
      groupHeader.hidden ||
      status === 'open' ||
      status === 'closed' ||
      (status === 'connecting' && win.navigator?.onLine !== false)
    ) {
      offlineBanner.hidden = true;
      offlineRetry.disabled = false;
      return;
    }
    const count = groupSocket()?.queueEntries().length ?? 0;
    const when = cachedSavedAt ? new Date(cachedSavedAt).toLocaleString() : 'the last sync';
    offlineText.textContent =
      `Offline. Showing the ledger as of ${when}; changes you make will be sent when you are back.` +
      (count > 0 ? ` ${count} ${count === 1 ? 'change' : 'changes'} waiting.` : '');
    offlineBanner.hidden = false;
    offlineRetry.disabled = status === 'connecting';
  }

  function persistOutbox(entries) {
    if (!groupId) return;
    const items = entries.map((entry) => ({
      ...entry,
      baseBlob: queuedEditBases.get(entry.id)?.baseBlob ?? null
    }));
    const live = new Set(entries.map((entry) => entry.id));
    for (const id of [...queuedEditBases.keys()]) {
      if (!live.has(id)) {
        queuedEditBases.delete(id);
        queuedEditRetries.delete(id);
      }
    }
    const saved = saveOutbox(local, groupId, items);
    renderPendingCount();
    if (!saved && entries.length > 0 && !outboxWarningShown) {
      outboxWarningShown = true;
      setStatus('This browser cannot keep changes offline.');
    }
  }

  function setConnection(status) {
    connectionStatus = status;
    if (cachedBase) renderOfflineBanner(status);
    if (!connection) return;
    if (status === 'open' || status === 'closed') {
      connection.hidden = true;
      connection.textContent = '';
    } else {
      connection.hidden = false;
      connection.textContent =
        status === 'offline'
          ? 'Offline — changes will sync when the connection returns.'
          : status === 'reconnecting'
            ? 'Reconnecting…'
            : 'Connecting…';
    }

    if (status !== 'open') toggleModeButton.disabled = true;
    if (!waitingPanel.hidden) {
      if (status === 'offline') {
        waitingCopy.textContent = 'Offline — this will continue when the connection returns.';
      } else if (status === 'reconnecting' || status === 'connecting') {
        waitingCopy.textContent = 'Reconnecting…';
      }
    }
  }

  /** Replace the form with the group, in place: no modal, no confirmation, no second screen. */
  function showGroup({ code, name, displayName, role = 'organizer', memberId = null, currency = DEFAULT_CURRENCY }) {
    group = { code, name };
    resumeSession = null;
    hideNotice();

    groupId = null;
    groupIdPromise = groupIdFromCode(code);
    recordGuard = new RevGuard();
    guardGroupId = null;
    void groupIdPromise.then((value) => {
      groupId = value;
      if (guardGroupId !== value) {
        recordGuard.hydrate(revsFor(local, value));
        guardGroupId = value;
      }
    });
    groupKeyPromise = deriveGroupKey(code);
    selfId = memberId;
    selfName = displayName || 'You';
    groupRole = role;
    groupCurrency = normalizeCurrency(currency);
    members = new Map();
    removedMembers = new Set();
    leftMembers = new Set();
    if (memberId) members.set(memberId, selfName);
    ledger = new Map();
    expenseDraftId = null;
    pendingExpenseId = null;
    savingExpense = false;
    closeExpenseSheet();
    closeSettlementSheet();
    renderLedger();
    exportPanel.hidden = false;
    exportStatus.textContent = '';
    pendingCount.hidden = true;
    pendingCount.textContent = '';
    offlineBanner.hidden = true;
    cachedSavedAt = 0;
    if (cacheTimer !== null) win.clearTimeout(cacheTimer);
    cacheTimer = null;
    cachedBase = null;
    cachedRecords = new Map();
    queuedEditBases = new Map();
    queuedEditRetries = new Set();
    importButton.hidden = role !== 'organizer';
    endGroupButton.hidden = role !== 'organizer';
    leaveGroupButton.hidden = role === 'organizer';
    closeLifecycle();
    endedHandledFor = null;
    resetImport();

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
    closeSettlementSheet();
    hideNotice();
    group = null;
    resumeSession = resume;
    ledgerPanel.hidden = true;
    balancesPanel.hidden = true;
    chartsPanel.hidden = true;
    exportPanel.hidden = true;
    offlineBanner.hidden = true;
    resetImport();
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
    closeSettlementSheet();
    hideNotice();
    group = null;
    resumeSession = null;
    ledgerPanel.hidden = true;
    balancesPanel.hidden = true;
    chartsPanel.hidden = true;
    exportPanel.hidden = true;
    offlineBanner.hidden = true;
    resetImport();
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
    closeSettlementSheet();
    createPanel.hidden = true;
    joinPanel.hidden = true;
    groupHeader.hidden = true;
    emptyLedger.hidden = true;
    ledgerPanel.hidden = true;
    balancesPanel.hidden = true;
    chartsPanel.hidden = true;
    exportPanel.hidden = true;
    offlineBanner.hidden = true;
    resetImport();
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
  /** Draw the last state from disk, with the socket still down or about to try. */
  async function showCachedGroup(session, code, groupIdValue, cached) {
    const key = await deriveGroupKey(code);
    let name = 'Your group';
    try {
      const opened = await open(key, cached.nameBlob);
      if (typeof opened?.name === 'string') name = opened.name;
    } catch {
      /* the neutral label is the honest one */
    }
    let currency = DEFAULT_CURRENCY;
    if (cached.metaBlob) {
      try {
        const meta = await open(key, cached.metaBlob);
        if (meta?.currency) currency = normalizeCurrency(meta.currency);
      } catch {
        /* the fallback currency stays */
      }
    }

    showGroup({
      code,
      name,
      displayName: session.displayName,
      role: cached.role === 'host' ? 'organizer' : 'member',
      memberId: cached.memberId || session.memberId,
      currency
    });

    applyMode(cached.joinMode, cached.role === 'host' ? 'host' : 'member');
    recordGuard = new RevGuard(revsFor(local, groupIdValue));
    guardGroupId = groupIdValue;

    const nextMembers = new Map();
    const nextRemoved = new Set();
    const nextLeft = new Set();
    for (const member of cached.roster) {
      if (member.status === 'removed') nextRemoved.add(member.id);
      if (member.status === 'left') nextLeft.add(member.id);
      if (member.status !== 'approved' && member.status !== 'removed' && member.status !== 'left') {
        continue;
      }
      nextMembers.set(member.id, await nameOf(key, member.nameBlob));
    }
    if (cached.memberId && !nextMembers.has(cached.memberId)) {
      nextMembers.set(cached.memberId, session.displayName);
    }
    members = nextMembers;
    removedMembers = nextRemoved;
    leftMembers = nextLeft;

    for (const record of cached.records) {
      if (!recordGuard.accept(record)) continue;
      if (record.deleted) {
        ledger.delete(record.id);
        continue;
      }
      const value = await decryptRecord(key, record, groupIdValue);
      if (value) ledger.set(record.id, { ...record, value });
    }
    saveRevs(local, groupIdValue, recordGuard.snapshot());

    cachedBase = {
      nameBlob: cached.nameBlob,
      metaBlob: cached.metaBlob,
      hostId: cached.hostId,
      memberId: cached.memberId,
      role: cached.role,
      joinMode: cached.joinMode,
      roster: cached.roster
    };
    cachedRecords = new Map(cached.records.map((record) => [record.id, { ...record }]));
    cachedSavedAt = cached.savedAt;

    const pending = outboxFor(local, groupIdValue);
    prepareOutbox(pending);
    await restorePending(pending);
    renderLedger();
    if (win.navigator?.onLine === false) renderOfflineBanner('offline');
  }

  async function resumeStored(session, code) {
    hideNotice();
    closeJoinSocket();
    closeHostSocket();

    const groupIdValue = await groupIdFromCode(code);
    if (groupIdValue !== session.groupId) {
      forget(session.groupId);
      showJoin({ code, error: 'That code is for a different group.' });
      return;
    }

    const cached = cacheFor(local, groupIdValue);
    let shown = false;
    if (cached) {
      await showCachedGroup(session, code, groupIdValue, cached);
      shown = true;
    } else {
      if (win.navigator?.onLine === false) {
        showJoin({ code, error: OFFLINE_FIRST_MESSAGE, resume: session });
        return;
      }
      const reachable = await probeRoom(groupIdValue);
      if (reachable === 'missing') {
        dropGroupCache(groupIdValue);
        forget(groupIdValue);
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
    }

    const url = new URL('api/ws', win.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', groupIdValue);

    const groupKey = deriveGroupKey(code);
    let socket;
    const stored = outboxFor(local, groupIdValue);
    prepareOutbox(stored);
    socket = new GroupSocket({
      url: url.toString(),
      auth: { t: 'auth', id: session.memberId, secret: session.memberSecret, mode: 'resume' },
      win,
      Ctor: win.WebSocket,
      flushGapMs: WRITE_GAP_MS,
      onQueueChange: persistOutbox,
      onStatus: (status) => {
        setConnection(status);
        renderPendingCount();
        if (status === 'closed' && !shown && !waitingPanel.hidden) {
          showJoin({
            code,
            error: 'The saved seat could not be opened. Enter the code again.',
            resume: session
          });
        }
      },
      onFrame: async (frame) => {
        if (frame.t === 'waiting') {
          showWaiting(code);
          remember({
            groupId: groupIdValue,
            memberId: session.memberId,
            secret: session.memberSecret,
            displayName: session.displayName,
            code
          });
          return;
        }

        if (frame.t === 'state') {
          const key = await groupKey;
          let name = 'Your group';
          try {
            const opened = await open(key, frame.nameBlob);
            if (typeof opened?.name === 'string') name = opened.name;
          } catch {
            /* a neutral label beats an unreadable blob */
          }

          if (frame.role === 'host') {
            hostSocket = socket;
            if (!shown) {
              joinSocket = null;
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
            await restorePending(socket.queueEntries());
          } else {
            joinSocket = socket;
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
            await restorePending(socket.queueEntries());
          }

          remember({
            groupId: groupIdValue,
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
        if (frame.t === 'conflict') {
          handleExpenseConflict(frame);
          return;
        }
        if (frame.t === 'ended') {
          handleEnded();
          return;
        }
        if (frame.t === 'left') {
          handleLeft();
          return;
        }
        if (frame.t === 'removed') {
          dropGroupCache(groupIdValue);
          forget(groupIdValue);
          socket.close();
          joinSocket = null;
          showJoin({ code, error: 'Removed from this group.' });
          return;
        }
        if (frame.t === 'refused') {
          if (handleExpenseRefusal(frame)) return;
          socket.close();
          joinSocket = null;
          if (frame.code === 'unknown_group') dropGroupCache(groupIdValue);
          if (frame.code === 'rate_limited') {
            showJoin({ code, error: refusalMessage(frame.code), resume: session });
          } else {
            forget(groupIdValue);
            showJoin({ code, error: refusalMessage(frame.code) });
          }
        }
      }
    });

    socket.restore(stored);
    joinSocket = socket;
    socket.connect();
  }

  function openJoinSocket({ groupId, memberId, secret, nameBlob, code, displayName }) {
    closeJoinSocket();

    const url = new URL('api/ws', win.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', groupId);

    let socket;
    socket = new GroupSocket({
      url: url.toString(),
      auth: { t: 'auth', id: memberId, secret, mode: 'join', nameBlob },
      win,
      Ctor: win.WebSocket,
      onStatus: (status) => setConnection(status),
      onFrame: async (frame) => {
        if (frame.t === 'waiting') {
          remember({ groupId, memberId, secret, displayName, code });
          waitingCopy.textContent =
            'The organizer has to let you in. Nothing from the group is shown until they do.';
          return;
        }

        if (frame.t === 'state' && frame.role === 'member') {
          if (group) {
            applyMode(frame.joinMode, 'member');
            await applyGroupState(frame, groupKeyPromise);
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
          await applyGroupState(frame, groupKeyPromise);
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
        if (frame.t === 'conflict') {
          handleExpenseConflict(frame);
          return;
        }
        if (frame.t === 'ended') {
          handleEnded();
          return;
        }
        if (frame.t === 'left') {
          handleLeft();
          return;
        }
        if (frame.t === 'removed') {
          dropGroupCache(groupId);
          forget(groupId);
          socket.close();
          joinSocket = null;
          showJoin({ code, error: 'Removed from this group.' });
          return;
        }
        if (frame.t === 'refused') {
          if (handleExpenseRefusal(frame)) return;
          socket.close();
          joinSocket = null;
          if (frame.code === 'unknown_group') dropGroupCache(groupId);
          forget(groupId);
          showJoin({ code, error: refusalMessage(frame.code) });
        }
      }
    });

    const stored = outboxFor(local, groupId);
    prepareOutbox(stored);
    socket.restore(stored);
    void restorePending(stored);

    joinSocket = socket;
    socket.connect();
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

    const key = deriveGroupKey(code);
    toggleModeButton.disabled = true;

    let socket;
    socket = new GroupSocket({
      url: url.toString(),
      auth: { t: 'auth', id: memberId, secret, mode: 'resume' },
      win,
      Ctor: win.WebSocket,
      flushGapMs: WRITE_GAP_MS,
      onQueueChange: persistOutbox,
      onStatus: (status) => {
        setConnection(status);
        renderPendingCount();
        if (status === 'open') toggleModeButton.disabled = false;
      },
      onFrame: (frame) => {
        if (frame.t === 'state') {
          void renderRoster(frame, key);
          void applyGroupState(frame, key);
          return;
        }
        if (frame.t === 'record') {
          void handleRecordFrame(frame);
          return;
        }
        if (frame.t === 'ended') {
          handleEnded();
          return;
        }
        if (frame.t === 'left') {
          handleLeft();
          return;
        }
        if (frame.t === 'import-members-ok') {
          handleImportMembersOk(frame);
          return;
        }
        if (frame.t === 'conflict') {
          handleExpenseConflict(frame);
          return;
        }
        if (frame.t === 'refused') {
          if (handleImportRefusal(frame)) return;
          if (handleExpenseRefusal(frame)) return;
          rosterEmpty.textContent = 'That request could not be completed.';
          rosterEmpty.hidden = false;
          toggleModeButton.disabled = false;
        }
      }
    });

    const stored = outboxFor(local, groupId);
    prepareOutbox(stored);
    socket.restore(stored);
    void restorePending(stored);

    hostSocket = socket;
    socket.connect();
  }

  function closeHostSocket() {
    if (!hostSocket) return;
    const socket = hostSocket;
    hostSocket = null;
    socket.close();
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
    const departed = frame.roster.filter(
      (member) =>
        (member.status === 'removed' || member.status === 'left') &&
        member.id !== frame.memberId
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
        if (hostSocket) hostSocket.send({ t: type, memberId: member.id });
      };
      allow.addEventListener('click', () => act('approve'));
      decline.addEventListener('click', () => act('reject'));

      chip.append(label, allow, decline);
      rosterPending.append(chip);
    }

    for (const member of departed) {
      const chip = doc.createElement('li');
      chip.className = 'chip';

      const label = doc.createElement('span');
      label.textContent = await nameOf(key, member.nameBlob);

      const state = doc.createElement('span');
      state.className = 'muted';
      state.textContent = member.status;
      chip.append(label, state);
      rosterApproved.append(chip);
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
        if (hostSocket) hostSocket.send({ t: 'remove', memberId: member.id });
      });

      if (member.participant) {
        const imported = doc.createElement('span');
        imported.className = 'muted';
        imported.textContent = 'imported';
        chip.append(label, imported, remove);
      } else {
        chip.append(label, remove);
      }
      rosterApproved.append(chip);
    }
  }

  /* ------------------------------------------------------------- the ledger */

  function expenseMode() {
    return splitModes.find((radio) => radio.checked)?.value ?? 'equal';
  }

  /** A name as the whole page should show it; a removed member keeps their name and gets a marker. */
  function memberLabel(id) {
    const name = members.get(id);
    if (!name) return 'Someone';
    if (leftMembers.has(id)) return `${name} · left`;
    return removedMembers.has(id) ? `${name} · removed` : name;
  }

  /** The people an expense sheet offers: removed members only when this edit already names them. */
  function splitMembers() {
    const required = new Set();
    if (editingExpense?.value) {
      const payers = Array.isArray(editingExpense.value.paidBy)
        ? editingExpense.value.paidBy
        : [{ memberId: editingExpense.value.paidBy }];
      for (const payer of payers) required.add(payer.memberId);
      for (const id of Object.keys(editingExpense.value.split ?? {})) required.add(id);
    }
    return [...members.entries()]
      .filter(
        ([id]) => (!removedMembers.has(id) && !leftMembers.has(id)) || required.has(id)
      )
      .map(([id]) => [id, memberLabel(id)])
      .sort((left, right) => left[1].localeCompare(right[1]) || (left[0] < right[0] ? -1 : 1));
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
  function groupSocket() {
    return hostSocket ?? joinSocket;
  }

  function activeSocket() {
    if (hostSocket?.isOpen) return hostSocket;
    if (joinSocket?.isOpen) return joinSocket;
    return null;
  }

  /** The sealed copy of the revision an offline edit started from; never plaintext at rest. */
  const baseAad = (groupIdValue, id) => expenseAad(groupIdValue, `${id}/base`);

  async function decryptRecord(key, record, groupIdValue) {
    for (const aad of [expenseAad(groupIdValue, record.id), settlementAad(groupIdValue, record.id)]) {
      try {
        const value = await open(key, record.blob, aad);
        if (value === null || typeof value !== 'object') continue;
        if (value.kind === 'settlement') {
          if (
            typeof value.from === 'string' &&
            typeof value.to === 'string' &&
            Number.isSafeInteger(value.amountPaise) &&
            value.amountPaise > 0
          ) {
            return value;
          }
          continue;
        }
        if (typeof value.description === 'string' && Number.isSafeInteger(value.amountPaise)) {
          return value;
        }
      } catch {
        /* try the other label */
      }
    }
    return null;
  }

  function cachePayload() {
    if (!cachedBase) return null;
    return { ...cachedBase, records: [...cachedRecords.values()] };
  }

  function writeCacheNow(groupIdValue) {
    const payload = cachePayload();
    if (groupIdValue && payload && saveCache(local, groupIdValue, payload)) {
      cachedSavedAt = Date.now();
    }
  }

  function scheduleCacheWrite(groupIdValue) {
    if (cacheTimer !== null) return;
    cacheTimer = win.setTimeout(() => {
      cacheTimer = null;
      writeCacheNow(groupIdValue);
    }, 250);
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

    if (guardGroupId !== groupIdValue) {
      recordGuard.hydrate(revsFor(local, groupIdValue));
      guardGroupId = groupIdValue;
    }

    const previousMembers = [...members.keys()].join(',');
    const nextMembers = new Map();
    const nextRemoved = new Set();
    const nextLeft = new Set();
    for (const member of frame.roster ?? []) {
      if (member.status === 'removed') nextRemoved.add(member.id);
      if (member.status === 'left') nextLeft.add(member.id);
      if (member.status !== 'approved' && member.status !== 'removed' && member.status !== 'left') {
        continue;
      }
      nextMembers.set(member.id, await nameOf(key, member.nameBlob));
    }
    if (selfId && !nextMembers.has(selfId)) nextMembers.set(selfId, selfName || 'You');
    members = nextMembers;
    removedMembers = nextRemoved;
    leftMembers = nextLeft;

    /* A state snapshot is merged into what is on screen, not swapped in: a broadcast that landed
       while the snapshot was being built is newer than the snapshot, and a dropped frame must not
       bring a deleted row back. Tombstones remove their row and keep the revision. */
    let learned = false;
    for (const record of frame.records ?? []) {
      if (!recordGuard.accept(record)) continue;
      learned = true;
      if (record.deleted) {
        ledger.delete(record.id);
        continue;
      }
      const value = await decryptRecord(key, record, groupIdValue);
      if (value) ledger.set(record.id, { ...record, value });
    }
    if (learned) saveRevs(local, groupIdValue, recordGuard.snapshot());

    cachedBase = {
      nameBlob: frame.nameBlob,
      metaBlob: frame.metaBlob ?? null,
      hostId: frame.hostId,
      memberId: frame.memberId,
      role: frame.role,
      joinMode: frame.joinMode === 'open' ? 'open' : 'approval',
      roster: frame.roster ?? []
    };
    cachedRecords = new Map((frame.records ?? []).map((record) => [record.id, { ...record }]));
    writeCacheNow(groupIdValue);

    const active = groupSocket();
    if (active) {
      const known = new Set((frame.records ?? []).map((record) => record.id));
      for (const entry of active.queueEntries()) {
        if (entry.frame.base === 0 && known.has(entry.id)) active.ack(entry.id);
      }
    }

    renderLedger();
    if (expenseSheetOpen) {
      renderPayerOptions();
      if ([...members.keys()].join(',') !== previousMembers) renderSplit();
      else updatePreview();
    }
  }

  function renderLedger() {
    const rows = [...ledger.values()]
      .filter((record) => record.pending || record.value?.kind !== 'settlement')
      .sort(
      (left, right) => (left.at ?? 0) - (right.at ?? 0) || (left.id < right.id ? -1 : 1)
    );

    disarmDelete();
    ledgerList.textContent = '';
    if (groupHeader.hidden) {
      ledgerPanel.hidden = true;
      balancesPanel.hidden = true;
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
      if (record.pending) {
        meta.textContent = 'Waiting to sync';
        left.append(title, meta);
        const side = doc.createElement('div');
        side.className = 'expense-side';
        const amount = doc.createElement('span');
        amount.className = 'expense-amount';
        amount.textContent = formatPaise(value.amountPaise, groupCurrency);
        side.append(amount);
        row.classList.add('pending');
        row.append(left, side);
        ledgerList.append(row);
        continue;
      }

      const payers = Array.isArray(value.paidBy)
        ? value.paidBy
        : [{ memberId: value.paidBy, amountPaise: value.amountPaise }];
      const payer = payers.map((entry) => memberLabel(entry.memberId)).join(' + ');
      const detail =
        payers.length > 1
          ? ` (${payers.map((entry) => formatPaise(entry.amountPaise, groupCurrency)).join(' + ')})`
          : '';
      const creator = record.creator ?? record.author;
      const edited = creator && creator !== record.author;
      const editor = memberLabel(record.author);
      meta.textContent =
        `Paid by ${payer}${detail} · ${value.date} ${value.time}` +
        (edited ? ` · edited by ${editor}` : '');
      left.append(title, meta);

      const side = doc.createElement('div');
      side.className = 'expense-side';

      const amount = doc.createElement('span');
      amount.className = 'expense-amount';
      amount.textContent = formatPaise(value.amountPaise, groupCurrency);

      const actions = doc.createElement('div');
      actions.className = 'expense-actions';

      const edit = doc.createElement('button');
      edit.type = 'button';
      edit.className = 'secondary';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => openExpenseSheet(record));

      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => armDelete(record, remove));

      actions.append(edit, remove);
      side.append(amount, actions);
      row.append(left, side);
      ledgerList.append(row);
    }

    renderBalances();
  }

  function chartMode() {
    return chartModes.find((radio) => radio.checked)?.value ?? 'paid';
  }

  function renderCharts() {
    if (groupHeader.hidden || lastChartExpenses.length === 0) {
      chartsPanel.hidden = true;
      chartHost.textContent = '';
      return;
    }

    chartsPanel.hidden = false;
    const { paid, incurred } = chartTotals(lastChartIds, lastChartExpenses);
    const values = chartMode() === 'paid' ? paid : incurred;
    renderChart(chartHost, values, {
      doc,
      names: Object.fromEntries(lastChartNames),
      title: chartMode() === 'paid' ? 'Paid by member' : 'Incurred by member',
      format: (paise) => formatPaise(paise, groupCurrency)
    });
  }

  function renderBalances() {
    if (groupHeader.hidden) {
      balancesPanel.hidden = true;
      return;
    }

    const expenses = [...ledger.values()]
      .filter(
        (record) =>
          !record.pending && !record.deleted && record.value?.kind !== 'settlement'
      )
      .map((record) => ({
        id: record.id,
        amountPaise: record.value.amountPaise,
        paidBy: record.value.paidBy,
        split: record.value.split
      }));

    const settlements = [...ledger.values()]
      .filter((record) => !record.pending && !record.deleted && record.value?.kind === 'settlement')
      .map((record) => ({
        id: record.id,
        from: record.value.from,
        to: record.value.to,
        amountPaise: record.value.amountPaise
      }));

    const referenced = new Set(members.keys());
    for (const expense of expenses) {
      const payers = Array.isArray(expense.paidBy)
        ? expense.paidBy
        : [{ memberId: expense.paidBy }];
      for (const payer of payers) referenced.add(payer.memberId);
      for (const id of Object.keys(expense.split)) referenced.add(id);
    }
    for (const payment of settlements) {
      referenced.add(payment.from);
      referenced.add(payment.to);
    }
    lastChartIds = [...referenced];
    lastChartNames = new Map([...members.keys()].map((id) => [id, memberLabel(id)]));
    lastChartExpenses = expenses;
    const map = balances([...referenced], expenses, settlements);
    const proposal = settle(map);
    const contributions = ledgerContributions([...referenced], expenses, settlements);
    const transfers = attribute(proposal.transfers, contributions);
    lastBalances = map;
    const names = new Map([...members.keys()].map((id) => [id, memberLabel(id)]));

    balanceList.textContent = '';
    const ordered = Object.entries(map).sort(
      ([left, leftValue], [right, rightValue]) =>
        (names.get(left) ?? left).localeCompare(names.get(right) ?? right) || rightValue - leftValue
    );
    for (const [id, paise] of ordered) {
      const row = doc.createElement('li');
      const name = doc.createElement('span');
      name.textContent = names.get(id) || 'Someone';
      const value = doc.createElement('span');
      if (paise > 0) {
        value.className = 'owed';
        value.textContent = `is owed ${formatPaise(paise, groupCurrency)}`;
      } else if (paise < 0) {
        value.className = 'owes';
        value.textContent = `owes ${formatPaise(-paise, groupCurrency)}`;
      } else {
        value.textContent = 'settled';
      }
      row.append(name, value);
      balanceList.append(row);
    }

    transferList.textContent = '';
    for (const transfer of transfers) {
      const row = doc.createElement('li');
      const body = doc.createElement('div');
      const label = doc.createElement('span');
      label.textContent = `${names.get(transfer.from) || 'Someone'} pays ${
        names.get(transfer.to) || 'Someone'
      } ${formatPaise(transfer.amountPaise, groupCurrency)}`;
      body.append(label);

      const why = doc.createElement('button');
      why.type = 'button';
      why.className = 'link-button';
      why.textContent = 'Why?';
      const via = doc.createElement('ul');
      via.className = 'via-list';
      via.hidden = true;
      for (const source of transfer.via) {
        const record = ledger.get(source.recordId);
        const line = doc.createElement('li');
        if (record?.value?.kind === 'settlement') {
          line.textContent = `Payment from ${names.get(record.value.from) || 'Someone'} to ${
            names.get(record.value.to) || 'Someone'
          } · ${formatPaise(source.amountPaise, groupCurrency)}`;
        } else if (record?.value) {
          line.textContent = `${record.value.description} · share ${formatPaise(
            source.amountPaise,
            groupCurrency
          )}`;
        } else {
          line.textContent = `Record · ${formatPaise(source.amountPaise, groupCurrency)}`;
        }
        via.append(line);
      }
      why.addEventListener('click', () => {
        via.hidden = !via.hidden;
        why.textContent = via.hidden ? 'Why?' : 'Hide';
      });
      body.append(why, via);

      const pay = doc.createElement('button');
      pay.type = 'button';
      pay.className = 'secondary';
      pay.textContent = 'Mark as paid';
      pay.addEventListener('click', () => openSettlement(transfer));

      const actions = doc.createElement('div');
      actions.className = 'transfer-actions';
      actions.append(pay);
      row.append(body, actions);
      transferList.append(row);
    }

    paymentList.textContent = '';
    const payments = [...ledger.values()]
      .filter(
        (record) => !record.pending && !record.deleted && record.value?.kind === 'settlement'
      )
      .sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
    if (payments.length === 0) {
      const row = doc.createElement('li');
      row.className = 'muted';
      row.textContent = 'No payments recorded yet.';
      paymentList.append(row);
    } else {
      for (const record of payments) {
        const row = doc.createElement('li');
        const label = doc.createElement('span');
        label.textContent = `${names.get(record.value.from) || 'Someone'} paid ${
          names.get(record.value.to) || 'Someone'
        } ${formatPaise(record.value.amountPaise, groupCurrency)} · ${record.value.date}`;
        const remove = doc.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary';
        remove.textContent = 'Delete';
        remove.addEventListener('click', () => armDelete(record, remove));
        row.append(label, remove);
        paymentList.append(row);
      }
    }

    const pending = [...ledger.values()].some((record) => record.pending);
    if (proposal.transfers.length === 0) {
      settleNote.textContent = pending
        ? 'Everyone is settled on the synced expenses; one is still waiting to sync.'
        : 'Everyone is settled.';
    } else {
      settleNote.textContent = proposal.exact
        ? 'The fewest transfers we can find.'
        : 'A short settle-up; with more than ten people we do not search for the absolute fewest.';
    }

    balancesPanel.hidden = false;
    renderCharts();
  }

  function disarmDelete() {
    if (deleteTimer !== null) win.clearTimeout(deleteTimer);
    deleteTimer = null;
    armedDeleteId = null;
    if (armedDeleteButton) {
      armedDeleteButton.textContent = 'Delete';
      armedDeleteButton.classList.remove('is-armed');
    }
    armedDeleteButton = null;
  }

  function armDelete(record, button) {
    if (armedDeleteId !== record.id) {
      disarmDelete();
      armedDeleteId = record.id;
      armedDeleteButton = button;
      button.textContent = 'Delete? It leaves every screen';
      button.classList.add('is-armed');
      deleteTimer = win.setTimeout(disarmDelete, 4_000);
      return;
    }

    disarmDelete();
    const socket = activeSocket();
    if (!socket) {
      setStatus('The group is not connected. Try again.');
      return;
    }
    pendingDeleteId = record.id;
    button.disabled = true;
    socket.send(
      { t: 'put', id: record.id, base: record.rev, blob: null, deleted: true },
      { id: record.id }
    );
  }

  function fillMemberSelect(select, selected) {
    select.textContent = '';
    for (const [id, name] of splitMembers()) {
      const option = doc.createElement('option');
      option.value = id;
      option.textContent = name;
      select.append(option);
    }
    if (selected && members.has(selected)) select.value = selected;
    else if (select.options.length > 0) select.selectedIndex = 0;
  }

  function renderPayerOptions() {
    const current = expensePayer.value;
    fillMemberSelect(expensePayer, current || selfId);

    for (const row of payerRows.querySelectorAll('.payer-row')) {
      const select = row.querySelector('select');
      fillMemberSelect(select, select.value);
    }
    updatePayerTotal();
  }

  function addPayerRow(memberId = null, amountPaise = 0) {
    const used = new Set(
      [...payerRows.querySelectorAll('.payer-row select')].map((select) => select.value)
    );
    const fallback = splitMembers().find(([id]) => !used.has(id))?.[0] ?? splitMembers()[0]?.[0] ?? null;
    const chosen = memberId ?? fallback;

    const row = doc.createElement('div');
    row.className = 'payer-row';
    const select = doc.createElement('select');
    fillMemberSelect(select, chosen);
    const input = doc.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.placeholder = '0.00';
    if (Number.isSafeInteger(amountPaise) && amountPaise > 0) {
      input.value = (amountPaise / 100).toFixed(2);
    }
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      row.remove();
      if (payerRows.querySelectorAll('.payer-row').length <= 1) collapsePayers();
      else updatePayerTotal();
    });

    row.append(select, input, remove);
    payerRows.append(row);
    updatePayerTotal();
  }

  function expandPayers() {
    if (multiPayer) return;
    multiPayer = true;
    payerSingle.hidden = true;
    addPayerButton.parentElement.hidden = true;
    payerRows.hidden = false;
    payerTotal.hidden = false;
    addAnotherWrap.hidden = false;
    payerRows.textContent = '';

    const amount = parseAmount(expenseAmount.value);
    addPayerRow(expensePayer.value, amount.ok ? amount.paise : 0);
    addPayerRow();
  }

  function collapsePayers() {
    const remaining = payerRows.querySelector('.payer-row select');
    const payer = remaining?.value;
    multiPayer = false;
    payerRows.textContent = '';
    payerRows.hidden = true;
    payerTotal.hidden = true;
    addAnotherWrap.hidden = true;
    payerSingle.hidden = false;
    addPayerButton.parentElement.hidden = false;
    if (payer) fillMemberSelect(expensePayer, payer);
  }

  function updatePayerTotal() {
    if (!multiPayer) {
      payerTotal.hidden = true;
      return;
    }
    payerTotal.hidden = false;

    const amount = parseAmount(expenseAmount.value);
    if (!amount.ok) {
      payerTotal.textContent = 'Enter the amount first.';
      return;
    }

    let sum = 0;
    for (const row of payerRows.querySelectorAll('.payer-row')) {
      const parsed = parseCustomAmount(row.querySelector('input').value);
      if (!parsed.ok) {
        payerTotal.textContent = parsed.message;
        return;
      }
      if (parsed.paise <= 0) {
        payerTotal.textContent = 'Every payer needs an amount above zero.';
        return;
      }
      sum += parsed.paise;
    }

    const delta = sum - amount.paise;
    if (delta === 0) payerTotal.textContent = `Paid in full: ${formatPaise(sum, groupCurrency)}.`;
    else if (delta < 0) payerTotal.textContent = `Short by ${formatPaise(-delta, groupCurrency)}.`;
    else payerTotal.textContent = `Over by ${formatPaise(delta, groupCurrency)}.`;
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
    } else if (mode === 'percent') {
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
        input.dataset.percent = '1';
        label.append(text, input);
        splitInputs.append(label);
      }
    } else if (mode === 'shares') {
      splitNote.textContent = 'Shares are counted; ten shares gets ten times what one share gets.';
      const defaults = defaultShares(entries.map(([id]) => id));
      for (const [id, name] of entries) {
        const label = doc.createElement('label');
        const text = doc.createElement('span');
        text.textContent = name;
        const input = doc.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.value = String(defaults[id] ?? 1);
        input.dataset.memberId = id;
        input.dataset.shares = '1';
        label.append(text, input);
        splitInputs.append(label);
      }
    } else {
      splitNote.textContent = 'Enter what each person owes; the total must match the amount.';
      for (const [id, name] of entries) {
        const label = doc.createElement('label');
        const text = doc.createElement('span');
        text.textContent = name;
        const input = doc.createElement('input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.placeholder = '0.00';
        const seed = customSeed?.get(id);
        if (Number.isSafeInteger(seed)) input.value = (seed / 100).toFixed(2);
        input.dataset.memberId = id;
        input.dataset.amount = '1';
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

    if (mode === 'shares') {
      const shareWeights = {};
      for (const input of splitInputs.querySelectorAll('input[data-shares]')) {
        const value = Number(input.value);
        shareWeights[input.dataset.memberId] =
          Number.isInteger(value) && value >= 0 ? value : Number.NaN;
      }
      return splitFor({ mode, amountPaise: amount.paise, shareWeights });
    }
    if (mode === 'custom') {
      const amounts = {};
      for (const input of splitInputs.querySelectorAll('input[data-amount]')) {
        const parsed = parseCustomAmount(input.value);
        if (!parsed.ok) return { ok: false, message: parsed.message };
        amounts[input.dataset.memberId] = parsed.paise;
      }
      return splitFor({ mode, amountPaise: amount.paise, amounts });
    }

    const percentages = {};
    for (const input of splitInputs.querySelectorAll('input[data-percent]')) {
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

  function openExpenseSheet(record = null) {
    if (!group || record?.deleted) return;

    closeSettlementSheet();
    expenseSheetOpen = true;
    editingExpense = record;
    editingBaseValue = record ? record.value : null;
    customSeed = record ? new Map(Object.entries(record.value.split ?? {})) : null;
    expenseDraftId = record ? record.id : randomSecret();
    pendingExpenseId = null;
    pendingExpenseEdit = false;
    pendingExpenseValue = null;
    mergeNotice = null;
    mergeNoticeFields = [];
    mergeRetryId = null;
    pendingDeleteId = null;
    savingExpense = false;
    expenseError.hidden = true;
    expenseError.textContent = '';

    const value = record?.value ?? null;
    const payerList = Array.isArray(value?.paidBy) ? value.paidBy : null;
    multiPayer = Boolean(payerList && payerList.length > 1);
    payerRows.textContent = '';
    payerRows.hidden = !multiPayer;
    payerTotal.hidden = !multiPayer;
    addAnotherWrap.hidden = !multiPayer;
    payerSingle.hidden = multiPayer;
    addPayerButton.parentElement.hidden = multiPayer;

    expenseDescription.value = value?.description ?? '';
    expenseAmount.value = value ? (value.amountPaise / 100).toFixed(2) : '';
    expenseNote.value = value?.note ?? '';
    expenseDate.value = value?.date ?? todayDate();
    expenseTime.value = value?.time ?? nowTime();
    expenseSave.disabled = false;
    expenseCancel.disabled = false;
    expenseSave.textContent = record ? 'Save changes' : 'Save expense';
    expenseCurrency.textContent = groupCurrency;

    splitModes.forEach((radio) => {
      radio.checked = radio.value === (record ? 'custom' : 'equal');
    });

    renderPayerOptions();
    const singlePayer = payerList?.[0]?.memberId ?? value?.paidBy;
    if (!multiPayer && singlePayer && members.has(singlePayer)) {
      fillMemberSelect(expensePayer, singlePayer);
    }
    if (multiPayer) {
      for (const payer of payerList) addPayerRow(payer.memberId, payer.amountPaise);
      updatePayerTotal();
    }
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
    pendingExpenseEdit = false;
    savingExpense = false;
    editingExpense = null;
    editingBaseValue = null;
    pendingExpenseValue = null;
    mergeNotice = null;
    mergeNoticeFields = [];
    mergeRetryId = null;
    customSeed = null;
    expenseSave.disabled = false;
    expenseCancel.disabled = false;
    expenseSave.textContent = 'Save expense';
    splitInputs.textContent = '';
    splitPreview.textContent = '';
    splitNote.textContent = '';
    multiPayer = false;
    payerRows.textContent = '';
    payerRows.hidden = true;
    payerTotal.hidden = true;
    payerTotal.textContent = '';
    addAnotherWrap.hidden = true;
    payerSingle.hidden = false;
    addPayerButton.parentElement.hidden = false;
    renderLedger();
  }

  function settlementPeople() {
    const ids = new Set([...members.keys(), ...Object.keys(lastBalances)]);
    return [...ids]
      .map((id) => ({ id, name: memberLabel(id) }))
      .sort((left, right) => left.name.localeCompare(right.name) || (left.id < right.id ? -1 : 1));
  }

  function fillPeople(select, people, selected) {
    select.textContent = '';
    for (const person of people) {
      const option = doc.createElement('option');
      option.value = person.id;
      option.textContent = person.name;
      select.append(option);
    }
    select.value = selected;
  }

  function settleFailure(message, field) {
    settleError.textContent = message;
    settleError.hidden = false;
    field?.focus?.();
  }

  function openSettlement(transfer = null) {
    if (!group) return;
    closeExpenseSheet();
    const people = settlementPeople();
    if (people.length < 2) {
      setStatus('A payment needs two people in the group.');
      return;
    }

    settlementDraftId = randomSecret();
    pendingSettlementId = null;
    savingSettlement = false;
    settleError.hidden = true;
    settleError.textContent = '';
    settleSave.disabled = false;
    settleCancel.disabled = false;
    settleSave.textContent = 'Record payment';
    settleAmount.value = transfer ? (transfer.amountPaise / 100).toFixed(2) : '';
    settleDate.value = todayDate();
    settleTime.value = nowTime();
    settleNoteInput.value = '';

    const from = transfer?.from ?? selfId ?? people[0].id;
    const to = transfer?.to ?? people.find((person) => person.id !== from)?.id ?? people[0].id;
    fillPeople(settleFrom, people, from);
    fillPeople(settleTo, people, to);

    settlementPanel.hidden = false;
    settleAmount.focus();
  }

  function closeSettlementSheet() {
    settlementPanel.hidden = true;
    settleError.hidden = true;
    settleError.textContent = '';
    pendingSettlementId = null;
    savingSettlement = false;
    settleSave.disabled = false;
    settleCancel.disabled = false;
    settleSave.textContent = 'Record payment';
    settleAmount.value = '';
    settleNoteInput.value = '';
  }

  async function saveSettlement(event) {
    event.preventDefault();
    if (!group || savingSettlement) return;

    settleError.hidden = true;
    const people = new Set(settlementPeople().map((person) => person.id));
    if (!people.has(settleFrom.value) || !people.has(settleTo.value)) {
      return settleFailure('Choose who paid and who received.', settleFrom);
    }
    if (settleFrom.value === settleTo.value) {
      return settleFailure('A payment needs two different people.', settleTo);
    }
    const amount = parseAmount(settleAmount.value);
    if (!amount.ok) return settleFailure(amount.message, settleAmount);
    const date = validateDate(settleDate.value);
    if (!date.ok) return settleFailure(date.message, settleDate);
    const time = validateTime(settleTime.value);
    if (!time.ok) return settleFailure(time.message, settleTime);
    const note = validateNote(settleNoteInput.value);
    if (!note.ok) return settleFailure(note.message, settleNoteInput);

    const socket = activeSocket();
    if (!socket) return settleFailure('The group is not connected. Try again.', settleSave);

    savingSettlement = true;
    settleSave.disabled = true;
    settleCancel.disabled = true;
    settleSave.textContent = 'Recording…';

    try {
      const key = await groupKeyPromise;
      const groupIdValue = await groupIdPromise;
      const value = {
        kind: 'settlement',
        from: settleFrom.value,
        to: settleTo.value,
        amountPaise: amount.paise,
        date: date.value,
        time: time.value,
        note: note.value
      };
      const blob = await seal(key, value, settlementAad(groupIdValue, settlementDraftId));
      pendingSettlementId = settlementDraftId;
      socket.send(
        {
          t: 'put',
          id: settlementDraftId,
          base: 0,
          blob,
          deleted: false
        },
        { id: settlementDraftId }
      );
    } catch {
      savingSettlement = false;
      settleSave.disabled = false;
      settleCancel.disabled = false;
      settleSave.textContent = 'Record payment';
      settleFailure('The payment could not be sealed. Try again.', settleSave);
    }
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
    let payers;
    if (multiPayer) {
      const rows = [...payerRows.querySelectorAll('.payer-row')];
      if (rows.length === 0) return expenseFailure('Add who paid.', addPayerButton);
      payers = [];
      const seen = new Set();
      let paid = 0;
      for (const row of rows) {
        const select = row.querySelector('select');
        const input = row.querySelector('input');
        if (!members.has(select.value)) return expenseFailure('Choose who paid.', select);
        if (seen.has(select.value)) {
          return expenseFailure('Each payer can appear only once.', select);
        }
        seen.add(select.value);
        const parsed = parseCustomAmount(input.value);
        if (!parsed.ok) return expenseFailure(parsed.message, input);
        if (parsed.paise <= 0) {
          return expenseFailure('Every payer needs an amount above zero.', input);
        }
        payers.push({ memberId: select.value, amountPaise: parsed.paise });
        paid += parsed.paise;
      }
      if (paid !== amount.paise) {
        const delta = paid - amount.paise;
        return expenseFailure(
          delta < 0
            ? `Short by ${formatPaise(-delta, groupCurrency)}.`
            : `Over by ${formatPaise(delta, groupCurrency)}.`,
          payerRows
        );
      }
    } else {
      if (!members.has(expensePayer.value)) {
        return expenseFailure('Choose who paid.', expensePayer);
      }
      payers = [{ memberId: expensePayer.value, amountPaise: amount.paise }];
    }

    const split = currentSplit();
    if (!split.ok) return expenseFailure(split.message, splitInputs);
    previewShares = split.shares;

    const socket = groupSocket();
    if (!socket) return expenseFailure('The group is not connected. Try again.', expenseSave);
    savingExpense = true;
    pendingExpenseEdit = Boolean(editingExpense);
    expenseSave.disabled = true;
    expenseCancel.disabled = true;
    expenseSave.textContent = 'Saving…';

    try {
      const key = await groupKeyPromise;
      const groupIdValue = await groupIdPromise;
      const value = {
        kind: 'expense',
        description: description.value,
        amountPaise: amount.paise,
        paidBy: payers,
        split: split.shares,
        date: date.value,
        time: time.value,
        note: note.value
      };
      const blob = await seal(key, value, expenseAad(groupIdValue, expenseDraftId));
      const edited = editingExpense;
      if (edited) {
        const baseBlob = await seal(
          key,
          edited.value,
          baseAad(groupIdValue, expenseDraftId)
        );
        queuedEditBases.set(expenseDraftId, { value: edited.value, baseBlob });
        queuedEditRetries.delete(expenseDraftId);
      } else {
        queuedEditBases.delete(expenseDraftId);
      }
      pendingExpenseValue = value;
      mergeNotice = null;
      mergeNoticeFields = [];
      mergeRetryId = null;
      socket.send(
        {
          t: 'put',
          id: expenseDraftId,
          base: editingExpense ? editingExpense.rev : 0,
          blob,
          deleted: false
        },
        { id: expenseDraftId }
      );

      if (!socket.isOpen) {
        const previous = edited ? ledger.get(expenseDraftId) : null;
        ledger.set(expenseDraftId, {
          id: expenseDraftId,
          rev: edited ? edited.rev : 0,
          pending: true,
          blob,
          value,
          at: previous?.at ?? Date.now(),
          author: selfId,
          creator: edited?.creator ?? edited?.author ?? selfId
        });
        savingExpense = false;
        pendingExpenseId = null;
        pendingExpenseEdit = false;
        closeExpenseSheet();
        renderLedger();
        setStatus('Waiting to sync.');
        return;
      }

      pendingExpenseId = expenseDraftId;
    } catch {
      savingExpense = false;
      expenseSave.disabled = false;
      expenseCancel.disabled = false;
      expenseSave.textContent = editingExpense ? 'Save changes' : 'Save expense';
      expenseFailure('The expense could not be sealed. Try again.', expenseSave);
    }
  }

  /** Rebuild the rows the outbox is still carrying, in the order they were made. */
  async function restorePending(entries) {
    if (!entries || entries.length === 0 || !groupKeyPromise) return;
    const key = await groupKeyPromise;
    const groupIdValue = await groupIdPromise;
    if (!groupIdValue) return;
    for (const entry of entries) {
      if (entry.frame.deleted) continue;
      const existing = ledger.get(entry.id);
      if (existing && !existing.pending && entry.frame.base === 0) continue;
      const value = await decryptRecord(
        key,
        { id: entry.id, blob: entry.frame.blob, deleted: false },
        groupIdValue
      );
      if (!value) continue;
      if (entry.frame.base > 0 && entry.baseBlob) {
        try {
          const base = await open(key, entry.baseBlob, baseAad(groupIdValue, entry.id));
          if (base && typeof base === 'object') {
            queuedEditBases.set(entry.id, { value: base, baseBlob: entry.baseBlob });
          }
        } catch {
          /* the edit stays pending; a conflict will refuse rather than guess */
        }
      }
      const at = existing?.at ?? Date.now();
      ledger.set(entry.id, {
        id: entry.id,
        rev: entry.frame.base,
        pending: true,
        blob: entry.frame.blob,
        value,
        author: selfId,
        creator: existing?.creator ?? existing?.author ?? selfId,
        at
      });
    }
    renderLedger();
    renderPendingCount();
  }

  async function applyCurrentRecord(current) {
    if (!current || !groupKeyPromise) return;
    const key = await groupKeyPromise;
    const groupIdValue = await groupIdPromise;
    if (current.deleted) {
      ledger.delete(current.id);
      renderLedger();
      return;
    }
    const value = await decryptRecord(key, current, groupIdValue);
    if (!value) return;
    ledger.set(current.id, { ...current, value });
    renderLedger();
  }

  async function settlePendingConflict(frame) {
    const pending = ledger.get(frame.id);
    if (!pending?.pending || !groupKeyPromise) return;
    const key = await groupKeyPromise;
    const groupIdValue = await groupIdPromise;

    if (frame.current && !frame.current.deleted) {
      const currentValue = await decryptRecord(key, frame.current, groupIdValue);
      const same = currentValue && JSON.stringify(currentValue) === JSON.stringify(pending.value);
      ledger.set(frame.id, { ...frame.current, value: currentValue });
      renderLedger();
      setStatus(same ? 'Expense added.' : 'That expense was not saved; it changed elsewhere.');
      return;
    }

    ledger.delete(frame.id);
    renderLedger();
    setStatus('That expense was not saved.');
  }

  /** Say who removed the row, and what it was when the value is still in hand. */
  function deletionStatus(record, value = null) {
    const name = memberLabel(record?.author);
    if (value?.kind === 'settlement') return `Payment deleted by ${name}.`;
    const what =
      typeof value?.description === 'string' && value.description !== ''
        ? `Expense “${value.description}”`
        : 'Expense';
    return `${what} deleted by ${name}.`;
  }

  async function handleRecordFrame(frame) {
    if (!groupKeyPromise) return;
    const key = await groupKeyPromise;
    const groupIdValue = await groupIdPromise;
    if (!recordGuard.accept(frame)) {
      noteImportFailure(frame.id);
      return;
    }
    if (groupIdValue) saveRevs(local, groupIdValue, recordGuard.snapshot());
    groupSocket()?.ack(frame.id);

    if (frame.deleted) {
      const previous = ledger.get(frame.id)?.value;
      ledger.delete(frame.id);
      cachedRecords.set(frame.id, {
        id: frame.id,
        rev: frame.rev,
        blob: null,
        deleted: true,
        author: frame.author,
        creator: frame.creator,
        at: frame.at
      });
      scheduleCacheWrite(groupIdValue);
      renderLedger();
      if (frame.id === pendingDeleteId) pendingDeleteId = null;
      if (editingExpense?.id === frame.id) closeExpenseSheet();
      setStatus(deletionStatus(frame, previous));
      return;
    }

    const value = await decryptRecord(key, frame, groupIdValue);
    if (!value) {
      noteImportFailure(frame.id);
      return;
    }
    ledger.set(frame.id, { ...frame, value });
    cachedRecords.set(frame.id, {
      id: frame.id,
      rev: frame.rev,
      blob: frame.blob,
      deleted: false,
      author: frame.author,
      creator: frame.creator,
      at: frame.at
    });
    scheduleCacheWrite(groupIdValue);
    renderLedger();
    noteImportedRecord(frame.id);

    if (frame.id === pendingExpenseId && (!selfId || frame.author === selfId)) {
      const wasEditing = pendingExpenseEdit;
      const notice = mergeNotice;
      pendingExpenseId = null;
      pendingExpenseEdit = false;
      savingExpense = false;
      closeExpenseSheet();
      setStatus(notice ?? (wasEditing ? 'Expense saved.' : 'Expense added.'));
    }
    if (frame.id === pendingSettlementId) {
      pendingSettlementId = null;
      savingSettlement = false;
      closeSettlementSheet();
      setStatus('Payment recorded.');
    }
  }

  function handleExpenseRefusal(frame) {
    if (frame.id === pendingSettlementId) {
      savingSettlement = false;
      pendingSettlementId = null;
      settleSave.disabled = false;
      settleCancel.disabled = false;
      settleSave.textContent = 'Record payment';
      settleFailure(
        frame.code === 'unapproved'
          ? 'You are not approved to record payments.'
          : 'The payment could not be recorded. Try again.',
        settleSave
      );
      return true;
    }

    if (ledger.get(frame.id)?.pending) {
      groupSocket()?.ack(frame.id);
      ledger.delete(frame.id);
      renderLedger();
      setStatus(
        frame.code === 'deleted'
          ? 'Someone deleted this expense.'
          : 'The expense could not be saved. Try again.'
      );
      return true;
    }

    /* A queued delete or edit outlives the sheet that made it; a permanent refusal retires it. */
    if (frame.id && groupSocket()?.queueEntries().some((entry) => entry.id === frame.id)) {
      groupSocket().ack(frame.id);
      if (frame.code === 'deleted') {
        ledger.delete(frame.id);
        renderLedger();
        setStatus('Someone deleted this expense.');
      } else {
        setStatus('The change could not be saved.');
      }
      return true;
    }

    if (frame.id === pendingDeleteId) {
      pendingDeleteId = null;
      if (frame.code === 'deleted') {
        ledger.delete(frame.id);
        renderLedger();
        setStatus('Someone deleted this expense.');
      } else {
        setStatus('The expense could not be deleted. Try again.');
      }
      return true;
    }

    if (!savingExpense || frame.id !== pendingExpenseId) return false;
    savingExpense = false;
    pendingExpenseId = null;
    pendingExpenseEdit = false;
    expenseSave.disabled = false;
    expenseCancel.disabled = false;
    expenseSave.textContent = editingExpense ? 'Save changes' : 'Save expense';
    const message =
      frame.code === 'too_large'
        ? 'That expense is too large to save.'
        : frame.code === 'deleted'
          ? 'Someone deleted this expense.'
          : frame.code === 'unapproved'
            ? 'You are not approved to add expenses.'
            : 'The expense could not be saved. Try again.';
    if (frame.code === 'deleted') {
      ledger.delete(frame.id);
      renderLedger();
      if (editingExpense?.id === frame.id) closeExpenseSheet();
    }
    expenseFailure(message, expenseSave);
    return true;
  }

  function dropQueuedEdit(id) {
    queuedEditBases.delete(id);
    queuedEditRetries.delete(id);
    groupSocket()?.ack(id);
  }

  /**
   * A queued edit reached a record that moved. Merge it field-by-field once, re-seal the merged
   * value and replace the queued frame in place; a second conflict stops with the latest shown.
   */
  async function mergeQueuedEdit(frame) {
    const id = frame.id;
    const base = queuedEditBases.get(id);
    const pending = ledger.get(id);

    if (!base?.value || !pending) {
      dropQueuedEdit(id);
      setStatus('The edit could not be saved. Try again.');
      return;
    }
    if (!frame.current) {
      dropQueuedEdit(id);
      setStatus('The expense could not be saved.');
      return;
    }
    if (frame.current.deleted) {
      dropQueuedEdit(id);
      ledger.delete(id);
      renderLedger();
      setStatus(deletionStatus(frame.current, pending.value));
      return;
    }

    const key = await groupKeyPromise;
    const groupIdValue = await groupIdPromise;
    const currentValue = await decryptRecord(key, frame.current, groupIdValue);
    if (!currentValue) {
      dropQueuedEdit(id);
      setStatus('The edit could not be merged. Try again.');
      return;
    }

    if (JSON.stringify(currentValue) === JSON.stringify(pending.value)) {
      dropQueuedEdit(id);
      ledger.set(id, { ...frame.current, value: currentValue });
      renderLedger();
      setStatus('Expense saved.');
      return;
    }

    if (queuedEditRetries.has(id)) {
      dropQueuedEdit(id);
      ledger.set(id, { ...frame.current, value: currentValue });
      renderLedger();
      setStatus('This expense changed again. Your edit was not saved; the latest version is shown.');
      return;
    }

    const merged = mergeDiff(base.value, pending.value, currentValue);
    if (merged.broken) {
      dropQueuedEdit(id);
      ledger.set(id, { ...frame.current, value: currentValue });
      renderLedger();
      setStatus('Your edit and the latest version no longer add up. The latest version is shown.');
      return;
    }

    try {
      const blob = await seal(key, merged.value, expenseAad(groupIdValue, id));
      const baseBlob = await seal(key, currentValue, baseAad(groupIdValue, id));
      queuedEditBases.set(id, { value: currentValue, baseBlob });
      queuedEditRetries.add(id);
      ledger.set(id, {
        ...frame.current,
        pending: true,
        blob,
        value: merged.value,
        author: selfId,
        creator: frame.current.creator ?? frame.current.author ?? selfId
      });
      renderLedger();
      groupSocket()?.replace(id, {
        t: 'put',
        id,
        base: frame.current.rev,
        blob,
        deleted: false
      });
      setStatus(mergeMessage(merged, memberLabel(frame.current.author)));
    } catch {
      dropQueuedEdit(id);
      setStatus('The edit could not be re-sealed. Check the latest version and try again.');
    }
  }

  function handleExpenseConflict(frame) {
    const settling = frame.id === pendingSettlementId;
    if (settling) {
      savingSettlement = false;
      pendingSettlementId = null;
      settleSave.disabled = false;
      settleCancel.disabled = false;
      settleSave.textContent = 'Record payment';
      if (frame.current) void applyCurrentRecord(frame.current);
      settleFailure('This record changed elsewhere. Try again.', settleSave);
      return true;
    }

    if (queuedEditBases.has(frame.id) && frame.id !== pendingExpenseId) {
      void mergeQueuedEdit(frame);
      return true;
    }

    if (ledger.get(frame.id)?.pending) {
      groupSocket()?.ack(frame.id);
      void settlePendingConflict(frame);
      return true;
    }

    const editing = frame.id === pendingExpenseId;
    const deleting = frame.id === pendingDeleteId;
    if (!editing && !deleting) return false;

    if (frame.current?.deleted) {
      const previous = ledger.get(frame.id)?.value;
      ledger.delete(frame.id);
      renderLedger();
      if (editing) closeExpenseSheet();
      if (deleting) pendingDeleteId = null;
      setStatus(deletionStatus(frame.current, previous));
      return true;
    }

    if (editing && frame.current && editingBaseValue && pendingExpenseValue) {
      groupSocket()?.ack(frame.id);
      void mergeExpenseConflict(frame);
      return true;
    }

    if (frame.current) {
      void applyCurrentRecord(frame.current);
      if (editing) editingExpense = { ...frame.current };
    }

    if (editing) {
      savingExpense = false;
      pendingExpenseId = null;
      pendingExpenseEdit = false;
      expenseSave.disabled = false;
      expenseCancel.disabled = false;
      expenseSave.textContent = editingExpense ? 'Save changes' : 'Save expense';
      expenseFailure(
        'This expense changed elsewhere. The latest version is shown; check it and try again.',
        expenseSave
      );
    }
    if (deleting) {
      pendingDeleteId = null;
      setStatus('This expense changed elsewhere. Check it and try again.');
    }
    return true;
  }

  const MERGE_LABELS = {
    description: 'description',
    amountPaise: 'amount',
    paidBy: 'payers',
    split: 'shares',
    date: 'date',
    time: 'time',
    note: 'note'
  };

  function fieldList(fields) {
    const labels = fields.map((field) => MERGE_LABELS[field] ?? field);
    if (labels.length === 0) return 'changes';
    if (labels.length === 1) return labels[0];
    return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  }

  function mergeMessage(merged, peerName) {
    const parts = [];
    if (merged.mine.length > 0) parts.push(`kept your ${fieldList(merged.mine)}`);
    if (merged.theirs.length > 0) parts.push(`took their ${fieldList(merged.theirs)}`);
    if (merged.both.length > 0) parts.push(`your ${fieldList(merged.both)} saved over theirs`);
    return parts.length === 0
      ? `Merged with ${peerName}'s edit.`
      : `Merged with ${peerName}'s edit — ${parts.join('; ')}.`;
  }

  function mergeBrokenMessage(broken, peerName) {
    const amount = formatPaise(broken.amountPaise ?? 0, groupCurrency);
    if (broken.reason === 'split') {
      const total = formatPaise(broken.totalPaise ?? 0, groupCurrency);
      return `Your amount (${amount}) and ${peerName}'s shares (${total}) no longer add up. Adjust one and save again.`;
    }
    if (broken.reason === 'payers') {
      return `Your amount (${amount}) and ${peerName}'s payers no longer add up. Adjust them and save again.`;
    }
    return 'The merged amount is not valid. Check it and save again.';
  }

  /**
   * A save lost its base: someone else wrote the record first. Merge the fields this editor
   * changed with what the server holds, check the money fields still add up, and retry once.
   * A second conflict stops rather than looping, with the latest version on screen.
   */
  async function mergeExpenseConflict(frame) {
    if (!groupKeyPromise) return;
    const key = await groupKeyPromise;
    const groupIdValue = await groupIdPromise;
    const currentValue = await decryptRecord(key, frame.current, groupIdValue);

    if (!currentValue) {
      finishExpenseConflict(
        frame,
        null,
        'This expense changed elsewhere. The latest version is shown; check it and try again.'
      );
      return;
    }

    ledger.set(frame.current.id, { ...frame.current, value: currentValue });
    renderLedger();

    if (mergeRetryId === frame.id) {
      const mine = fieldList(mergeNoticeFields);
      finishExpenseConflict(
        frame,
        currentValue,
        `This expense changed again before your merge was saved. Your ${mine} ${
          mergeNoticeFields.length === 1 ? 'was' : 'were'
        } not saved; the latest version is shown.`
      );
      return;
    }

    const merged = mergeDiff(editingBaseValue, pendingExpenseValue, currentValue);
    const peerName = memberLabel(frame.current.author);

    if (merged.broken) {
      openExpenseSheet({ ...frame.current, value: merged.value });
      expenseFailure(mergeBrokenMessage(merged.broken, peerName), expenseAmount);
      return;
    }

    mergeNotice = mergeMessage(merged, peerName);
    mergeNoticeFields = [...merged.mine, ...merged.both];
    pendingExpenseValue = merged.value;
    editingBaseValue = currentValue;
    editingExpense = { ...frame.current, value: currentValue };
    mergeRetryId = frame.id;

    try {
      const blob = await seal(key, merged.value, expenseAad(groupIdValue, frame.id));
      const baseBlob = await seal(key, currentValue, baseAad(groupIdValue, frame.id));
      queuedEditBases.set(frame.id, { value: currentValue, baseBlob });
      groupSocket()?.send(
        { t: 'put', id: frame.id, base: frame.current.rev, blob, deleted: false },
        { id: frame.id }
      );
    } catch {
      finishExpenseConflict(
        frame,
        currentValue,
        'The merged expense could not be sealed. Check the latest version and try again.'
      );
    }
  }

  function finishExpenseConflict(frame, currentValue, message) {
    savingExpense = false;
    pendingExpenseId = null;
    pendingExpenseEdit = false;
    mergeRetryId = null;
    mergeNotice = null;
    expenseSave.disabled = false;
    expenseCancel.disabled = false;
    expenseSave.textContent = 'Save changes';
    if (currentValue) openExpenseSheet({ ...frame.current, value: currentValue });
    expenseFailure(message, expenseSave);
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

  function closeLifecycle() {
    lifecycleAction = null;
    lifecycleConfirm.hidden = true;
    lifecycleText.textContent = '';
    lifecycleConfirmButton.textContent = '';
  }

  /** A deliberate second step; Cancel is focused so a stray Enter cannot end a trip. */
  function openLifecycle(action) {
    const socket = groupSocket();
    if (!socket || !socket.isOpen) {
      setStatus(action === 'end' ? 'Ending needs a connection.' : 'Leaving needs a connection.');
      return;
    }
    lifecycleAction = action;
    lifecycleText.textContent =
      action === 'end'
        ? 'Every expense, payment and name in this group will be deleted. Anyone with this group open will lose it. This cannot be undone.'
        : 'Leave this group? Your expenses stay in the group and stay attributed. This device forgets the group. This cannot be undone.';
    lifecycleConfirmButton.textContent = action === 'end' ? 'End group' : 'Leave group';
    lifecycleConfirm.hidden = false;
    lifecycleCancel.focus();
  }

  function confirmLifecycle() {
    const action = lifecycleAction;
    if (!action) return;
    const socket = groupSocket();
    if (!socket || !socket.isOpen) {
      setStatus(action === 'end' ? 'Ending needs a connection.' : 'Leaving needs a connection.');
      return;
    }
    closeLifecycle();
    setStatus(action === 'end' ? 'Ending the group…' : 'Leaving the group…');
    socket.send({ t: action === 'end' ? 'end' : 'leave' });
  }

  function dropGroupCache(groupIdValue) {
    if (!groupIdValue) return;
    forgetGroupCache(local, groupIdValue);
    forgetRevs(local, groupIdValue);
    cachedBase = null;
    cachedRecords = new Map();
    cachedSavedAt = 0;
    queuedEditBases = new Map();
    queuedEditRetries = new Set();
    if (cacheTimer !== null) win.clearTimeout(cacheTimer);
    cacheTimer = null;
    pendingImport = null;
    importJob = null;
  }

  /** The organizer ended the group: forget it before navigating, so no cache can resume it. */
  function handleEnded() {
    const current = groupId;
    if (current && endedHandledFor === current) return;
    endedHandledFor = current;
    dropGroupCache(current);
    if (current) forget(current);
    closeHostSocket();
    closeJoinSocket();
    showCreate();
    showNotice('This group has ended. It cannot be reopened.');
  }

  /** This device left: the group is forgotten here; its entries remain on every other screen. */
  function handleLeft() {
    const current = groupId;
    dropGroupCache(current);
    if (current) forget(current);
    closeHostSocket();
    closeJoinSocket();
    showCreate();
    showNotice('You left the group. Your expenses stay in the group.');
  }

  /** Build the readable copy and hand it to the browser's download flow. */
  function downloadExport() {
    if (!group) return;
    try {
      const exportedAt = new Date();
      const file = exportGroup({
        name: group.name,
        currency: groupCurrency,
        members: [...members].map(([id, name]) => ({ id, name })),
        records: [...ledger.values()],
        exportedAt
      });
      const text = `${JSON.stringify(file, null, 2)}\n`;
      const blob = new win.Blob([text], { type: 'application/json' });
      const url = win.URL.createObjectURL(blob);
      const link = doc.createElement('a');
      link.href = url;
      link.download = exportFileName(exportedAt);
      link.rel = 'noopener';
      doc.body.append(link);
      link.click();
      link.remove();
      win.setTimeout(() => win.URL.revokeObjectURL(url), 0);

      const count = (value, one, many) => `${value} ${value === 1 ? one : many}`;
      exportStatus.textContent = `Exported ${count(
        file.expenses.length,
        'expense',
        'expenses'
      )} and ${count(file.settlements.length, 'payment', 'payments')}.`;
    } catch {
      exportStatus.textContent = 'The file could not be made. Try again.';
    }
  }


  function prepareOutbox(entries) {
    for (const entry of entries) {
      if (entry.baseBlob) {
        queuedEditBases.set(entry.id, {
          baseBlob: entry.baseBlob,
          value: queuedEditBases.get(entry.id)?.value ?? null
        });
      }
    }
  }

  function resetImport() {
    if (importJob?.timer) win.clearTimeout(importJob.timer);
    pendingImport = null;
    importJob = null;
    importConfirm.hidden = true;
    importConfirmText.textContent = '';
    importStatus.textContent = '';
    importButton.disabled = false;
    importFile.value = '';
  }

  function liveRecordCount() {
    return [...ledger.values()].filter((record) => !record.deleted).length;
  }

  const countLabel = (value, one, many) => `${value} ${value === 1 ? one : many}`;

  /** Validate the chosen file before anything is written, then ask if the group is not empty. */
  async function chooseImportFile() {
    const chosen = importFile.files?.[0];
    importFile.value = '';
    if (!chosen || importJob) return;

    importStatus.textContent = '';
    importConfirm.hidden = true;
    pendingImport = null;

    if (groupRole !== 'organizer') {
      importStatus.textContent = 'Only the organizer can import.';
      return;
    }

    let text;
    try {
      text = await chosen.text();
    } catch {
      importStatus.textContent = 'That file could not be read.';
      return;
    }

    const parsed = importGroup(text);
    if (!parsed.ok) {
      importStatus.textContent = parsed.message;
      return;
    }
    if (parsed.group.currency !== groupCurrency) {
      importStatus.textContent = `This file is in ${parsed.group.currency}; this group uses ${groupCurrency}.`;
      return;
    }

    const existing = liveRecordCount();
    if (existing > 0) {
      pendingImport = parsed;
      importConfirmText.textContent =
        `This group already has ${countLabel(existing, 'record', 'records')}. ` +
        `Importing adds ${countLabel(parsed.members.length, 'person', 'people')}, ` +
        `${countLabel(parsed.expenses.length, 'expense', 'expenses')} and ` +
        `${countLabel(parsed.settlements.length, 'payment', 'payments')}.`;
      importConfirm.hidden = false;
      return;
    }

    await beginImport(parsed);
  }

  /** Re-seal the file under this group's key, add its people, then write every record. */
  async function beginImport(parsed) {
    if (importJob) return;
    const socket = groupSocket();
    if (!socket || !socket.isOpen) {
      importStatus.textContent = 'Importing needs a connection.';
      return;
    }

    try {
      const key = await groupKeyPromise;
      const groupIdValue = await groupIdPromise;
      const usedNames = new Set(members.values());
      const takeName = (name) => {
        let label = name;
        let suffix = 2;
        while (usedNames.has(label)) {
          label = `${name} (${suffix})`;
          suffix += 1;
        }
        usedNames.add(label);
        return label;
      };

      const ids = new Map();
      const memberFrames = [];
      for (const member of parsed.members) {
        const memberId = randomSecret();
        ids.set(member.name, memberId);
        memberFrames.push({ memberId, nameBlob: await seal(key, { name: takeName(member.name) }) });
      }

      const recordFrames = [];
      for (const expense of parsed.expenses) {
        const id = randomSecret();
        const value = {
          kind: 'expense',
          description: expense.description,
          amountPaise: expense.amountPaise,
          paidBy: expense.paidBy.map((row) => ({
            memberId: ids.get(row.name),
            amountPaise: row.amountPaise
          })),
          split: Object.fromEntries(
            expense.split.map((row) => [ids.get(row.name), row.amountPaise])
          ),
          date: expense.date,
          time: expense.time,
          note: expense.note
        };
        const blob = await seal(key, value, expenseAad(groupIdValue, id));
        recordFrames.push({ id, frame: { t: 'put', id, base: 0, blob, deleted: false } });
      }
      for (const payment of parsed.settlements) {
        const id = randomSecret();
        const value = {
          kind: 'settlement',
          from: ids.get(payment.from),
          to: ids.get(payment.to),
          amountPaise: payment.amountPaise,
          date: payment.date,
          time: payment.time,
          note: payment.note
        };
        const blob = await seal(key, value, settlementAad(groupIdValue, id));
        recordFrames.push({ id, frame: { t: 'put', id, base: 0, blob, deleted: false } });
      }

      importJob = {
        phase: 'members',
        timer: win.setTimeout(() => {
          if (importJob === null) return;
          importStatus.textContent = 'The import is still waiting for the connection.';
          importJob = null;
          importButton.disabled = false;
        }, 15_000),
        memberIds: new Set(memberFrames.map((member) => member.memberId)),
        recordIds: new Set(recordFrames.map((record) => record.id)),
        recordFrames,
        totalRecords: recordFrames.length,
        done: 0,
        failures: 0,
        people: parsed.members.length,
        expenses: parsed.expenses.length,
        settlements: parsed.settlements.length
      };
      importButton.disabled = true;
      importStatus.textContent =
        `Importing ${countLabel(recordFrames.length, 'record', 'records')} for ` +
        `${countLabel(parsed.members.length, 'person', 'people')}…`;
      socket.send({ t: 'import-members', members: memberFrames });
    } catch {
      importJob = null;
      importButton.disabled = false;
      importStatus.textContent = 'The import could not be prepared. Try again.';
    }
  }

  function handleImportMembersOk(frame) {
    if (!importJob || importJob.phase !== 'members') return;
    if (
      !Array.isArray(frame.memberIds) ||
      frame.memberIds.length !== importJob.memberIds.size ||
      frame.memberIds.some((id) => !importJob.memberIds.has(id))
    ) {
      importStatus.textContent = 'The import could not confirm the people. Try again.';
      importJob = null;
      importButton.disabled = false;
      return;
    }
    const socket = groupSocket();
    if (!socket || !socket.isOpen) {
      importStatus.textContent = 'The connection dropped; the import did not continue.';
      importJob = null;
      importButton.disabled = false;
      return;
    }

    importJob.phase = 'records';
    for (const record of importJob.recordFrames) {
      socket.send(record.frame, { id: record.id });
    }
    if (importJob.totalRecords === 0) finishImport();
  }

  function handleImportRefusal(frame) {
    if (!importJob) return false;

    if (importJob.phase === 'members') {
      if (importJob.timer) win.clearTimeout(importJob.timer);
      importStatus.textContent =
        frame.code === 'group_full'
          ? 'The group has no room for the imported people.'
          : frame.code === 'exists'
            ? 'An imported person conflicts with an existing member.'
            : 'The import could not add the people.';
      importJob = null;
      pendingImport = null;
      importButton.disabled = false;
      return true;
    }

    return noteImportFailure(frame.id);
  }

  function noteImportFailure(id) {
    if (!importJob || importJob.phase !== 'records' || !importJob.recordIds.has(id)) return false;
    importJob.failures += 1;
    if (importJob.done + importJob.failures >= importJob.totalRecords) finishImport();
    return true;
  }

  function noteImportedRecord(id) {
    if (!importJob || importJob.phase !== 'records' || !importJob.recordIds.has(id)) return;
    importJob.done += 1;
    if (importJob.done + importJob.failures >= importJob.totalRecords) finishImport();
  }

  function finishImport() {
    const job = importJob;
    if (job?.timer) win.clearTimeout(job.timer);
    importJob = null;
    pendingImport = null;
    importButton.disabled = false;
    if (!job) return;
    if (job.failures > 0) {
      importStatus.textContent = `Imported ${job.done} of ${job.totalRecords} records; ${job.failures} failed.`;
      return;
    }
    importStatus.textContent =
      `Imported ${countLabel(job.expenses, 'expense', 'expenses')} and ` +
      `${countLabel(job.settlements, 'payment', 'payments')} for ` +
      `${countLabel(job.people, 'person', 'people')}.`;
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
      showJoin({
        code: invited.code,
        error: win.navigator?.onLine === false ? OFFLINE_FIRST_MESSAGE : ''
      });
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
    if (!stored) {
      if (win.navigator?.onLine === false) showNotice(OFFLINE_FIRST_MESSAGE);
      return;
    }

    const code = codeFor(tab, groupId);
    if (code) {
      await resumeStored(stored, code);
      return;
    }
    showJoin({ resume: stored });
  }

  if ('serviceWorker' in (win.navigator ?? {})) {
    win.navigator.serviceWorker.register('sw.js').catch(() => {
      /* an unsupported or blocked worker leaves the online app unchanged */
    });
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
