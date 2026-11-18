/**
 * The page's side of presence: one frame type, and one chip.
 *
 * The server speaks presence as `{t:'here', ids:[...]}` — ids only, on a heartbeat. The page has
 * three sockets (host, member and resume) and every one of them must read that frame the same way,
 * so the reading is exported and tested here instead of being three copies that can drift. Two
 * promises are pinned: only a `here` frame moves the chip (an old `presence` frame, a `state` or a
 * `record` must not), and the chip's text for a given id set is exactly what it was before the
 * heartbeats — "Just you here", "2 here · A, B", or nothing at all.
 *
 * No jsdom and no browser: `public/app.js` is a plain ES module whose DOM wiring sits behind a
 * guard, so node can import it and test the pure rules.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

import { presenceChip, presenceIds, presenceText, renderPresenceChip } from '../public/app.js';
import { avatarFor } from '../public/crypto.js';

test('the page reads ids from a here frame and from no other frame', () => {
  assert.deepEqual([...presenceIds({ t: 'here', ids: ['a', 'b'] })], ['a', 'b']);

  /* Ids only: anything that is not a string is not an id, and does not reach the chip. */
  assert.deepEqual([...presenceIds({ t: 'here', ids: ['a', 42, null, { id: 'b' }] })], ['a']);

  /* The frame this replaced, and every other frame the page handles: none of them is presence. */
  for (const frame of [
    { t: 'presence', here: ['a'] },
    { t: 'state', roster: [] },
    { t: 'record', id: 'r' },
    { t: 'refused', code: 'wiping' },
    { t: 'ended' },
    { t: 'here' },
    { t: 'here', ids: 'a' },
    {},
    null,
    undefined,
    'here',
    42
  ]) {
    assert.equal(
      presenceIds(frame),
      null,
      `${JSON.stringify(frame) ?? String(frame)} is not a here frame`
    );
  }
});

test('the presence chip is unchanged for a given id set', () => {
  const names = new Map([
    ['a', 'Asha'],
    ['b', 'Balan'],
    ['c', 'Chitra']
  ]);
  const label = (id) => names.get(id) ?? 'Someone';

  assert.equal(presenceText(new Set(), 'a', label), '', 'nobody here is no chip at all');
  assert.equal(presenceText(new Set(['a']), 'a', label), 'Just you here');
  assert.equal(
    presenceText(new Set(['a']), 'b', label),
    '1 here · Asha',
    'one other person is named, not "just you"'
  );
  assert.equal(presenceText(new Set(['a', 'b']), 'a', label), '2 here · Asha, Balan');
  assert.equal(
    presenceText(new Set(['a', 'b', 'c']), 'c', label),
    '3 here · Asha, Balan, Chitra',
    'the label is the chip\'s only name source'
  );
});

test('the chip is hidden with empty text exactly when the text is empty', () => {
  /* The one text that hides the chip: nothing to say is nothing to show. */
  assert.deepEqual(presenceChip(''), { hidden: true, text: '' });

  /* Every other text is shown as it is, including one that is only whitespace: emptiness is the
     exact empty string, not a trimmed or coerced one. */
  for (const text of ['Just you here', '1 here · Asha', '2 here · Asha, Balan', ' ']) {
    assert.deepEqual(presenceChip(text), { hidden: false, text }, `${JSON.stringify(text)} is shown`);
  }
});

/* ---------------------------------------------------------------------- the chip's avatars */

/*
 * A chip is drawn into whatever `doc` and `element` it is handed, so these tests need no jsdom: the
 * stand-ins below record every node the render creates and every attribute it writes. What the
 * render may not do is as much the subject as what it must: it may not fetch, it may not turn a
 * name into markup, and it may not widen the page.
 */

const PEOPLE = new Map([
  ['a', 'Asha'],
  ['b', 'Balan'],
  ['c', 'Chitra']
]);
const labelOf = (id) => PEOPLE.get(id) ?? 'Someone';
const nameOf = (id) => PEOPLE.get(id) ?? '';

/** A `document` that makes nodes and remembers them; `innerHTML` is a write the tests can see. */
function fakeDoc() {
  const created = [];
  const doc = {
    createElement(tagName) {
      const node = {
        tagName,
        className: '',
        style: {},
        attributes: {},
        children: [],
        textContent: '',
        setAttribute(name, value) {
          node.attributes[name] = String(value);
        },
        getAttribute(name) {
          return Object.hasOwn(node.attributes, name) ? node.attributes[name] : null;
        },
        append(...nodes) {
          node.children.push(...nodes);
        }
      };
      /* A real DOM would *build elements* out of this; recording the write is what lets a test
         refuse it without a browser. */
      Object.defineProperty(node, 'innerHTML', {
        get: () => '',
        set: (value) => {
          node.innerHTMLWrites = [...(node.innerHTMLWrites ?? []), String(value)];
        }
      });
      created.push(node);
      return node;
    }
  };
  return { doc, created };
}

