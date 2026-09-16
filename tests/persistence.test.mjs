/**
 * Browser-local draft persistence.
 *
 * Two things are being protected here.
 *
 * The first is that a draft survives a reload *exactly*. A persistence layer
 * that rounds, reorders or "tidies" a document is worse than none, because the
 * damage is silent and lands on mission data. The regression case at the bottom
 * pins one specific origin all the way through a save and a restore.
 *
 * The second is that nothing stored in a browser can take a tool down. Storage
 * throws in ordinary situations - a private window, blocked site data, a full
 * quota - and the stored value itself can be anything at all, because a user
 * can edit it. Every one of those paths is exercised below.
 */

import {
  DraftStore,
  LOAD_STATUS,
  PERSISTENCE_VERSION,
  STORAGE_NAMESPACE,
  debounce,
  looksLikeCanvasView,
  looksLikeMapView,
  looksLikeSiteDocument,
  looksLikeTrajectoryDraft,
  storageKey,
} from '../shared/js/persistence.js';
import { History } from '../shared/js/history.js';
import { validateSite } from '../shared/js/validation.js';
import { demoSite } from './fixtures.mjs';
import { assert, assertClose, assertThrowsWith, describe } from './harness.mjs';

/** A localStorage stand-in. The real one is a browser API; this is its contract. */
class MemoryStorage {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
    this.failOnSet = null;
    this.failOnGet = null;
  }

  getItem(key) {
    if (this.failOnGet) throw new Error(this.failOnGet);
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    if (this.failOnSet) throw new Error(this.failOnSet);
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}

const siteStore = (storage, overrides = {}) =>
  new DraftStore({
    slot: 'site_editor:draft',
    storage,
    accept: looksLikeSiteDocument,
    now: () => '2026-09-16T00:00:00.000Z',
    ...overrides,
  });

describe('persistence: storage keys', (test) => {
  test('a key is namespaced, versioned and names its slot', () => {
    assert.equal(storageKey('site_editor:draft'), 'uav-mission-toolkit:v1:site_editor:draft');
    assert.equal(
      storageKey('trajectory_editor:draft'),
      'uav-mission-toolkit:v1:trajectory_editor:draft'
    );
  });

  test('the version in the key follows the persistence version', () => {
    assert.equal(storageKey('site_editor:draft', 7), 'uav-mission-toolkit:v7:site_editor:draft');
    assert.ok(storageKey('x').startsWith(`${STORAGE_NAMESPACE}:v${PERSISTENCE_VERSION}:`));
  });

  test('a nameless slot is refused rather than producing a bare prefix', () => {
    assertThrowsWith(() => storageKey(''), 'non-empty string');
    assertThrowsWith(() => storageKey(null), 'non-empty string');
  });

  test('a store writes only to its own key', () => {
    const storage = new MemoryStorage();
    siteStore(storage).save({ origin: {} });
    assert.deepEqual([...storage.map.keys()], ['uav-mission-toolkit:v1:site_editor:draft']);
  });

  test('two versions of the same slot cannot overwrite each other', () => {
    const storage = new MemoryStorage();
    siteStore(storage, { version: 1 }).save({ origin: { latitude_deg: 1 } });
    siteStore(storage, { version: 2 }).save({ origin: { latitude_deg: 2 } });
    assert.equal(storage.size, 2);
    assert.equal(siteStore(storage, { version: 1 }).load().document.origin.latitude_deg, 1);
    assert.equal(siteStore(storage, { version: 2 }).load().document.origin.latitude_deg, 2);
  });
});

