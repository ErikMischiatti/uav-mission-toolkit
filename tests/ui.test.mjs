/**
 * The parts of shared/js/ui.js that are pure logic.
 *
 * Most of that module touches the DOM and is deliberately not covered here (a
 * DOM shim would be a dependency). `summarizeFindings` is the exception: it
 * decides the single line a reader uses to answer "is this safe to export?",
 * so its edge cases are worth pinning down.
 */

import { GLOSSARY, summarizeFindings } from '../shared/js/ui.js';
import { assert, describe } from './harness.mjs';

const error = (code = 'x') => ({ severity: 'error', code, message: code });
const warning = (code = 'x') => ({ severity: 'warning', code, message: code });
const note = (code = 'x') => ({ severity: 'info', code, message: code });

describe('ui: validation verdict', (test) => {
  test('an empty finding list is simply valid', () => {
    const verdict = summarizeFindings([]);
    assert.equal(verdict.level, 'ok');
    assert.equal(verdict.text, 'Valid');
    assert.equal(verdict.glyph, '✓');
  });

  test('informational notes do not make a document invalid', () => {
    const verdict = summarizeFindings([note('a'), note('b')]);
    assert.equal(verdict.level, 'ok');
    assert.equal(verdict.text, 'Valid · 2 notes');
  });

  test('a warning downgrades the verdict but is not an error', () => {
    const verdict = summarizeFindings([warning()]);
    assert.equal(verdict.level, 'warning');
    assert.equal(verdict.text, '1 warning');
  });

  test('any error dominates, whatever else is present', () => {
    const verdict = summarizeFindings([note(), warning(), error()]);
    assert.equal(verdict.level, 'error');
    assert.equal(verdict.glyph, '✕');
  });

  test('errors and warnings are counted and joined, worst first', () => {
    const verdict = summarizeFindings([error('a'), error('b'), warning('c')]);
    assert.equal(verdict.text, '2 errors · 1 warning');
  });

  test('notes are not listed once there is something worse to say', () => {
    const verdict = summarizeFindings([error(), note(), note()]);
    assert.equal(verdict.text, '1 error');
  });

  test('singular and plural are both correct', () => {
    assert.equal(summarizeFindings([error()]).text, '1 error');
    assert.equal(summarizeFindings([error('a'), error('b')]).text, '2 errors');
    assert.equal(summarizeFindings([warning()]).text, '1 warning');
    assert.equal(summarizeFindings([warning('a'), warning('b')]).text, '2 warnings');
  });

  test('an idle document reports neither valid nor invalid', () => {
    const verdict = summarizeFindings([], { idle: true });
    assert.equal(verdict.level, 'idle');
    assert.equal(verdict.text, 'Nothing loaded');
    assert.equal(summarizeFindings([], { idle: true, idleText: 'No trajectory' }).text, 'No trajectory');
  });

  test('an unknown severity is ignored rather than crashing the summary', () => {
    const verdict = summarizeFindings([{ severity: 'debug', code: 'x', message: 'x' }]);
    assert.equal(verdict.level, 'ok');
  });

  test('every verdict carries a glyph, so colour is never the only signal', () => {
    for (const findings of [[], [warning()], [error()]]) {
      assert.ok(summarizeFindings(findings).glyph.length > 0);
    }
    assert.ok(summarizeFindings([], { idle: true }).glyph.length > 0);
  });
});

describe('ui: glossary', (test) => {
  test('defines every term the tools attach a help affordance to', () => {
    for (const term of ['ENU', 'AGL', 'AMSL', 'ATO', 'heading']) {
      assert.equal(typeof GLOSSARY[term], 'string', `missing glossary entry: ${term}`);
      assert.ok(GLOSSARY[term].length > 20, `glossary entry for ${term} is too short to help`);
    }
  });

  test('keeps the explanations short enough for a tooltip', () => {
    for (const [term, text] of Object.entries(GLOSSARY)) {
      assert.ok(text.length < 200, `glossary entry for ${term} is too long for a tooltip`);
    }
  });
});
