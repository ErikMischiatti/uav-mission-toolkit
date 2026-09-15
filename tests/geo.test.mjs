/**
 * shared/js/geo.js - the only place the project converts between WGS84 and the
 * local ENU frame, and the source of every geometric predicate the validators
 * rely on.
 */

import {
  LOCAL_FRAME_RECOMMENDED_RADIUS_M,
  assertFiniteNumber,
  bearingDeg,
  boundingBox,
  distance2dM,
  distance3dM,
  enuToGeodetic,
  geodeticToEnu,
  maxRadiusFromOriginM,
  metersPerDegree,
  normalizeHeadingDeg,
  normalizeLongitudeDeltaDeg,
  pathLengthM,
  pointInPolygon,
  polygonAreaM2,
  polygonPerimeterM,
  polygonSelfIntersections,
  polygonSignedAreaM2,
  verticesMean,
} from '../shared/js/geo.js';
import {
  BOWTIE,
  COLLINEAR,
  L_SHAPE,
  SQUARE_CCW,
  SQUARE_CW,
  demoSite,
  p,
} from './fixtures.mjs';
import {
  assert,
  assertBetween,
  assertClose,
  assertThrowsWith,
  describe,
} from './harness.mjs';

const MUNICH_ISH = { latitude_deg: 48.0, longitude_deg: 11.0 };

