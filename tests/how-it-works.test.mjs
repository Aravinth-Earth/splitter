/**
 * The page's account of its own trust model, read as a claim about the code.
 *
 * The failure this file exists for: the page once said "no data sent anywhere" while loading a CDN
 * and an analytics script, and later stated three of the five limits a reader has to know. Copy is
 * a claim about behaviour, so every sentence the panel makes is pinned to the thing it describes:
 * the code is the key (crypto.js), the organizer approves (group.js `joinMode`), the server holds
 * ids, sealed blobs and timestamps (group.js `open`/`put`), the code never travels (wire.js), the
 * cache is readable by whoever can reach the browser (cache.js plus store.js's sessionStorage
 * code), Cloudflare is the only copy (no other storage anywhere), and there are no accounts
 * (store.js has no credential for a server to name).
 *
 * Three habits are load-bearing. Every absence claim is preceded by a presence count, so a panel
 * that renders nothing cannot pass. Reachability is asserted as an `<a href="#how-it-works">`
 * inside both screens the acceptance criteria name, because a button would need a listener and
 * therefore would not survive a load with no script. And the banned-copy guard is run twice, once
 * over the real assets and once over a copy with the lie appended, so a guard that inspects
 * nothing cannot pass by passing.
 *
 * What this file cannot see is pixels and a real navigation: the anchor scroll and the panel's
 * paint need the browser harness (scripts/e2e, still an open work item).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageSource = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const shellSource = readFileSync(join(root, 'public', 'sw.js'), 'utf8');

/* --------------------------------------------------------------- reading html */

/** The source of one `<section id="...">`, to its matching close tag, or null. */
function sectionSource(source, id) {
  const opener = new RegExp(`<section\\b[^>]*\\bid="${id}"[^>]*>`, 'i').exec(source);
  if (!opener) return null;
  const start = opener.index;
  const tags = /<(\/?)section\b[^>]*>/gi;
  tags.lastIndex = opener.index + opener[0].length;
  let depth = 1;
  let match;
  while ((match = tags.exec(source))) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return source.slice(start, tags.lastIndex);
  }
  return null;
}

const ENTITIES = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&nbsp;', ' '],
  ['&mdash;', '—'],
  ['&ndash;', '–'],
  ['&hellip;', '…'],
  ['&rsquo;', '’']
]);

