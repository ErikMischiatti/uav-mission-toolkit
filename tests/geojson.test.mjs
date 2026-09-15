/**
 * Generic GeoJSON import.
 *
 * Two things are being protected here above all else:
 *
 *  - **Coordinate order.** GeoJSON is [longitude, latitude]. A swapped pair
 *    usually still parses and often still plots somewhere plausible, which is
 *    exactly what makes it dangerous. Several tests below would pass with the
 *    order reversed if they only checked that *a* number came out, so they
 *    check which way the geometry actually moved.
 *  - **That nothing is invented.** No origin, no altitude, no altitude
 *    reference, and no assumption that a polygon in a file is a safety area.
 */

import {
  IMPORT_TARGETS,
  applyImportPlan,
  buildGeoJsonFromSite,
  parseGeoJson,
  readPosition,
  toLocal,
  usableOrigin,
} from '../shared/js/geojson.js';
import { validateSite } from '../shared/js/validation.js';
import { demoSite } from './fixtures.mjs';
import { assert, assertClose, assertThrowsWith, describe } from './harness.mjs';

/** A site with an origin at a round, obviously synthetic position. */
function siteWithOrigin() {
  const site = demoSite();
  site.origin = { latitude_deg: 48, longitude_deg: 11, altitude_amsl_m: 520 };
  return site;
}

/** A site with no usable origin at all. */
function siteWithoutOrigin() {
  const site = demoSite();
  site.origin = {};
  site.safety_area.horizontal = [];
  site.mission_points = [];
  return site;
}

const point = (lon, lat, properties = {}) => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Point', coordinates: [lon, lat] },
});

const polygon = (ring, properties = {}) => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Polygon', coordinates: [ring] },
});

const collection = (...features) => ({ type: 'FeatureCollection', features });

/** A small closed ring around 11E 48N, in GeoJSON [lon, lat] order. */
const RING = [
  [11.000, 48.000],
  [11.002, 48.000],
  [11.002, 48.001],
  [11.000, 48.001],
  [11.000, 48.000],
];

/** Map every supported feature to one target. */
function planFor(features, target) {
  const plan = {};
  for (const feature of features) plan[feature.index] = target;
  return plan;
}

describe('geojson: positions and coordinate order', (test) => {
  test('a position is read as [longitude, latitude], in that order', () => {
    const position = readPosition([11.5, 48.25]);
    assert.equal(position.longitude_deg, 11.5);
    assert.equal(position.latitude_deg, 48.25);
  });

  test('a latitude above 90 in second place is rejected with the order explained', () => {
    // This is what a reversed pair looks like: [48, 110] read as lon 48, lat 110.
    assertThrowsWith(() => readPosition([48, 110]), '[longitude, latitude]');
    assertThrowsWith(() => readPosition([48, 110]), 'reversed');
  });

  test('a longitude outside [-180, 180] is rejected', () => {
    assertThrowsWith(() => readPosition([200, 48]), 'longitude 200');
  });

  test('a position needs at least two numbers', () => {
    assertThrowsWith(() => readPosition([11]), 'at least two numbers');
    assertThrowsWith(() => readPosition('11,48'), 'at least two numbers');
    assertThrowsWith(() => readPosition([null, 48]), 'longitude (the FIRST value)');
    assertThrowsWith(() => readPosition([11, 'x']), 'latitude (the SECOND value)');
  });

  test('an elevation is noticed but not consumed', () => {
    assert.equal(readPosition([11, 48, 500]).hadElevation, true);
    assert.equal(readPosition([11, 48]).hadElevation, false);
  });

  test('the conversion puts east and north where they belong', () => {
    const origin = { latitude_deg: 48, longitude_deg: 11 };
    // Longitude larger than the origin's means east; latitude larger means north.
    const east = toLocal(origin, { latitude_deg: 48, longitude_deg: 11.001 });
    assert.ok(east.east_m > 0, 'a larger longitude must be further east');
    assertClose(east.north_m, 0, 1e-6);

    const north = toLocal(origin, { latitude_deg: 48.001, longitude_deg: 11 });
    assert.ok(north.north_m > 0, 'a larger latitude must be further north');
    assertClose(north.east_m, 0, 1e-6);

    // And the magnitudes are right: 0.001 deg of latitude is about 111 m.
    assert.ok(north.north_m > 100 && north.north_m < 120, `got ${north.north_m} m`);
    // At 48 N a degree of longitude is roughly cos(48) of a degree of latitude.
    assert.ok(east.east_m > 65 && east.east_m < 80, `got ${east.east_m} m`);
  });

  test('the origin itself converts to exactly (0, 0)', () => {
    const origin = { latitude_deg: 48, longitude_deg: 11 };
    assert.deepEqual(toLocal(origin, { latitude_deg: 48, longitude_deg: 11 }), {
      east_m: 0,
      north_m: 0,
    });
  });
});