describe('geo: ENU <-> geodetic round-trip', (test) => {
  test('ENU -> geodetic -> ENU returns the original offset', () => {
    for (const enu of [
      { east_m: 0, north_m: 0 },
      { east_m: 120, north_m: -95 },
      { east_m: -1234.5, north_m: 987.6 },
      { east_m: 4999, north_m: -4999 },
    ]) {
      const back = geodeticToEnu(MUNICH_ISH, enuToGeodetic(MUNICH_ISH, enu));
      assertClose(back.east_m, enu.east_m, 1e-6, `east for ${JSON.stringify(enu)}`);
      assertClose(back.north_m, enu.north_m, 1e-6, `north for ${JSON.stringify(enu)}`);
    }
  });

  test('geodetic -> ENU -> geodetic returns the original position', () => {
    const point = { latitude_deg: 48.0102, longitude_deg: 10.9897 };
    const back = enuToGeodetic(MUNICH_ISH, geodeticToEnu(MUNICH_ISH, point));
    assertClose(back.latitude_deg, point.latitude_deg, 1e-12);
    assertClose(back.longitude_deg, point.longitude_deg, 1e-12);
  });

  test('round-trips at the equator, mid-latitude and high latitude', () => {
    for (const latitude_deg of [0, 23.5, 48, 71.5]) {
      const origin = { latitude_deg, longitude_deg: -3.25 };
      const enu = { east_m: 750, north_m: -400 };
      const back = geodeticToEnu(origin, enuToGeodetic(origin, enu));
      assertClose(back.east_m, enu.east_m, 1e-6, `east at ${latitude_deg} deg`);
      assertClose(back.north_m, enu.north_m, 1e-6, `north at ${latitude_deg} deg`);
    }
  });

  test('the origin maps to (0, 0) and back exactly', () => {
    const enu = geodeticToEnu(MUNICH_ISH, MUNICH_ISH);
    assert.equal(enu.east_m, 0);
    assert.equal(enu.north_m, 0);
    const geodetic = enuToGeodetic(MUNICH_ISH, { east_m: 0, north_m: 0 });
    assert.equal(geodetic.latitude_deg, MUNICH_ISH.latitude_deg);
    assert.equal(geodetic.longitude_deg, MUNICH_ISH.longitude_deg);
  });

  test('axes point the right way: +north is north, +east is east', () => {
    const north = geodeticToEnu(MUNICH_ISH, { latitude_deg: 48.01, longitude_deg: 11.0 });
    assert.equal(north.east_m, 0);
    assertBetween(north.north_m, 1110, 1116, '0.01 deg of latitude in metres');

    const east = geodeticToEnu(MUNICH_ISH, { latitude_deg: 48.0, longitude_deg: 11.01 });
    assert.equal(east.north_m, 0);
    assertBetween(east.east_m, 740, 750, '0.01 deg of longitude at 48 deg north');
  });

  test('metres per degree stay inside the physically possible band', () => {
    for (const latitude_deg of [-89, -45, 0, 45, 89]) {
      const scale = metersPerDegree(latitude_deg);
      assertBetween(scale.north_m_per_deg, 110500, 111800, `north at ${latitude_deg} deg`);
      assertBetween(
        scale.east_m_per_deg,
        0,
        111350,
        `east at ${latitude_deg} deg`
      );
    }
    // The east scale shrinks with the cosine of the latitude.
    assert.ok(metersPerDegree(60).east_m_per_deg < metersPerDegree(0).east_m_per_deg / 1.9);
  });

  test('a site straddling the antimeridian does not jump halfway round the world', () => {
    const origin = { latitude_deg: -16.5, longitude_deg: 179.99 };
    const enu = geodeticToEnu(origin, { latitude_deg: -16.5, longitude_deg: -179.99 });
    assert.ok(enu.east_m > 0, 'crossing eastwards must give a positive east offset');
    assertBetween(enu.east_m, 2000, 2500, 'distance across the antimeridian');
  });

  test('normalizeLongitudeDeltaDeg wraps into [-180, 180)', () => {
    assert.equal(normalizeLongitudeDeltaDeg(0), 0);
    assert.equal(normalizeLongitudeDeltaDeg(10), 10);
    assert.equal(normalizeLongitudeDeltaDeg(180), -180);
    assert.equal(normalizeLongitudeDeltaDeg(-180), -180);
    assert.equal(normalizeLongitudeDeltaDeg(190), -170);
    assert.equal(normalizeLongitudeDeltaDeg(-190), 170);
    assertClose(normalizeLongitudeDeltaDeg(359.98), -0.02, 1e-9);
  });

  test('refuses to convert ENU at a pole instead of dividing by zero', () => {
    assertThrowsWith(
      () => enuToGeodetic({ latitude_deg: 90, longitude_deg: 0 }, { east_m: 10, north_m: 0 }),
      'too close to a pole'
    );
  });

  test('refuses non-finite inputs instead of producing NaN', () => {
    assertThrowsWith(
      () => geodeticToEnu(MUNICH_ISH, { latitude_deg: Number.NaN, longitude_deg: 11 }),
      'point.latitude_deg'
    );
    assertThrowsWith(
      () => geodeticToEnu({}, { latitude_deg: 48, longitude_deg: 11 }),
      'origin.latitude_deg'
    );
    assertThrowsWith(
      () => enuToGeodetic(MUNICH_ISH, { east_m: 'far', north_m: 0 }),
      'enu.east_m'
    );
    assertThrowsWith(() => assertFiniteNumber(Infinity, 'speed'), 'speed');
  });
});

describe('geo: heading normalization and cardinal directions', (test) => {
  test('normalizeHeadingDeg maps every angle into [0, 360)', () => {
    const expected = [
      [0, 0],
      [90, 90],
      [359.9, 359.9],
      [360, 0],
      [361, 1],
      [720, 0],
      [450, 90],
      [-1, 359],
      [-90, 270],
      [-360, 0],
      [-450, 270],
    ];
    for (const [input, want] of expected) {
      assertClose(normalizeHeadingDeg(input), want, 1e-9, `normalizeHeadingDeg(${input})`);
    }
  });

  test('normalizeHeadingDeg rejects a non-finite heading', () => {
    assertThrowsWith(() => normalizeHeadingDeg(Number.NaN), 'headingDeg');
    assertThrowsWith(() => normalizeHeadingDeg(null), 'headingDeg');
  });

  test('bearingDeg is degrees clockwise from north: 0 = N, 90 = E', () => {
    const origin = p(0, 0);
    const cardinals = [
      ['north', p(0, 100), 0],
      ['north-east', p(100, 100), 45],
      ['east', p(100, 0), 90],
      ['south-east', p(100, -100), 135],
      ['south', p(0, -100), 180],
      ['south-west', p(-100, -100), 225],
      ['west', p(-100, 0), 270],
      ['north-west', p(-100, 100), 315],
    ];
    for (const [label, target, want] of cardinals) {
      assertClose(bearingDeg(origin, target), want, 1e-9, `bearing to ${label}`);
    }
  });

  test('bearings are always returned normalized, never negative', () => {
    for (const target of [p(-1, 1), p(-1, 0), p(-1, -1), p(0, -1)]) {
      const bearing = bearingDeg(p(0, 0), target);
      assertBetween(bearing, 0, 359.9999999, `bearing to ${JSON.stringify(target)}`);
    }
  });

  test('the bearing between two coincident points is undefined, not zero', () => {
    assert.equal(bearingDeg(p(12, -4), p(12, -4)), null);
  });

  test('bearing does not depend on where the pair sits in the frame', () => {
    assertClose(bearingDeg(p(500, -300), p(500, -200)), 0);
    assertClose(bearingDeg(p(-500, 300), p(-400, 300)), 90);
  });
});