describe('persistence: save, restore and clear', (test) => {
  test('an empty slot reports empty rather than failing', () => {
    const result = siteStore(new MemoryStorage()).load();
    assert.equal(result.status, LOAD_STATUS.EMPTY);
    assert.equal(result.document, undefined);
  });

  test('a saved document comes back identical', () => {
    const storage = new MemoryStorage();
    const store = siteStore(storage);
    const site = demoSite();

    assert.equal(store.save(site).ok, true);
    const result = store.load();

    assert.equal(result.status, LOAD_STATUS.OK);
    assert.deepEqual(result.document, site, 'a restored draft must equal what was saved');
  });

  test('the envelope records when it was written and any caller metadata', () => {
    const store = siteStore(new MemoryStorage());
    store.save(demoSite(), { sourceLabel: 'examples/demo_site/site.json' });
    const result = store.load();
    assert.equal(result.savedUtc, '2026-09-16T00:00:00.000Z');
    assert.equal(result.meta.sourceLabel, 'examples/demo_site/site.json');
  });

  test('clear removes the draft and leaves the slot empty', () => {
    const storage = new MemoryStorage();
    const store = siteStore(storage);
    store.save(demoSite());
    assert.equal(store.has(), true);

    assert.equal(store.clear().ok, true);
    assert.equal(store.has(), false);
    assert.equal(store.load().status, LOAD_STATUS.EMPTY);
    assert.equal(storage.size, 0);
  });

  test('saving again replaces the previous draft rather than accumulating', () => {
    const storage = new MemoryStorage();
    const store = siteStore(storage);
    store.save({ origin: { latitude_deg: 1 } });
    store.save({ origin: { latitude_deg: 2 } });
    assert.equal(storage.size, 1);
    assert.equal(store.load().document.origin.latitude_deg, 2);
  });

  test('a stored draft is a snapshot: later mutation does not reach it', () => {
    const store = siteStore(new MemoryStorage());
    const site = demoSite();
    store.save(site);
    site.origin.latitude_deg = 99;
    site.mission_points.push({ id: 'added_later' });
    assert.equal(store.load().document.origin.latitude_deg, 48);
    assert.equal(store.load().document.mission_points.length, 4);
  });
});

describe('persistence: nothing stored can break the tool', (test) => {
  test('invalid JSON is reported, not thrown', () => {
    const storage = new MemoryStorage({ 'uav-mission-toolkit:v1:site_editor:draft': '{not json' });
    const result = siteStore(storage).load();
    assert.equal(result.status, LOAD_STATUS.UNREADABLE);
    assert.ok(result.reason.includes('not valid JSON'));
    assert.equal(result.document, undefined, 'nothing is handed back from unreadable data');
  });

  test('a stored value that is not an object is refused', () => {
    for (const raw of ['42', '"a string"', '[1,2,3]', 'null']) {
      const storage = new MemoryStorage({ 'uav-mission-toolkit:v1:site_editor:draft': raw });
      const result = siteStore(storage).load();
      assert.equal(result.status, LOAD_STATUS.UNREADABLE, `raw was ${raw}`);
    }
  });

  test('an envelope from another application is refused', () => {
    const storage = new MemoryStorage({
      'uav-mission-toolkit:v1:site_editor:draft': JSON.stringify({
        namespace: 'some-other-tool',
        persistence_version: 1,
        document: { origin: {} },
      }),
    });
    const result = siteStore(storage).load();
    assert.equal(result.status, LOAD_STATUS.UNREADABLE);
    assert.ok(result.reason.includes('not written by this toolkit'));
  });

  test('a different persistence version is refused and never guessed at', () => {
    const storage = new MemoryStorage({
      'uav-mission-toolkit:v1:site_editor:draft': JSON.stringify({
        namespace: STORAGE_NAMESPACE,
        persistence_version: 99,
        document: demoSite(),
      }),
    });
    const result = siteStore(storage).load();
    assert.equal(result.status, LOAD_STATUS.INCOMPATIBLE);
    assert.equal(result.document, undefined);
    assert.ok(result.reason.includes('99'));
    assert.ok(result.reason.includes('not be guessed at'));
  });

  test('an envelope carrying no document is refused', () => {
    const storage = new MemoryStorage({
      'uav-mission-toolkit:v1:site_editor:draft': JSON.stringify({
        namespace: STORAGE_NAMESPACE,
        persistence_version: 1,
      }),
    });
    assert.equal(siteStore(storage).load().status, LOAD_STATUS.UNREADABLE);
  });

  test('a payload of the wrong kind is refused rather than loaded into the wrong tool', () => {
    const storage = new MemoryStorage();
    // A trajectory draft written into the site slot.
    new DraftStore({ slot: 'site_editor:draft', storage, accept: () => true }).save({
      points: [{ east_m: 0, north_m: 0 }],
      closed: true,
    });
    const result = siteStore(storage).load();
    assert.equal(result.status, LOAD_STATUS.REJECTED);
    assert.ok(result.reason.includes('not the kind of document'));
  });

  test('an accept predicate that throws is a refusal, never a pass', () => {
    const storage = new MemoryStorage();
    siteStore(storage).save(demoSite());
    const store = new DraftStore({
      slot: 'site_editor:draft',
      storage,
      accept: () => {
        throw new Error('predicate exploded');
      },
    });
    const result = store.load();
    assert.equal(result.status, LOAD_STATUS.REJECTED);
    assert.ok(result.reason.includes('predicate exploded'));
  });

  test('unusable storage is reported by every method instead of throwing', () => {
    const store = siteStore(null);
    assert.equal(store.available, false);
    assert.equal(store.load().status, LOAD_STATUS.UNAVAILABLE);
    assert.equal(store.save({ origin: {} }).ok, false);
    assert.equal(store.clear().ok, false);
    assert.equal(store.has(), false);
  });

  test('a storage that throws on read is reported, not propagated', () => {
    const storage = new MemoryStorage();
    storage.failOnGet = 'access denied';
    const result = siteStore(storage).load();
    assert.equal(result.status, LOAD_STATUS.UNAVAILABLE);
    assert.ok(result.reason.includes('access denied'));
  });

  test('a full quota is reported and leaves the previous draft intact', () => {
    const storage = new MemoryStorage();
    const store = siteStore(storage);
    store.save({ origin: { latitude_deg: 1 } });

    storage.failOnSet = 'QuotaExceededError';
    const result = store.save({ origin: { latitude_deg: 2 } });

    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('QuotaExceededError'));
    assert.equal(
      store.load().document.origin.latitude_deg,
      1,
      'a failed save must not also destroy the last good draft'
    );
  });

  test('a document that cannot be serialised is reported, not half-written', () => {
    const storage = new MemoryStorage();
    const cyclic = { origin: {} };
    cyclic.self = cyclic;
    const result = siteStore(storage).save(cyclic);
    assert.equal(result.ok, false);
    assert.equal(storage.size, 0, 'nothing is written when serialisation fails');
  });
});