describe('geojson: parsing shapes', (test) => {
  test('a FeatureCollection yields one entry per feature', () => {
    const { features } = parseGeoJson(collection(point(11, 48), polygon(RING)));
    assert.equal(features.length, 2);
    assert.equal(features[0].geometryType, 'Point');
    assert.equal(features[1].geometryType, 'Polygon');
    assert.ok(features.every((f) => f.supported));
  });

  test('a bare Feature works', () => {
    const { features } = parseGeoJson(point(11, 48, { name: 'pad' }));
    assert.equal(features.length, 1);
    assert.equal(features[0].label, 'pad');
    assert.equal(features[0].suggestedTarget, 'mission_point');
  });

  test('a bare geometry object works', () => {
    const { features } = parseGeoJson({ type: 'Point', coordinates: [11, 48] });
    assert.equal(features.length, 1);
    assert.equal(features[0].supported, true);
  });

  test('a polygon is suggested as a safety area, but only suggested', () => {
    const { features } = parseGeoJson(polygon(RING));
    assert.equal(features[0].suggestedTarget, 'safety_area');
    // The suggestion is not an import. Nothing happens without a plan.
    const result = applyImportPlan({ site: siteWithOrigin(), features, plan: {} });
    assert.equal(result.site, null);
    assert.equal(result.findings[0].code, 'import.nothing_selected');
  });

  test('a ring loses its repeated closing position', () => {
    const { features } = parseGeoJson(polygon(RING));
    assert.equal(RING.length, 5);
    assert.equal(features[0].ring.length, 4, 'the duplicated first vertex is dropped');
    assert.equal(features[0].unclosedRing, false);
  });

  test('a ring that is not explicitly closed is still accepted', () => {
    const open = RING.slice(0, -1);
    const { features } = parseGeoJson(polygon([...open, open[0]]));
    assert.equal(features[0].ring.length, 4);
  });

  test('a feature name is taken from the usual property keys', () => {
    assert.equal(parseGeoJson(point(11, 48, { name: 'alpha' })).features[0].label, 'alpha');
    assert.equal(parseGeoJson(point(11, 48, { title: 'bravo' })).features[0].label, 'bravo');
    assert.equal(parseGeoJson(point(11, 48)).features[0].label, 'feature 0');
  });
});

