/**
 * Small DOM and formatting helpers shared by all four tools.
 *
 * Deliberately not a framework. The only rules it enforces are:
 *  - text always goes into the DOM via textContent, never innerHTML, so no
 *    loaded file can inject markup;
 *  - an unavailable value renders as an em dash, never as 0;
 *  - errors are always shown to the user, never only logged.
 */

/** Rendered in place of a value that does not exist. */
export const NO_VALUE = '—';

/**
 * Create an element.
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs] - `class`, `text`, `title`, `dataset`
 *   and `on<Event>` handlers are treated specially; everything else becomes an
 *   attribute.
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement} throws when the element is missing, so a typo in a
 *   selector fails loudly instead of producing a silently dead control.
 */
export function must(selector, root = document) {
  const node = root.querySelector(selector);
  if (node === null) {
    throw new Error(`Internal error: no element matches "${selector}".`);
  }
  return /** @type {HTMLElement} */ (node);
}

/** Remove all children of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Read a design-system colour token.
 *
 * Leaflet and the SVG canvas need real colour strings, not CSS variables, so
 * the geometry colours are pulled from the same custom properties the
 * stylesheet defines. That keeps one palette instead of two, and makes the
 * geometry follow the light/dark theme automatically.
 *
 * @param {string} name e.g. '--geo-safety'
 * @param {string} fallback used when the stylesheet has not loaded
 * @returns {string}
 */
