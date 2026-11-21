/**
 * Splitter — the proof that nothing readable crosses the wire.
 *
 * This launches a real Chromium browser, boots the real Worker with tests/wrangler.mjs, and drives
 * a two-member session through the page itself: create, join, approve, add an expense, edit it,
 * record a payment, delete the expense and end the group. Every WebSocket frame in both directions
 * and every HTTP request body to /api/ is recorded, then scanned with scripts/e2e/scan.mjs.
 *
 * The run prints `N frames, M bodies scanned` and refuses to pass on either count being zero: a
 * capture that saw nothing is not evidence. Before the verdict it makes a mutant of one frame and
 * one body and checks that the scanner flags both, so the gate cannot pass by scanning nothing.
 * One readable group name, member name, description, amount digit or the group code fails the run.
 *
 * `npm run e2e` is separate from `npm test` on purpose: it needs a Chromium binary. Set
 * CHROME_PATH when Chromium is installed somewhere `findChrome` does not look.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { startWorker } from '../../tests/wrangler.mjs';
import { launchChrome } from './cdp.mjs';
import {
  reportLine,
  scanCapture,
  scanValue,
  withPlaintext
} from './scan.mjs';

const GROUP_NAME = 'Quasar Ledger Sentinel';
const HOST_NAME = 'Zelda Quasar';
const MEMBER_NAME = 'Yorvik Nimbus';
const DESCRIPTION = 'Sentinel Dinner';
const EDIT_DESCRIPTION = 'Sentinel Ferry';
const AMOUNT_TEXT = '9876543.21'; /* 987654321 paise */
const PAYMENT_TEXT = '1234567.89'; /* 123456789 paise */
const DATE = '2026-11-21';
const TIME = '20:00';

/** Open a target, attach a flat session, enable the domains and navigate. */
async function openPage(cdp, { url, onSession }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  onSession(sessionId);

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', { maxPostDataSize: 8 * 1024 * 1024 }, sessionId);

  const evaluate = async (expression) => {
    const reply = await cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (reply.exceptionDetails) {
      const detail =
        reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? 'page error';
      throw new Error(detail);
    }
    return reply.result?.value;
  };

  const waitFor = async (expression, what, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return;
      } catch (error) {
        last = error;
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
  };

  const page = {
    sessionId,
    evaluate,
    waitFor,
    click: (selector) =>
      evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ${selector}'); el.click(); return true; })()`
      ),
    fill: (selector, value) =>
      evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no ${selector}'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
      ),
    text: (selector) =>
      evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
  };

  await cdp.send('Page.navigate', { url }, sessionId);
  return page;
}

/** Record both socket directions and every /api request body for the pages this run opens. */
function startCapture(cdp) {
  const sessions = new Set();
  const frames = [];
  const bodies = [];

  const record = (direction) => (params, sessionId) => {
    if (!sessions.has(sessionId)) return;
    frames.push({ direction, payload: params.response?.payloadData ?? '' });
  };

  cdp.on('Network.webSocketFrameSent', record('sent'));
  cdp.on('Network.webSocketFrameReceived', record('received'));

  cdp.on('Network.requestWillBeSent', (params, sessionId) => {
    if (!sessions.has(sessionId)) return;
    const { request } = params;
    let path;
    try {
      path = new URL(request.url).pathname;
    } catch {
      return;
    }
    if (!path.startsWith('/api/')) return;
    if (typeof request.postData !== 'string') return;
    bodies.push({ url: request.url, body: request.postData });
  });

  return {
    frames,
    bodies,
    add(sessionId) {
      sessions.add(sessionId);
    }
  };
}