/** The chip element as index.html declares it: a live region that starts hidden and empty. */
function fakeChip() {
  const element = {
    hidden: true,
    children: [],
    attributes: { role: 'status' },
    writes: [],
    textContent: '',
    setAttribute(name, value) {
      element.attributes[name] = String(value);
      element.writes.push(name);
    },
    removeAttribute(name) {
      delete element.attributes[name];
      element.writes.push(name);
    },
    append(...nodes) {
      element.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      element.children = [...nodes];
    }
  };
  return element;
}

function renderChip(ids, selfId = 'a') {
  const { doc, created } = fakeDoc();
  const element = fakeChip();
  const result = renderPresenceChip(doc, element, ids, selfId, labelOf, nameOf);
  return { element, created, result };
}

const facesOf = (element) =>
  element.children.filter((node) => node.className.split(' ').includes('presence-avatar'));

const textOf = (element) => {
  const texts = element.children.filter((node) => node.className === 'presence-text');
  assert.equal(texts.length, 1, 'the chip carries exactly one text span');
  return texts[0].textContent;
};

test('the chip draws one avatar per id, in the order the text names them', () => {
  const { element, created } = renderChip(new Set(['a', 'b', 'c']), 'c');

  assert.equal(element.hidden, false);
  assert.equal(textOf(element), '3 here · Asha, Balan, Chitra');
  assert.deepEqual(
    textOf(element).split(' · ')[1].split(', '),
    ['Asha', 'Balan', 'Chitra'],
    'the text names the people in set order'
  );

  const faces = facesOf(element);
  assert.equal(faces.length, 3, 'one avatar for each id the text names');
  assert.deepEqual(
    faces.map((face) => face.style.background),
    ['a', 'b', 'c'].map((id) => avatarFor(id, nameOf(id)).background),
    'each avatar is the one its own id and name name, in the order the text names them'
  );
  assert.deepEqual(
    faces.map((face) => face.style.color),
    ['a', 'b', 'c'].map((id) => avatarFor(id, nameOf(id)).ink)
  );
  assert.deepEqual(
    faces.map((face) => face.textContent),
    ['A', 'B', 'C'],
    'the avatar carries the initial of its name'
  );
  assert.deepEqual(
    faces.map((face) => face.attributes['aria-hidden']),
    ['true', 'true', 'true'],
    'an avatar is decoration: the sentence is what a screen reader reads'
  );
  assert.deepEqual(
    created.map((node) => node.tagName),
    ['span', 'span', 'span', 'span'],
    'every node the chip draws is a span'
  );

  /* Set order, not insertion-by-name: a set built the other way is drawn the other way, so the
     order above is the set's and not an accident of the fixture. */
  const reversed = ['c', 'b', 'a'];
  const { element: other } = renderChip(new Set(reversed), 'a');
  assert.equal(textOf(other), '3 here · Chitra, Balan, Asha');
  assert.deepEqual(
    facesOf(other).map((face) => face.style.background),
    reversed.map((id) => avatarFor(id, nameOf(id)).background)
  );

  /* One person, and that person is the viewer: one avatar, and the copy this page always showed. */
  const { element: alone } = renderChip(new Set(['a']), 'a');
  assert.equal(textOf(alone), 'Just you here');
  assert.equal(facesOf(alone).length, 1);
});

test('an avatar leaves with its id, and an empty set leaves none', () => {
  const { doc } = fakeDoc();
  const element = fakeChip();

  renderPresenceChip(doc, element, new Set(['a', 'b']), 'b', labelOf, nameOf);
  assert.deepEqual(
    facesOf(element).map((face) => face.style.background),
    ['a', 'b'].map((id) => avatarFor(id, nameOf(id)).background)
  );

  renderPresenceChip(doc, element, new Set(['a']), 'b', labelOf, nameOf);
  assert.deepEqual(
    facesOf(element).map((face) => face.style.background),
    [avatarFor('a', 'Asha').background],
    'the avatar that left is not left behind'
  );
  assert.equal(textOf(element), '1 here · Asha');

  /* Drawing the same frame twice draws one chip, not two. */
  renderPresenceChip(doc, element, new Set(['a']), 'b', labelOf, nameOf);
  assert.equal(facesOf(element).length, 1);
  assert.equal(element.children.length, 2, 'one avatar and one text span');

  const result = renderPresenceChip(doc, element, new Set(), 'b', labelOf, nameOf);
  assert.deepEqual(result, { hidden: true, text: '' });
  assert.equal(element.hidden, true, 'nobody here is no chip at all');
  assert.deepEqual(element.children, [], 'and no avatar to go with it');
});

test('member names are literal text and never markup', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const { doc, created } = fakeDoc();
  const element = fakeChip();

  /* Not the viewer's own id, so the name reaches the chip's text as well as its avatar. */
  renderPresenceChip(doc, element, new Set(['a']), 'b', () => hostile, () => hostile);

  assert.deepEqual(
    created.map((node) => node.tagName),
    ['span', 'span'],
    'a name never becomes an element of its own'
  );
  assert.ok(
    textOf(element).includes(hostile),
    'the name is in the chip as the characters that were typed'
  );
  assert.equal(facesOf(element)[0].textContent, '<', 'the initial is the first code point, not a tag');

  for (const node of created) {
    assert.equal(node.innerHTMLWrites, undefined, 'a name is never written as HTML');
    assert.ok(!Object.keys(node.attributes).includes('onerror'), 'a name never becomes an attribute');
  }
});

