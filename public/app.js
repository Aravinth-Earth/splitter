/**
 * Splitter — the create-group page.
 *
 * One job: take a group name, a currency and a display name, turn them into a code and a key in
 * this browser, and ask the Worker to reserve a slot. The name and the currency never travel as
 * text — they are sealed under a key derived from the code — so the request carries a hash of the
 * code, a hash of this member's secret, and two blobs the server cannot open.
 *
 * The code is kept in memory only. Nothing in this module writes to browser storage on purpose: a
 * reload losing the group is expected until a group can be re-opened from a code, and a code
 * written to a store is a key written to a store.
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
  const whoLine = doc.getElementById('who-line');
  const copyStatus = doc.getElementById('copy-status');
  const codeHint = doc.getElementById('code-hint');
  const dismissHintButton = doc.getElementById('dismiss-hint');
  const emptyLedger = doc.getElementById('empty-ledger');

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
    void copy(inviteLink(pageBase(), group.code), 'Invite link copied — it carries the code.');
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
  function showGroup({ code, name, displayName }) {
    group = { code };

    groupNameDisplay.textContent = name;
    groupCode.textContent = formatCode(code);
    whoLine.textContent = displayName;
    whoLine.hidden = false;
    copyStatus.textContent = '';
    codeHint.hidden = false;

    createPanel.hidden = true;
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

  /** Copy text, and say what happened. A refused clipboard falls back, then reports the failure. */
  async function copy(text, done) {
    const copied = await writeClipboard(text);
    copyStatus.textContent = copied
      ? done
      : 'Copy failed — select the code and copy it by hand.';
    if (copied) hideHint();
  }

  async function writeClipboard(text) {
    try {
      if (win.navigator?.clipboard?.writeText) {
        await win.navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* A refused permission is not a copy; the old path below is the only fallback left. */
    }

    try {
      const area = doc.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '0';
      area.style.left = '-9999px';
      doc.body.append(area);
      area.select();
      const copied = doc.execCommand('copy');
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

/* Under `node --test` there is no document, so importing this module for its pure functions wires
   nothing. In a browser the module is deferred, so the form exists by the time this line runs. */
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  init(document, window);
}