describe('geo: polygon area', (test) => {
  test('measures a 100 m square as 10 000 m²', () => {
    assertClose(polygonAreaM2(SQUARE_CCW), 10000);
    assertClose(polygonAreaM2(SQUARE_CW), 10000);
  });

  test('the signed area carries the winding direction', () => {
    assertClose(polygonSignedAreaM2(SQUARE_CCW), 10000);
    assertClose(polygonSignedAreaM2(SQUARE_CW), -10000);
  });

  test('measures a triangle as half base times height', () => {
    assertClose(polygonAreaM2([p(0, 0), p(100, 0), p(0, 50)]), 2500);
  });

  test('is invariant under translation and vertex rotation', () => {
    const shifted = SQUARE_CCW.map((v) => p(v.east_m - 4321, v.north_m + 8765));
    assertClose(polygonAreaM2(shifted), 10000, 1e-6);
    const rotated = [...SQUARE_CCW.slice(2), ...SQUARE_CCW.slice(0, 2)];
    assertClose(polygonAreaM2(rotated), 10000);
  });

  test('a degenerate ring has zero area rather than an error', () => {
    assert.equal(polygonAreaM2(COLLINEAR), 0);
    assert.equal(polygonAreaM2([p(0, 0), p(0, 0), p(0, 0)]), 0);
  });

  test('anything that is not a ring of three or more vertices measures zero', () => {
    assert.equal(polygonAreaM2([]), 0);
    assert.equal(polygonAreaM2([p(0, 0), p(1, 1)]), 0);
    assert.equal(polygonAreaM2(null), 0);
    assert.equal(polygonAreaM2('not a polygon'), 0);
  });

  test('measures the L shape as the sum of its two rectangles', () => {
    // 100x40 plus 40x60.
    assertClose(polygonAreaM2(L_SHAPE), 100 * 40 + 40 * 60);
  });

  test('measures the shipped demo site safety area', () => {
    const polygon = demoSite().safety_area.horizontal;
    assertClose(polygonAreaM2(polygon), 43750, 1e-6);
    assert.equal(polygon.length, 6);
  });

  test('the perimeter closes the ring implicitly', () => {
    assertClose(polygonPerimeterM(SQUARE_CCW), 400);
    assertClose(pathLengthM(SQUARE_CCW, { closed: false }), 300);
  });

  test('the mean of the vertices sits inside a convex ring', () => {
    const mean = verticesMean(SQUARE_CCW);
    assertClose(mean.east_m, 50);
    assertClose(mean.north_m, 50);
    assert.equal(verticesMean([]), null);
  });

  test('the bounding box spans the extremes', () => {
    const box = boundingBox(demoSite().safety_area.horizontal);
    assert.equal(box.min_east_m, -115);
    assert.equal(box.max_east_m, 120);
    assert.equal(box.min_north_m, -100);
    assert.equal(box.max_north_m, 115);
    assert.equal(box.width_m, 235);
    assert.equal(box.height_m, 215);
    assert.equal(boundingBox([]), null);
  });

  test('distances and path lengths are metric and 3D-aware', () => {
    assertClose(distance2dM(p(0, 0), p(3, 4)), 5);
    assertClose(
      distance3dM(
        { east_m: 0, north_m: 0, altitude_m: 0 },
        { east_m: 3, north_m: 4, altitude_m: 12 }
      ),
      13
    );
    assert.equal(maxRadiusFromOriginM([]), 0);
    assertClose(maxRadiusFromOriginM([p(3, 4), p(1, 1)]), 5);
    assert.ok(LOCAL_FRAME_RECOMMENDED_RADIUS_M > 0);
  });
});