describe('persistence: what counts as a restorable draft', (test) => {
  test('a site mid-edit is restorable even though it would fail validation', () => {
    // Exactly the state worth recovering: the user cleared an altitude and has
    // not typed the new one yet. Refusing this would throw away the work.
    const site = demoSite();
    site.mission_points[0].altitude_m = null;
    site.safety_area.min_altitude_m = null;

    assert.ok(validateSite(site).some((f) => f.severity === 'error'), 'precondition: invalid site');
    assert.equal(looksLikeSiteDocument(site), true, 'but still restorable');

    const store = siteStore(new MemoryStorage());
    store.save(site);
    const restored = store.load();
    assert.equal(restored.status, LOAD_STATUS.OK);
    assert.equal(restored.document.mission_points[0].altitude_m, null);
    assert.equal(
      restored.document.mission_points[0].altitude_m,
      null,
      'a missing altitude stays missing; nothing is filled in'
    );
  });

  test('the site check is structural, not a second validator', () => {
    assert.equal(looksLikeSiteDocument({ origin: {} }), true);
    assert.equal(looksLikeSiteDocument({ mission_points: [] }), true);
    assert.equal(looksLikeSiteDocument({}), false);
    assert.equal(looksLikeSiteDocument({ points: [], closed: true }), false);
    assert.equal(looksLikeSiteDocument(null), false);
    assert.equal(looksLikeSiteDocument([]), false);
    assert.equal(looksLikeSiteDocument('site'), false);
  });

  test('a trajectory draft is recognised by its editing state', () => {
    assert.equal(looksLikeTrajectoryDraft({ points: [], closed: false }), true);
    assert.equal(looksLikeTrajectoryDraft({ points: [] }), false);
    assert.equal(looksLikeTrajectoryDraft({ closed: true }), false);
    assert.equal(looksLikeTrajectoryDraft(demoSite()), false);
  });

  test('a viewport is only restored when every number is usable', () => {
    assert.equal(looksLikeMapView({ latitude_deg: 50, longitude_deg: 14, zoom: 17 }), true);
    assert.equal(looksLikeMapView({ latitude_deg: 91, longitude_deg: 14, zoom: 17 }), false);
    assert.equal(looksLikeMapView({ latitude_deg: 50, longitude_deg: 14 }), false);
    assert.equal(looksLikeMapView({ latitude_deg: 'x', longitude_deg: 14, zoom: 1 }), false);

    assert.equal(looksLikeCanvasView({ minX: -1, minY: -1, width: 2, height: 2 }), true);
    assert.equal(looksLikeCanvasView({ minX: -1, minY: -1, width: 0, height: 2 }), false);
    assert.equal(looksLikeCanvasView({ minX: -1, minY: -1, width: 2 }), false);
  });
});

