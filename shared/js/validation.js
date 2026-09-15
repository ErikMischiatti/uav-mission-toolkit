/**
 * Validation rules for the site and trajectory formats.
 *
 * Every tool in the toolkit runs the same functions from this module, so the
 * editor, the viewer and any future tool cannot disagree about whether a file
 * is acceptable.
 *
 * A validator returns a list of findings. It never throws for bad *content*
 * (that is what the findings are for) - it only throws if it is handed
 * something that is not an object at all.
 */

import {
  LOCAL_FRAME_RECOMMENDED_RADIUS_M,
  boundingBox,
  maxRadiusFromOriginM,
  pathSegmentsLeavingPolygon,
  pointInPolygon,
  polygonAreaM2,
  polygonSelfIntersections,
} from './geo.js';

/** Schema version understood by this build of the toolkit. */
export const SITE_SCHEMA_VERSION = 1;
/** Schema version understood by this build of the toolkit. */
export const TRAJECTORY_SCHEMA_VERSION = 1;

export const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
});

/**
 * The altitude references this project recognises. There is deliberately no
 * default: a file must say which one it uses.
 *  - AGL:  above ground level at the point in question
 *  - AMSL: above mean sea level (WGS84 EGM geoid, as reported by the source)
 *  - ATO:  above take-off point (the site origin altitude)
 */
export const ALTITUDE_REFERENCES = Object.freeze(['AGL', 'AMSL', 'ATO']);

/** Local frame types this version supports. */
export const LOCAL_FRAME_TYPES = Object.freeze(['ENU']);

/** Heading reference used throughout the project. */
export const HEADING_REFERENCES = Object.freeze(['true_north']);

/** Plausibility band for an origin altitude, used for a warning only. */
const PLAUSIBLE_ORIGIN_ALTITUDE_RANGE_M = Object.freeze({ min: -500, max: 9000 });

/** Above this speed the toolkit assumes a unit mix-up (e.g. km/h typed as m/s). */
const IMPLAUSIBLE_SPEED_MPS = 60;

/**
 * @typedef {{severity: string, code: string, message: string, path?: string}} Finding
 */

/**
 * @param {Finding[]} findings
 * @returns {boolean}
 */
export function hasErrors(findings) {
  return findings.some((f) => f.severity === SEVERITY.ERROR);
}

/**
 * @param {Finding[]} findings
 * @returns {{error: number, warning: number, info: number}}
 */
export function severityCounts(findings) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    if (finding.severity in counts) counts[finding.severity] += 1;
  }
  return counts;
}

function finding(severity, code, message, path) {
  return path ? { severity, code, message, path } : { severity, code, message };
}

const error = (code, message, path) => finding(SEVERITY.ERROR, code, message, path);
const warn = (code, message, path) => finding(SEVERITY.WARNING, code, message, path);
const info = (code, message, path) => finding(SEVERITY.INFO, code, message, path);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Validate a site definition object.
 *
 * @param {unknown} site parsed site.json
 * @returns {Finding[]}
 */
