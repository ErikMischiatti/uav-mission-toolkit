/**
 * The project-owned trajectory format: JSON document and the flat CSV form.
 *
 * Both representations are documented in docs/file_formats.md.
 *
 * Important asymmetry, stated here so nobody has to rediscover it:
 * the JSON document carries the frame and the altitude reference; the CSV does
 * NOT. A CSV is a list of numbers and cannot describe what its altitude column
 * means. Any tool that consumes a trajectory CSV must obtain the altitude
 * reference from the user or from an accompanying JSON document, and this
 * toolkit refuses to guess one.
 */

import { bearingDeg, distance3dM, pathLengthM } from './geo.js';
import {
  formatFixed,
  parseCsv,
  parseStrictNumber,
  requireCsvColumns,
  roundTo,
  toCsv,
} from './io.js';
import { TRAJECTORY_SCHEMA_VERSION } from './validation.js';

/**
 * The columns of the trajectory CSV, in the order they are written. Readers
 * look columns up by name, so a file with a different column order is still
 * accepted.
 */
export const TRAJECTORY_CSV_COLUMNS = Object.freeze([
  'east_m',
  'north_m',
  'altitude_m',
  'heading_deg',
  'speed_mps',
]);

/**
 * Parse a trajectory CSV into points.
 *
 * @param {string} text
 * @param {string} sourceLabel used in error messages
 * @returns {{points: Array<{east_m:number,north_m:number,altitude_m:number,heading_deg:number,speed_mps:number,line:number}>, headers: string[]}}
 */
export function parseTrajectoryCsv(text, sourceLabel = 'trajectory CSV') {
  const { headers, rows } = parseCsv(text, sourceLabel);
  requireCsvColumns(headers, TRAJECTORY_CSV_COLUMNS, sourceLabel);

  if (rows.length === 0) {
    throw new Error(`${sourceLabel} contains a header row but no data rows.`);
  }

  const points = rows.map((row) => ({
    east_m: parseStrictNumber(row.east_m, `${sourceLabel} line ${row.__line}, column east_m`),
    north_m: parseStrictNumber(row.north_m, `${sourceLabel} line ${row.__line}, column north_m`),
    altitude_m: parseStrictNumber(
      row.altitude_m,
      `${sourceLabel} line ${row.__line}, column altitude_m`
    ),
    heading_deg: parseStrictNumber(
      row.heading_deg,
      `${sourceLabel} line ${row.__line}, column heading_deg`
    ),
    speed_mps: parseStrictNumber(
      row.speed_mps,
      `${sourceLabel} line ${row.__line}, column speed_mps`
    ),
    line: row.__line,
  }));

  return { points, headers };
}

/**
 * Serialise points to the trajectory CSV form.
 * @param {Array<object>} points
 * @returns {string}
 */
export function trajectoryToCsv(points) {
  const rows = points.map((point, index) => {
    for (const column of TRAJECTORY_CSV_COLUMNS) {
      if (!Number.isFinite(point[column])) {
        throw new Error(
          `Cannot export point ${index}: "${column}" is ${JSON.stringify(point[column])}. ` +
            `Every exported column must hold a finite number.`
        );
      }
    }
    return {
      east_m: formatFixed(point.east_m),
      north_m: formatFixed(point.north_m),
      altitude_m: formatFixed(point.altitude_m),
      heading_deg: formatFixed(point.heading_deg),
      speed_mps: formatFixed(point.speed_mps),
    };
  });
  return toCsv([...TRAJECTORY_CSV_COLUMNS], rows);
}

/**
 * Assemble a trajectory JSON document. Every field that matters for
 * interpretation is required; there are no optional safety-critical arguments.
 *
 * @param {{name: string, points: Array<object>, speedMps: number,
 *          altitudeReference: string, closed: boolean, description?: string}} spec
 * @returns {object}
 */