/** What a reader sees: tags gone, entities decoded, whitespace collapsed. */
function readableText(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES.get(entity.toLowerCase()) ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

function flatten(source) {
  return readableText(source).toLowerCase();
}

/** The children of the one list with this id, as raw `<li>` sources. */
function listItems(source, id) {
  const opener = new RegExp(`<ul\\b[^>]*\\bid="${id}"[^>]*>`, 'i').exec(source);
  if (!opener) return [];
  const body = source.slice(opener.index + opener[0].length);
  const close = body.search(/<\/ul>/i);
  const list = close === -1 ? body : body.slice(0, close);
  return [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => match[1]);
}

const panel = sectionSource(pageSource, 'how-it-works');

/* ------------------------------------------------------------- the four facts */

test('the panel exists and reaches a reader as text', () => {
  assert.ok(panel, 'index.html must carry a <section id="how-it-works">');
  assert.match(panel, /<h2\b[^>]*id="how-title"[^>]*>\s*How this works\s*<\/h2>/i);

  const text = flatten(panel);
  assert.ok(text.length > 500, `the panel must carry an explanation, not a heading, read ${text.length} characters`);
});

test('it states the code is the key, made in the browser and never sent', () => {
  const text = flatten(panel);

  assert.match(text, /the code is the key/, 'the panel must open with what the code is');
  assert.match(text, /(in|by) (this|your) browser/, 'the key must be described as made here, not by the server');
  assert.match(
    text,
    /code (?:itself )?is never (?:sent|shared)|code (?:itself )?never (?:leaves|reaches|travels)/,
    'the panel must say the code does not travel'
  );
  /* The one request the page does make, so the sentence cannot be read as "nothing is sent". */
  assert.match(
    text,
    /(sealed|hash)/,
    'the panel must name what does travel: a hash and sealed blobs'
  );
});

test('it states that the organizer approves who joins', () => {
  const text = flatten(panel);

  assert.match(text, /organizer/, 'the panel must name the organizer');
  assert.match(
    text,
    /organizer (?:decides|approves|lets|lets each)/,
    'the panel must say the organizer decides who is in'
  );
  /* group.js has two join modes, and a flat "the organizer approves" would be false in open mode. */
  assert.match(text, /approv/, 'approval must be named');
  assert.match(text, /open/, 'open joining must be named, because a group can be switched to it');
});

test('it names what the server holds: ids, ciphertext and timestamps', () => {
  const text = flatten(panel);

  assert.match(text, /\bmember ids\b/, 'the panel must name the ids the server keeps');
  assert.match(text, /\bgroup id\b/, 'the panel must name the group id');
  assert.match(text, /ciphertext|sealed/, 'the panel must name the sealed blobs');
  assert.match(text, /timestamps?\b|\bwhen\b/, 'the panel must name the times the server keeps');
  /* group.js stamps three: `createdAt` at init, `joinedAt` per member, and `at` on every write. */
  assert.match(text, /group was made/, 'the panel must name the time the group was made');
  assert.match(text, /asked to join|joined/, 'the panel must name the time a person asked to join');
  assert.match(text, /write arrived|wrote/, 'the panel must name the time of a write');

  for (const mentioned of ['group name', 'amount']) {
    assert.ok(text.includes(mentioned), `the panel must say the server cannot read the ${mentioned}`);
  }
  assert.match(text, /cannot read|never (sees|learns)/, 'the negation must be stated, not implied');
});

/* ------------------------------------------------------------- the five limits */

test('it names exactly the five limits the trust model has', () => {
  const limits = listItems(panel ?? '', 'how-limits');
  assert.equal(limits.length, 5, `the panel must name five limits as separate items, found ${limits.length}`);

  const items = limits.map((item) => flatten(item)).join('\n');

  assert.match(items, /code.*cannot be revoked|cannot be revoked.*code/, 'limit 1: a leaked code cannot be revoked');
  assert.match(items, /withhold/, 'limit 2: the server can withhold a write');
  assert.match(items, /replay/, 'limit 2: the server can replay an older state');
  assert.match(items, /never saw|has not seen|newer version/, 'limit 2: ... to a device that never saw the newer version');
  assert.match(items, /not encrypted|plaintext/, 'limit 3: what this browser keeps is readable');
  assert.match(items, /cache|local storage|this browser/, 'limit 3 must name the local copy');
  assert.match(items, /cloudflare/, 'limit 4: the only copy is on Cloudflare');
  assert.match(items, /only copy/, 'limit 4 must say it plainly');
  assert.match(items, /no accounts/, 'limit 5: there are no accounts');
  assert.match(items, /recover/, 'limit 5: nothing can be recovered');

  /* Every limit is one sentence or more, not a keyword, so a scan for these words cannot pass on
     a list that says nothing. */
  for (const item of limits) {
    const words = flatten(item).split(/\s+/).filter(Boolean);
    assert.ok(words.length >= 12, `each limit must be explained, found ${words.length} words in: ${flatten(item)}`);
  }
});

/* ---------------------------------------------------------- reachable, offline */

test('the panel is reachable from the landing form and from the group screen', () => {
  const landing = sectionSource(pageSource, 'create-panel');
  const group = sectionSource(pageSource, 'group-header');
  assert.ok(landing, 'the page must still carry the landing form');
  assert.ok(group, 'the page must still carry the group screen');

  const linkIn = (source, where) => {
    const links = [...source.matchAll(/<a\b[^>]*href="#how-it-works"[^>]*>([\s\S]*?)<\/a>/gi)];
    assert.equal(links.length, 1, `${where} must offer exactly one link to the panel, found ${links.length}`);
    assert.ok(readableText(links[0][1]).length > 0, `${where} link must have a label`);
    assert.match(readableText(links[0][1]).toLowerCase(), /how this works/, `${where} link must say what it opens`);
  };

  linkIn(landing, 'the landing form');
  linkIn(group, 'the group screen');
});

test('the panel needs no script and no network to be read', () => {
  assert.ok(panel, 'the panel must exist to be read offline');
  assert.equal(/<script\b/i.test(panel), false, 'the panel must be static markup, not built by a script');
  assert.equal(/\b(?:src|srcset)\s*=/i.test(panel), false, 'the panel must fetch no resource');
  assert.equal(/<img\b|<iframe\b|<link\b/i.test(panel), false, 'the panel must carry no external asset');

  /* The shell is what makes an offline load possible at all; the page it caches is the one with
     the panel in it. */
  const shell = shellSource.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(shell, 'sw.js must declare the shell it keeps');
  assert.match(shell[1], /(^|[\s,])'\/'/, "the shell must cache the page itself, so the panel arrives with it");
});

test('the panel is not a modal and does not take focus on load', () => {
  assert.match(panel, /^<section\b/, 'the panel must be a plain section');
  assert.equal(/role\s*=\s*"dialog"/i.test(panel), false, 'the panel must not be a dialog');
  assert.equal(/aria-modal/i.test(panel), false, 'the panel must not be modal');
  assert.equal(/\bautofocus\b/i.test(panel), false, 'nothing in the panel may take focus on load');
  assert.equal(/\btabindex="-1"/i.test(panel), false, 'nothing in the panel may be a focus target');
  assert.match(panel, /^<section\b[^>]*class="[^"]*\bpanel\b/, 'the panel is a panel on the page, in the flow');

  /* A `<details>` that starts closed would hide the sentences a reader is owed; the panel is
     open text. */
  assert.equal(/<details\b/i.test(panel), false, 'the panel must not be collapsed behind a disclosure');
  assert.equal(/\bhidden\b/i.test(panel.slice(0, panel.indexOf('>'))), false, 'the panel must paint on load');
});

