/**
 * Geodetic and local-frame geometry helpers.
 *
 * This module is the ONLY place in the toolkit where WGS84 latitude/longitude
 * is converted to/from the project-local ENU frame. Keeping the conversion
 * isolated means it can later be replaced by a real geodesy implementation
 * (GeographicLib, proj4, ...) without touching any of the tools.
 *
 * ACCURACY WARNING
 * ----------------
 * The conversion implemented here is a local tangent-plane ("flat earth")
 * approximation: the WGS84 radii of curvature are evaluated once at the site
 * origin and then used as constant metres-per-degree scale factors. It is
 * adequate for operating areas of a few kilometres. It is NOT survey-grade
 * geodesy. See docs/coordinate_frames.md for the derivation, the assumptions
 * and the error budget.
 *
 * Units are SI throughout: metres, seconds, metres per second. Angles are in
 * degrees at module boundaries (and converted internally) because every file
 * format in this project stores degrees.
 */

/** WGS84 semi-major axis. */
export const WGS84_SEMI_MAJOR_AXIS_M = 6378137.0;
/** WGS84 flattening. */
export const WGS84_FLATTENING = 1 / 298.257223563;
/** WGS84 first eccentricity squared. */
export const WGS84_ECCENTRICITY_SQ =
  WGS84_FLATTENING * (2 - WGS84_FLATTENING);

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Distance from the origin beyond which the flat-earth approximation should no
 * longer be trusted for mission planning. Tools emit a warning above this.
 * See docs/coordinate_frames.md for where this number comes from.
 */
export const LOCAL_FRAME_RECOMMENDED_RADIUS_M = 5000;

/** A full turn, used instead of a bare 360 in heading arithmetic. */
const FULL_TURN_DEG = 360;

/**
 * Meridional radius of curvature (north-south) at a given latitude.
 * @param {number} latitudeDeg
 * @returns {number} radius in metres
 */
export function meridionalRadiusM(latitudeDeg) {
  const sinLat = Math.sin(latitudeDeg * DEG_TO_RAD);
  const w = Math.sqrt(1 - WGS84_ECCENTRICITY_SQ * sinLat * sinLat);
  return (WGS84_SEMI_MAJOR_AXIS_M * (1 - WGS84_ECCENTRICITY_SQ)) / (w * w * w);
}

/**
 * Prime vertical radius of curvature (east-west) at a given latitude.
 * @param {number} latitudeDeg
 * @returns {number} radius in metres
 */
export function primeVerticalRadiusM(latitudeDeg) {
  const sinLat = Math.sin(latitudeDeg * DEG_TO_RAD);
  const w = Math.sqrt(1 - WGS84_ECCENTRICITY_SQ * sinLat * sinLat);
  return WGS84_SEMI_MAJOR_AXIS_M / w;
}

/**
 * Local metres-per-degree scale factors at a given latitude. These are the
 * constants that define the tangent plane for a site.
 *
 * @param {number} latitudeDeg
 * @returns {{north_m_per_deg: number, east_m_per_deg: number}}
 */
export function metersPerDegree(latitudeDeg) {
  assertFiniteNumber(latitudeDeg, 'latitudeDeg');
  const latRad = latitudeDeg * DEG_TO_RAD;
  return {
    north_m_per_deg: meridionalRadiusM(latitudeDeg) * DEG_TO_RAD,
    east_m_per_deg: primeVerticalRadiusM(latitudeDeg) * Math.cos(latRad) * DEG_TO_RAD,
  };
}

/**
 * Convert a WGS84 position to local ENU metres relative to a site origin.
 *
 * Only the horizontal components are returned. The vertical axis is
 * deliberately NOT handled here: an altitude number is meaningless without its
 * reference (AGL / AMSL / ATO), and this project never guesses one. Each tool
 * carries the altitude reference explicitly alongside the altitude value.
 *
 * @param {{latitude_deg: number, longitude_deg: number}} origin
 * @param {{latitude_deg: number, longitude_deg: number}} point
 * @returns {{east_m: number, north_m: number}}
 */
export function geodeticToEnu(origin, point) {
  assertFiniteNumber(origin?.latitude_deg, 'origin.latitude_deg');
  assertFiniteNumber(origin?.longitude_deg, 'origin.longitude_deg');
  assertFiniteNumber(point?.latitude_deg, 'point.latitude_deg');
  assertFiniteNumber(point?.longitude_deg, 'point.longitude_deg');

  const scale = metersPerDegree(origin.latitude_deg);
  const dLon = normalizeLongitudeDeltaDeg(point.longitude_deg - origin.longitude_deg);
  const dLat = point.latitude_deg - origin.latitude_deg;

  return {
    east_m: dLon * scale.east_m_per_deg,
    north_m: dLat * scale.north_m_per_deg,
  };
}