describe('geojson: malformed and unsupported input', (test) => {
  test('something that is not an object at all is rejected', () => {
    for (const bad of [null, 42, 'text', []]) {
      const { features, findings } = parseGeoJson(bad);
      assert.equal(features.length, 0);
      assert.equal(findings[0].severity, 'error');
    }
  });

  test('an object with no type is rejected', () => {
    const { findings } = parseGeoJson({ features: [] });
    assert.equal(findings[0].code, 'geojson.missing_type');
  });

  test('a FeatureCollection with no features array is rejected', () => {
    const { findings } = parseGeoJson({ type: 'FeatureCollection' });
    assert.equal(findings[0].code, 'geojson.feature_collection');
  });

  test('an empty FeatureCollection is reported, not treated as an error', () => {
    const { features, findings } = parseGeoJson(collection());
    assert.equal(features.length, 0);
    assert.equal(findings[0].severity, 'info');
  });

  test('a non-Feature entry inside a FeatureCollection is skipped with a warning', () => {
    const { features, findings } = parseGeoJson({
      type: 'FeatureCollection',
      features: [point(11, 48), { type: 'Point', coordinates: [11, 48] }],
    });
    assert.equal(features.length, 1);
    assert.ok(findings.some((f) => f.code === 'geojson.not_a_feature'));
  });

  test('a LineString is unsupported, and says why', () => {
    const { features } = parseGeoJson({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[11, 48], [11.001, 48]] },
    });
    assert.equal(features[0].supported, false);
    assert.ok(features[0].reason.includes('no defined mapping'));
  });

  test('a GeometryCollection is refused with an explanation', () => {
    const { findings } = parseGeoJson({
      type: 'GeometryCollection',
      geometries: [{ type: 'Point', coordinates: [11, 48] }],
    });
    assert.equal(findings[0].code, 'geojson.geometry_collection');
    assert.ok(findings[0].message.includes('FeatureCollection'));
  });

  test('a feature with no geometry is unsupported rather than a crash', () => {
    const { features } = parseGeoJson({ type: 'Feature', properties: {}, geometry: null });
    assert.equal(features[0].supported, false);
  });

  test('a polygon with a hole is refused, because dropping it would enlarge the area', () => {
    const hole = [
      [11.0005, 48.0002],
      [11.0015, 48.0002],
      [11.0015, 48.0008],
      [11.0005, 48.0002],
    ];
    const { features } = parseGeoJson({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [RING, hole] },
    });
    assert.equal(features[0].supported, false);
    assert.ok(features[0].reason.includes('hole'));
  });

  test('a ring with too few positions is refused', () => {
    const { features } = parseGeoJson(polygon([[11, 48], [11.001, 48], [11, 48]]));
    assert.equal(features[0].supported, false);
    assert.ok(features[0].reason.includes('four positions'));
  });

  test('a bad coordinate inside a ring names the offending position', () => {
    const bad = [[11, 48], [11.002, 48], [11.002, 999], [11, 48]];
    const { features } = parseGeoJson(polygon([...bad, bad[0]]));
    assert.equal(features[0].supported, false);
    assert.ok(features[0].reason.includes('position'));
  });
});

describe('geojson: multi-geometries are taken only when unambiguous', (test) => {
  test('a MultiPolygon holding one polygon is treated as that polygon', () => {
    const { features } = parseGeoJson({
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: [[RING]] },
    });
    assert.equal(features[0].supported, true);
    assert.equal(features[0].ring.length, 4);
  });

  test('a MultiPolygon holding several polygons is refused', () => {
    const { features } = parseGeoJson({
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: [[RING], [RING]] },
    });
    assert.equal(features[0].supported, false);
    assert.ok(features[0].reason.includes('exactly one polygon'));
  });

  test('a MultiPoint holding one position is treated as that point', () => {
    const { features } = parseGeoJson({
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPoint', coordinates: [[11, 48]] },
    });
    assert.equal(features[0].supported, true);
    assert.equal(features[0].position.longitude_deg, 11);
  });

  test('a MultiPoint holding several positions is refused', () => {
    const { features } = parseGeoJson({
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPoint', coordinates: [[11, 48], [11.001, 48]] },
    });
    assert.equal(features[0].supported, false);
  });
});

