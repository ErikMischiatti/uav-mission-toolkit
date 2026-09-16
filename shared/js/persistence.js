/**
 * Browser-local draft persistence.
 *
 * A tool keeps the document you are editing in `localStorage`, so closing the
 * tab or reloading the page does not lose the work. That is the whole scope:
 * this is a recovery mechanism for one browser on one machine, not storage, not
 * sync, and not a substitute for exporting the file.
 *
 * WHAT THIS MODULE REFUSES TO DO
 * -----------------------------
 * It never repairs a draft. A stored value is either returned exactly as it was
 * written, or refused with a reason - there is no path where a half-readable
 * draft is patched into something plausible and handed back as mission data.
 * That is the same rule the file loaders follow, and it matters more here,
 * because a draft is restored silently at start-up rather than being chosen by
 * a human.
 *
 * WHAT "VALID" MEANS FOR A DRAFT
 * ------------------------------
 * Deliberately weaker than what the validators require of a *file*. A draft is
 * work in progress: an altitude the user has not filled in yet, or a polygon
 * mid-edit, is a normal state that the editor is designed to show and report.
 * Refusing to restore those would throw away the work exactly when it is least
 * replaceable.
 *
 * So the only structural question asked here is "is this the kind of document
 * this tool edits?" - answered by the caller's `accept` predicate. Everything
 * about its *content* is left to shared/js/validation.js, which reports it in
 * the normal way once the draft is on screen. Restoring a draft therefore tells
 * you no less than loading the same file would.
 *
 * FAILURE IS NORMAL, NOT EXCEPTIONAL
 * ----------------------------------
 * `localStorage` throws in ordinary situations: a private window, site data
 * disabled, or a full quota. None of that may take a tool down, so every access
 * is wrapped and every method returns a result instead of throwing. A tool that
 * cannot persist still works; it just says so.
 */

/** Prefix on every key this project writes, so it cannot collide on a shared origin. */
export const STORAGE_NAMESPACE = 'uav-mission-toolkit';

/**
 * Version of the *envelope* below - not of the documents it carries.
 *
 * Bump it when the envelope shape changes, or when a change to a document
 * format would make an older draft misleading rather than merely outdated. An
 * envelope written by a different version is refused as `incompatible` and
 * never guessed at.
 */
export const PERSISTENCE_VERSION = 1;

/** Result statuses from {@link DraftStore#load}. */
export const LOAD_STATUS = Object.freeze({
  /** Nothing stored. */
  EMPTY: 'empty',
  /** A usable draft was read. */
  OK: 'ok',
  /** Storage itself could not be read. */
  UNAVAILABLE: 'unavailable',
  /** Stored, but not parseable as the envelope this module writes. */
  UNREADABLE: 'unreadable',
  /** A well-formed envelope from a different persistence version. */
  INCOMPATIBLE: 'incompatible',
  /** A well-formed envelope whose payload is not the kind of document expected. */
  REJECTED: 'rejected',
});

/**
 * Build the storage key for one slot.
 *
 * Namespaced and versioned on purpose: `uav-mission-toolkit:v1:site_editor:draft`
 * says who owns it, which envelope version wrote it, which tool it belongs to
 * and what it holds. A future version writes different keys, so old and new
 * drafts coexist instead of one silently overwriting the other.
 *
 * @param {string} slot e.g. 'site_editor:draft'
 * @param {number} [version]
 * @returns {string}
 */
export function storageKey(slot, version = PERSISTENCE_VERSION) {
  if (typeof slot !== 'string' || slot.trim() === '') {
    throw new Error('A storage slot name must be a non-empty string.');
  }
  return `${STORAGE_NAMESPACE}:v${version}:${slot}`;
}

/**
 * The browser's localStorage, or null when it cannot be used.
 *
 * Merely reading `window.localStorage` throws when site data is blocked, so the
 * access is probed rather than assumed.
 *
 * @returns {Storage|null}
 */
