/**
 * The altitude sweep's safety check: a generated variant must differ from its
 * source in the altitude column and in nothing else.
 *
 * altitude_sweep/app.js is a DOM module and cannot be imported here, so these
 * tests exercise the same pipeline it runs - withAltitude, trajectoryToCsv,
 * parseTrajectoryCsv, verifyAltitudeVariant - against the shipped demo
 * trajectory. The verification is done on text that has made a full round trip
 * through CSV, exactly as the tool does it, so what is checked is the bytes
 * that would land in the downloaded file.
 */

import { parseTrajectoryCsv, trajectoryToCsv, withAltitude } from '../shared/js/trajectory.js';
import { hasErrors, verifyAltitudeVariant } from '../shared/js/validation.js';
import { demoTrajectoryCsv } from './fixtures.mjs';
import { assert, assertFinding, codes, describe } from './harness.mjs';

/** The source points every test in this file sweeps. */
function basePoints() {
  return parseTrajectoryCsv(demoTrajectoryCsv()).points;
}

/**
 * One variant, built and verified the way altitude_sweep/app.js does it.
 * @param {Array<object>} source
 * @param {number} altitudeM
 * @param {(points: Array<object>) => Array<object>} [tamper] applied to the
 *   variant points before serialisation, to simulate a defect
 */
function buildAndVerify(source, altitudeM, tamper = (points) => points) {
  const csv = trajectoryToCsv(tamper(withAltitude(source, altitudeM)));
  const { points: reparsed } = parseTrajectoryCsv(csv, `variant_alt${altitudeM}m.csv`);
  return verifyAltitudeVariant(source, reparsed, altitudeM);
}

/** Replace one field of one row. */
function tamperRow(index, field, value) {
  return (points) =>
    points.map((point, i) => (i === index ? { ...point, [field]: value } : point));
}

describe('altitude sweep: a clean variant verifies', (test) => {
  test('a variant of the demo trajectory passes with no findings', () => {
    const { ok, findings } = buildAndVerify(basePoints(), 60);
    assert.deepEqual(findings, []);
    assert.equal(ok, true);
  });

  test('every altitude in a 20 m to 100 m sweep verifies', () => {
    const source = basePoints();
    for (let altitude = 20; altitude <= 100; altitude += 20) {
      const { ok, findings } = buildAndVerify(source, altitude);
      assert.equal(ok, true, `${altitude} m: ${JSON.stringify(findings)}`);
    }
  });

  test('fractional and negative altitudes survive the CSV round trip', () => {
    const source = basePoints();
    for (const altitude of [0, 12.5, 37.125, -15.5]) {
      const { ok, findings } = buildAndVerify(source, altitude);
      assert.equal(ok, true, `${altitude} m: ${JSON.stringify(findings)}`);
    }
  });

  test('the variant really does carry the new altitude and the old geometry', () => {
    const source = basePoints();
    const csv = trajectoryToCsv(withAltitude(source, 75));
    const { points } = parseTrajectoryCsv(csv);
    assert.equal(points.length, source.length);
    for (let i = 0; i < points.length; i += 1) {
      assert.equal(points[i].altitude_m, 75, `row ${i} altitude`);
      assert.equal(points[i].east_m, source[i].east_m, `row ${i} east`);
      assert.equal(points[i].north_m, source[i].north_m, `row ${i} north`);
      assert.equal(points[i].heading_deg, source[i].heading_deg, `row ${i} heading`);
      assert.equal(points[i].speed_mps, source[i].speed_mps, `row ${i} speed`);
    }
  });

  test('a single-row trajectory is still verified row for row', () => {
    const source = basePoints().slice(0, 1);
    assert.equal(buildAndVerify(source, 50).ok, true);
  });
});