describe('geojson: applying a confirmed plan', (test) => {
  test('a polygon becomes the safety area, converted into local metres', () => {
    const site = siteWithOrigin();
    const { features } = parseGeoJson(polygon(RING));
    const result = applyImportPlan({
      site,
      features,
      plan: { 0: 'safety_area' },
    });

    assert.notEqual(result.site, null);
    assert.equal(result.summary.safetyAreaVertices, 4);
    const ring = result.site.safety_area.horizontal;
    // The first RING position is the origin itself, so it must land on (0, 0).
    assert.deepEqual(ring[0], { east_m: 0, north_m: 0 });
    // The second is 0.002 deg further east and no further north.
    assert.ok(ring[1].east_m > 100, `expected an eastward offset, got ${ring[1].east_m}`);
    assertClose(ring[1].north_m, 0, 1e-6);
    // The third is also north.
    assert.ok(ring[2].north_m > 100, `expected a northward offset, got ${ring[2].north_m}`);
  });

  test('the source site is never mutated', () => {
    const site = siteWithOrigin();
    const before = JSON.stringify(site);
    const { features } = parseGeoJson(polygon(RING));
    applyImportPlan({ site, features, plan: { 0: 'safety_area' } });
    assert.equal(JSON.stringify(site), before, 'applyImportPlan must return a new site');
  });

  test('points become mission points with no altitude and no reference', () => {
    const site = siteWithOrigin();
    const { features } = parseGeoJson(
      collection(point(11.001, 48.001, { name: 'alpha' }), point(11.002, 48.002, { name: 'bravo' }))
    );
    const result = applyImportPlan({ site, features, plan: planFor(features, 'mission_point') });

    assert.equal(result.summary.missionPoints, 2);
    const added = result.site.mission_points.slice(-2);
    assert.deepEqual(added.map((p) => p.id), ['alpha', 'bravo']);
    for (const imported of added) {
      assert.equal(imported.altitude_m, null, 'an altitude must never be invented');
      assert.equal(imported.altitude_reference, null, 'a reference must never be invented');
      assert.ok(imported.east_m > 0 && imported.north_m > 0);
    }
    assert.ok(result.findings.some((f) => f.code === 'import.altitudes_unset'));
  });

  test('an imported id that collides with an existing one is made unique', () => {
    const site = siteWithOrigin();
    const { features } = parseGeoJson(point(11.001, 48.001, { name: 'takeoff_pad' }));
    const result = applyImportPlan({ site, features, plan: { 0: 'mission_point' } });
    const ids = result.site.mission_points.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'ids must stay unique within a site');
    assert.ok(ids.includes('takeoff_pad_2'));
  });

  test('replacing an existing safety area is reported, not silent', () => {
    const site = siteWithOrigin();
    const { features } = parseGeoJson(polygon(RING));
    const result = applyImportPlan({ site, features, plan: { 0: 'safety_area' } });
    assert.ok(result.findings.some((f) => f.code === 'import.safety_area_replaced'));
  });

  test('two polygons cannot both be the safety area', () => {
    const site = siteWithOrigin();
    const { features } = parseGeoJson(collection(polygon(RING), polygon(RING)));
    const result = applyImportPlan({ site, features, plan: planFor(features, 'safety_area') });
    assert.equal(result.site, null);
    assert.equal(result.findings[0].code, 'import.multiple_safety_areas');
  });

  test('a point cannot be mapped to the safety area, nor a polygon to a mission point', () => {
    const site = siteWithOrigin();
    const pointFeatures = parseGeoJson(point(11, 48)).features;
    assert.equal(
      applyImportPlan({ site, features: pointFeatures, plan: { 0: 'safety_area' } }).findings[0].code,
      'import.area_not_a_polygon'
    );

    const polygonFeatures = parseGeoJson(polygon(RING)).features;
    assert.equal(
      applyImportPlan({ site, features: polygonFeatures, plan: { 0: 'mission_point' } }).findings[0].code,
      'import.point_not_a_point'
    );
  });

  test('an unsupported feature cannot be forced through by selecting it', () => {
    const site = siteWithOrigin();
    const { features } = parseGeoJson({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[11, 48], [11.001, 48]] },
    });
    const result = applyImportPlan({ site, features, plan: { 0: 'safety_area' } });
    assert.equal(result.site, null);
    assert.equal(result.findings[0].code, 'import.unsupported_selected');
  });

  test('an unknown target is refused rather than ignored', () => {
    const site = siteWithOrigin();
    const { features } = parseGeoJson(point(11, 48));
    const result = applyImportPlan({ site, features, plan: { 0: 'somewhere_else' } });
    assert.equal(result.findings[0].code, 'import.bad_target');
  });

  test('the produced site still passes the ordinary site validator', () => {
    const site = siteWithOrigin();
    const { features } = parseGeoJson(polygon(RING));
    const result = applyImportPlan({ site, features, plan: { 0: 'safety_area' } });
    const findings = validateSite(result.site);
    const codes = findings.map((f) => f.code);
    // The imported square is a perfectly good ring: no geometry complaints.
    assert.ok(!codes.includes('safety_area.horizontal.self_intersecting'), codes.join(', '));
    assert.ok(!codes.includes('safety_area.horizontal.degenerate'), codes.join(', '));
    assert.ok(!codes.includes('safety_area.horizontal.closed_ring'), codes.join(', '));
  });
});