export function validateSite(site) {
  const findings = [];

  if (site === null || typeof site !== 'object' || Array.isArray(site)) {
    return [error('site.type', 'The site definition must be a JSON object.')];
  }

  // --- schema version ---
  if (site.schema_version !== SITE_SCHEMA_VERSION) {
    findings.push(
      error(
        'schema_version',
        `Unsupported schema_version: ${JSON.stringify(site.schema_version)}. ` +
          `This build understands version ${SITE_SCHEMA_VERSION}.`,
        'schema_version'
      )
    );
  }

  // --- name ---
  if (!isNonEmptyString(site.name)) {
    findings.push(error('name.missing', 'Site "name" must be a non-empty string.', 'name'));
  }

  // --- site id ---
  // Optional, and deliberately separate from "name": a name is for humans and
  // may change, while an id is what a trajectory records to say which frame it
  // was drawn in. Nothing derives an id from a filename.
  if (site.site_id !== undefined && site.site_id !== null) {
    if (!isNonEmptyString(site.site_id)) {
      findings.push(
        error('site_id.type', 'Site "site_id", when present, must be a non-empty string.', 'site_id')
      );
    } else if (!/^[A-Za-z0-9._-]+$/.test(site.site_id)) {
      findings.push(
        warn(
          'site_id.charset',
          `site_id ${JSON.stringify(site.site_id)} contains characters outside ` +
            `[A-Za-z0-9._-]. Ids travel through filenames and URLs; keep them plain.`,
          'site_id'
        )
      );
    }
  }

  // --- origin ---
  const origin = site.origin;
  let originIsUsable = false;
  if (origin === null || typeof origin !== 'object') {
    findings.push(error('origin.missing', 'Site "origin" object is missing.', 'origin'));
  } else {
    const latOk = isFiniteNumber(origin.latitude_deg) &&
      origin.latitude_deg >= -90 && origin.latitude_deg <= 90;
    const lonOk = isFiniteNumber(origin.longitude_deg) &&
      origin.longitude_deg >= -180 && origin.longitude_deg <= 180;

    if (!latOk) {
      findings.push(
        error(
          'origin.latitude',
          `origin.latitude_deg must be a number in [-90, 90], got ${JSON.stringify(origin.latitude_deg)}.`,
          'origin.latitude_deg'
        )
      );
    }
    if (!lonOk) {
      findings.push(
        error(
          'origin.longitude',
          `origin.longitude_deg must be a number in [-180, 180], got ${JSON.stringify(origin.longitude_deg)}.`,
          'origin.longitude_deg'
        )
      );
    }
    if (latOk && lonOk && origin.latitude_deg === 0 && origin.longitude_deg === 0) {
      findings.push(
        warn(
          'origin.null_island',
          'Origin is exactly 0/0. That is almost always an unset value rather than a real site.',
          'origin'
        )
      );
    }
    if (!isFiniteNumber(origin.altitude_amsl_m)) {
      findings.push(
        error(
          'origin.altitude',
          'origin.altitude_amsl_m must be a finite number in metres AMSL. ' +
            'The toolkit does not substitute a default origin altitude.',
          'origin.altitude_amsl_m'
        )
      );
    } else if (
      origin.altitude_amsl_m < PLAUSIBLE_ORIGIN_ALTITUDE_RANGE_M.min ||
      origin.altitude_amsl_m > PLAUSIBLE_ORIGIN_ALTITUDE_RANGE_M.max
    ) {
      findings.push(
        warn(
          'origin.altitude_implausible',
          `origin.altitude_amsl_m = ${origin.altitude_amsl_m} m is outside the plausible range ` +
            `[${PLAUSIBLE_ORIGIN_ALTITUDE_RANGE_M.min}, ${PLAUSIBLE_ORIGIN_ALTITUDE_RANGE_M.max}] m.`,
          'origin.altitude_amsl_m'
        )
      );
    }
    originIsUsable = latOk && lonOk;
  }

  // --- local frame ---
  const frame = site.local_frame;
  if (frame === null || typeof frame !== 'object') {
    findings.push(
      error('local_frame.missing', 'Site "local_frame" object is missing.', 'local_frame')
    );
  } else {
    if (!LOCAL_FRAME_TYPES.includes(frame.type)) {
      findings.push(
        error(
          'local_frame.type',
          `local_frame.type must be one of ${LOCAL_FRAME_TYPES.join(', ')}, got ` +
            `${JSON.stringify(frame.type)}.`,
          'local_frame.type'
        )
      );
    }
    if (!HEADING_REFERENCES.includes(frame.heading_reference)) {
      findings.push(
        error(
          'local_frame.heading_reference',
          `local_frame.heading_reference must be one of ${HEADING_REFERENCES.join(', ')}, got ` +
            `${JSON.stringify(frame.heading_reference)}.`,
          'local_frame.heading_reference'
        )
      );
    }
  }

  // --- safety area ---
  const safety = site.safety_area;
  let polygon = null;
  let safetyAltitudeReference = null;
  let minAltitude = null;
  let maxAltitude = null;

  if (safety === null || typeof safety !== 'object') {
    findings.push(
      error('safety_area.missing', 'Site "safety_area" object is missing.', 'safety_area')
    );
  } else {
    const ring = safety.horizontal;
    if (!Array.isArray(ring)) {
      findings.push(
        error(
          'safety_area.horizontal.type',
          'safety_area.horizontal must be an array of {east_m, north_m} vertices.',
          'safety_area.horizontal'
        )
      );
    } else if (ring.length < 3) {
      findings.push(
        error(
          'safety_area.horizontal.too_few',
          `The safety polygon needs at least 3 vertices, found ${ring.length}.`,
          'safety_area.horizontal'
        )
      );
    } else {
      const badVertices = [];
      ring.forEach((vertex, index) => {
        if (
          vertex === null ||
          typeof vertex !== 'object' ||
          !isFiniteNumber(vertex.east_m) ||
          !isFiniteNumber(vertex.north_m)
        ) {
          badVertices.push(index);
        }
      });
      if (badVertices.length > 0) {
        findings.push(
          error(
            'safety_area.horizontal.vertex',
            `Safety polygon vertices at index ${badVertices.join(', ')} are not valid ` +
              `{east_m, north_m} pairs.`,
            'safety_area.horizontal'
          )
        );
      } else {
        polygon = ring;
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first.east_m === last.east_m && first.north_m === last.north_m) {
          findings.push(
            warn(
              'safety_area.horizontal.closed_ring',
              'The first and last polygon vertices are identical. The ring is closed ' +
                'implicitly; the duplicated vertex should be removed.',
              'safety_area.horizontal'
            )
          );
        }
        const selfIntersections = polygonSelfIntersections(ring);
        if (selfIntersections.length > 0) {
          findings.push(
            error(
              'safety_area.horizontal.self_intersecting',
              `The safety polygon intersects itself (edge pairs: ` +
                `${selfIntersections.map(([a, b]) => `${a}/${b}`).join(', ')}). ` +
                `"Inside" is not well defined for such a polygon.`,
              'safety_area.horizontal'
            )
          );
        }
        const area = polygonAreaM2(ring);
        if (area <= 0) {
          findings.push(
            error(
              'safety_area.horizontal.degenerate',
              'The safety polygon has zero area (all vertices are collinear or coincident).',
              'safety_area.horizontal'
            )
          );
        }
      }
    }

    if (!ALTITUDE_REFERENCES.includes(safety.altitude_reference)) {
      findings.push(
        error(
          'safety_area.altitude_reference',
          `safety_area.altitude_reference must be one of ${ALTITUDE_REFERENCES.join(', ')}, got ` +
            `${JSON.stringify(safety.altitude_reference)}. The toolkit never assumes a reference.`,
          'safety_area.altitude_reference'
        )
      );
    } else {
      safetyAltitudeReference = safety.altitude_reference;
    }

    const minOk = isFiniteNumber(safety.min_altitude_m);
    const maxOk = isFiniteNumber(safety.max_altitude_m);
    if (!minOk) {
      findings.push(
        error(
          'safety_area.min_altitude',
          'safety_area.min_altitude_m must be a finite number in metres.',
          'safety_area.min_altitude_m'
        )
      );
    }
    if (!maxOk) {
      findings.push(
        error(
          'safety_area.max_altitude',
          'safety_area.max_altitude_m must be a finite number in metres.',
          'safety_area.max_altitude_m'
        )
      );
    }
    if (minOk && maxOk) {
      minAltitude = safety.min_altitude_m;
      maxAltitude = safety.max_altitude_m;
      if (!(minAltitude < maxAltitude)) {
        findings.push(
          error(
            'safety_area.altitude_band',
            `safety_area.min_altitude_m (${minAltitude}) must be strictly less than ` +
              `max_altitude_m (${maxAltitude}).`,
            'safety_area'
          )
        );
      }
    }
  }

  // --- mission points ---
  const points = site.mission_points;
  if (!Array.isArray(points)) {
    findings.push(
      error(
        'mission_points.type',
        'Site "mission_points" must be an array (it may be empty).',
        'mission_points'
      )
    );
  } else {
    if (points.length === 0) {
      findings.push(
        info('mission_points.empty', 'The site defines no mission points.', 'mission_points')
      );
    }
    const seenIds = new Set();
    points.forEach((point, index) => {
      const path = `mission_points[${index}]`;
      if (point === null || typeof point !== 'object') {
        findings.push(error('mission_point.type', `${path} is not an object.`, path));
        return;
      }

      if (!isNonEmptyString(point.id)) {
        findings.push(
          error('mission_point.id', `${path}.id must be a non-empty string.`, `${path}.id`)
        );
      } else if (seenIds.has(point.id)) {
        findings.push(
          error(
            'mission_point.duplicate_id',
            `Duplicate mission point id "${point.id}". Ids must be unique within a site.`,
            `${path}.id`
          )
        );
      } else {
        seenIds.add(point.id);
      }

      const eastOk = isFiniteNumber(point.east_m);
      const northOk = isFiniteNumber(point.north_m);
      if (!eastOk || !northOk) {
        findings.push(
          error(
            'mission_point.position',
            `${path} must have finite east_m and north_m values.`,
            path
          )
        );
      }

      if (!isFiniteNumber(point.altitude_m)) {
        findings.push(
          error(
            'mission_point.altitude',
            `${path}.altitude_m must be a finite number in metres.`,
            `${path}.altitude_m`
          )
        );
      }

      if (!ALTITUDE_REFERENCES.includes(point.altitude_reference)) {
        findings.push(
          error(
            'mission_point.altitude_reference',
            `${path}.altitude_reference must be one of ${ALTITUDE_REFERENCES.join(', ')}, got ` +
              `${JSON.stringify(point.altitude_reference)}.`,
            `${path}.altitude_reference`
          )
        );
      } else if (
        safetyAltitudeReference !== null &&
        point.altitude_reference !== safetyAltitudeReference
      ) {
        findings.push(
          error(
            'mission_point.altitude_reference_mismatch',
            `${path} uses altitude reference ${point.altitude_reference} but the safety area is ` +
              `defined in ${safetyAltitudeReference}. The altitude limits cannot be checked ` +
              `across different references; convert the values explicitly.`,
            `${path}.altitude_reference`
          )
        );
      } else if (
        minAltitude !== null &&
        maxAltitude !== null &&
        isFiniteNumber(point.altitude_m) &&
        (point.altitude_m < minAltitude || point.altitude_m > maxAltitude)
      ) {
        findings.push(
          error(
            'mission_point.altitude_out_of_band',
            `${path} altitude ${point.altitude_m} m ${point.altitude_reference} is outside the ` +
              `safety band [${minAltitude}, ${maxAltitude}] m ${safetyAltitudeReference}.`,
            `${path}.altitude_m`
          )
        );
      }

      if (point.heading_deg === undefined || point.heading_deg === null) {
        findings.push(
          info(
            'mission_point.heading_unspecified',
            `${path} does not specify heading_deg. Whatever consumes this site will decide the ` +
              `heading; the toolkit does not fill one in.`,
            `${path}.heading_deg`
          )
        );
      } else if (
        !isFiniteNumber(point.heading_deg) ||
        point.heading_deg < 0 ||
        point.heading_deg >= 360
      ) {
        findings.push(
          error(
            'mission_point.heading',
            `${path}.heading_deg must be a number in [0, 360) degrees clockwise from true north, ` +
              `got ${JSON.stringify(point.heading_deg)}.`,
            `${path}.heading_deg`
          )
        );
      }

      if (polygon !== null && eastOk && northOk && !pointInPolygon(point, polygon)) {
        findings.push(
          error(
            'mission_point.outside_safety_area',
            `Mission point "${point.id ?? index}" at (E ${point.east_m} m, N ${point.north_m} m) ` +
              `lies outside the safety polygon.`,
            path
          )
        );
      }
    });
  }

  // --- tangent-plane sanity ---
  if (originIsUsable) {
    const allLocalPoints = [
      ...(polygon ?? []),
      ...(Array.isArray(points)
        ? points.filter((p) => p && isFiniteNumber(p.east_m) && isFiniteNumber(p.north_m))
        : []),
    ];
    const radius = maxRadiusFromOriginM(allLocalPoints);
    if (radius > LOCAL_FRAME_RECOMMENDED_RADIUS_M) {
      findings.push(
        warn(
          'local_frame.extent',
          `The site extends ${radius.toFixed(0)} m from the origin, beyond the ` +
            `${LOCAL_FRAME_RECOMMENDED_RADIUS_M} m for which the flat-earth approximation in ` +
            `shared/js/geo.js is recommended. See docs/coordinate_frames.md.`
        )
      );
    }
  }

  return findings;
}

