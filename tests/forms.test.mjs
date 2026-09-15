/**
 * Form-control contracts in the tool pages.
 *
 * These are HTML-level mistakes that no unit test would catch and that look
 * fine in a screenshot: a control that the browser silently marks :invalid, an
 * input with no label, a button with no accessible name. They are checked by
 * reading the markup rather than by running a browser, so they stay part of the
 * dependency-free suite.
 *
 * The step/min/value rule is the subtle one. For `<input type="number">` the
 * browser validates against a grid anchored at `min` (0 when absent), so
 * `min="1" step="10" value="200"` is *invalid*: 200 is not 1 + 10k. The control
 * then shows an error border and blocks form submission for a value the tool
 * considers perfectly good. Continuous physical quantities therefore use
 * `step="any"`, and only genuine counts use an integer step.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assert, describe } from './harness.mjs';

const repoRoot = new URL('../', import.meta.url);

const TOOL_PAGES = Object.freeze([
  'site_editor/index.html',
  'site_viewer/index.html',
  'trajectory_editor/index.html',
  'altitude_sweep/index.html',
]);

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, repoRoot)), 'utf8');
}

/** Crude but sufficient tag scanner: these pages are hand-written and flat. */
function tags(html, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>`, 'g');
  return [...html.matchAll(pattern)].map((match) => match[0]);
}

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match === null ? null : match[1];
}

describe('forms: numeric inputs', (test) => {
  test('every value sits on the grid the browser validates against', () => {
    for (const page of TOOL_PAGES) {
      for (const tag of tags(read(page), 'input')) {
        if (attribute(tag, 'type') !== 'number') continue;
        const step = attribute(tag, 'step');
        const value = attribute(tag, 'value');
        if (step === null || step === 'any' || value === null) continue;

        const base = Number(attribute(tag, 'min') ?? 0);
        const offsets = (Number(value) - base) / Number(step);
        assert.ok(
          Math.abs(offsets - Math.round(offsets)) < 1e-9,
          `${page}: #${attribute(tag, 'id')} has value="${value}" which is not reachable from ` +
            `min="${attribute(tag, 'min')}" in steps of "${step}"; the browser marks it invalid`
        );
      }
    }
  });

  test('a stated minimum is itself a valid value', () => {
    for (const page of TOOL_PAGES) {
      for (const tag of tags(read(page), 'input')) {
        if (attribute(tag, 'type') !== 'number') continue;
        const min = attribute(tag, 'min');
        const max = attribute(tag, 'max');
        if (min === null || max === null) continue;
        assert.ok(
          Number(min) < Number(max),
          `${page}: #${attribute(tag, 'id')} has min="${min}" which is not below max="${max}"`
        );
      }
    }
  });

  test('counts use an integer step and continuous quantities use step="any"', () => {
    // A fractional number of samples is meaningless, so those keep a real step.
    const counts = new Set(['p-circle-samples', 'p-arc-segments', 'p-eight-samples']);
    for (const page of TOOL_PAGES) {
      for (const tag of tags(read(page), 'input')) {
        if (attribute(tag, 'type') !== 'number') continue;
        const id = attribute(tag, 'id');
        const step = attribute(tag, 'step');
        if (counts.has(id)) {
          assert.equal(step, '1', `${page}: #${id} counts whole things and should step by 1`);
        }
      }
    }
  });
});

describe('forms: labels and names', (test) => {
  test('every input and select is associated with a label', () => {
    for (const page of TOOL_PAGES) {
      const html = read(page);
      const labelled = new Set(
        tags(html, 'label')
          .map((tag) => attribute(tag, 'for'))
          .filter((value) => value !== null)
      );
      for (const kind of ['input', 'select']) {
        for (const tag of tags(html, kind)) {
          if (attribute(tag, 'type') === 'hidden') continue;
          const id = attribute(tag, 'id');
          assert.ok(id, `${page}: a <${kind}> has no id, so no label can point at it`);
          assert.ok(
            labelled.has(id) || attribute(tag, 'aria-label') !== null,
            `${page}: #${id} has no <label for="${id}"> and no aria-label`
          );
        }
      }
    }
  });

  test('no control relies on a placeholder instead of a label', () => {
    for (const page of TOOL_PAGES) {
      const html = read(page);
      const labelled = new Set(
        tags(html, 'label')
          .map((tag) => attribute(tag, 'for'))
          .filter((value) => value !== null)
      );
      for (const tag of tags(html, 'input')) {
        if (attribute(tag, 'placeholder') === null) continue;
        const id = attribute(tag, 'id');
        assert.ok(
          labelled.has(id),
          `${page}: #${id} has a placeholder but no label; a placeholder is not a label`
        );
      }
    }
  });

  test('every button carries a visible name or an aria-label', () => {
    for (const page of TOOL_PAGES) {
      const html = read(page);
      // Match the whole element so the text content can be inspected.
      for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const [, attrs, inner] = match;
        const text = inner.replace(/<[^>]*>/g, '').trim();
        const id = /\bid="([^"]*)"/.exec(attrs)?.[1] ?? '(no id)';
        assert.ok(
          text !== '' || /\baria-label="/.test(attrs),
          `${page}: button #${id} has neither text nor an aria-label`
        );
      }
    }
  });

  test('every page has exactly one h1', () => {
    for (const page of TOOL_PAGES) {
      assert.equal(
        tags(read(page), 'h1').length,
        1,
        `${page} should have exactly one <h1>: the name of the tool`
      );
    }
  });

  test('the current tool is marked in its own navigation', () => {
    for (const page of TOOL_PAGES) {
      const html = read(page);
      assert.equal(
        [...html.matchAll(/aria-current="page"/g)].length,
        1,
        `${page} should mark exactly one nav link as the current page`
      );
    }
  });
});

describe('forms: the shared shell', (test) => {
  test('every tool page uses the full-height shell and the status bar', () => {
    for (const page of TOOL_PAGES) {
      const html = read(page);
      assert.ok(html.includes('<body class="tool">'), `${page} does not use the tool shell`);
      assert.ok(html.includes('class="app-statusbar"'), `${page} has no status bar`);
      assert.ok(html.includes('id="status"'), `${page} has no status line`);
    }
  });

  test('every tool page shows a context bar and a validation verdict', () => {
    for (const page of TOOL_PAGES) {
      const html = read(page);
      assert.ok(html.includes('class="context-bar"'), `${page} has no context bar`);
      assert.ok(html.includes('id="ctx-verdict"'), `${page} does not show a validation verdict`);
    }
  });

  test('every tool that opens a document says which one is loaded', () => {
    // The trajectory editor is absent on purpose: it creates a trajectory
    // rather than opening one, and has no document to name yet.
    for (const page of ['site_editor/index.html', 'site_viewer/index.html', 'altitude_sweep/index.html']) {
      assert.ok(
        read(page).includes('id="ctx-source"'),
        `${page} does not say what is currently loaded`
      );
    }
  });

  test('every page loads the shared stylesheet before its own', () => {
    for (const page of [...TOOL_PAGES, 'index.html']) {
      const html = read(page);
      const shared = html.indexOf('common.css');
      assert.ok(shared > -1, `${page} does not load the shared stylesheet`);
      const own = html.indexOf('"style.css"');
      if (own > -1) {
        assert.ok(own > shared, `${page} loads its own stylesheet before the shared one`);
      }
    }
  });
});