describe('geojson: the origin is never invented', (test) => {
  test('without an origin the import is refused with an explanation', () => {
    const site = siteWithoutOrigin();
    const { features } = parseGeoJson(polygon(RING));
    const result = applyImportPlan({ site, features, plan: { 0: 'safety_area' } });

    assert.equal(result.site, null);
    assert.equal(result.findings[0].code, 'import.no_origin');
    assert.ok(result.findings[0].message.includes('will not pick one for you'));
  });

  test('a point explicitly marked as the origin sets it', () => {
    const site = siteWithoutOrigin();
    const { features } = parseGeoJson(collection(point(11, 48), polygon(RING)));
    const result = applyImportPlan({
      site,
      features,
      plan: { 0: 'origin', 1: 'safety_area' },
    });

    assert.notEqual(result.site, null);
    assert.equal(result.summary.originSet, true);
    assert.equal(result.site.origin.latitude_deg, 48);
    assert.equal(result.site.origin.longitude_deg, 11);
    // The polygon was converted against the origin set in the same operation.
    assert.deepEqual(result.site.safety_area.horizontal[0], { east_m: 0, north_m: 0 });
  });

  test('an imported origin brings no altitude with it', () => {
    const site = siteWithoutOrigin();
    const { features } = parseGeoJson(point(11, 48));
    const result = applyImportPlan({ site, features, plan: { 0: 'origin' } });
    assert.equal(result.site.origin.altitude_amsl_m, null);
    assert.ok(result.findings.some((f) => f.code === 'import.origin_altitude_unset'));
  });

  test('an existing origin is not silently moved', () => {
    const site = siteWithOrigin();
    const { features } = parseGeoJson(point(12, 49));
    const result = applyImportPlan({ site, features, plan: { 0: 'origin' } });
    assert.equal(result.site, null);
    assert.equal(result.findings[0].code, 'import.origin_already_set');
  });

  test('only one feature can be the origin', () => {
    const site = siteWithoutOrigin();
    const { features } = parseGeoJson(collection(point(11, 48), point(12, 49)));
    const result = applyImportPlan({ site, features, plan: planFor(features, 'origin') });
    assert.equal(result.findings[0].code, 'import.multiple_origins');
  });

  test('a polygon cannot be the origin', () => {
    const site = siteWithoutOrigin();
    const { features } = parseGeoJson(polygon(RING));
    const result = applyImportPlan({ site, features, plan: { 0: 'origin' } });
    assert.equal(result.findings[0].code, 'import.origin_not_a_point');
  });

  test('usableOrigin refuses anything it cannot convert with', () => {
    assert.equal(usableOrigin(null), null);
    assert.equal(usableOrigin({}), null);
    assert.equal(usableOrigin({ latitude_deg: 48 }), null);
    assert.equal(usableOrigin({ latitude_deg: 91, longitude_deg: 11 }), null);
    assert.equal(usableOrigin({ latitude_deg: 48, longitude_deg: 181 }), null);
    assert.deepEqual(usableOrigin({ latitude_deg: 48, longitude_deg: 11 }), {
      latitude_deg: 48,
      longitude_deg: 11,
    });
  });
});

