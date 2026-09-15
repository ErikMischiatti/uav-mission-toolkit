/**
 * A ~100 line test harness. No dependencies, by design: this repository has no
 * package.json and no install step, and the test suite must not introduce one.
 *
 * Usage, in any tests/*.test.mjs file:
 *
 *   import { describe, assertClose } from './harness.mjs';
 *
 *   describe('geo: polygon area', (test) => {
 *     test('measures a 100 m square', () => {
 *       assertClose(polygonAreaM2(square), 10000);
 *     });
 *   });
 *
 * Assertions come from node:assert/strict where a plain equality check will do;
 * the helpers below cover the cases it does not (floating point, error
 * messages, validation findings).
 */

import assert from 'node:assert/strict';

/** @typedef {{name: string, fn: () => void}} TestCase */
/** @typedef {{group: string, cases: TestCase[]}} TestGroup */

/** @type {TestGroup[]} */
export const groups = [];

/**
 * Register a group of tests. The callback receives the `test` function so that
 * cases cannot be registered outside a group.
 *
 * @param {string} group
 * @param {(test: (name: string, fn: () => void) => void) => void} define
 */
export function describe(group, define) {
  /** @type {TestCase[]} */
  const cases = [];
  define((name, fn) => cases.push({ name, fn }));
  groups.push({ group, cases });
}

export { assert };

/** Default tolerance for metre-scale comparisons: well below 1 micrometre. */
export const DEFAULT_TOLERANCE = 1e-9;

/**
 * Compare two floating point numbers.
 * @param {number} actual
 * @param {number} expected
 * @param {number} [tolerance]
 * @param {string} [message]
 */
export function assertClose(actual, expected, tolerance = DEFAULT_TOLERANCE, message = '') {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    assert.fail(`${message || 'value'}: expected a finite number near ${expected}, got ${actual}`);
  }
  const delta = Math.abs(actual - expected);
  if (delta > tolerance) {
    assert.fail(
      `${message || 'value'}: expected ${expected} ± ${tolerance}, got ${actual} (off by ${delta})`
    );
  }
}

/**
 * Assert that a value lies inside an inclusive range. Used where the exact
 * number depends on the WGS84 constants and pinning it would test arithmetic
 * rather than behaviour.
 *
 * @param {number} actual
 * @param {number} low
 * @param {number} high
 * @param {string} [message]
 */
export function assertBetween(actual, low, high, message = '') {
  if (!(typeof actual === 'number' && actual >= low && actual <= high)) {
    assert.fail(`${message || 'value'}: expected a number in [${low}, ${high}], got ${actual}`);
  }
}

/**
 * Assert that `fn` throws, and that the message contains `expectedText`.
 * Requiring a substring keeps the tests honest about error messages being part
 * of this toolkit's interface - a parse failure has to say what and where.
 *
 * @param {() => unknown} fn
 * @param {string} expectedText
 * @param {string} [message]
 */
export function assertThrowsWith(fn, expectedText, message = '') {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (thrown === null) {
    assert.fail(`${message || 'call'}: expected it to throw, it returned normally`);
  }
  const text = thrown instanceof Error ? thrown.message : String(thrown);
  if (!text.includes(expectedText)) {
    assert.fail(`${message || 'call'}: expected the error to mention "${expectedText}", got "${text}"`);
  }
}

// --- validation finding helpers ---------------------------------------------

/**
 * @param {Array<{code: string}>} findings
 * @returns {string[]}
 */
export function codes(findings) {
  return findings.map((finding) => finding.code);
}

/**
 * Assert that a validator reported a particular code.
 * @param {Array<{code: string, severity: string}>} findings
 * @param {string} code
 * @param {string} [severity] when given, the finding must also have this severity
 */
export function assertFinding(findings, code, severity) {
  const matches = findings.filter((finding) => finding.code === code);
  if (matches.length === 0) {
    assert.fail(`expected a "${code}" finding, got: [${codes(findings).join(', ') || 'none'}]`);
  }
  if (severity !== undefined && !matches.some((finding) => finding.severity === severity)) {
    assert.fail(
      `expected "${code}" with severity ${severity}, got ${matches.map((f) => f.severity).join(', ')}`
    );
  }
}

/**
 * Assert that a validator did NOT report a particular code.
 * @param {Array<{code: string}>} findings
 * @param {string} code
 */
export function assertNoFinding(findings, code) {
  if (findings.some((finding) => finding.code === code)) {
    assert.fail(`did not expect a "${code}" finding, got: [${codes(findings).join(', ')}]`);
  }
}