/**
 * Summary statistics for a site. Returns nulls rather than guesses when the
 * underlying data is not usable.
 *
 * @param {object} site
 * @returns {{vertexCount:number, missionPointCount:number, areaM2:number|null,
 *            bounds:ReturnType<typeof boundingBox>, altitudeBandM:number|null}}
 */
export function siteStatistics(site) {
  const polygon = Array.isArray(site?.safety_area?.horizontal)
    ? site.safety_area.horizontal.filter(
        (v) => v && isFiniteNumber(v.east_m) && isFiniteNumber(v.north_m)
      )
    : [];
  const missionPoints = Array.isArray(site?.mission_points) ? site.mission_points : [];
  const min = site?.safety_area?.min_altitude_m;
  const max = site?.safety_area?.max_altitude_m;

  return {
    vertexCount: polygon.length,
    missionPointCount: missionPoints.length,
    areaM2: polygon.length >= 3 ? polygonAreaM2(polygon) : null,
    bounds: boundingBox(polygon),
    altitudeBandM: isFiniteNumber(min) && isFiniteNumber(max) ? max - min : null,
  };
}

/**
 * Validate a trajectory document (the JSON form).
 *
 * @param {unknown} trajectory
 * @param {{site?: object}} [context] optional site to check containment against
 * @returns {Finding[]}
 */
