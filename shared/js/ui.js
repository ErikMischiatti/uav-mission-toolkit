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
 * Render a validation finding list into a container.
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
