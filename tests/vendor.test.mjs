/**
 * The vendored third-party assets and the local asset references in the HTML.
 *
 * None of this is visible from the JavaScript sources: a page can reference a
 * stylesheet that does not exist, or keep a CDN URL that quietly reintroduces a
 * network dependency, and every unit test would still pass. A broken path only
 * shows up as a map that does not render, which is exactly the failure this
 * toolkit should not have offline.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assert, describe } from './harness.mjs';

const repoRoot = new URL('../', import.meta.url);
const leafletDir = new URL('shared/vendor/leaflet/', repoRoot);

/** The exact Leaflet release this repository vendors. */
const LEAFLET_VERSION = '1.9.4';

/** Every file the vendored copy must provide. */
const LEAFLET_FILES = Object.freeze([
  'leaflet.js',
  'leaflet.css',
  'LICENSE',
  'images/layers.png',
  'images/layers-2x.png',
  'images/marker-icon.png',
  'images/marker-icon-2x.png',
  'images/marker-shadow.png',
]);

/** Hosts that must not appear in a page's asset references. */
const CDN_HOSTS = Object.freeze(['unpkg.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net']);

function path(url) {
  return fileURLToPath(url);
}

function read(relativePath) {
  return readFileSync(path(new URL(relativePath, repoRoot)), 'utf8');
}

/** Every *.html file in the repository, as repo-relative paths. */
function htmlFiles(dir = repoRoot, prefix = '') {
  const out = [];
  for (const entry of readdirSync(path(dir))) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const child = new URL(`${entry}${statSync(path(new URL(entry, dir))).isDirectory() ? '/' : ''}`, dir);
    if (statSync(path(child)).isDirectory()) out.push(...htmlFiles(child, `${prefix}${entry}/`));
    else if (entry.endsWith('.html')) out.push(`${prefix}${entry}`);
  }
  return out;
}

/** Local (non-absolute, non-protocol) href/src values in a document. */
function localAssetReferences(html) {
  const references = [];
  const pattern = /(?:href|src)\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const value = match[1];
    if (/^(?:[a-z]+:|\/\/|#|mailto:)/i.test(value)) continue;
    references.push(value.split('#')[0].split('?')[0]);
  }
  return references;
}

describe('vendor: the vendored Leaflet copy', (test) => {
  test('ships every file Leaflet needs, and none of them is empty', () => {
    for (const file of LEAFLET_FILES) {
      const filePath = path(new URL(file, leafletDir));
      assert.ok(existsSync(filePath), `missing vendored file: shared/vendor/leaflet/${file}`);
      assert.ok(statSync(filePath).size > 0, `vendored file is empty: ${file}`);
    }
  });

  test('is the exact version the notices claim, taken from Leaflet\'s own banner', () => {
    const source = read('shared/vendor/leaflet/leaflet.js');
    assert.ok(
      source.includes(`Leaflet ${LEAFLET_VERSION}`),
      `shared/vendor/leaflet/leaflet.js does not identify itself as Leaflet ${LEAFLET_VERSION}`
    );
    assert.ok(
      read('THIRD_PARTY_NOTICES.md').includes(`Leaflet ${LEAFLET_VERSION}`),
      'THIRD_PARTY_NOTICES.md does not record the vendored Leaflet version'
    );
  });

  test('carries the license text, because vendoring means redistributing', () => {
    const license = read('shared/vendor/leaflet/LICENSE');
    assert.ok(license.includes('BSD 2-Clause'), 'the vendored LICENSE is not the BSD 2-Clause text');
    assert.ok(license.includes('Copyright'), 'the vendored LICENSE carries no copyright line');
  });

  test('resolves every relative url() in leaflet.css to a file that exists', () => {
    const css = read('shared/vendor/leaflet/leaflet.css');
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)]
      .map((match) => match[1].trim().replace(/^["']|["']$/g, ''))
      // url(#default#VML) is an old-IE behaviour selector, not a file.
      .filter((url) => !url.startsWith('#') && !url.startsWith('data:'));

    assert.ok(urls.length > 0, 'leaflet.css references no images at all, which is suspicious');
    for (const url of urls) {
      assert.ok(
        existsSync(path(new URL(url, leafletDir))),
        `leaflet.css references "${url}", which is not present under shared/vendor/leaflet/`
      );
    }
  });
});

describe('vendor: asset references in the pages', (test) => {
  const pages = htmlFiles();

  test('finds the tool pages it is supposed to check', () => {
    for (const expected of [
      'index.html',
      'site_editor/index.html',
      'site_viewer/index.html',
      'trajectory_editor/index.html',
      'altitude_sweep/index.html',
    ]) {
      assert.ok(pages.includes(expected), `expected to find ${expected}`);
    }
  });

  test('every local href/src in every page resolves to a file that exists', () => {
    for (const page of pages) {
      const html = read(page);
      const pageUrl = new URL(page, repoRoot);
      for (const reference of localAssetReferences(html)) {
        assert.ok(
          existsSync(path(new URL(reference, pageUrl))),
          `${page} references "${reference}", which does not exist`
        );
      }
    }
  });

  test('no page loads a script or stylesheet from a CDN', () => {
    for (const page of pages) {
      const html = read(page);
      for (const host of CDN_HOSTS) {
        assert.ok(
          !html.includes(host),
          `${page} still references ${host}; the toolkit must run without an internet connection`
        );
      }
    }
  });

  test('both map tools load the vendored Leaflet, not a remote copy', () => {
    for (const page of ['site_editor/index.html', 'site_viewer/index.html']) {
      const html = read(page);
      assert.ok(
        html.includes('../shared/vendor/leaflet/leaflet.js'),
        `${page} does not load the vendored leaflet.js`
      );
      assert.ok(
        html.includes('../shared/vendor/leaflet/leaflet.css'),
        `${page} does not load the vendored leaflet.css`
      );
    }
  });

  test('only the map tools pull Leaflet in at all', () => {
    for (const page of ['index.html', 'trajectory_editor/index.html', 'altitude_sweep/index.html']) {
      assert.ok(
        !read(page).includes('vendor/leaflet'),
        `${page} loads Leaflet but has no map; that is dead weight`
      );
    }
  });
});
