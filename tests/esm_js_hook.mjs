/**
 * Node module-resolution hook: treat the project's `.js` files as ES modules.
 *
 * The browser knows these files are modules because every page loads them with
 * <script type="module">. Node decides by file extension plus the nearest
 * package.json "type" field, and this project deliberately has no package.json,
 * so Node would otherwise read `shared/js/geo.js` as CommonJS and fail on the
 * first `export` keyword.
 *
 * This hook is the whole reason the tests need no build step and no manifest.
 * It is registered by tests/run_tests.mjs; nothing else in the repository uses
 * it and nothing in the shipped tools depends on it.
 */

/**
 * @param {string} url
 * @param {object} context
 * @param {Function} nextLoad
 */
export async function load(url, context, nextLoad) {
  if (url.startsWith('file://') && url.endsWith('.js')) {
    return nextLoad(url, { ...context, format: 'module' });
  }
  return nextLoad(url, context);
}