export function validateTrajectory(trajectory, context = {}) {
  const findings = [];

  if (trajectory === null || typeof trajectory !== 'object' || Array.isArray(trajectory)) {
    return [error('trajectory.type', 'The trajectory must be a JSON object.')];
  }

  if (trajectory.schema_version !== TRAJECTORY_SCHEMA_VERSION) {
    findings.push(
      error(
        'schema_version',
        `Unsupported schema_version: ${JSON.stringify(trajectory.schema_version)}. ` +
          `This build understands version ${TRAJECTORY_SCHEMA_VERSION}.`,
        'schema_version'
      )
    );
  }

  if (trajectory.frame !== 'local_enu') {
    findings.push(
      error(
        'frame',
        `trajectory.frame must be "local_enu", got ${JSON.stringify(trajectory.frame)}.`,
        'frame'
      )
    );
  }

  if (!ALTITUDE_REFERENCES.includes(trajectory.altitude_reference)) {
    findings.push(
      error(
        'altitude_reference',
        `trajectory.altitude_reference must be one of ${ALTITUDE_REFERENCES.join(', ')}, got ` +
          `${JSON.stringify(trajectory.altitude_reference)}.`,
        'altitude_reference'
      )
    );
  }

  if (typeof trajectory.closed !== 'boolean') {
    findings.push(
      error('closed', 'trajectory.closed must be a boolean.', 'closed')
    );
  }

  if (!isFiniteNumber(trajectory.speed_mps) || trajectory.speed_mps <= 0) {
    findings.push(
      error(
        'speed',
        `trajectory.speed_mps must be a positive number of metres per second, got ` +
          `${JSON.stringify(trajectory.speed_mps)}.`,
        'speed_mps'
      )
    );
  } else if (trajectory.speed_mps > IMPLAUSIBLE_SPEED_MPS) {
    findings.push(
      warn(
        'speed.implausible',
        `trajectory.speed_mps = ${trajectory.speed_mps} m/s (${(trajectory.speed_mps * 3.6).toFixed(0)} km/h). ` +
          `Check the units - this project uses metres per second.`,
        'speed_mps'
      )
    );
  }

  const points = trajectory.points;
  if (!Array.isArray(points)) {
    findings.push(error('points.type', 'trajectory.points must be an array.', 'points'));
    return findings;
  }
  if (points.length < 2) {
    findings.push(
      error('points.too_few', `A trajectory needs at least 2 points, found ${points.length}.`, 'points')
    );
  }

  const site = context.site ?? null;
  const polygon = Array.isArray(site?.safety_area?.horizontal)
    ? site.safety_area.horizontal
    : null;
  const siteAltitudeReference = site?.safety_area?.altitude_reference ?? null;
  let outsideCount = 0;

  points.forEach((point, index) => {
    const path = `points[${index}]`;
    if (point === null || typeof point !== 'object') {
      findings.push(error('point.type', `${path} is not an object.`, path));
      return;
    }
    if (!isFiniteNumber(point.east_m) || !isFiniteNumber(point.north_m)) {
      findings.push(
        error('point.position', `${path} must have finite east_m and north_m values.`, path)
      );
    } else if (polygon && !pointInPolygon(point, polygon)) {
      outsideCount += 1;
    }
    if (!isFiniteNumber(point.altitude_m)) {
      findings.push(
        error('point.altitude', `${path}.altitude_m must be a finite number.`, `${path}.altitude_m`)
      );
    }
    if (
      point.heading_deg !== undefined &&
      point.heading_deg !== null &&
      (!isFiniteNumber(point.heading_deg) || point.heading_deg < 0 || point.heading_deg >= 360)
    ) {
      findings.push(
        error(
          'point.heading',
          `${path}.heading_deg must be in [0, 360) degrees clockwise from true north.`,
          `${path}.heading_deg`
        )
      );
    }
  });

  findings.push(
    ...validateAgainstSite(
      {
        points,
        closed: trajectory.closed,
        altitudeReference: trajectory.altitude_reference,
        outsideCount,
      },
      site
    )
  );

  findings.push(...siteContextFindings(trajectory, site));
  findings.push(...frameCompatibilityFindings(trajectory, site));

  return findings;
}