export function cssToken(name, fallback) {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/**
 * Render a validation finding list into a container.
 *
 * Findings are ordered errors first, and the "nothing to report" case is a
 * single quiet line rather than a success card: a panel full of green boxes
 * teaches the reader to stop looking at it.
 *
 * @param {HTMLElement} container
 * @param {Array<{severity:string, code:string, message:string, path?:string}>} findings
 * @param {{emptyMessage?: string}} [options]
 */
export function renderFindings(container, findings, options = {}) {
  const { emptyMessage = 'No findings.' } = options;
  clear(container);

  if (findings.length === 0) {
    container.append(el('p', { class: 'finding finding--ok', text: emptyMessage }));
    return;
  }

  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort(
    (a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
  );

  const list = el('ul', { class: 'finding-list' });
  for (const found of sorted) {
    const item = el('li', { class: `finding finding--${found.severity}` }, [
      el('span', { class: 'finding__severity', text: found.severity }),
      el('span', { class: 'finding__message', text: found.message }),
    ]);
    if (found.path) {
      item.append(el('code', { class: 'finding__path', text: found.path }));
    }
    list.append(item);
  }
  container.append(list);
}

/**
 * Summarise a finding list in a few words: "Valid", "2 errors · 1 warning".
 *
 * Returned as data rather than markup so the caller decides where it goes.
 *
 * @param {Array<{severity:string}>} findings
 * @param {{idle?: boolean, idleText?: string}} [options] idle = nothing loaded yet
 * @returns {{level: 'idle'|'ok'|'warning'|'error', glyph: string, text: string}}
 */
export function summarizeFindings(findings, options = {}) {
  if (options.idle) {
    return { level: 'idle', glyph: '·', text: options.idleText ?? 'Nothing loaded' };
  }
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    if (finding.severity in counts) counts[finding.severity] += 1;
  }

  const parts = [];
  if (counts.error > 0) parts.push(plural(counts.error, 'error'));
  if (counts.warning > 0) parts.push(plural(counts.warning, 'warning'));
  if (counts.error === 0 && counts.warning === 0 && counts.info > 0) {
    parts.push(plural(counts.info, 'note'));
  }

  if (counts.error > 0) return { level: 'error', glyph: '✕', text: parts.join(' · ') };
  if (counts.warning > 0) return { level: 'warning', glyph: '!', text: parts.join(' · ') };
  // Informational notes are not a problem; the verdict stays "valid" and says so.
  return {
    level: 'ok',
    glyph: '✓',
    text: parts.length > 0 ? `Valid · ${parts.join(' · ')}` : 'Valid',
  };
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Write a validation verdict into a container as a compact badge.
 *
 * The glyph is redundant with the colour on purpose: colour alone must never be
 * the only carrier of a state that matters.
 *
 * @param {HTMLElement} container
 * @param {ReturnType<typeof summarizeFindings>} verdict
 */
export function renderVerdict(container, verdict) {
  container.className = `verdict verdict--${verdict.level}`;
  clear(container);
  container.append(
    el('span', { class: 'verdict__glyph', text: verdict.glyph, 'aria-hidden': 'true' }),
    el('span', { text: verdict.text })
  );
}

/**
 * Fill one slot of the context bar.
 * @param {HTMLElement} element the .context__value span
 * @param {string|null} value
 * @param {string} [emptyText]
 */
export function setContext(element, value, emptyText = 'not set') {
  const missing = value === null || value === undefined || value === '';
  element.textContent = missing ? emptyText : String(value);
  element.classList.toggle('context__value--muted', missing);
}

/**
 * A short explanation for a piece of unavoidable jargon. Used by the `?`
 * affordances next to labels; kept here so every tool says the same thing.
 */
export const GLOSSARY = Object.freeze({
  ENU: 'East-North-Up: a local Cartesian frame in metres, with its origin at the site origin. ' +
    'X is east, Y is north, Z is up.',
  AGL: 'Above Ground Level: height above the terrain directly below the point.',
  AMSL: 'Above Mean Sea Level: height above the sea-level reference surface.',
  ATO: 'Above Take-Off: height above the site origin altitude.',
  heading: 'Degrees clockwise from true north, in [0, 360). 0 is north, 90 is east.',
  local_enu: 'Coordinates are metres in the site\'s local ENU frame, not latitude/longitude.',
});

/**
 * Attach a `?` help affordance carrying a glossary entry.
 * @param {string} term a key of GLOSSARY, or literal help text
 * @returns {HTMLElement}
 */
export function helpFor(term) {
  const text = GLOSSARY[term] ?? term;
  return el('button', {
    type: 'button',
    class: 'help',
    text: '?',
    title: text,
    'aria-label': `What does ${term} mean? ${text}`,
    // A help marker is not a form control; keep it out of the submit path.
    onClick: (event) => event.preventDefault(),
  });
}

/**
 * Write a one-line status message.
 * @param {HTMLElement} container
 * @param {string} message
 * @param {'ok'|'error'|'warning'|'info'} [level]
 */
export function setStatus(container, message, level = 'info') {
  container.className = `status status--${level}`;
  container.textContent = message;
}

/**
 * Show an error to the user and keep the stack in the console for debugging.
 * @param {HTMLElement} container
 * @param {unknown} err
 * @param {string} [context]
 */
export function reportError(container, err, context = '') {
  const message = err instanceof Error ? err.message : String(err);
  console.error(context || 'Error:', err);
  setStatus(container, context ? `${context}: ${message}` : message, 'error');
}

/**
 * Route otherwise-invisible failures (a syntax error in a module, a rejected
 * promise nobody awaited) to the page's status line, so the tool never looks
 * like it simply did nothing.
 * @param {HTMLElement} container
 */
export function installGlobalErrorHandlers(container) {
  window.addEventListener('error', (event) => {
    reportError(container, event.error ?? event.message, 'Unhandled error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError(container, event.reason, 'Unhandled promise rejection');
  });
}

/**
 * Leaflet is vendored under shared/vendor/leaflet/ and loaded by each tool's
 * HTML, so this only fails when the repository is incomplete or the page was
 * opened from the wrong place. Fail with an actionable message rather than a
 * bare "L is not defined".
 * @returns {object} the Leaflet namespace
 */
export function ensureLeaflet() {
  if (typeof window.L === 'undefined') {
    throw new Error(
      'Leaflet did not load from shared/vendor/leaflet/leaflet.js, so the map is ' +
        'unavailable. Check that the file exists and that the page is served over HTTP ' +
        'from the repository root. Everything else on this page still works.'
    );
  }
  return window.L;
}

// --- formatting -------------------------------------------------------------

/**
 * @param {unknown} value
 * @param {number} [digits]
 * @returns {string}
 */
export function formatNumber(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_VALUE;
  return value.toFixed(digits);
}

/** @returns {string} e.g. "123.4 m" */
export function formatMeters(value, digits = 1) {
  const text = formatNumber(value, digits);
  return text === NO_VALUE ? NO_VALUE : `${text} m`;
}

/** @returns {string} e.g. "40000 m² (4.00 ha)" */
export function formatArea(valueM2) {
  if (typeof valueM2 !== 'number' || !Number.isFinite(valueM2)) return NO_VALUE;
  const hectares = valueM2 / 10000;
  return `${valueM2.toFixed(0)} m² (${hectares.toFixed(2)} ha)`;
}

/** @returns {string} e.g. "2 min 05 s" */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return NO_VALUE;
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes === 0) return `${rest} s`;
  return `${minutes} min ${String(rest).padStart(2, '0')} s`;
}

/** @returns {string} latitude/longitude with 7 decimals (~1 cm). */
export function formatLatLon(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(7) : NO_VALUE;
}

// --- numeric inputs ---------------------------------------------------------

/**
 * Read a numeric input. An empty or unparseable field yields null rather than
 * zero, so the caller can report "not set" instead of inventing a value.
 * @param {HTMLInputElement} input
 * @returns {number|null}
 */
export function readNumberInput(input) {
  const raw = input.value.trim();
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Format a model value for a numeric input: a missing value shows as empty.
 * @param {unknown} value
 * @returns {string}
 */
export function numberToInput(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/**
 * Build a definition list from label/value pairs.
 * @param {Array<[string, string]>} pairs
 * @returns {HTMLElement}
 */
export function definitionList(pairs) {
  const list = el('dl', { class: 'kv' });
  for (const [label, value] of pairs) {
    list.append(el('dt', { text: label }), el('dd', { text: value }));
  }
  return list;
}
