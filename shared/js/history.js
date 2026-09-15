/**
 * Undo/redo, shared by every tool that edits a document.
 *
 * There is one implementation because four ad-hoc undo stacks would disagree
 * with each other about the details that actually matter: when a drag becomes
 * one entry, when the redo stack is discarded, and what happens when a new file
 * is loaded.
 *
 * WHY SNAPSHOTS RATHER THAN INVERSE COMMANDS
 * ------------------------------------------
 * The documents this toolkit edits are small plain-JSON objects — a site is a
 * handful of kilobytes, a trajectory a list of points. Storing a deep copy per
 * edit costs almost nothing and removes a whole class of bug: an inverse
 * command that is subtly wrong corrupts the document in a way that is only
 * discovered later, whereas a snapshot either restores the document exactly or
 * fails loudly. For a tool whose output is flown, "cannot be subtly wrong" is
 * worth more than the memory.
 *
 * The cost is that history does not describe *what* changed, only *that* it
 * changed. Each entry therefore carries a human label, which is what the UI
 * shows and what the tests assert on.
 *
 * COALESCING
 * ----------
 * A drag fires a continuous stream of pointer events, and typing in a field
 * fires one input event per keystroke. Neither should leave one history entry
 * per event. Callers pass a `coalesceKey`: consecutive pushes carrying the same
 * key replace the previous entry instead of adding one, so a whole drag or a
 * whole burst of typing collapses into a single undoable operation. A push with
 * no key, or with a different key, always starts a new entry.
 */

/** Entries kept, not counting the baseline. Bounded so a long session cannot grow without limit. */
export const DEFAULT_HISTORY_LIMIT = 50;

/**
 * @typedef {{label: string, coalesceKey: string|null}} HistoryEntryInfo
 */