/**
 * Check a path against a site: containment, segments that leave the area, and
 * the altitude band.
 *
 * Exported separately from {@link validateTrajectory} because the trajectory
 * editor needs these answers *while the trajectory is still incomplete*. A
 * user who has not yet chosen an altitude reference should still be told that
 * their path leaves the safety area — waiting until the document can be
 * assembled would hide the most important finding behind an unrelated one.
 * Keeping one implementation means the editor and the file check cannot drift.
 *
 * @param {{points: Array<object>, closed: boolean, altitudeReference: string|null,
 *          outsideCount?: number}} path
 * @param {object|null} site
 * @returns {Finding[]}
 */
export function validateAgainstSite(path, site) {
  const findings = [];
  if (site === null || typeof site !== 'object') return findings;

  const { points, closed, altitudeReference } = path;
  if (!Array.isArray(points)) return findings;

  const ring = site.safety_area?.horizontal;
  const polygon = Array.isArray(ring) && ring.length >= 3 ? ring : null;
  const usable = points.filter(
    (point) => point && isFiniteNumber(point.east_m) && isFiniteNumber(point.north_m)
  );

  if (polygon !== null) {
    const outsideCount =
      path.outsideCount ??
      usable.filter((point) => !pointInPolygon(point, polygon)).length;

    if (outsideCount > 0) {
      findings.push(
        error(
          'points.outside_safety_area',
          `${outsideCount} trajectory point(s) lie outside the safety polygon of the loaded site.`,
          'points'
        )
      );
    }

    // A leg between two interior points can still cut across a concave notch
    // and leave the area in between. Checking the waypoints alone misses it.
    if (typeof closed === 'boolean' && usable.length === points.length) {
      const crossingOnly = pathSegmentsLeavingPolygon(points, polygon, { closed }).filter(
        (index) => {
          const from = points[index];
          const to = points[(index + 1) % points.length];
          // Segments with an endpoint already outside are covered above; only
          // report the ones that would otherwise go unseen.
          return pointInPolygon(from, polygon) && pointInPolygon(to, polygon);
        }
      );
      if (crossingOnly.length > 0) {
        findings.push(
          error(
            'segments.leave_safety_area',
            `${crossingOnly.length} path segment(s) leave the safety polygon between their ` +
              `endpoints (segment${crossingOnly.length === 1 ? '' : 's'} ` +
              `${crossingOnly.join(', ')}). Both waypoints are inside, but the straight line ` +
              `between them is not.`,
            'points'
          )
        );
      }
    }
  }

  // --- altitude band, only when the two references agree ---------------------
  const siteAltitudeReference = site.safety_area?.altitude_reference ?? null;
  const referenceIsValid = ALTITUDE_REFERENCES.includes(altitudeReference);
  if (siteAltitudeReference === null || !referenceIsValid) return findings;

  if (altitudeReference !== siteAltitudeReference) {
    findings.push(
      warn(
        'altitude_reference.mismatch',
        `The trajectory is defined in ${altitudeReference} but the loaded site uses ` +
          `${siteAltitudeReference}. Altitude limits were not checked: converting between ` +
          `references needs information this toolkit does not have.`,
        'altitude_reference'
      )
    );
    return findings;
  }

  findings.push(...altitudeBandFindings(points, site));
  return findings;
}