/** Drive the two-member session and return the group code it was given. */
async function drive(worker, cdp, capture) {
  const host = await openPage(cdp, {
    url: `${worker.baseUrl}/`,
    onSession: (sessionId) => capture.add(sessionId)
  });
  await host.waitFor(
    "document.getElementById('create-panel') && !document.getElementById('create-panel').hidden",
    'the create form'
  );
  await host.fill('#group-name', GROUP_NAME);
  await host.fill('#currency', 'INR');
  await host.fill('#display-name', HOST_NAME);
  await host.click('#create-btn');
  await host.waitFor("!document.getElementById('group-header').hidden", 'the host group header');

  const rawCode = (await host.text('#group-code')).trim();
  const code = rawCode.replace(/[^0-9A-Z]/g, '');
  if (code.length !== 16) {
    throw new Error(`the host page did not show a 16-character code: "${rawCode}"`);
  }

  const joiner = await openPage(cdp, {
    url: `${worker.baseUrl}/`,
    onSession: (sessionId) => capture.add(sessionId)
  });
  await joiner.waitFor(
    "document.getElementById('create-panel') && !document.getElementById('create-panel').hidden",
    'the create form on the joining tab'
  );
  await joiner.click('#show-join');
  await joiner.fill('#join-code', code);
  await joiner.fill('#join-name', MEMBER_NAME);
  await joiner.click('#join-btn');
  await joiner.waitFor("!document.getElementById('waiting-panel').hidden", 'the waiting panel');

  await host.waitFor(
    "[...document.querySelectorAll('#roster-pending button')].some((button) => button.textContent === 'Let in')",
    'the pending member on the host roster'
  );
  await host.evaluate(
    "[...document.querySelectorAll('#roster-pending button')].find((button) => button.textContent === 'Let in').click()"
  );
  await joiner.waitFor("!document.getElementById('group-header').hidden", 'the member group header');

  await host.click('#add-expense');
  await host.waitFor("!document.getElementById('expense-panel').hidden", 'the expense sheet');
  await host.fill('#expense-description', DESCRIPTION);
  await host.fill('#expense-amount', AMOUNT_TEXT);
  await host.fill('#expense-date', DATE);
  await host.fill('#expense-time', TIME);
  await host.click('#expense-save');
  await host.waitFor(
    "document.querySelectorAll('#ledger-list .expense-row').length > 0",
    'the expense row'
  );
  await joiner.waitFor(
    `document.getElementById('ledger-list').textContent.includes(${JSON.stringify(DESCRIPTION)})`,
    'the member to receive the expense'
  );

  await host.evaluate("document.querySelector('#ledger-list .expense-actions button').click()");
  await host.waitFor("!document.getElementById('expense-panel').hidden", 'the edit sheet');
  await host.fill('#expense-description', EDIT_DESCRIPTION);
  await host.click('#expense-save');
  await host.waitFor(
    `document.getElementById('ledger-list').textContent.includes(${JSON.stringify(EDIT_DESCRIPTION)})`,
    'the edited expense'
  );

  await host.click('#record-payment');
  await host.waitFor("!document.getElementById('settlement-panel').hidden", 'the payment sheet');
  await host.evaluate(`(() => {
    const from = document.getElementById('settle-from');
    const to = document.getElementById('settle-to');
    if (from.options.length < 2) throw new Error('need two people to record a payment');
    from.selectedIndex = 0;
    to.selectedIndex = 1;
    for (const el of [from, to]) el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await host.fill('#settle-amount', PAYMENT_TEXT);
  await host.fill('#settle-date', DATE);
  await host.fill('#settle-time', TIME);
  await host.click('#settle-save');
  await host.waitFor(
    "document.getElementById('payment-list').childNodes.length > 0",
    'the recorded payment'
  );

  const removeButton = "document.querySelectorAll('#ledger-list .expense-actions button')[1]";
  await host.evaluate(`(${removeButton}).click()`);
  await host.waitFor(
    `${removeButton}.textContent === 'Delete? It leaves every screen'`,
    'the delete to arm'
  );
  await host.evaluate(`(${removeButton}).click()`);
  await host.waitFor(
    "document.querySelectorAll('#ledger-list .expense-row').length === 0",
    'the deleted expense to leave the ledger'
  );

  await host.click('#end-group');
  await host.waitFor("!document.getElementById('lifecycle-confirm').hidden", 'the end confirmation');
  await host.click('#lifecycle-confirm-button');
  await host.waitFor("!document.getElementById('create-panel').hidden", 'the landing screen after end');

  await sleep(300);
  return code;
}

function sentinelsFor(code) {
  const formatted = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12)}`;
  return [
    { label: 'group name', value: GROUP_NAME },
    { label: 'host name', value: HOST_NAME },
    { label: 'member name', value: MEMBER_NAME },
    { label: 'description', value: DESCRIPTION },
    { label: 'description', value: EDIT_DESCRIPTION },
    { label: 'amount', value: AMOUNT_TEXT.replace('.', '') },
    { label: 'amount', value: PAYMENT_TEXT.replace('.', '') },
    { label: 'code', value: code },
    { label: 'code', value: formatted }
  ];
}

/** Parse one capture entry, or null when it is not JSON. */
function parsePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const worker = await startWorker();
  let browser;
  let capture;
  let code;

  try {
    browser = await launchChrome();
    capture = startCapture(browser.cdp);
    code = await drive(worker, browser.cdp, capture);
  } finally {
    await browser?.close();
    await worker.stop();
  }

  const sentinels = sentinelsFor(code);
  const result = scanCapture(capture, sentinels);
  const line = reportLine(result);
  console.log(line);

  /* The gate must be able to fail. Two mutants — one frame and one body — are scanned before the
     capture is judged, so a scanner that accepted everything cannot report a clean session. */
  const frameSample = capture.frames
    .map((frame) => parsePayload(frame.payload))
    .find((value) => value !== null) ?? { t: 'ping' };
  const frameMutant = scanValue(withPlaintext(frameSample, sentinels[0]), sentinels);
  if (frameMutant.violations.length === 0) {
    console.error('FAIL the scanner did not catch a plaintext sentinel in a frame; it proves nothing');
    process.exitCode = 1;
    return;
  }

  const bodySample = capture.bodies
    .map((body) => parsePayload(body.body))
    .find((value) => value !== null) ?? { groupId: 'a'.repeat(64) };
  const bodyMutant = scanValue(withPlaintext(bodySample, sentinels[2]), sentinels);
  if (bodyMutant.violations.length === 0) {
    console.error('FAIL the scanner did not catch a plaintext sentinel in a body; it proves nothing');
    process.exitCode = 1;
    return;
  }

  if (result.frames === 0) {
    console.error('FAIL the session produced no WebSocket frames');
    process.exitCode = 1;
    return;
  }
  if (result.bodies === 0) {
    console.error('FAIL the session produced no HTTP request bodies');
    process.exitCode = 1;
    return;
  }
  if (result.violations.length > 0) {
    console.error(`FAIL ${result.violations.length} readable value(s) crossed the wire:`);
    for (const violation of result.violations) {
      console.error(`  - ${violation.path}: ${violation.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`OK no readable value in ${result.leaves} leaves`);
}

main().catch((error) => {
  console.error(`e2e failed: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
