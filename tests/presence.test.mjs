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

import { presenceChip, presenceIds, presenceText } from '../public/app.js';

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