/**
 * Check the optional `site_context` block.
 *
 * The block is what makes a trajectory self-describing about the frame its
 * coordinates live in. It is optional — a trajectory drawn in an abstract local
 * plane legitimately has none — but a present block that is malformed is worse
 * than an absent one, because it looks authoritative.
 *
 * @param {object} trajectory
 * @param {object|null} site the site being validated against, if any
 * @returns {Finding[]}
 */
function siteContextFindings(trajectory, site) {
  const findings = [];
  const context = trajectory.site_context;

  if (context === undefined || context === null) {
    // Only worth saying when there is a site in play. A trajectory drawn in an
    // abstract local plane has nothing to record, and a permanent note on every
    // such file would just train the reader to ignore the panel.
    if (site !== null && typeof site === 'object') {
      findings.push(
        info(
          'site_context.absent',
          'This trajectory records no site context, so the file itself does not say which ' +
            'local frame its coordinates belong to. Exporting it from this tool with a site ' +
            'selected will add that.',
          'site_context'
        )
      );
    }
    return findings;
  }

  if (typeof context !== 'object' || Array.isArray(context)) {
    findings.push(
      error('site_context.type', 'trajectory.site_context must be a JSON object.', 'site_context')
    );
    return findings;
  }

  if (context.site_id !== undefined && !isNonEmptyString(context.site_id)) {
    findings.push(
      error(
        'site_context.site_id',
        'site_context.site_id must be a non-empty string when present.',
        'site_context.site_id'
      )
    );
  }

  const origin = context.origin;
  if (origin !== undefined) {
    if (origin === null || typeof origin !== 'object') {
      findings.push(
        error(
          'site_context.origin.type',
          'site_context.origin must be an object with latitude_deg and longitude_deg.',
          'site_context.origin'
        )
      );
    } else {
      const latOk = isFiniteNumber(origin.latitude_deg) &&
        origin.latitude_deg >= -90 && origin.latitude_deg <= 90;
      const lonOk = isFiniteNumber(origin.longitude_deg) &&
        origin.longitude_deg >= -180 && origin.longitude_deg <= 180;
      if (!latOk || !lonOk) {
        findings.push(
          error(
            'site_context.origin.range',
            'site_context.origin must carry a latitude_deg in [-90, 90] and a longitude_deg ' +
              'in [-180, 180].',
            'site_context.origin'
          )
        );
      }
    }
  }

  const frame = context.local_frame;
  if (frame !== undefined && frame !== null && typeof frame === 'object') {
    if (frame.type !== undefined && !LOCAL_FRAME_TYPES.includes(frame.type)) {
      findings.push(
        error(
          'site_context.local_frame.type',
          `site_context.local_frame.type must be one of ${LOCAL_FRAME_TYPES.join(', ')}, got ` +
            `${JSON.stringify(frame.type)}.`,
          'site_context.local_frame.type'
        )
      );
    }
  }

  return findings;
}