describe('geo: point in polygon', (test) => {
  test('accepts points well inside a convex ring', () => {
    for (const inside of [p(50, 50), p(1, 1), p(99, 99), p(50, 1)]) {
      assert.equal(pointInPolygon(inside, SQUARE_CCW), true, `${JSON.stringify(inside)}`);
    }
  });

  test('rejects points outside, on every side', () => {
    for (const outside of [p(-1, 50), p(101, 50), p(50, -1), p(50, 101), p(1000, 1000)]) {
      assert.equal(pointInPolygon(outside, SQUARE_CCW), false, `${JSON.stringify(outside)}`);
    }
  });

  test('does not depend on the winding direction', () => {
    assert.equal(pointInPolygon(p(50, 50), SQUARE_CW), true);
    assert.equal(pointInPolygon(p(150, 50), SQUARE_CW), false);
  });

  test('a concave ring excludes the notch inside its bounding box', () => {
    assert.equal(pointInPolygon(p(20, 20), L_SHAPE), true, 'inside the foot');
    assert.equal(pointInPolygon(p(20, 80), L_SHAPE), true, 'inside the upright');
    assert.equal(pointInPolygon(p(80, 80), L_SHAPE), false, 'in the notch');
    assert.equal(boundingBox(L_SHAPE).width_m, 100, 'the notch is inside the bounding box');
  });

  test('a ring of fewer than three vertices contains nothing', () => {
    assert.equal(pointInPolygon(p(0, 0), [p(0, 0), p(1, 1)]), false);
    assert.equal(pointInPolygon(p(0, 0), []), false);
    assert.equal(pointInPolygon(p(0, 0), null), false);
  });

  test('every demo mission point lies inside the demo safety area', () => {
    const site = demoSite();
    for (const point of site.mission_points) {
      assert.equal(
        pointInPolygon(point, site.safety_area.horizontal),
        true,
        `mission point ${point.id}`
      );
    }
    assert.equal(pointInPolygon(p(200, 200), site.safety_area.horizontal), false);
  });
});

describe('geo: self-intersection detection', (test) => {
  test('reports the crossing pair of a bow tie', () => {
    const hits = polygonSelfIntersections(BOWTIE);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], [1, 3]);
  });

  test('reports nothing for simple rings', () => {
    assert.deepEqual(polygonSelfIntersections(SQUARE_CCW), []);
    assert.deepEqual(polygonSelfIntersections(SQUARE_CW), []);
    assert.deepEqual(polygonSelfIntersections(L_SHAPE), []);
    assert.deepEqual(polygonSelfIntersections(demoSite().safety_area.horizontal), []);
  });

  test('adjacent edges sharing a vertex are not reported as crossings', () => {
    // Every pair of neighbouring edges touches; only a proper crossing counts.
    const star = [p(0, 0), p(100, 10), p(200, 0), p(150, 100), p(50, 100)];
    assert.deepEqual(polygonSelfIntersections(star), []);
  });

  test('a ring too short to cross itself is not examined', () => {
    assert.deepEqual(polygonSelfIntersections([p(0, 0), p(10, 0), p(0, 10)]), []);
    assert.deepEqual(polygonSelfIntersections([]), []);
    assert.deepEqual(polygonSelfIntersections(null), []);
  });

  test('finds both crossings of a ring that self-intersects twice', () => {
    const doubled = [p(0, 0), p(100, 0), p(0, 50), p(100, 50), p(0, 100), p(100, 100)];
    assert.ok(polygonSelfIntersections(doubled).length >= 2);
  });
});
