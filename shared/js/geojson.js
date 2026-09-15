/**
 * Generic GeoJSON import (RFC 7946).
 *
 * Nothing here is specific to any vendor, autopilot or ground station: this
 * reads plain GeoJSON as produced by QGIS, geojson.io, OpenStreetMap exports
 * and the like.
 *
 * TWO RULES SHAPE THIS WHOLE MODULE
 * ---------------------------------
 * 1. **Nothing is imported without being asked for.** A GeoJSON polygon is not
 *    a safety area. It is a polygon. Somebody drew it, and this toolkit has no
 *    way to know whether it is the operating boundary, a field, a car park or a
 *    lake. So parsing only *proposes* a mapping; `applyImportPlan` acts on the
 *    mapping the user confirmed, and on nothing else.
 *
 * 2. **An origin is never invented.** Local ENU coordinates are meaningless
 *    without one. If the site has no usable origin, the import is refused with
 *    a message saying so, unless the user explicitly designates one of the
 *    imported points as the origin.
 *
 * COORDINATE ORDER
 * ----------------
 * GeoJSON positions are `[longitude, latitude]` — longitude first. This is the
 * single most common way to corrupt imported geometry, because a swapped pair
 * usually still parses and often still plots somewhere plausible. Every
 * position goes through {@link readPosition}, which is the only place in this
 * module that indexes into a coordinate array, and it validates both ranges.
 */

import { geodeticToEnu } from './geo.js';
import { roundTo } from './io.js';
import { SEVERITY } from './validation.js';

/** What an imported feature may become. */
export const IMPORT_TARGETS = Object.freeze([
  'ignore',
  'safety_area',
  'mission_point',
  'origin',
]);

/** Geometry types this build can map onto the site format. */
export const SUPPORTED_GEOMETRY_TYPES = Object.freeze([
  'Point',
  'Polygon',
  'MultiPoint',
  'MultiPolygon',
]);

/** Local coordinates are written to the millimetre, as everywhere else. */
const COORDINATE_DECIMALS = 3;

function finding(severity, code, message) {
  return { severity, code, message };
}
const error = (code, message) => finding(SEVERITY.ERROR, code, message);
const warn = (code, message) => finding(SEVERITY.WARNING, code, message);
const info = (code, message) => finding(SEVERITY.INFO, code, message);

/**
 * Read one GeoJSON position.
 *
 * @param {unknown} position
 * @param {string} where used in the error message
 * @returns {{latitude_deg: number, longitude_deg: number, hadElevation: boolean}}
 * @throws {Error} with a message naming the problem and the expected order
 */
export function readPosition(position, where = 'position') {
  if (!Array.isArray(position) || position.length < 2) {
    throw new Error(
      `${where}: a GeoJSON position must be an array of at least two numbers, ` +
        `[longitude, latitude].`
    );
  }
  const [longitude, latitude] = position;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) {
    throw new Error(`${where}: longitude (the FIRST value) is not a finite number.`);
  }
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) {
    throw new Error(`${where}: latitude (the SECOND value) is not a finite number.`);
  }
  if (longitude < -180 || longitude > 180) {
    throw new Error(
      `${where}: longitude ${longitude} is outside [-180, 180]. GeoJSON positions are ` +
        `[longitude, latitude] — check that the pair is not reversed.`
    );
  }
  if (latitude < -90 || latitude > 90) {
    throw new Error(
      `${where}: latitude ${latitude} is outside [-90, 90]. GeoJSON positions are ` +
        `[longitude, latitude] — a value above 90 in second place usually means the pair ` +
        `is reversed.`
    );
  }
  return {
    latitude_deg: latitude,
    longitude_deg: longitude,
    hadElevation: position.length > 2 && typeof position[2] === 'number',
  };
}

/**
 * Parse a GeoJSON document into the features this toolkit could import.
 *
 * Never throws for bad *content*: an unsupported or malformed feature comes
 * back marked unsupported, with the reason, so the mapping UI can show the
 * whole file and explain what it will and will not take. It throws only when
 * the argument is not a GeoJSON object at all.
 *
 * @param {unknown} document a parsed GeoJSON object
 * @param {string} [sourceLabel]
 * @returns {{features: Array<object>, findings: Array<object>}}
 */
