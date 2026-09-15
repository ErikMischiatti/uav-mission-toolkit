/**
 * The data shipped in examples/.
 *
 * Every tool loads the example manifest on start-up, so a manifest that points
 * at a file that does not exist, or that records an altitude reference the CSV
 * contradicts, breaks all four tools at once. None of that is visible from the
 * source alone, which is why it is checked here.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { pointInPolygon } from '../shared/js/geo.js';
import { parseTrajectoryCsv } from '../shared/js/trajectory.js';
import { ALTITUDE_REFERENCES, validateSite } from '../shared/js/validation.js';
import { demoManifest, demoSite, readExample } from './fixtures.mjs';
import { assert, describe } from './harness.mjs';

const examplesDir = new URL('../examples/', import.meta.url);

describe('examples: the shipped manifest', (test) => {
  const manifest = demoManifest();

  test('is versioned and lists at least one site', () => {
    assert.equal(manifest.schema_version, 1);
    assert.ok(Array.isArray(manifest.sites) && manifest.sites.length > 0);
  });

  test('every path it lists exists and every site it lists validates', () => {
    for (const site of manifest.sites) {
      assert.ok(site.id, 'a manifest site needs an id');
      const path = fileURLToPath(new URL(site.site_path, examplesDir));
      assert.ok(existsSync(path), `missing site file: ${site.site_path}`);
      assert.deepEqual(validateSite(JSON.parse(readExample(site.site_path))), [], site.site_path);
    }
  });

  test('every trajectory it lists parses and declares its missing metadata', () => {
    for (const site of manifest.sites) {
      for (const trajectory of site.trajectories ?? []) {
        const path = fileURLToPath(new URL(trajectory.csv_path, examplesDir));
        assert.ok(existsSync(path), `missing trajectory file: ${trajectory.csv_path}`);

        const { points } = parseTrajectoryCsv(readExample(trajectory.csv_path), trajectory.csv_path);
        assert.ok(points.length >= 2, `${trajectory.csv_path} needs at least 2 points`);

        // The CSV cannot carry these three facts, so the manifest must.
        assert.ok(
          ALTITUDE_REFERENCES.includes(trajectory.altitude_reference),
          `${trajectory.id}: altitude_reference must be one of ${ALTITUDE_REFERENCES.join(', ')}`
        );
        assert.equal(trajectory.frame, 'local_enu', `${trajectory.id}: frame`);
        assert.equal(typeof trajectory.closed, 'boolean', `${trajectory.id}: closed flag`);
      }
    }
  });

  test('the demo trajectory stays inside the demo site it belongs to', () => {
    const site = demoSite();
    const { points } = parseTrajectoryCsv(readExample('demo_site/example_trajectory.csv'));
    for (const [index, point] of points.entries()) {
      assert.ok(
        pointInPolygon(point, site.safety_area.horizontal),
        `trajectory point ${index} lies outside the demo safety area`
      );
    }
  });

  test('the demo trajectory flies inside the demo altitude band', () => {
    const { safety_area: safety } = demoSite();
    const { points } = parseTrajectoryCsv(readExample('demo_site/example_trajectory.csv'));
    const manifestEntry = manifest.sites[0].trajectories[0];
    assert.equal(manifestEntry.altitude_reference, safety.altitude_reference);
    for (const point of points) {
      assert.ok(
        point.altitude_m >= safety.min_altitude_m && point.altitude_m <= safety.max_altitude_m,
        `altitude ${point.altitude_m} m is outside [${safety.min_altitude_m}, ${safety.max_altitude_m}]`
      );
    }
  });
});
