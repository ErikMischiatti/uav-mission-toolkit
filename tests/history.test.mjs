/**
 * The shared undo/redo history.
 *
 * This is the one module in the toolkit whose bugs are silent: a history that
 * restores *almost* the right document, or that lets undo walk back into a file
 * the user has already closed, produces plausible-looking data. So the rules
 * are pinned down here rather than left to each tool.
 */

import { DEFAULT_HISTORY_LIMIT, History } from '../shared/js/history.js';
import { assert, assertThrowsWith, describe } from './harness.mjs';

/** A document shaped like the ones the tools actually edit. */
const doc = (name, points = []) => ({ name, points: points.map((p) => ({ ...p })) });

describe('history: the basics', (test) => {
  test('a fresh history can do nothing', () => {
    const history = new History();
    assert.equal(history.canUndo(), false);
    assert.equal(history.canRedo(), false);
    assert.equal(history.undo(), null);
    assert.equal(history.redo(), null);
    assert.equal(history.current(), null);
    assert.equal(history.depth(), 0);
  });

  test('a baseline alone is not undoable: there is nothing behind it', () => {
    const history = new History();
    history.reset(doc('a'));
    assert.equal(history.canUndo(), false);
    assert.equal(history.canRedo(), false);
    assert.deepEqual(history.current(), doc('a'));
  });

  test('undo returns the previous state and redo returns the next one', () => {
    const history = new History();
    history.reset(doc('a'));
    history.push(doc('b'), 'Edit b');
    history.push(doc('c'), 'Edit c');

    assert.equal(history.canUndo(), true);
    assert.deepEqual(history.undo(), doc('b'));
    assert.deepEqual(history.undo(), doc('a'));
    assert.equal(history.undo(), null, 'cannot undo past the baseline');

    assert.deepEqual(history.redo(), doc('b'));
    assert.deepEqual(history.redo(), doc('c'));
    assert.equal(history.redo(), null, 'cannot redo past the newest state');
  });

  test('the first push with no baseline becomes the baseline', () => {
    const history = new History();
    history.push(doc('a'), 'Edit');
    assert.deepEqual(history.current(), doc('a'));
    assert.equal(history.canUndo(), false);
  });

  test('an entry without a label is refused', () => {
    const history = new History();
    history.reset(doc('a'));
    assertThrowsWith(() => history.push(doc('b'), ''), 'non-empty label');
    assertThrowsWith(() => history.push(doc('b')), 'non-empty label');
  });

  test('a nonsensical limit is refused at construction', () => {
    assertThrowsWith(() => new History({ limit: 0 }), 'positive integer');
    assertThrowsWith(() => new History({ limit: -3 }), 'positive integer');
    assertThrowsWith(() => new History({ limit: 2.5 }), 'positive integer');
  });
});

describe('history: isolation from the live document', (test) => {
  test('a state is copied on the way in, so later mutation cannot rewrite the past', () => {
    const history = new History();
    const live = doc('a', [{ east_m: 0 }]);
    history.reset(live);
    history.push(doc('b', [{ east_m: 1 }]), 'Move');

    live.points[0].east_m = 999;
    live.name = 'mutated';

    assert.deepEqual(history.undo(), doc('a', [{ east_m: 0 }]));
  });

  test('a state is copied on the way out, so editing the result cannot corrupt history', () => {
    const history = new History();
    history.reset(doc('a', [{ east_m: 0 }]));
    history.push(doc('b'), 'Edit');

    const restored = history.undo();
    restored.points[0].east_m = 999;

    history.redo();
    assert.deepEqual(history.undo(), doc('a', [{ east_m: 0 }]));
  });
});

describe('history: the redo branch', (test) => {
  test('a new edit after an undo discards the redo branch', () => {
    const history = new History();
    history.reset(doc('a'));
    history.push(doc('b'), 'Edit b');
    history.push(doc('c'), 'Edit c');

    history.undo(); // back at b
    assert.equal(history.canRedo(), true);

    history.push(doc('d'), 'Edit d');
    assert.equal(history.canRedo(), false, 'c is now unreachable');
    assert.deepEqual(history.undo(), doc('b'));
    assert.deepEqual(history.redo(), doc('d'));
  });

  test('undoing to the baseline and editing again still leaves one undo', () => {
    const history = new History();
    history.reset(doc('a'));
    history.push(doc('b'), 'Edit b');
    history.undo();
    history.push(doc('c'), 'Edit c');
    assert.equal(history.canUndo(), true);
    assert.deepEqual(history.undo(), doc('a'));
  });
});