/**
 * Convert local ENU metres back to WGS84 latitude/longitude.
 * Inverse of {@link geodeticToEnu}; the same tangent-plane caveats apply.
 *
 * @param {{latitude_deg: number, longitude_deg: number}} origin
 * @param {{east_m: number, north_m: number}} enu
 * @returns {{latitude_deg: number, longitude_deg: number}}
 */
export function enuToGeodetic(origin, enu) {
  assertFiniteNumber(origin?.latitude_deg, 'origin.latitude_deg');
  assertFiniteNumber(origin?.longitude_deg, 'origin.longitude_deg');
  assertFiniteNumber(enu?.east_m, 'enu.east_m');
  assertFiniteNumber(enu?.north_m, 'enu.north_m');

  const scale = metersPerDegree(origin.latitude_deg);
  // east_m_per_deg collapses to zero at the poles; refuse rather than divide by ~0.
  if (Math.abs(scale.east_m_per_deg) < 1e-6) {
    throw new Error(
      'Cannot convert ENU to geodetic: the site origin is too close to a pole ' +
        'for the local tangent-plane approximation.'
    );
  }

  return {
    latitude_deg: origin.latitude_deg + enu.north_m / scale.north_m_per_deg,
    longitude_deg: origin.longitude_deg + enu.east_m / scale.east_m_per_deg,
  };
}

/**
 * Wrap a longitude difference into [-180, 180) so that a site straddling the
 * antimeridian does not produce a ~40 000 km offset.
 * @param {number} deltaDeg
 * @returns {number}
 */
export function normalizeLongitudeDeltaDeg(deltaDeg) {
  let d = deltaDeg;
  while (d >= 180) d -= FULL_TURN_DEG;
  while (d < -180) d += FULL_TURN_DEG;
  return d;
}

/**
 * Normalize a heading into [0, 360).
 * @param {number} headingDeg
 * @returns {number}
 */
export function normalizeHeadingDeg(headingDeg) {
  assertFiniteNumber(headingDeg, 'headingDeg');
  const wrapped = headingDeg % FULL_TURN_DEG;
  return wrapped < 0 ? wrapped + FULL_TURN_DEG : wrapped;
}

/**
 * Project heading convention: degrees clockwise from local frame North,
 * i.e. 0 = North (+Y / +north_m), 90 = East (+X / +east_m). Always [0, 360).
 *
 * @param {{east_m: number, north_m: number}} from
 * @param {{east_m: number, north_m: number}} to
 * @returns {number|null} null when the two points coincide (heading undefined)
 */
export function bearingDeg(from, to) {
  const dEast = to.east_m - from.east_m;
  const dNorth = to.north_m - from.north_m;
  if (dEast === 0 && dNorth === 0) return null;
  return normalizeHeadingDeg(Math.atan2(dEast, dNorth) * RAD_TO_DEG);
}

/**
 * Horizontal distance between two local points.
 * @param {{east_m: number, north_m: number}} a
 * @param {{east_m: number, north_m: number}} b
 * @returns {number} metres
 */
export function distance2dM(a, b) {
  return Math.hypot(b.east_m - a.east_m, b.north_m - a.north_m);
}

/**
 * 3D distance between two local points. Both points must use the SAME altitude
 * reference; this function cannot check that and does not try to.
 * @param {{east_m: number, north_m: number, altitude_m: number}} a
 * @param {{east_m: number, north_m: number, altitude_m: number}} b
 * @returns {number} metres
 */
export function distance3dM(a, b) {
  return Math.hypot(
    b.east_m - a.east_m,
    b.north_m - a.north_m,
    b.altitude_m - a.altitude_m
  );
}

/**
 * Total length of a polyline.
 * @param {Array<{east_m:number,north_m:number,altitude_m?:number}>} points
 * @param {{closed?: boolean, threeD?: boolean}} [options]
 * @returns {number} metres
 */
export function pathLengthM(points, options = {}) {
  const { closed = false, threeD = false } = options;
  if (!Array.isArray(points) || points.length < 2) return 0;
  const measure = threeD ? distance3dM : distance2dM;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += measure(points[i - 1], points[i]);
  }
  if (closed) {
    total += measure(points[points.length - 1], points[0]);
  }
  return total;
}

/**
 * Ray-casting point-in-polygon test. Points exactly on an edge are treated as
 * inside is NOT guaranteed - boundary cases are numerically ambiguous and the
 * callers of this function treat "on the fence" as a planning problem anyway.
 *
 * @param {{east_m:number,north_m:number}} point
 * @param {Array<{east_m:number,north_m:number}>} polygon ring, not repeating the first vertex
 * @returns {boolean}
 */