export function buildTrajectoryDocument(spec) {
  const { name, points, speedMps, altitudeReference, closed, description } = spec;

  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('A trajectory document needs a non-empty name.');
  }
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('A trajectory document needs at least 2 points.');
  }
  if (!Number.isFinite(speedMps) || speedMps <= 0) {
    throw new Error('A trajectory document needs a positive speed_mps.');
  }
  if (typeof altitudeReference !== 'string' || altitudeReference === '') {
    throw new Error(
      'A trajectory document needs an explicit altitude_reference (AGL, AMSL or ATO).'
    );
  }
  if (typeof closed !== 'boolean') {
    throw new Error('A trajectory document needs an explicit "closed" flag.');
  }

  const document = {
    schema_version: TRAJECTORY_SCHEMA_VERSION,
    name,
    frame: 'local_enu',
    heading_reference: 'true_north',
    altitude_reference: altitudeReference,
    closed,
    speed_mps: roundTo(speedMps),
    points: points.map((point) => ({
      east_m: roundTo(point.east_m),
      north_m: roundTo(point.north_m),
      altitude_m: roundTo(point.altitude_m),
      heading_deg: roundTo(point.heading_deg),
      speed_mps: roundTo(point.speed_mps),
    })),
  };
  if (typeof description === 'string' && description.trim() !== '') {
    document.description = description;
  }
  return document;
}

/**
 * Compute the heading of every point as the bearing to the next point (the
 * path tangent). The final point of an open path reuses the previous heading,
 * because a trajectory that ends nowhere has no forward direction.
 *
 * When two consecutive points coincide the bearing is undefined; the previous
 * usable heading is carried forward, and the first point falls back to the
 * caller-supplied `fallbackHeadingDeg`, which must be explicit.
 *
 * @param {Array<{east_m:number,north_m:number}>} points
 * @param {{closed: boolean, fallbackHeadingDeg: number}} options
 * @returns {number[]} one heading per point, degrees clockwise from true north
 */
export function computePathHeadings(points, options) {
  const { closed, fallbackHeadingDeg } = options;
  if (!Number.isFinite(fallbackHeadingDeg)) {
    throw new Error('computePathHeadings requires an explicit finite fallbackHeadingDeg.');
  }

  const headings = new Array(points.length).fill(null);
  for (let i = 0; i < points.length; i += 1) {
    const isLast = i === points.length - 1;
    if (isLast && !closed) {
      headings[i] = null; // resolved below by carrying the previous heading
      continue;
    }
    const next = points[(i + 1) % points.length];
    headings[i] = bearingDeg(points[i], next);
  }

  // Forward pass: carry the previous heading over undefined bearings.
  let carried = null;
  for (let i = 0; i < headings.length; i += 1) {
    if (headings[i] === null) headings[i] = carried;
    else carried = headings[i];
  }
  // Backward pass: only leading entries can still be null (nothing preceded
  // them); give them the first heading that is actually defined, or the
  // caller's explicit fallback if the whole path is degenerate.
  let nextKnown = fallbackHeadingDeg;
  for (let i = headings.length - 1; i >= 0; i -= 1) {
    if (headings[i] === null) headings[i] = nextKnown;
    else nextKnown = headings[i];
  }
  return headings;
}

/**
 * Path length and the duration implied by a constant ground speed.
 *
 * The duration is a first-order estimate only: it ignores acceleration,
 * deceleration, turn radius and any hold time at waypoints.
 *
 * @param {Array<{east_m:number,north_m:number,altitude_m:number}>} points
 * @param {{closed: boolean, speedMps: number}} options
 * @returns {{lengthM: number, durationS: number|null}}
 */
export function trajectoryMetrics(points, options) {
  const { closed, speedMps } = options;
  const lengthM = pathLengthM(points, { closed, threeD: true });
  const durationS = Number.isFinite(speedMps) && speedMps > 0 ? lengthM / speedMps : null;
  return { lengthM, durationS };
}

/**
 * Longest single segment of a path, useful for spotting a stray point.
 * @param {Array<object>} points
 * @param {boolean} closed
 * @returns {number} metres
 */
export function longestSegmentM(points, closed) {
  if (points.length < 2) return 0;
  let longest = 0;
  const limit = closed ? points.length : points.length - 1;
  for (let i = 0; i < limit; i += 1) {
    longest = Math.max(longest, distance3dM(points[i], points[(i + 1) % points.length]));
  }
  return longest;
}

/**
 * Produce a copy of the points with every altitude replaced. Used by the
 * altitude sweep; it is intentionally the only thing that tool changes.
 *
 * @param {Array<object>} points
 * @param {number} altitudeM
 * @returns {Array<object>}
 */
export function withAltitude(points, altitudeM) {
  if (!Number.isFinite(altitudeM)) {
    throw new Error(`withAltitude requires a finite altitude, got ${JSON.stringify(altitudeM)}.`);
  }
  return points.map((point) => ({ ...point, altitude_m: altitudeM }));
}
