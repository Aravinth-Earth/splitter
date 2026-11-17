/**
 * The page's lifecycle frames, without a browser.
 *
 * A group's end is announced with a frame, and a wipe that stopped part-way is announced with a
 * different one. The page has three sockets — host, member and resume — and every one of them has to
 * read those frames the same way, so the reading is one exported function rather than three copies
 * that can drift. Two promises are pinned here. An end leaves the group; a failed wipe does not,
 * because the socket is still attached, so navigating away would tell the person their group ended
 * when it did not. And the copy is checked for what it may not claim: a failed wipe deletes the keys
 * before the meta, so the records may already be gone and the message must not imply they are not.
 *
 * A wipe in progress refuses writes with a `refused` frame carrying the code `wiping`. That is not a
 * judgement about the write and not the group's end, so it is read the same way as the failed wipe:
 * the socket and the group view stay, and the status line says the group is being deleted.
 *
 * No jsdom and no browser: `public/app.js` is a plain ES module whose DOM wiring sits behind a
 * guard, so node can import it and test the rules that decide what a frame means.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WIPE_FAILED_MESSAGE,
  WIPING_MESSAGE,
  isWipingRefusal,
  lifecycleFrameOutcome
} from '../public/app.js';

test('a wipe that failed keeps the group on screen and does not claim the data survived', () => {
  assert.equal(lifecycleFrameOutcome({ t: 'wipe-failed' }), 'stay', 'the group view is not left');

  assert.match(WIPE_FAILED_MESSAGE, /delete failed/i, 'the copy names the failed delete');
  assert.match(WIPE_FAILED_MESSAGE, /still exists/i, 'and says the group is still there');
  assert.match(
    WIPE_FAILED_MESSAGE,
    /some or all of its data may be gone/i,
    'and does not overpromise: the keys go before the meta, so the records may already be deleted'
  );
  assert.match(WIPE_FAILED_MESSAGE, /try again/i, 'and says what to do about it');
  assert.doesNotMatch(
    WIPE_FAILED_MESSAGE,
    /still open/i,
    'a half-wiped group is not "still open": it can exist with nothing in it'
  );
  assert.ok(
    WIPE_FAILED_MESSAGE.length <= 120,
    'the message is one status line, not a paragraph over the group'
  );
});

test('a refusal that says the group is being wiped keeps the socket and the group view', () => {
  assert.equal(
    isWipingRefusal({ t: 'refused', code: 'wiping' }),
    true,
    'the refusal the server sends mid-wipe is handled, not read as an end'
  );

  assert.match(WIPING_MESSAGE, /being deleted/i, 'the copy says the group is going');
  assert.match(WIPING_MESSAGE, /try again/i, 'and that a later attempt can work');
  assert.ok(WIPING_MESSAGE.length <= 120, 'it is a status line, not a paragraph');

  /* Every other refusal, and every other frame, is somebody else's answer. */
  for (const frame of [
    { t: 'refused', code: 'not_host' },
    { t: 'refused', code: 'unknown_group' },
    { t: 'refused' },
    { t: 'wipe-failed' },
    { t: 'ended' },
    {},
    null,
    undefined,
    'wiping',
    42
  ]) {
    assert.equal(
      isWipingRefusal(frame),
      false,
      `${JSON.stringify(frame) ?? String(frame)} is not a wiping refusal`
    );
  }
});

test('an ended frame still leaves the group, and every other frame changes nothing', () => {
  assert.equal(lifecycleFrameOutcome({ t: 'ended' }), 'leave', 'the end frame is the one that leaves');

  for (const frame of [
    { t: 'state' },
    { t: 'record' },
    { t: 'presence' },
    { t: 'conflict' },
    { t: 'left' },
    { t: 'refused', code: 'not_host' },
    {}
  ]) {
    assert.equal(
      lifecycleFrameOutcome(frame),
      null,
      `${frame.t ?? 'an empty frame'} must not move the page`
    );
  }
});

test('a frame that is not an object changes nothing and throws nothing', () => {
  for (const frame of [null, undefined, 'ended', 42, [], ['ended']]) {
    assert.equal(
      lifecycleFrameOutcome(frame),
      null,
      `${JSON.stringify(frame) ?? String(frame)} is not a frame`
    );
  }
});