describe('geojson: the import vocabulary', (test) => {
  test('the targets are the documented ones', () => {
    assert.deepEqual([...IMPORT_TARGETS], ['ignore', 'safety_area', 'mission_point', 'origin']);
  });

  test('elevation values are reported as ignored rather than used', () => {
    const { findings } = parseGeoJson({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [11, 48, 500] },
    });
    const note = findings.find((f) => f.code === 'geojson.elevation_ignored');
    assert.ok(note, 'an ignored elevation must be reported');
    assert.ok(note.message.includes('never guesses'));
  });
});

describe('geojson: export', (test) => {
  test('a site becomes a FeatureCollection with the origin, the area and the points', () => {
    const { geojson, findings } = buildGeoJsonFromSite(siteWithOrigin());
    assert.equal(geojson.type, 'FeatureCollection');

    const roles = geojson.features.map((f) => f.properties.role);
    assert.ok(roles.includes('safety_area'));
    assert.ok(roles.includes('origin'));
    assert.equal(roles.filter((r) => r === 'mission_point').length, 4);
    assert.ok(findings.some((f) => f.code === 'export.lossy'));
  });

  test('the exported ring is closed the way GeoJSON requires', () => {
    const { geojson } = buildGeoJsonFromSite(siteWithOrigin());
    const area = geojson.features.find((f) => f.properties.role === 'safety_area');
    const ring = area.geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1], 'a linear ring repeats its first position');
    assert.equal(ring.length, siteWithOrigin().safety_area.horizontal.length + 1);
  });

  test('exported positions are [longitude, latitude], in that order', () => {
    const { geojson } = buildGeoJsonFromSite(siteWithOrigin());
    const origin = geojson.features.find((f) => f.properties.role === 'origin');
    const [longitude, latitude] = origin.geometry.coordinates;
    assert.equal(longitude, 11, 'longitude comes first');
    assert.equal(latitude, 48, 'latitude comes second');
  });

  test('altitudes travel as properties, never as a third coordinate', () => {
    const { geojson } = buildGeoJsonFromSite(siteWithOrigin());
    for (const feature of geojson.features) {
      const positions =
        feature.geometry.type === 'Point'
          ? [feature.geometry.coordinates]
          : feature.geometry.coordinates[0];
      for (const position of positions) {
        assert.equal(position.length, 2, 'a third value would be read as an unreferenced height');
      }
    }
    const missionPoint = geojson.features.find((f) => f.properties.role === 'mission_point');
    assert.equal(typeof missionPoint.properties.altitude_m, 'number');
    assert.equal(missionPoint.properties.altitude_reference, 'AGL');
  });

  test('a site with no usable origin cannot be exported, and says why', () => {
    const { geojson, findings } = buildGeoJsonFromSite(siteWithoutOrigin());
    assert.equal(geojson, null);
    assert.equal(findings[0].code, 'export.no_origin');
  });

  test('export and import round-trip the safety area back to the same metres', () => {
    const site = siteWithOrigin();
    const { geojson } = buildGeoJsonFromSite(site);

    const { features } = parseGeoJson(geojson);
    const area = features.find((f) => f.geometryType === 'Polygon');
    const target = { ...site, safety_area: { ...site.safety_area, horizontal: [] } };
    const result = applyImportPlan({
      site: target,
      features,
      plan: { [area.index]: 'safety_area' },
    });

    const before = site.safety_area.horizontal;
    const after = result.site.safety_area.horizontal;
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i += 1) {
      // A round trip through degrees loses a little; a millimetre is plenty.
      assertClose(after[i].east_m, before[i].east_m, 1e-3, `vertex ${i} east`);
      assertClose(after[i].north_m, before[i].north_m, 1e-3, `vertex ${i} north`);
    }
  });
});