export function defaultStorage() {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return null;
    // A read is not enough: some browsers expose the object and refuse writes.
    const probe = `${STORAGE_NAMESPACE}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * One persisted slot: read it, write it, clear it, and never throw.
 */
export class DraftStore {
  /**
   * @param {{
   *   slot: string,
   *   storage?: Storage|null,
   *   version?: number,
   *   accept?: (document: unknown) => boolean,
   *   now?: () => string,
   * }} options `accept` decides whether a payload is the kind of document this
   *   slot holds. It is a structural check only; it must not inspect values.
   */
  constructor(options) {
    const {
      slot,
      storage = defaultStorage(),
      version = PERSISTENCE_VERSION,
      accept = isPlainObject,
      now = () => new Date().toISOString(),
    } = options;

    this.slot = slot;
    this.version = version;
    this.key = storageKey(slot, version);
    this.storage = storage ?? null;
    this.accept = accept;
    this.now = now;
  }

  /** @returns {boolean} whether anything can be persisted at all. */
  get available() {
    return this.storage !== null;
  }

  /**
   * Write a document.
   *
   * @param {unknown} document the document as the tool holds it
   * @param {Record<string, unknown>} [meta] small extras, e.g. the source label
   * @returns {{ok: boolean, reason?: string, bytes?: number}}
   */
  save(document, meta = {}) {
    if (this.storage === null) {
      return { ok: false, reason: 'Browser storage is unavailable, so nothing was saved.' };
    }
    let text;
    try {
      text = JSON.stringify({
        namespace: STORAGE_NAMESPACE,
        persistence_version: this.version,
        slot: this.slot,
        saved_utc: this.now(),
        meta,
        document,
      });
    } catch (err) {
      // A document that cannot be serialised is a programming error, not a
      // storage problem, and is worth saying so rather than half-writing.
      return { ok: false, reason: `This document could not be serialised: ${messageOf(err)}` };
    }

    try {
      this.storage.setItem(this.key, text);
      return { ok: true, bytes: text.length };
    } catch (err) {
      // Overwhelmingly a quota error. The previous value, if any, is left
      // alone: a failed save must not also destroy the last good draft.
      return { ok: false, reason: `Could not save the draft: ${messageOf(err)}` };
    }
  }

  /**
   * Read the stored document.
   *
   * Never throws, and never returns a repaired document. Anything that is not
   * exactly what this module wrote comes back with a status and a reason.
   *
   * @returns {{status: string, document?: unknown, meta?: object, savedUtc?: string, reason?: string, raw?: string}}
   */
  load() {
    if (this.storage === null) {
      return { status: LOAD_STATUS.UNAVAILABLE, reason: 'Browser storage is unavailable.' };
    }

    let raw;
    try {
      raw = this.storage.getItem(this.key);
    } catch (err) {
      return { status: LOAD_STATUS.UNAVAILABLE, reason: messageOf(err) };
    }
    if (raw === null || raw === undefined) return { status: LOAD_STATUS.EMPTY };

    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (err) {
      return {
        status: LOAD_STATUS.UNREADABLE,
        reason: `The saved draft is not valid JSON: ${messageOf(err)}`,
        raw,
      };
    }

    if (!isPlainObject(envelope)) {
      return { status: LOAD_STATUS.UNREADABLE, reason: 'The saved draft is not an object.', raw };
    }
    if (envelope.namespace !== STORAGE_NAMESPACE) {
      return {
        status: LOAD_STATUS.UNREADABLE,
        reason: 'The saved draft was not written by this toolkit.',
        raw,
      };
    }
    if (envelope.persistence_version !== this.version) {
      return {
        status: LOAD_STATUS.INCOMPATIBLE,
        reason:
          `The saved draft uses persistence version ` +
          `${JSON.stringify(envelope.persistence_version)}; this build writes version ` +
          `${this.version}. It will not be guessed at.`,
        raw,
      };
    }
    if (!('document' in envelope)) {
      return { status: LOAD_STATUS.UNREADABLE, reason: 'The saved draft carries no document.', raw };
    }

    let accepted = false;
    try {
      accepted = this.accept(envelope.document) === true;
    } catch (err) {
      // A predicate that throws is treated as a refusal, never as a pass.
      return {
        status: LOAD_STATUS.REJECTED,
        reason: `The saved draft could not be checked: ${messageOf(err)}`,
        raw,
      };
    }
    if (!accepted) {
      return {
        status: LOAD_STATUS.REJECTED,
        reason: 'The saved draft is not the kind of document this tool edits.',
        raw,
      };
    }

    return {
      status: LOAD_STATUS.OK,
      document: envelope.document,
      meta: isPlainObject(envelope.meta) ? envelope.meta : {},
      savedUtc: typeof envelope.saved_utc === 'string' ? envelope.saved_utc : undefined,
    };
  }

  /**
   * Remove the stored draft.
   * @returns {{ok: boolean, reason?: string}}
   */
  clear() {
    if (this.storage === null) {
      return { ok: false, reason: 'Browser storage is unavailable.' };
    }
    try {
      this.storage.removeItem(this.key);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: messageOf(err) };
    }
  }

  /** @returns {boolean} whether this slot currently holds anything at all. */
  has() {
    if (this.storage === null) return false;
    try {
      return this.storage.getItem(this.key) !== null;
    } catch {
      return false;
    }
  }
}

/**
 * Collapse a burst of calls into one write.
 *
 * Every keystroke in the editors re-renders, and writing the whole document to
 * `localStorage` on each one is both wasteful and synchronous on the main
 * thread. The trailing call is the one that matters, so only it runs.
 *
 * @param {(...args: unknown[]) => void} fn
 * @param {number} delayMs
 * @param {{setTimeout?: Function, clearTimeout?: Function}} [timers] injectable for tests
 * @returns {((...args: unknown[]) => void) & {flush: () => void, cancel: () => void}}
 */
export function debounce(fn, delayMs, timers = {}) {
  const setTimer = timers.setTimeout ?? setTimeout;
  const clearTimer = timers.clearTimeout ?? clearTimeout;
  let handle = null;
  let pendingArgs = null;

  const run = (...args) => {
    pendingArgs = args;
    if (handle !== null) clearTimer(handle);
    handle = setTimer(() => {
      handle = null;
      const args_ = pendingArgs;
      pendingArgs = null;
      fn(...args_);
    }, delayMs);
  };

  /** Run a pending call now, e.g. before the page unloads. */
  run.flush = () => {
    if (handle === null) return;
    clearTimer(handle);
    handle = null;
    const args_ = pendingArgs;
    pendingArgs = null;
    fn(...args_);
  };

  /** Drop a pending call without running it. */
  run.cancel = () => {
    if (handle !== null) clearTimer(handle);
    handle = null;
    pendingArgs = null;
  };

  return run;
}

/**
 * A structural check for a site document.
 *
 * Deliberately shallow. It asks whether this looks like the kind of thing the
 * site editor edits, not whether it is a good site - `validateSite()` answers
 * that, on screen, in the normal way. A draft saved mid-edit is expected to
 * have problems, and losing it would be worse than showing it.
 *
 * @param {unknown} document
 * @returns {boolean}
 */
export function looksLikeSiteDocument(document) {
  if (!isPlainObject(document)) return false;
  // One marker that the site editor itself always maintains, and that no other
  // document in this toolkit has.
  return (
    'safety_area' in document ||
    'mission_points' in document ||
    'origin' in document ||
    'local_frame' in document
  );
}

/**
 * A structural check for a trajectory-editor draft.
 *
 * The trajectory editor persists its editing state rather than a trajectory
 * document: the control points plus the flight parameters, which is what an
 * undo has to restore anyway.
 *
 * @param {unknown} draft
 * @returns {boolean}
 */
export function looksLikeTrajectoryDraft(draft) {
  return isPlainObject(draft) && Array.isArray(draft.points) && 'closed' in draft;
}

/**
 * A structural check for a persisted map viewport.
 * @param {unknown} view
 * @returns {boolean}
 */
export function looksLikeMapView(view) {
  return (
    isPlainObject(view) &&
    Number.isFinite(view.latitude_deg) &&
    Number.isFinite(view.longitude_deg) &&
    Number.isFinite(view.zoom) &&
    Math.abs(view.latitude_deg) <= 90 &&
    Math.abs(view.longitude_deg) <= 180
  );
}

/**
 * A structural check for a persisted canvas viewport.
 * @param {unknown} view
 * @returns {boolean}
 */
export function looksLikeCanvasView(view) {
  return (
    isPlainObject(view) &&
    Number.isFinite(view.minX) &&
    Number.isFinite(view.minY) &&
    Number.isFinite(view.width) &&
    Number.isFinite(view.height) &&
    view.width > 0 &&
    view.height > 0
  );
}

// --- internal ---------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}