export function parseGeoJson(document, sourceLabel = 'GeoJSON') {
  const findings = [];

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return {
      features: [],
      findings: [error('geojson.type', `${sourceLabel} is not a GeoJSON object.`)],
    };
  }
  if (typeof document.type !== 'string') {
    return {
      features: [],
      findings: [
        error('geojson.missing_type', `${sourceLabel} has no "type" member, so it is not GeoJSON.`),
      ],
    };
  }

  /** @type {Array<{geometry: unknown, properties: object, label: string}>} */
  const raw = [];

  if (document.type === 'FeatureCollection') {
    if (!Array.isArray(document.features)) {
      return {
        features: [],
        findings: [
          error(
            'geojson.feature_collection',
            `${sourceLabel}: a FeatureCollection must have a "features" array.`
          ),
        ],
      };
    }
    if (document.features.length === 0) {
      findings.push(info('geojson.empty', `${sourceLabel} contains no features.`));
    }
    document.features.forEach((feature, index) => {
      if (feature === null || typeof feature !== 'object' || feature.type !== 'Feature') {
        findings.push(
          warn(
            'geojson.not_a_feature',
            `${sourceLabel}: entry ${index} of the FeatureCollection is not a Feature and was skipped.`
          )
        );
        return;
      }
      raw.push({
        geometry: feature.geometry,
        properties: isPlainObject(feature.properties) ? feature.properties : {},
        label: featureLabel(feature, index),
      });
    });
  } else if (document.type === 'Feature') {
    raw.push({
      geometry: document.geometry,
      properties: isPlainObject(document.properties) ? document.properties : {},
      label: featureLabel(document, 0),
    });
  } else if (document.type === 'GeometryCollection') {
    return {
      features: [],
      findings: [
        error(
          'geojson.geometry_collection',
          `${sourceLabel}: GeometryCollection is not supported. Its members carry no properties ` +
            `of their own, so there is nothing to tell one geometry from another when choosing ` +
            `what each should become. Export the collection as a FeatureCollection instead.`
        ),
      ],
    };
  } else {
    // A bare geometry object.
    raw.push({ geometry: document, properties: {}, label: 'geometry' });
  }

  const features = raw.map((entry, index) => describeGeometry(entry, index, sourceLabel));
  const usable = features.filter((feature) => feature.supported);
  if (features.length > 0 && usable.length === 0) {
    findings.push(
      warn(
        'geojson.nothing_usable',
        `${sourceLabel} contains ${features.length} feature(s), none of which this build can map ` +
          `onto a site. See the reason next to each.`
      )
    );
  }
  if (features.some((feature) => feature.hadElevation)) {
    findings.push(
      info(
        'geojson.elevation_ignored',
        'Some positions carry a third (elevation) value. It was not imported: GeoJSON does not ' +
          'say what an elevation is measured against, and this toolkit never guesses an ' +
          'altitude reference. Set altitudes explicitly after importing.'
      )
    );
  }

  return { features, findings };
}

/**
 * Turn one geometry into a description the mapping UI can show.
 * @returns {object}
 */