export class History {
  /**
   * @param {{limit?: number, clone?: (value: unknown) => unknown}} [options]
   */
  constructor(options = {}) {
    const { limit = DEFAULT_HISTORY_LIMIT, clone } = options;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`History limit must be a positive integer, got ${JSON.stringify(limit)}.`);
    }
    this.limit = limit;
    this.clone = clone ?? defaultClone;
    /** @type {Array<{state: unknown, label: string, coalesceKey: string|null}>} */
    this.entries = [];
    /** Index of the entry describing the current state. -1 means "empty". */
    this.index = -1;
    /** @type {Set<(history: History) => void>} */
    this.listeners = new Set();
  }

  /**
   * Start a new document.
   *
   * This is what keeps history from spanning unrelated files: loading a site or
   * a trajectory must call reset, so that undo can never walk backwards out of
   * the document the user is looking at and into the previous one.
   *
   * @param {unknown} state
   * @param {string} [label]
   */
  reset(state, label = 'Loaded') {
    this.entries = [{ state: this.clone(state), label, coalesceKey: null }];
    this.index = 0;
    this.#notify();
  }

  /** Forget everything, including the baseline. */
  clear() {
    this.entries = [];
    this.index = -1;
    this.#notify();
  }

  /**
   * Record a new current state.
   *
   * @param {unknown} state the document *after* the change
   * @param {string} label what the user did, e.g. "Move mission point"
   * @param {{coalesceKey?: string|null}} [options]
   */
  push(state, label, options = {}) {
    const coalesceKey = options.coalesceKey ?? null;
    if (typeof label !== 'string' || label.trim() === '') {
      throw new Error('Every history entry needs a non-empty label.');
    }
    if (this.index < 0) {
      // Nothing has been reset yet; treat the first push as the baseline so a
      // caller cannot end up with an undo that restores nothing.
      this.reset(state, label);
      return;
    }

    // Anything that was undone is now unreachable: a new edit after an undo
    // discards the redo branch rather than trying to reconcile two futures.
    if (this.index < this.entries.length - 1) {
      this.entries.length = this.index + 1;
    }

    const current = this.entries[this.index];
    const canCoalesce =
      coalesceKey !== null && current.coalesceKey === coalesceKey && this.index > 0;

    if (canCoalesce) {
      // Replace the state in place; the label and the key stay as they were, so
      // the whole drag still reads as the one operation it was.
      current.state = this.clone(state);
    } else {
      this.entries.push({ state: this.clone(state), label, coalesceKey });
      this.index += 1;
      this.#enforceLimit();
    }
    this.#notify();
  }

  /**
   * Step back one operation.
   * @returns {unknown|null} the restored state, or null when there is nothing to undo
   */
  undo() {
    if (!this.canUndo()) return null;
    this.index -= 1;
    this.#notify();
    return this.clone(this.entries[this.index].state);
  }

  /**
   * Step forward one operation.
   * @returns {unknown|null} the restored state, or null when there is nothing to redo
   */
  redo() {
    if (!this.canRedo()) return null;
    this.index += 1;
    this.#notify();
    return this.clone(this.entries[this.index].state);
  }

  /** @returns {boolean} */
  canUndo() {
    return this.index > 0;
  }

  /** @returns {boolean} */
  canRedo() {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  /**
   * What undo would reverse, for a button tooltip. Null when undo is unavailable.
   * @returns {string|null}
   */
  undoLabel() {
    return this.canUndo() ? this.entries[this.index].label : null;
  }

  /**
   * What redo would reapply. Null when redo is unavailable.
   * @returns {string|null}
   */
  redoLabel() {
    return this.canRedo() ? this.entries[this.index + 1].label : null;
  }

  /** The current state, without moving. @returns {unknown|null} */
  current() {
    return this.index < 0 ? null : this.clone(this.entries[this.index].state);
  }

  /** Number of undoable operations currently available. @returns {number} */
  depth() {
    return Math.max(0, this.index);
  }

  /** Labels of every entry, oldest first. Used by the tests. @returns {string[]} */
  labels() {
    return this.entries.map((entry) => entry.label);
  }

  /**
   * Be told whenever the stacks change, so a toolbar can enable and disable
   * itself without the caller remembering to do it at every call site.
   * @param {(history: History) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this);
    return () => this.listeners.delete(listener);
  }

  #enforceLimit() {
    // entries[0] is the baseline, so the cap is limit + 1 stored states.
    const excess = this.entries.length - (this.limit + 1);
    if (excess <= 0) return;
    this.entries.splice(0, excess);
    this.index -= excess;
  }

  #notify() {
    for (const listener of this.listeners) listener(this);
  }
}

/**
 * Deep copy. structuredClone is available in every browser this toolkit
 * targets and in Node 17+; the JSON round trip is a fallback for older hosts
 * and is adequate because every document here is plain JSON by construction.
 * @param {unknown} value
 */
function defaultClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Wire undo/redo to a pair of buttons and the usual keyboard shortcuts.
 *
 * Kept here rather than in each tool so that the shortcuts, the disabled
 * states and the tooltips cannot drift apart between tools.
 *
 * @param {{
 *   history: History,
 *   undoButton: HTMLButtonElement,
 *   redoButton: HTMLButtonElement,
 *   apply: (state: unknown, direction: 'undo'|'redo', label: string|null) => void,
 *   target?: EventTarget,
 * }} options
 * @returns {() => void} detach
 */
export function attachHistoryControls(options) {
  const { history, undoButton, redoButton, apply, target = document } = options;

  const run = (direction) => {
    const label = direction === 'undo' ? history.undoLabel() : history.redoLabel();
    const state = direction === 'undo' ? history.undo() : history.redo();
    if (state === null) return;
    apply(state, direction, label);
  };

  const onUndo = () => run('undo');
  const onRedo = () => run('redo');

  const onKeyDown = (event) => {
    // Cmd on macOS, Ctrl elsewhere. Never both, so the shortcut cannot fire
    // twice on a keyboard where both are held.
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      run(event.shiftKey ? 'redo' : 'undo');
    } else if (key === 'y') {
      // The Windows convention, offered as well as Ctrl+Shift+Z.
      event.preventDefault();
      run('redo');
    }
  };

  const refresh = () => {
    undoButton.disabled = !history.canUndo();
    redoButton.disabled = !history.canRedo();
    const undoLabel = history.undoLabel();
    const redoLabel = history.redoLabel();
    undoButton.title = undoLabel === null ? 'Nothing to undo' : `Undo: ${undoLabel} (Ctrl+Z)`;
    redoButton.title = redoLabel === null ? 'Nothing to redo' : `Redo: ${redoLabel} (Ctrl+Shift+Z)`;
  };

  undoButton.addEventListener('click', onUndo);
  redoButton.addEventListener('click', onRedo);
  target.addEventListener('keydown', onKeyDown);
  const unsubscribe = history.subscribe(refresh);

  return () => {
    undoButton.removeEventListener('click', onUndo);
    redoButton.removeEventListener('click', onRedo);
    target.removeEventListener('keydown', onKeyDown);
    unsubscribe();
  };
}