describe('altitude sweep: a corrupted variant is caught', (test) => {
  test('a waypoint that moved east is caught', () => {
    const { ok, findings } = buildAndVerify(basePoints(), 60, tamperRow(3, 'east_m', 74.75));
    assert.equal(ok, false);
    assertFinding(findings, 'variant.east');
    assert.ok(findings[0].message.includes('Row 4'), 'the failing row is named');
  });

  test('a waypoint that moved north is caught', () => {
    const { ok, findings } = buildAndVerify(basePoints(), 60, tamperRow(0, 'north_m', -35.5));
    assert.equal(ok, false);
    assertFinding(findings, 'variant.north');
  });

  test('a changed heading is caught', () => {
    const { ok, findings } = buildAndVerify(basePoints(), 60, tamperRow(5, 'heading_deg', 12));
    assert.equal(ok, false);
    assertFinding(findings, 'variant.heading');
  });

  test('a changed speed is caught', () => {
    const { ok, findings } = buildAndVerify(basePoints(), 60, tamperRow(2, 'speed_mps', 7));
    assert.equal(ok, false);
    assertFinding(findings, 'variant.speed');
  });

  test('an altitude that is not the one the variant was generated for is caught', () => {
    const source = basePoints();
    const { points } = parseTrajectoryCsv(trajectoryToCsv(withAltitude(source, 60)));
    const { ok, findings } = verifyAltitudeVariant(source, points, 65);
    assert.equal(ok, false);
    assertFinding(findings, 'variant.altitude');
    assert.equal(findings.length, source.length, 'every row is reported');
  });

  test('an altitude left at the source value in one row is caught', () => {
    const { ok, findings } = buildAndVerify(basePoints(), 60, tamperRow(9, 'altitude_m', 40));
    assert.equal(ok, false);
    assertFinding(findings, 'variant.altitude');
    assert.ok(findings[0].message.includes('Row 10'));
  });

  test('a dropped row fails immediately, without a row-by-row comparison', () => {
    const source = basePoints();
    const { points } = parseTrajectoryCsv(trajectoryToCsv(withAltitude(source, 60).slice(0, -1)));
    const { ok, findings } = verifyAltitudeVariant(source, points, 60);
    assert.equal(ok, false);
    assert.deepEqual(codes(findings), ['variant.row_count']);
  });

  test('an added row is caught too', () => {
    const source = basePoints();
    const doubled = [...withAltitude(source, 60), ...withAltitude(source, 60).slice(0, 1)];
    const { points } = parseTrajectoryCsv(trajectoryToCsv(doubled));
    assert.deepEqual(codes(verifyAltitudeVariant(source, points, 60).findings), ['variant.row_count']);
  });

  test('several corrupted rows are all reported, not just the first', () => {
    const { findings } = buildAndVerify(basePoints(), 60, (points) =>
      points.map((point, i) => (i < 3 ? { ...point, east_m: point.east_m + 1 } : point))
    );
    assert.equal(findings.filter((f) => f.code === 'variant.east').length, 3);
    assert.equal(hasErrors(findings), true);
  });
});

describe('altitude sweep: verification tolerances', (test) => {
  test('a difference far below a micrometre is accepted', () => {
    const source = basePoints();
    const nudged = source.map((point) => ({ ...point, east_m: point.east_m + 1e-9 }));
    assert.equal(verifyAltitudeVariant(source, withAltitude(nudged, 40), 40).ok, true);
  });

  test('a millimetre of drift is rejected', () => {
    const source = basePoints();
    const nudged = source.map((point) => ({ ...point, north_m: point.north_m + 1e-3 }));
    const { ok, findings } = verifyAltitudeVariant(source, withAltitude(nudged, 40), 40);
    assert.equal(ok, false);
    assertFinding(findings, 'variant.north');
  });

  test('the tolerances can be tightened but not silently widened by the caller', () => {
    const source = basePoints();
    const nudged = source.map((point) => ({ ...point, east_m: point.east_m + 1e-8 }));
    assert.equal(verifyAltitudeVariant(source, withAltitude(nudged, 40), 40).ok, true);
    assert.equal(
      verifyAltitudeVariant(source, withAltitude(nudged, 40), 40, { positionToleranceM: 1e-12 }).ok,
      false,
      'a tighter tolerance must reject what the default accepts'
    );
  });
});
