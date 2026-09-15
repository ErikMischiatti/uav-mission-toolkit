/**
 * Shape presets for the trajectory editor.
 *
 * Every preset returns control points in the local ENU plane (metres) together
 * with whether the resulting path is closed. Altitude, speed and heading are
 * not the presets' business - they are applied by the editor.
 *
 * The parameters are geometric (lengths, radii, sample counts), so having
 * defaults for them in the UI is a convenience, not a hidden safety value.
 */

/** Angles are measured clockwise from north, matching the project convention. */
const DEG_TO_RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** @typedef {{east_m: number, north_m: number}} LocalPoint */
/** @typedef {{points: LocalPoint[], closed: boolean}} PresetResult */

export const PRESET_IDS = Object.freeze([
  'straight',
  'circle',
  'racetrack',
  'figure_eight',
]);

/**
 * Build the control points for a preset.
 *
 * @param {string} id one of PRESET_IDS
 * @param {Record<string, number>} params
 * @returns {PresetResult}
 */
export function buildPreset(id, params) {
  switch (id) {
    case 'straight':
      return straight(params);
    case 'circle':
      return circle(params);
    case 'racetrack':
      return racetrack(params);
    case 'figure_eight':
      return figureEight(params);
    default:
      throw new Error(`Unknown trajectory preset "${id}".`);
  }
}

/**
 * A single leg starting at the local origin and running in the given direction.
 * @param {{length_m: number, heading_deg: number}} params
 * @returns {PresetResult}
 */
function straight({ length_m: length, heading_deg: heading }) {
  requirePositive(length, 'Length');
  requireFinite(heading, 'Direction');
  const rad = heading * DEG_TO_RAD;
  return {
    points: [
      { east_m: 0, north_m: 0 },
      { east_m: length * Math.sin(rad), north_m: length * Math.cos(rad) },
    ],
    closed: false,
  };
}

/**
 * A circle around the local origin, sampled clockwise starting at due north.
 * @param {{radius_m: number, samples: number}} params
 * @returns {PresetResult}
 */
function circle({ radius_m: radius, samples }) {
  requirePositive(radius, 'Radius');
  requireIntegerAtLeast(samples, 3, 'Number of points');
  const points = [];
  for (let i = 0; i < samples; i += 1) {
    const t = (TWO_PI * i) / samples;
    points.push({ east_m: radius * Math.sin(t), north_m: radius * Math.cos(t) });
  }
  return { points, closed: true };
}

/**
 * Two straights along east joined by semicircular turns.
 * @param {{straight_length_m: number, turn_radius_m: number, arc_segments: number}} params
 * @returns {PresetResult}
 */
function racetrack({
  straight_length_m: straightLength,
  turn_radius_m: turnRadius,
  arc_segments: arcSegments,
}) {
  requireNonNegative(straightLength, 'Straight length');
  requirePositive(turnRadius, 'Turn radius');
  requireIntegerAtLeast(arcSegments, 1, 'Arc segments');

  const half = straightLength / 2;
  const points = [
    { east_m: -half, north_m: -turnRadius },
    { east_m: half, north_m: -turnRadius },
  ];
  points.push(...arcInterior(half, 0, turnRadius, -90, 90, arcSegments));
  points.push({ east_m: half, north_m: turnRadius });
  points.push({ east_m: -half, north_m: turnRadius });
  points.push(...arcInterior(-half, 0, turnRadius, 90, 270, arcSegments));
  return { points, closed: true };
}

/**
 * A figure eight (Gerono lemniscate) centred on the local origin, crossing
 * itself at the origin.
 * @param {{width_m: number, height_m: number, samples: number}} params
 * @returns {PresetResult}
 */
function figureEight({ width_m: width, height_m: height, samples }) {
  requirePositive(width, 'Width');
  requirePositive(height, 'Height');
  requireIntegerAtLeast(samples, 8, 'Number of points');

  const points = [];
  for (let i = 0; i < samples; i += 1) {
    const t = (TWO_PI * i) / samples;
    points.push({
      east_m: (width / 2) * Math.sin(t),
      // sin(t)cos(t) peaks at 0.5, so the north extent is exactly height_m.
      north_m: height * Math.sin(t) * Math.cos(t),
    });
  }
  return { points, closed: true };
}

/**
 * Interior points of an arc in standard mathematical convention (degrees
 * counter-clockwise from +east), endpoints excluded because the callers add
 * them explicitly.
 */
function arcInterior(centerEast, centerNorth, radius, startDeg, endDeg, segments) {
  const points = [];
  for (let i = 1; i < segments; i += 1) {
    const angle = (startDeg + ((endDeg - startDeg) * i) / segments) * DEG_TO_RAD;
    points.push({
      east_m: centerEast + radius * Math.cos(angle),
      north_m: centerNorth + radius * Math.sin(angle),
    });
  }
  return points;
}

function requireFinite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a number.`);
}

function requirePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
}

function requireNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be zero or greater.`);
  }
}

function requireIntegerAtLeast(value, minimum, label) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be a whole number of at least ${minimum}.`);
  }
}