describe('persistence: the site document survives a round trip', (test) => {
  test('every field of the demo site is unchanged', () => {
    const store = siteStore(new MemoryStorage());
    const before = demoSite();
    store.save(before);
    const after = store.load().document;

    assert.deepEqual(after, before);
    assert.deepEqual(validateSite(after), validateSite(before), 'and it validates identically');
  });

  test('an edited site round-trips with the edits intact', () => {
    const store = siteStore(new MemoryStorage());
    const site = demoSite();
    site.name = 'edited_site';
    site.site_id = 'edited_site';
    site.mission_points[1].east_m = -61.5;
    site.safety_area.horizontal.push({ east_m: -120, north_m: 0 });

    store.save(site);
    const after = store.load().document;

    assert.equal(after.name, 'edited_site');
    assert.equal(after.mission_points[1].east_m, -61.5);
    assert.equal(after.safety_area.horizontal.length, 7);
  });

  test('a trajectory editing state round-trips', () => {
    const store = new DraftStore({
      slot: 'trajectory_editor:draft',
      storage: new MemoryStorage(),
      accept: looksLikeTrajectoryDraft,
    });
    const draft = {
      points: [
        { east_m: -50, north_m: -35 },
        { east_m: 50, north_m: -35 },
        { east_m: 0, north_m: 35 },
      ],
      closed: true,
      selectedIndex: 1,
      name: 'survey_loop',
      altitude: '42.5',
      altitudeReference: 'AGL',
      speed: '5',
      headingMode: 'path_tangent',
      fixedHeading: '0',
      preset: 'racetrack',
    };

    store.save(draft);
    const after = store.load();

    assert.equal(after.status, LOAD_STATUS.OK);
    assert.deepEqual(after.document, draft);
    assert.equal(after.document.points.length, 3);
    assert.equal(after.document.altitude, '42.5', 'an in-progress field keeps its exact text');
  });
});

describe('persistence: the reported regression case', (test) => {
  // The coordinates below are a regression fixture and nothing else: no default
  // anywhere in the toolkit uses them, and none should.
  const LONGITUDE_DEG = 14.418333;
  const LATITUDE_DEG = 50.111806;

  test('an edited origin survives save and restore to the last decimal', () => {
    const store = siteStore(new MemoryStorage());

    const site = demoSite();
    site.origin.longitude_deg = LONGITUDE_DEG;
    site.origin.latitude_deg = LATITUDE_DEG;

    assert.equal(store.save(site).ok, true);
    const restored = store.load();

    assert.equal(restored.status, LOAD_STATUS.OK);
    assertClose(restored.document.origin.longitude_deg, LONGITUDE_DEG, 1e-12, 'longitude');
    assertClose(restored.document.origin.latitude_deg, LATITUDE_DEG, 1e-12, 'latitude');
    // Not merely close: JSON round-trips a double exactly, so nothing was lost.
    assert.equal(restored.document.origin.longitude_deg, LONGITUDE_DEG);
    assert.equal(restored.document.origin.latitude_deg, LATITUDE_DEG);
  });

  test('the restored origin is not the demo origin', () => {
    const store = siteStore(new MemoryStorage());
    const demo = demoSite();
    const site = demoSite();
    site.origin.longitude_deg = LONGITUDE_DEG;
    site.origin.latitude_deg = LATITUDE_DEG;
    store.save(site);

    const restored = store.load().document;
    assert.notEqual(restored.origin.longitude_deg, demo.origin.longitude_deg);
    assert.notEqual(restored.origin.latitude_deg, demo.origin.latitude_deg);
  });

  test('these coordinates appear nowhere as a default', () => {
    const demo = demoSite();
    assert.notEqual(demo.origin.longitude_deg, LONGITUDE_DEG);
    assert.notEqual(demo.origin.latitude_deg, LATITUDE_DEG);
  });

  test('an edit made after the restore also survives the next save', () => {
    const storage = new MemoryStorage();
    const store = siteStore(storage);
    const site = demoSite();
    site.origin.longitude_deg = LONGITUDE_DEG;
    site.origin.latitude_deg = LATITUDE_DEG;
    store.save(site);

    // Reload, move a mission point, save again - the sequence the browser check
    // performs.
    const reopened = store.load().document;
    reopened.mission_points[0].east_m = 12.5;
    reopened.mission_points[0].north_m = -7.25;
    store.save(reopened);

    const final = store.load().document;
    assert.equal(final.origin.longitude_deg, LONGITUDE_DEG);
    assert.equal(final.origin.latitude_deg, LATITUDE_DEG);
    assert.equal(final.mission_points[0].east_m, 12.5);
    assert.equal(final.mission_points[0].north_m, -7.25);
  });
});