/* ------------------------------------------------------------- copy accuracy */

const LIES = [
  'no data sent anywhere',
  'no data ever leaves',
  'only ever holds ciphertext',
  'nothing is sent to the server'
];

test('no sentence on the page claims the app sends nothing', () => {
  const flat = pageSource.toLowerCase().replace(/\s+/g, ' ');
  for (const lie of LIES) {
    assert.equal(flat.includes(lie), false, `the page must not say "${lie}": ciphertext goes to the Worker`);
  }
});

test('the display name is described as sealed, not as never sent', () => {
  /* The name travels inside a sealed blob, so "not sent to the server" would be false. "Not sent
     as text" is the true sentence — but a substring scan cannot tell the two apart, so this test
     reads what follows the phrase and demands the qualifier. */
  const flat = pageSource.toLowerCase().replace(/\s+/g, ' ');
  const occurrences = [...flat.matchAll(/it is not sent to the server([^.<]*)/g)].map((match) => match[1].trim());
  assert.ok(occurrences.length >= 1, 'the page must still say how the name is kept out of reach');
  for (const rest of occurrences) {
    assert.match(rest, /^as text/i, `"it is not sent to the server ${rest}" denies a request the page does make`);
  }

  const hintFor = (id) => flatten(new RegExp(`<p\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)</p>`, 'i').exec(pageSource)?.[1] ?? '');
  assert.match(hintFor('display-name-help'), /sealed|as text/, 'the create form must say how the name travels');
  assert.match(hintFor('join-name-help'), /as text/, 'the join form must say the name is not sent as text');
});

/* --------------------------------------------------------------- the guard */

function copyRepo() {
  const directory = mkdtempSync(join(tmpdir(), 'splitter-check-'));
  cpSync(join(root, 'scripts'), join(directory, 'scripts'), { recursive: true });
  cpSync(join(root, 'public'), join(directory, 'public'), { recursive: true });
  cpSync(join(root, 'wrangler.toml'), join(directory, 'wrangler.toml'));
  return directory;
}

function runCheck(directory) {
  try {
    const stdout = execFileSync(process.execPath, [join(directory, 'scripts', 'check.mjs')], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('npm run check passes on the shipped assets', () => {
  const directory = copyRepo();
  try {
    const result = runCheck(directory);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /check passed/, 'the guard must report what it scanned');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('npm run check fails on a page that claims nothing is sent', () => {
  const directory = copyRepo();
  try {
    const page = join(directory, 'public', 'index.html');
    writeFileSync(page, readFileSync(page, 'utf8').replace('</main>', '<p>No data sent anywhere.</p></main>'));
    const result = runCheck(directory);
    assert.notEqual(result.status, 0, 'the guard must refuse the lie, not print a pass');
    assert.match(result.output, /no data sent anywhere/, 'the refusal must name the phrase it found');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