test('drawing the chip makes no request', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args);
    return Promise.reject(new Error('no network in a render'));
  };

  try {
    const { element, created } = renderChip(new Set(['a', 'b']), 'a');
    assert.equal(textOf(element), '2 here · Asha, Balan', 'the chip did draw');

    assert.equal(calls.length, 0, 'rendering a chip fetches nothing');
    for (const node of created) {
      assert.deepEqual(
        Object.keys(node.attributes).filter((name) => ['src', 'href', 'srcset'].includes(name)),
        [],
        'nothing the chip draws points anywhere'
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the chip keeps its live region and its accessible name is its text', () => {
  const { doc } = fakeDoc();
  const element = fakeChip();
  assert.equal(element.attributes.role, 'status', 'the fixture is the live region index.html declares');

  renderPresenceChip(doc, element, new Set(['a', 'b']), 'a', labelOf, nameOf);

  assert.equal(element.attributes.role, 'status', 'the live region is still the chip');
  assert.deepEqual(element.writes, [], 'the render writes no attribute of the chip itself');

  const spoken = element.children
    .filter((node) => node.attributes['aria-hidden'] !== 'true')
    .map((node) => node.textContent)
    .join('');
  assert.equal(spoken, textOf(element));
  assert.equal(spoken, '2 here · Asha, Balan', 'the accessible name is the sentence, not a run of initials');
  assert.ok(
    facesOf(element).every((face) => face.attributes['aria-hidden'] === 'true'),
    'every avatar is out of the accessible name'
  );
});

/** Every `.send(...)` argument in a module, as text, matched to its own closing paren. */
function sendPayloads(text) {
  const payloads = [];
  for (const match of text.matchAll(/\.send\s*\(/g)) {
    let depth = 1;
    let at = match.index + match[0].length;
    const start = at;
    while (at < text.length && depth > 0) {
      if (text[at] === '(') depth += 1;
      else if (text[at] === ')') depth -= 1;
      at += 1;
    }
    payloads.push(text.slice(start, at - 1));
  }
  return payloads;
}

test('the page sends no presence frame and no avatar value', () => {
  const dir = new URL('../public/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 5, `the scan reads the page modules, found ${files.length}`);

  const payloads = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    payloads.push(...sendPayloads(text).map((payload) => `${file}: ${payload.replace(/\s+/g, ' ')}`));
  }
  assert.ok(payloads.length >= 8, `the page does send frames, found ${payloads.length}`);

  const banned = [];
  for (const payload of payloads) {
    /* Presence is the server's frame: the page reads it and never writes one. */
    if (/['"](?:here|presence)['"]/.test(payload)) banned.push(payload);
    /* An avatar is the page's own drawing: its fields never travel. */
    if (/\b(?:avatar|shape|background|ink)\b/.test(payload)) banned.push(payload);
  }
  assert.deepEqual(banned, [], 'no frame carries presence or an avatar');
});

/** The declarations of one top-level rule, whitespace flattened. */
function cssRule(css, selector) {
  const pattern = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const match = css.match(pattern);
  assert.ok(match, `style.css has a ${selector} rule`);
  return match[1].replace(/\s+/g, ' ').trim();
}

test('the chip wraps at phone width and never sets a fixed width', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  const chip = cssRule(css, '.presence');
  assert.match(chip, /flex-wrap:\s*wrap/, 'a long row wraps instead of running off the page');
  assert.match(chip, /max-width:\s*100%/, 'the chip stays inside the column it sits in');
  assert.equal(/(?:^|; )width\s*:/.test(chip), false, 'the chip itself has no fixed width');
  assert.equal(/white-space:\s*nowrap/.test(chip), false, 'nothing in the chip is held on one line');

  const text = cssRule(css, '.presence-text');
  assert.match(text, /min-width:\s*0/, 'the text may shrink below its longest unbroken word');
  assert.match(text, /overflow-wrap:\s*anywhere/, 'a long name breaks instead of widening the page');
  assert.equal(/white-space:\s*nowrap/.test(text), false);

  const avatar = cssRule(css, '.presence-avatar');
  assert.match(avatar, /(?:flex:\s*none|flex-shrink:\s*0)/, 'an avatar keeps its size while the text wraps');

  /* Every shape the hash can draw has a rule, so a shape is a shape and not a class that does
     nothing. */
  const shapes = new Set(
    Array.from({ length: 200 }, (_, at) => avatarFor(`member-${at}`, 'Asha').shape)
  );
  assert.ok(shapes.size >= 4, `the hash draws several shapes, found ${shapes.size}`);
  for (const shape of shapes) cssRule(css, `.presence-avatar-${shape}`);
});