function describeGeometry(entry, index, sourceLabel) {
  const base = {
    index,
    label: entry.label,
    properties: entry.properties,
    supported: false,
    reason: null,
    geometryType: null,
    /** Normalized payload: a ring for areas, a single position for points. */
    ring: null,
    position: null,
    hadElevation: false,
    suggestedTarget: 'ignore',
  };

  const geometry = entry.geometry;
  if (geometry === null || typeof geometry !== 'object' || typeof geometry.type !== 'string') {
    return { ...base, reason: 'The feature has no geometry object.' };
  }
  base.geometryType = geometry.type;

  try {
    switch (geometry.type) {
      case 'Point':
        return { ...base, ...pointPayload(geometry.coordinates, `${sourceLabel} ${entry.label}`) };

      case 'MultiPoint': {
        if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) {
          return {
            ...base,
            reason:
              `MultiPoint with ${lengthOf(geometry.coordinates)} positions. Only a MultiPoint ` +
              `holding exactly one position has an unambiguous mapping; split it into separate ` +
              `features first.`,
          };
        }
        return {
          ...base,
          ...pointPayload(geometry.coordinates[0], `${sourceLabel} ${entry.label}`),
        };
      }

      case 'Polygon':
        return { ...base, ...polygonPayload(geometry.coordinates, `${sourceLabel} ${entry.label}`) };

      case 'MultiPolygon': {
        if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) {
          return {
            ...base,
            reason:
              `MultiPolygon with ${lengthOf(geometry.coordinates)} polygons. A site has exactly ` +
              `one safety area, so only a MultiPolygon holding exactly one polygon maps ` +
              `unambiguously. Split it into separate features first.`,
          };
        }
        return {
          ...base,
          ...polygonPayload(geometry.coordinates[0], `${sourceLabel} ${entry.label}`),
        };
      }

      default:
        return {
          ...base,
          reason:
            `${geometry.type} has no defined mapping onto a site definition. This build imports ` +
            `${SUPPORTED_GEOMETRY_TYPES.join(', ')}.`,
        };
    }
  } catch (err) {
    return { ...base, reason: err instanceof Error ? err.message : String(err) };
  }
}

function pointPayload(coordinates, where) {
  const position = readPosition(coordinates, where);
  return {
    supported: true,
    position,
    hadElevation: position.hadElevation,
    // A point could be a mission point or the origin; the user decides. The
    // suggestion is the less consequential of the two.
    suggestedTarget: 'mission_point',
  };
}

function polygonPayload(coordinates, where) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    throw new Error(`${where}: a Polygon needs at least one linear ring.`);
  }
  if (coordinates.length > 1) {
    throw new Error(
      `${where}: this Polygon has ${coordinates.length - 1} interior ring(s) (holes). A safety ` +
        `area in this format is a single ring and cannot express a hole, and dropping one would ` +
        `silently enlarge the area you are allowed to fly in. Remove the holes, or import the ` +
        `exterior ring as its own feature.`
    );
  }

  const ring = coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4) {
    throw new Error(
      `${where}: a GeoJSON linear ring needs at least four positions, the last repeating the ` +
        `first. Found ${lengthOf(ring)}.`
    );
  }

  const positions = ring.map((position, index) => readPosition(position, `${where} position ${index}`));

  // GeoJSON rings repeat the first position at the end; this project's safety
  // area is an open ring, so the duplicate is dropped here rather than being
  // imported and then reported as a warning by the site validator.
  const first = positions[0];
  const last = positions[positions.length - 1];
  const closed =
    first.latitude_deg === last.latitude_deg && first.longitude_deg === last.longitude_deg;
  const open = closed ? positions.slice(0, -1) : positions;

  if (open.length < 3) {
    throw new Error(`${where}: the ring has only ${open.length} distinct position(s).`);
  }

  return {
    supported: true,
    ring: open,
    // Reported so the mapping UI can mention it. Not fatal: plenty of real
    // files omit the repeated closing position, and this project's ring is
    // closed implicitly either way.
    unclosedRing: !closed,
    hadElevation: positions.some((position) => position.hadElevation),
    suggestedTarget: 'safety_area',
  };
}

/**
 * Apply a confirmed mapping to a site.
 *
 * The site is not mutated: a new object is returned, so a failed or unwanted
 * import cannot leave the editor holding a half-changed document.
 *
 * @param {{site: object, features: Array<object>, plan: Record<number, string>}} request
 *   `plan` maps a feature index to one of IMPORT_TARGETS.
 * @returns {{site: object|null, findings: Array<object>, summary: object}}
 */