/**
 * Compare every trajectory altitude against the site's altitude band.
 *
 * Only called once the trajectory and the site are known to use the same
 * altitude reference; comparing an AGL number with an AMSL limit would be
 * arithmetic without meaning.
 *
 * @param {Array<object>} points
 * @param {object} site
 * @returns {Finding[]}
 */
function altitudeBandFindings(points, site) {
  const findings = [];
  const min = site?.safety_area?.min_altitude_m;
  const max = site?.safety_area?.max_altitude_m;
  const reference = site?.safety_area?.altitude_reference ?? '';
  if (!isFiniteNumber(min) || !isFiniteNumber(max)) return findings;

  const below = [];
  const above = [];
  points.forEach((point, index) => {
    if (!point || !isFiniteNumber(point.altitude_m)) return;
    if (point.altitude_m < min) below.push(index);
    if (point.altitude_m > max) above.push(index);
  });

  if (below.length > 0) {
    findings.push(
      error(
        'points.below_site_minimum',
        `${below.length} trajectory point(s) are below the site minimum of ${min} m ` +
          `${reference} (lowest: ${formatExtreme(points, below, Math.min)} m).`,
        'points'
      )
    );
  }
  if (above.length > 0) {
    findings.push(
      error(
        'points.above_site_maximum',
        `${above.length} trajectory point(s) are above the site maximum of ${max} m ` +
          `${reference} (highest: ${formatExtreme(points, above, Math.max)} m).`,
        'points'
      )
    );
  }
  return findings;
}

function formatExtreme(points, indices, pick) {
  return pick(...indices.map((index) => points[index].altitude_m));
}

/**
 * Is the trajectory expressed in a frame the site actually defines?
 *
 * The trajectory carries no origin of its own, so it is only meaningful
 * relative to some site's local frame. If the site's frame is not the one the
 * trajectory format assumes, the coordinates cannot be placed on the ground and
 * that has to be an error rather than a quiet mismatch.
 *
 * @param {object} trajectory
 * @param {object|null} site
 * @returns {Finding[]}
 */