export function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].east_m;
    const yi = polygon[i].north_m;
    const xj = polygon[j].east_m;
    const yj = polygon[j].north_m;
    const crossesRay = yi > point.north_m !== yj > point.north_m;
    if (!crossesRay) continue;
    const intersectEast = ((xj - xi) * (point.north_m - yi)) / (yj - yi) + xi;
    if (point.east_m < intersectEast) inside = !inside;
  }
  return inside;
}

/**
 * Signed area of a polygon ring (shoelace). Positive = counter-clockwise.
 * @param {Array<{east_m:number,north_m:number}>} polygon
 * @returns {number} square metres
 */
export function polygonSignedAreaM2(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    sum += (polygon[j].east_m + polygon[i].east_m) * (polygon[j].north_m - polygon[i].north_m);
  }
  return -sum / 2;
}

/**
 * Unsigned polygon area.
 * @param {Array<{east_m:number,north_m:number}>} polygon
 * @returns {number} square metres
 */
export function polygonAreaM2(polygon) {
  return Math.abs(polygonSignedAreaM2(polygon));
}

/**
 * Polygon perimeter (the ring is implicitly closed).
 * @param {Array<{east_m:number,north_m:number}>} polygon
 * @returns {number} metres
 */
export function polygonPerimeterM(polygon) {
  return pathLengthM(polygon, { closed: true });
}

/**
 * Arithmetic mean of the vertices. Good enough for placing a label; this is not
 * the area centroid.
 * @param {Array<{east_m:number,north_m:number}>} polygon
 * @returns {{east_m:number,north_m:number}|null}
 */
export function verticesMean(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  const sum = polygon.reduce(
    (acc, p) => ({ east_m: acc.east_m + p.east_m, north_m: acc.north_m + p.north_m }),
    { east_m: 0, north_m: 0 }
  );
  return {
    east_m: sum.east_m / polygon.length,
    north_m: sum.north_m / polygon.length,
  };
}

/**
 * Axis-aligned bounding box of a set of local points.
 * @param {Array<{east_m:number,north_m:number}>} points
 * @returns {{min_east_m:number,max_east_m:number,min_north_m:number,max_north_m:number,width_m:number,height_m:number}|null}
 */
export function boundingBox(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.east_m) || !Number.isFinite(p.north_m)) continue;
    minE = Math.min(minE, p.east_m);
    maxE = Math.max(maxE, p.east_m);
    minN = Math.min(minN, p.north_m);
    maxN = Math.max(maxN, p.north_m);
  }
  if (!Number.isFinite(minE) || !Number.isFinite(minN)) return null;
  return {
    min_east_m: minE,
    max_east_m: maxE,
    min_north_m: minN,
    max_north_m: maxN,
    width_m: maxE - minE,
    height_m: maxN - minN,
  };
}

/**
 * Largest distance of any point from the local origin (0, 0). Used to warn when
 * a site outgrows the tangent-plane approximation.
 * @param {Array<{east_m:number,north_m:number}>} points
 * @returns {number} metres, 0 for an empty list
 */
export function maxRadiusFromOriginM(points) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  return points.reduce(
    (max, p) => Math.max(max, Math.hypot(p.east_m, p.north_m)),
    0
  );
}

/**
 * Do two closed line segments properly intersect? Shared endpoints do not
 * count, so adjacent polygon edges are not reported.
 */
function segmentsProperlyIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

function cross(a, b, p) {
  return (b.east_m - a.east_m) * (p.north_m - a.north_m) -
    (b.north_m - a.north_m) * (p.east_m - a.east_m);
}

/**
 * Find self-intersections of a polygon ring. A self-intersecting safety area is
 * ambiguous (what counts as "inside"?) so tools report it as an error.
 *
 * O(n^2); safety polygons in this toolkit have a handful of vertices.
 *
 * @param {Array<{east_m:number,north_m:number}>} polygon
 * @returns {Array<[number, number]>} pairs of intersecting edge indices
 */
export function polygonSelfIntersections(polygon) {
  const hits = [];
  if (!Array.isArray(polygon) || polygon.length < 4) return hits;
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const a1 = polygon[i];
    const a2 = polygon[(i + 1) % n];
    for (let j = i + 1; j < n; j += 1) {
      // Skip adjacent edges (including the wrap-around pair).
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = polygon[j];
      const b2 = polygon[(j + 1) % n];
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) hits.push([i, j]);
    }
  }
  return hits;
}

/**
 * Throw a descriptive error instead of silently producing NaN downstream.
 * @param {unknown} value
 * @param {string} label
 */
export function assertFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number, received: ${JSON.stringify(value)}`);
  }
}