export function applyImportPlan(request) {
  const { site, features, plan } = request;
  const findings = [];
  const summary = { safetyAreaVertices: 0, missionPoints: 0, originSet: false };

  if (site === null || typeof site !== 'object') {
    return { site: null, findings: [error('import.no_site', 'There is no site to import into.')], summary };
  }

  const chosen = features
    .map((feature) => ({ feature, target: plan[feature.index] ?? 'ignore' }))
    .filter((entry) => entry.target !== 'ignore');

  if (chosen.length === 0) {
    return {
      site: null,
      findings: [info('import.nothing_selected', 'Nothing was selected for import.')],
      summary,
    };
  }

  for (const entry of chosen) {
    if (!IMPORT_TARGETS.includes(entry.target)) {
      return {
        site: null,
        findings: [error('import.bad_target', `Unknown import target "${entry.target}".`)],
        summary,
      };
    }
    if (!entry.feature.supported) {
      return {
        site: null,
        findings: [
          error(
            'import.unsupported_selected',
            `"${entry.feature.label}" cannot be imported: ${entry.feature.reason}`
          ),
        ],
        summary,
      };
    }
  }

  // --- work out the origin ---------------------------------------------------
  const originEntries = chosen.filter((entry) => entry.target === 'origin');
  if (originEntries.length > 1) {
    return {
      site: null,
      findings: [
        error('import.multiple_origins', 'Only one feature can be the origin; more than one was chosen.'),
      ],
      summary,
    };
  }
  for (const entry of originEntries) {
    if (entry.feature.position === null) {
      return {
        site: null,
        findings: [
          error(
            'import.origin_not_a_point',
            `"${entry.feature.label}" is a ${entry.feature.geometryType}. Only a Point can be ` +
              `the site origin.`
          ),
        ],
        summary,
      };
    }
  }

  const existingOrigin = usableOrigin(site.origin);
  let origin = existingOrigin;

  if (originEntries.length === 1) {
    if (existingOrigin !== null) {
      return {
        site: null,
        findings: [
          error(
            'import.origin_already_set',
            `This site already has an origin at ${existingOrigin.latitude_deg}, ` +
              `${existingOrigin.longitude_deg}. Moving it would change the meaning of every ` +
              `local coordinate already in the site, so this import will not do it. Edit the ` +
              `origin in the "Origin and frame" panel if you really want to move it, then ` +
              `import again.`
          ),
        ],
        summary,
      };
    }
    origin = {
      latitude_deg: originEntries[0].feature.position.latitude_deg,
      longitude_deg: originEntries[0].feature.position.longitude_deg,
    };
    summary.originSet = true;
  }

  if (origin === null) {
    return {
      site: null,
      findings: [
        error(
          'import.no_origin',
          'This site has no usable origin, so latitude/longitude cannot be converted into local ' +
            'ENU metres. Either set the origin in the "Origin and frame" panel first, or mark ' +
            'one of the imported points as the origin. The toolkit will not pick one for you.'
        ),
      ],
      summary,
    };
  }

  // --- build the new site ----------------------------------------------------
  const next = structuredClone(site);
  if (summary.originSet) {
    next.origin = {
      ...(isPlainObject(next.origin) ? next.origin : {}),
      latitude_deg: roundTo(origin.latitude_deg, 9),
      longitude_deg: roundTo(origin.longitude_deg, 9),
    };
    // The origin altitude is a separate, safety-relevant value that GeoJSON
    // does not carry a reference for. It stays whatever the site already said,
    // which for a new site is "not set".
    if (!Number.isFinite(next.origin.altitude_amsl_m)) {
      next.origin.altitude_amsl_m = null;
      findings.push(
        warn(
          'import.origin_altitude_unset',
          'The origin position was imported, but its altitude was not: GeoJSON does not say what ' +
            'an elevation is measured against. Set origin.altitude_amsl_m by hand.'
        )
      );
    }
  }

  const areaEntries = chosen.filter((entry) => entry.target === 'safety_area');
  if (areaEntries.length > 1) {
    return {
      site: null,
      findings: [
        error(
          'import.multiple_safety_areas',
          `A site has exactly one safety area, but ${areaEntries.length} features were mapped ` +
            `to it. Choose one.`
        ),
      ],
      summary,
    };
  }
  if (areaEntries.length === 1) {
    const feature = areaEntries[0].feature;
    if (feature.ring === null) {
      return {
        site: null,
        findings: [
          error(
            'import.area_not_a_polygon',
            `"${feature.label}" is a ${feature.geometryType}. Only a Polygon can become the ` +
              `safety area.`
          ),
        ],
        summary,
      };
    }
    const ring = feature.ring.map((position) => toLocal(origin, position));
    if (!isPlainObject(next.safety_area)) next.safety_area = {};
    const replaced = Array.isArray(next.safety_area.horizontal)
      ? next.safety_area.horizontal.length
      : 0;
    next.safety_area.horizontal = ring;
    summary.safetyAreaVertices = ring.length;
    if (replaced > 0) {
      findings.push(
        warn(
          'import.safety_area_replaced',
          `The existing safety area (${replaced} vertices) was replaced by the imported polygon ` +
            `(${ring.length} vertices).`
        )
      );
    }
  }

  const pointEntries = chosen.filter((entry) => entry.target === 'mission_point');
  if (pointEntries.length > 0) {
    if (!Array.isArray(next.mission_points)) next.mission_points = [];
    const taken = new Set(next.mission_points.map((point) => point.id));
    for (const entry of pointEntries) {
      const feature = entry.feature;
      if (feature.position === null) {
        return {
          site: null,
          findings: [
            error(
              'import.point_not_a_point',
              `"${feature.label}" is a ${feature.geometryType}. Only a Point can become a ` +
                `mission point.`
            ),
          ],
          summary,
        };
      }
      const local = toLocal(origin, feature.position);
      next.mission_points.push({
        id: uniqueId(feature.label, taken),
        east_m: local.east_m,
        north_m: local.north_m,
        // Altitude and its reference are safety-critical and GeoJSON carries
        // neither in a form this toolkit can trust. They stay unset and the
        // site validator reports them until a human fills them in.
        altitude_m: null,
        altitude_reference: null,
        heading_deg: null,
      });
      summary.missionPoints += 1;
    }
    findings.push(
      warn(
        'import.altitudes_unset',
        `${summary.missionPoints} imported mission point(s) have no altitude and no altitude ` +
          `reference. Set both before exporting: nothing here invents them.`
      )
    );
  }

  return { site: next, findings, summary };
}