function frameCompatibilityFindings(trajectory, site) {
  const findings = [];
  if (site === null || typeof site !== 'object') return findings;

  const siteFrame = site.local_frame?.type ?? null;
  if (siteFrame !== null && trajectory.frame === 'local_enu' && siteFrame !== 'ENU') {
    findings.push(
      error(
        'frame.incompatible',
        `The trajectory is expressed in local_enu but the site declares local_frame.type ` +
          `${JSON.stringify(siteFrame)}. The coordinates cannot be interpreted against this site.`,
        'frame'
      )
    );
  }

  const siteHeading = site.local_frame?.heading_reference ?? null;
  if (
    siteHeading !== null &&
    typeof trajectory.heading_reference === 'string' &&
    trajectory.heading_reference !== siteHeading
  ) {
    findings.push(
      error(
        'heading_reference.incompatible',
        `The trajectory measures headings from ${trajectory.heading_reference} but the site uses ` +
          `${siteHeading}.`,
        'heading_reference'
      )
    );
  }

  // A trajectory that names a site should name *this* site.
  const declared = trajectory.site_context?.site_id;
  const actual = site.site_id ?? null;
  if (isNonEmptyString(declared) && isNonEmptyString(actual) && declared !== actual) {
    findings.push(
      warn(
        'site_context.site_id_mismatch',
        `The trajectory records site_id ${JSON.stringify(declared)} but the loaded site is ` +
          `${JSON.stringify(actual)}. Check that this is the frame the trajectory was drawn in.`,
        'site_context.site_id'
      )
    );
  }

  return findings;
}

/**
 * Verify that a generated altitude variant differs from its source ONLY in the
 * altitude column. This is the core safety check of the altitude sweep tool:
 * a variant that quietly moved a waypoint sideways must never be exported.
 *
 * Both arguments are lists of parsed trajectory points.
 *
 * @param {Array<object>} basePoints
 * @param {Array<object>} variantPoints
 * @param {number} expectedAltitudeM
 * @param {{positionToleranceM?: number, headingToleranceDeg?: number, speedToleranceMps?: number}} [tolerances]
 * @returns {{ok: boolean, findings: Finding[]}}
 */
export function verifyAltitudeVariant(
  basePoints,
  variantPoints,
  expectedAltitudeM,
  tolerances = {}
) {
  // Tolerances exist because values make a round trip through decimal text.
  // They are far tighter than anything that could matter operationally.
  const positionTolerance = tolerances.positionToleranceM ?? 1e-6;
  const headingTolerance = tolerances.headingToleranceDeg ?? 1e-6;
  const speedTolerance = tolerances.speedToleranceMps ?? 1e-9;

  const findings = [];

  if (basePoints.length !== variantPoints.length) {
    findings.push(
      error(
        'variant.row_count',
        `Row count changed: source has ${basePoints.length} rows, variant has ` +
          `${variantPoints.length}.`
      )
    );
    return { ok: false, findings };
  }

  for (let i = 0; i < basePoints.length; i += 1) {
    const base = basePoints[i];
    const variant = variantPoints[i];
    const row = i + 1;

    if (Math.abs(base.east_m - variant.east_m) > positionTolerance) {
      findings.push(
        error('variant.east', `Row ${row}: east_m changed (${base.east_m} -> ${variant.east_m}).`)
      );
    }
    if (Math.abs(base.north_m - variant.north_m) > positionTolerance) {
      findings.push(
        error('variant.north', `Row ${row}: north_m changed (${base.north_m} -> ${variant.north_m}).`)
      );
    }
    if (Math.abs(base.heading_deg - variant.heading_deg) > headingTolerance) {
      findings.push(
        error(
          'variant.heading',
          `Row ${row}: heading_deg changed (${base.heading_deg} -> ${variant.heading_deg}).`
        )
      );
    }
    if (Math.abs(base.speed_mps - variant.speed_mps) > speedTolerance) {
      findings.push(
        error(
          'variant.speed',
          `Row ${row}: speed_mps changed (${base.speed_mps} -> ${variant.speed_mps}).`
        )
      );
    }
    if (variant.altitude_m !== expectedAltitudeM) {
      findings.push(
        error(
          'variant.altitude',
          `Row ${row}: altitude_m is ${variant.altitude_m} m but the variant was generated for ` +
            `${expectedAltitudeM} m.`
        )
      );
    }
  }

  return { ok: !hasErrors(findings), findings };
}