describe('persistence: debounced writes', (test) => {
  /** A controllable clock, so the test does not sleep. */
  function fakeTimers() {
    const queue = new Map();
    let next = 1;
    return {
      setTimeout: (fn) => {
        queue.set(next, fn);
        return next++;
      },
      clearTimeout: (handle) => queue.delete(handle),
      run: () => {
        for (const fn of [...queue.values()]) fn();
        queue.clear();
      },
      get pending() {
        return queue.size;
      },
    };
  }

  test('a burst of calls produces one write, with the last value', () => {
    const timers = fakeTimers();
    const seen = [];
    const save = debounce((value) => seen.push(value), 400, timers);

    for (let i = 1; i <= 20; i += 1) save(i);
    assert.deepEqual(seen, [], 'nothing is written while the burst is still arriving');

    timers.run();
    assert.deepEqual(seen, [20], 'one write, carrying the newest value');
  });

  test('flush writes a pending value immediately', () => {
    const timers = fakeTimers();
    const seen = [];
    const save = debounce((value) => seen.push(value), 400, timers);
    save('a');
    save.flush();
    assert.deepEqual(seen, ['a']);
    assert.equal(timers.pending, 0);
  });

  test('flush with nothing pending does nothing', () => {
    const timers = fakeTimers();
    const seen = [];
    const save = debounce((value) => seen.push(value), 400, timers);
    save.flush();
    assert.deepEqual(seen, []);
  });

  test('cancel drops a pending write', () => {
    const timers = fakeTimers();
    const seen = [];
    const save = debounce((value) => seen.push(value), 400, timers);
    save('a');
    save.cancel();
    timers.run();
    assert.deepEqual(seen, []);
  });
});