/**
 * Convert a WGS84 position to the site's local ENU frame.
 * @param {{latitude_deg:number,longitude_deg:number}} origin
 * @param {{latitude_deg:number,longitude_deg:number}} position
 * @returns {{east_m:number,north_m:number}}
 */
export function toLocal(origin, position) {
  const enu = geodeticToEnu(origin, position);
  return {
    east_m: roundTo(enu.east_m, COORDINATE_DECIMALS),
    north_m: roundTo(enu.north_m, COORDINATE_DECIMALS),
  };
}

/**
 * The site origin, if it is usable for a conversion. Null otherwise; this is
 * what stops the import from inventing one.
 * @param {unknown} origin
 * @returns {{latitude_deg:number,longitude_deg:number}|null}
 */
export function usableOrigin(origin) {
  if (!isPlainObject(origin)) return null;
  const { latitude_deg: lat, longitude_deg: lon } = origin;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { latitude_deg: lat, longitude_deg: lon };
}

// --- helpers ----------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function lengthOf(value) {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * A readable name for a feature, taken from the usual property keys. Purely
 * cosmetic: nothing downstream reads meaning out of it.
 */
function featureLabel(feature, index) {
  const properties = isPlainObject(feature.properties) ? feature.properties : {};
  for (const key of ['name', 'Name', 'NAME', 'title', 'id', 'ref']) {
    const value = properties[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  if (typeof feature.id === 'string' && feature.id.trim() !== '') return feature.id.trim();
  return `feature ${index}`;
}

/** Turn a label into a mission point id that is not already taken. */
function uniqueId(label, taken) {
  const base =
    String(label).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'imported';
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let i = 2; ; i += 1) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}