describe('history: coalescing a drag into one operation', (test) => {
  test('consecutive pushes with the same key collapse into a single entry', () => {
    const history = new History();
    history.reset(doc('start'));
    for (let i = 1; i <= 25; i += 1) {
      history.push(doc(`drag-${i}`), 'Move control point', { coalesceKey: 'drag:point:3' });
    }
    assert.equal(history.depth(), 1, 'a whole drag is one undoable operation');
    assert.deepEqual(history.current(), doc('drag-25'), 'and it keeps the final position');
    assert.deepEqual(history.undo(), doc('start'));
  });

  test('a different key starts a new entry', () => {
    const history = new History();
    history.reset(doc('start'));
    history.push(doc('a'), 'Move', { coalesceKey: 'drag:point:1' });
    history.push(doc('b'), 'Move', { coalesceKey: 'drag:point:2' });
    assert.equal(history.depth(), 2, 'dragging a second point is a second operation');
  });

  test('an unkeyed push after a keyed one starts a new entry', () => {
    const history = new History();
    history.reset(doc('start'));
    history.push(doc('a'), 'Move', { coalesceKey: 'drag:point:1' });
    history.push(doc('b'), 'Add point');
    assert.equal(history.depth(), 2);
    assert.deepEqual(history.labels(), ['Loaded', 'Move', 'Add point']);
  });

  test('coalescing never swallows the baseline', () => {
    const history = new History();
    history.reset(doc('start'), 'Loaded');
    history.push(doc('a'), 'Type', { coalesceKey: 'name' });
    history.push(doc('b'), 'Type', { coalesceKey: 'name' });
    assert.deepEqual(history.undo(), doc('start'), 'the loaded document is still reachable');
  });

  test('resuming the same key after an intervening operation does not merge across it', () => {
    const history = new History();
    history.reset(doc('start'));
    history.push(doc('a'), 'Type', { coalesceKey: 'name' });
    history.push(doc('b'), 'Add point');
    history.push(doc('c'), 'Type', { coalesceKey: 'name' });
    assert.equal(history.depth(), 3);
  });
});

describe('history: bounds', (test) => {
  test('the number of undoable operations is capped', () => {
    const history = new History({ limit: 5 });
    history.reset(doc('base'));
    for (let i = 1; i <= 20; i += 1) history.push(doc(`s${i}`), `Edit ${i}`);

    assert.equal(history.depth(), 5);
    for (let i = 0; i < 5; i += 1) history.undo();
    assert.equal(history.canUndo(), false);
    assert.deepEqual(history.current(), doc('s15'), 'the oldest states were dropped, not the newest');
  });

  test('the cap does not break the pointer: redo still walks forward correctly', () => {
    const history = new History({ limit: 3 });
    history.reset(doc('base'));
    for (let i = 1; i <= 10; i += 1) history.push(doc(`s${i}`), `Edit ${i}`);
    history.undo();
    history.undo();
    assert.deepEqual(history.current(), doc('s8'));
    assert.deepEqual(history.redo(), doc('s9'));
    assert.deepEqual(history.redo(), doc('s10'));
    assert.equal(history.canRedo(), false);
  });

  test('the default cap is a real number, not unbounded', () => {
    assert.ok(Number.isInteger(DEFAULT_HISTORY_LIMIT) && DEFAULT_HISTORY_LIMIT > 0);
    assert.ok(DEFAULT_HISTORY_LIMIT <= 500, 'an unbounded-in-practice cap defeats the point');
  });
});

describe('history: documents do not bleed into each other', (test) => {
  test('loading a new document makes the previous one unreachable', () => {
    const history = new History();
    history.reset(doc('site-a'));
    history.push(doc('site-a-edited'), 'Edit');

    history.reset(doc('site-b'), 'Loaded site B');

    assert.equal(history.canUndo(), false, 'undo must not walk back into the previous file');
    assert.equal(history.canRedo(), false);
    assert.deepEqual(history.current(), doc('site-b'));
    assert.deepEqual(history.labels(), ['Loaded site B']);
  });

  test('clear leaves nothing behind at all', () => {
    const history = new History();
    history.reset(doc('a'));
    history.push(doc('b'), 'Edit');
    history.clear();
    assert.equal(history.current(), null);
    assert.equal(history.canUndo(), false);
    assert.equal(history.canRedo(), false);
  });
});

describe('history: labels and notifications', (test) => {
  test('the labels describe what undo and redo would do', () => {
    const history = new History();
    history.reset(doc('a'));
    history.push(doc('b'), 'Move mission point');
    history.push(doc('c'), 'Add vertex');

    assert.equal(history.undoLabel(), 'Add vertex');
    assert.equal(history.redoLabel(), null);

    history.undo();
    assert.equal(history.undoLabel(), 'Move mission point');
    assert.equal(history.redoLabel(), 'Add vertex');

    history.undo();
    assert.equal(history.undoLabel(), null, 'nothing left to undo');
    assert.equal(history.redoLabel(), 'Move mission point');
  });

  test('subscribers are called immediately and on every change', () => {
    const history = new History();
    const seen = [];
    const unsubscribe = history.subscribe((h) => seen.push([h.canUndo(), h.canRedo()]));

    assert.deepEqual(seen, [[false, false]], 'the subscriber learns the current state at once');

    history.reset(doc('a'));
    history.push(doc('b'), 'Edit');
    history.undo();
    assert.deepEqual(seen.at(-1), [false, true]);

    unsubscribe();
    history.redo();
    assert.equal(seen.length, 4, 'an unsubscribed listener stops being called');
  });
});
