/**
 * Test data.
 *
 * The demo site and the demo trajectory are read from examples/ rather than
 * duplicated here, so that a change to the shipped example data that breaks
 * validation fails the suite instead of going unnoticed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const examplesDir = new URL('../examples/', import.meta.url);

/** @param {string} relativePath */
export function readExample(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, examplesDir)), 'utf8');
}

/** @param {string} relativePath */
export function readExampleJson(relativePath) {
  return JSON.parse(readExample(relativePath));
}

/** The shipped demo site, freshly parsed on every call so tests can mutate it. */
export function demoSite() {
  return readExampleJson('demo_site/site.json');
}

/** The shipped demo trajectory CSV, as text. */
export function demoTrajectoryCsv() {
  return readExample('demo_site/example_trajectory.csv');
}

/** The shipped example manifest. */
export function demoManifest() {
  return readExampleJson('manifest.json');
}

// --- synthetic geometry -----------------------------------------------------

/** @param {number} east @param {number} north */
export const p = (east, north) => ({ east_m: east, north_m: north });

/** A 100 m square, counter-clockwise, first quadrant. Area 10 000 m². */
export const SQUARE_CCW = Object.freeze([p(0, 0), p(100, 0), p(100, 100), p(0, 100)]);

/** The same square wound clockwise. */
export const SQUARE_CW = Object.freeze([p(0, 0), p(0, 100), p(100, 100), p(100, 0)]);

/** A bow tie: the classic self-intersecting quadrilateral. */
export const BOWTIE = Object.freeze([p(0, 0), p(100, 0), p(0, 100), p(100, 100)]);

/** An L shape, so that the bounding box contains points that are outside it. */
export const L_SHAPE = Object.freeze([
  p(0, 0),
  p(100, 0),
  p(100, 40),
  p(40, 40),
  p(40, 100),
  p(0, 100),
]);

/** Three collinear points: a ring with no area. */
export const COLLINEAR = Object.freeze([p(0, 0), p(50, 0), p(100, 0)]);

/**
 * A minimal, valid trajectory point.
 * @param {Partial<{east_m:number,north_m:number,altitude_m:number,heading_deg:number,speed_mps:number}>} overrides
 */
export function point(overrides = {}) {
  return {
    east_m: 0,
    north_m: 0,
    altitude_m: 40,
    heading_deg: 0,
    speed_mps: 5,
    ...overrides,
  };
}

/**
 * A valid trajectory document that lies inside the demo site's safety polygon.
 * @param {Record<string, unknown>} overrides
 */
export function validTrajectory(overrides = {}) {
  return {
    schema_version: 1,
    name: 'test_trajectory',
    frame: 'local_enu',
    heading_reference: 'true_north',
    altitude_reference: 'AGL',
    closed: true,
    speed_mps: 5,
    points: [
      point({ east_m: -50, north_m: -35, heading_deg: 90 }),
      point({ east_m: 50, north_m: -35, heading_deg: 0 }),
      point({ east_m: 50, north_m: 35, heading_deg: 270 }),
      point({ east_m: -50, north_m: 35, heading_deg: 180 }),
    ],
    ...overrides,
  };
}