describe('persistence: history and the draft stay in step', (test) => {
  /**
   * The editors wire history and persistence together the same way: an edit is
   * pushed onto the history and then written to the draft, and undo/redo write
   * the restored state as well. These exercise that contract with the real
   * History, because the failure it prevents is nasty and silent - a reload
   * resurrecting a state the user had just undone.
   */
  function editor(storage) {
    const history = new History();
    const store = siteStore(storage);
    let document_ = null;

    return {
      history,
      store,
      get document() {
        return document_;
      },
      /** What a tool does when it opens a file or restores a draft. */
      adopt(site, { fromDraft = false } = {}) {
        document_ = structuredClone(site);
        // A restored document starts from a clean stack, exactly as a loaded
        // one does: undo must not reach the state the draft was saved in.
        history.reset(document_, fromDraft ? 'Restored draft' : 'Loaded file');
        if (!fromDraft) store.save(document_);
      },
      /** What a tool does after an edit. */
      commit(mutate, label) {
        mutate(document_);
        history.push(document_, label);
        store.save(document_);
      },
      undo() {
        const restored = history.undo();
        if (restored === null) return false;
        document_ = restored;
        store.save(document_);
        return true;
      },
      redo() {
        const restored = history.redo();
        if (restored === null) return false;
        document_ = restored;
        store.save(document_);
        return true;
      },
    };
  }

  test('an undo is written to the draft, so a reload cannot resurrect it', () => {
    const storage = new MemoryStorage();
    const tool = editor(storage);
    tool.adopt(demoSite());

    tool.commit((site) => site.safety_area.horizontal.push({ east_m: 5, north_m: 5 }), 'Add vertex');
    assert.equal(tool.store.load().document.safety_area.horizontal.length, 7);

    tool.undo();
    assert.equal(
      tool.store.load().document.safety_area.horizontal.length,
      6,
      'the persisted draft must follow the undo, not the edit that was undone'
    );
  });

  test('a redo is written to the draft too', () => {
    const tool = editor(new MemoryStorage());
    tool.adopt(demoSite());
    tool.commit((site) => {
      site.name = 'renamed';
    }, 'Rename');
    tool.undo();
    assert.equal(tool.store.load().document.name, 'demo_site');

    tool.redo();
    assert.equal(tool.store.load().document.name, 'renamed');
  });

  test('a restored draft starts with an empty undo stack', () => {
    const storage = new MemoryStorage();

    // Session one: load, edit twice, and leave.
    const first = editor(storage);
    first.adopt(demoSite());
    first.commit((site) => {
      site.name = 'first_edit';
    }, 'Rename');
    first.commit((site) => {
      site.mission_points.pop();
    }, 'Remove mission point');
    assert.equal(first.history.canUndo(), true);

    // Session two: a fresh page restores the draft.
    const second = editor(storage);
    const restored = second.store.load();
    assert.equal(restored.status, LOAD_STATUS.OK);
    second.adopt(restored.document, { fromDraft: true });

    assert.equal(second.document.name, 'first_edit', 'the work came back');
    assert.equal(second.document.mission_points.length, 3);
    assert.equal(second.history.canUndo(), false, 'but its history did not');
    assert.equal(second.history.canRedo(), false);
    assert.deepEqual(second.history.labels(), ['Restored draft']);
  });

  test('undo after a restore reaches only the edits made since', () => {
    const storage = new MemoryStorage();
    const first = editor(storage);
    first.adopt(demoSite());
    first.commit((site) => {
      site.name = 'before_reload';
    }, 'Rename');

    const second = editor(storage);
    second.adopt(second.store.load().document, { fromDraft: true });
    second.commit((site) => {
      site.name = 'after_reload';
    }, 'Rename again');

    assert.equal(second.undo(), true);
    assert.equal(second.document.name, 'before_reload', 'back to the restored state');
    assert.equal(second.undo(), false, 'and no further: the earlier session is not reachable');
    assert.equal(second.store.load().document.name, 'before_reload');
  });

  test('opening a file replaces the draft, so the previous one cannot return', () => {
    const storage = new MemoryStorage();
    const tool = editor(storage);
    tool.adopt(demoSite());
    tool.commit((site) => {
      site.name = 'work_in_progress';
    }, 'Rename');
    assert.equal(tool.store.load().document.name, 'work_in_progress');

    const other = demoSite();
    other.name = 'a_different_site';
    tool.adopt(other);

    assert.equal(
      tool.store.load().document.name,
      'a_different_site',
      'opening a document makes it the active editing state'
    );
  });

  test('the regression origin survives a full edit, reload and undo cycle', () => {
    const storage = new MemoryStorage();
    const first = editor(storage);
    first.adopt(demoSite());
    first.commit((site) => {
      site.origin.longitude_deg = 14.418333;
      site.origin.latitude_deg = 50.111806;
    }, 'Change origin');
    first.commit((site) => {
      site.mission_points[0].east_m = 12.5;
      site.mission_points[0].north_m = -7.25;
    }, 'Move mission point');

    // Reload.
    const second = editor(storage);
    second.adopt(second.store.load().document, { fromDraft: true });

    assert.equal(second.document.origin.longitude_deg, 14.418333);
    assert.equal(second.document.origin.latitude_deg, 50.111806);
    assert.equal(second.document.mission_points[0].east_m, 12.5);

    // An edit and an undo after the restore leave the origin untouched.
    second.commit((site) => {
      site.name = 'later';
    }, 'Rename');
    second.undo();
    assert.equal(second.store.load().document.origin.longitude_deg, 14.418333);
    assert.equal(second.store.load().document.origin.latitude_deg, 50.111806);
  });

  test('discarding the draft leaves nothing for the next session to restore', () => {
    const storage = new MemoryStorage();
    const tool = editor(storage);
    tool.adopt(demoSite());
    tool.commit((site) => {
      site.origin.longitude_deg = 14.418333;
    }, 'Change origin');

    tool.store.clear();

    const next = siteStore(storage);
    assert.equal(next.load().status, LOAD_STATUS.EMPTY);
    assert.equal(next.has(), false);
  });
});
