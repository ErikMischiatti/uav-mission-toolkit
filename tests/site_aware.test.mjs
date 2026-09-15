/**
 * Checking a trajectory against the site it is flown in.
 *
 * The distinction these tests exist to protect is the one between "every
 * waypoint is inside the safety area" and "the path stays inside the safety
 * area". For a concave polygon those are different statements, and only the
 * second one is the question a planner is actually asking.
 */

import {
  pathSegmentsLeavingPolygon,
  segmentPolygonCrossings,
} from '../shared/js/geo.js';
import { buildSiteContext, buildTrajectoryDocument } from '../shared/js/trajectory.js';
import {
  hasErrors,
  validateAgainstSite,
  validateSite,
  validateTrajectory,
} from '../shared/js/validation.js';
import { L_SHAPE, SQUARE_CCW, demoSite, p, point, validTrajectory } from './fixtures.mjs';
import { assert, assertFinding, assertNoFinding, describe } from './harness.mjs';

/** A site wrapping an arbitrary polygon and altitude band, valid in every other respect. */
function siteWith(overrides = {}) {
  const site = demoSite();
  if (overrides.polygon) site.safety_area.horizontal = overrides.polygon;
  if (overrides.min !== undefined) site.safety_area.min_altitude_m = overrides.min;
  if (overrides.max !== undefined) site.safety_area.max_altitude_m = overrides.max;
  if (overrides.altitudeReference) site.safety_area.altitude_reference = overrides.altitudeReference;
  if (overrides.frameType) site.local_frame.type = overrides.frameType;
  if (overrides.headingReference) site.local_frame.heading_reference = overrides.headingReference;
  if ('siteId' in overrides) site.site_id = overrides.siteId;
  // Mission points belong to the demo polygon; drop them when the polygon changes.
  if (overrides.polygon) site.mission_points = [];
  return site;
}

describe('geo: segments against a polygon', (test) => {
  test('a segment wholly inside crosses no edge', () => {
    assert.deepEqual(segmentPolygonCrossings(p(10, 10), p(90, 90), SQUARE_CCW), []);
  });

  test('a segment leaving the polygon crosses exactly one edge', () => {
    assert.equal(segmentPolygonCrossings(p(50, 50), p(150, 50), SQUARE_CCW).length, 1);
  });

  test('a segment passing straight through crosses two edges', () => {
    assert.equal(segmentPolygonCrossings(p(-50, 50), p(150, 50), SQUARE_CCW).length, 2);
  });

  test('a degenerate polygon is not an excuse to throw', () => {
    assert.deepEqual(segmentPolygonCrossings(p(0, 0), p(1, 1), []), []);
    assert.deepEqual(segmentPolygonCrossings(p(0, 0), p(1, 1), [p(0, 0), p(1, 1)]), []);
  });

  test('a non-finite endpoint yields no crossings rather than NaN geometry', () => {
    assert.deepEqual(
      segmentPolygonCrossings({ east_m: Number.NaN, north_m: 0 }, p(1, 1), SQUARE_CCW),
      []
    );
  });

  test('the concave case: both endpoints inside, the line between them is not', () => {
    // The L shape has a notch in its top-right. Both points sit in the arms.
    const inArmA = p(80, 20);
    const inArmB = p(20, 80);
    assert.ok(segmentPolygonCrossings(inArmA, inArmB, L_SHAPE).length > 0);
  });

  test('path segments that leave the polygon are reported by index', () => {
    const points = [p(10, 10), p(90, 10), p(200, 10), p(10, 90)];
    const leaving = pathSegmentsLeavingPolygon(points, SQUARE_CCW, { closed: false });
    // Segment 1 ends outside and segment 2 starts outside.
    assert.deepEqual(leaving, [1, 2]);
  });

  test('a closed path also checks the leg from the last point back to the first', () => {
    const points = [p(10, 10), p(90, 10), p(90, 90)];
    assert.deepEqual(pathSegmentsLeavingPolygon(points, SQUARE_CCW, { closed: true }), []);

    const escaping = [p(10, 10), p(90, 10), p(150, 150)];
    const leaving = pathSegmentsLeavingPolygon(escaping, SQUARE_CCW, { closed: true });
    assert.ok(leaving.includes(2), 'the closing leg should be checked too');
  });

  test('fewer than two points cannot have a segment', () => {
    assert.deepEqual(pathSegmentsLeavingPolygon([p(0, 0)], SQUARE_CCW, {}), []);
    assert.deepEqual(pathSegmentsLeavingPolygon([], SQUARE_CCW, {}), []);
  });
});

describe('validation: a trajectory against its site', (test) => {
  test('a trajectory inside the site produces no containment findings', () => {
    const findings = validateTrajectory(validTrajectory(), { site: demoSite() });
    assertNoFinding(findings, 'points.outside_safety_area');
    assertNoFinding(findings, 'segments.leave_safety_area');
  });

  test('points outside the safety polygon are an error, counted once', () => {
    const trajectory = validTrajectory({
      points: [
        point({ east_m: 0, north_m: 0 }),
        point({ east_m: 5000, north_m: 0 }),
        point({ east_m: 5000, north_m: 5000 }),
      ],
    });
    const findings = validateTrajectory(trajectory, { site: demoSite() });
    assertFinding(findings, 'points.outside_safety_area', 'error');
    assert.equal(
      findings.filter((f) => f.code === 'points.outside_safety_area').length,
      1,
      'the count belongs in one finding, not one finding per point'
    );
  });

  test('a segment that leaves the area between two interior points is an error', () => {
    const site = siteWith({ polygon: [...L_SHAPE] });
    const trajectory = validTrajectory({
      closed: false,
      points: [point({ east_m: 80, north_m: 20 }), point({ east_m: 20, north_m: 80 })],
    });
    const findings = validateTrajectory(trajectory, { site });
    assertFinding(findings, 'segments.leave_safety_area', 'error');
    // Both waypoints really are inside; this is not just the point check firing.
    assertNoFinding(findings, 'points.outside_safety_area');
  });

  test('a segment whose endpoint is already outside is not reported twice', () => {
    const trajectory = validTrajectory({
      closed: false,
      points: [point({ east_m: 0, north_m: 0 }), point({ east_m: 9000, north_m: 0 })],
    });
    const findings = validateTrajectory(trajectory, { site: demoSite() });
    assertFinding(findings, 'points.outside_safety_area', 'error');
    assertNoFinding(findings, 'segments.leave_safety_area');
  });

  test('an altitude below the site minimum is an error naming the lowest value', () => {
    const site = siteWith({ min: 20, max: 100, altitudeReference: 'AGL' });
    const trajectory = validTrajectory({
      altitude_reference: 'AGL',
      points: [
        point({ east_m: 0, north_m: 0, altitude_m: 5 }),
        point({ east_m: 10, north_m: 10, altitude_m: 50 }),
      ],
    });
    const findings = validateTrajectory(trajectory, { site });
    assertFinding(findings, 'points.below_site_minimum', 'error');
    assert.ok(findings.find((f) => f.code === 'points.below_site_minimum').message.includes('5'));
  });

  test('an altitude above the site maximum is an error', () => {
    const site = siteWith({ min: 20, max: 100, altitudeReference: 'AGL' });
    const trajectory = validTrajectory({
      altitude_reference: 'AGL',
      points: [
        point({ east_m: 0, north_m: 0, altitude_m: 150 }),
        point({ east_m: 10, north_m: 10, altitude_m: 50 }),
      ],
    });
    assertFinding(validateTrajectory(trajectory, { site }), 'points.above_site_maximum', 'error');
  });

  test('an altitude exactly on a limit is inside the band', () => {
    const site = siteWith({ min: 20, max: 100, altitudeReference: 'AGL' });
    const trajectory = validTrajectory({
      altitude_reference: 'AGL',
      points: [
        point({ east_m: 0, north_m: 0, altitude_m: 20 }),
        point({ east_m: 10, north_m: 10, altitude_m: 100 }),
      ],
    });
    const findings = validateTrajectory(trajectory, { site });
    assertNoFinding(findings, 'points.below_site_minimum');
    assertNoFinding(findings, 'points.above_site_maximum');
  });

  test('a reference mismatch stops the band check instead of comparing apples to oranges', () => {
    const site = siteWith({ min: 20, max: 100, altitudeReference: 'AGL' });
    const trajectory = validTrajectory({
      altitude_reference: 'AMSL',
      points: [
        point({ east_m: 0, north_m: 0, altitude_m: 5 }),
        point({ east_m: 10, north_m: 10, altitude_m: 5 }),
      ],
    });
    const findings = validateTrajectory(trajectory, { site });
    assertFinding(findings, 'altitude_reference.mismatch', 'warning');
    assertNoFinding(findings, 'points.below_site_minimum');
  });

  test('a site whose frame is not ENU cannot host a local_enu trajectory', () => {
    const site = siteWith({ frameType: 'NED' });
    assertFinding(validateTrajectory(validTrajectory(), { site }), 'frame.incompatible', 'error');
  });

  test('a heading-reference disagreement is an error, not a silent mismatch', () => {
    const site = siteWith({ headingReference: 'magnetic_north' });
    assertFinding(
      validateTrajectory(validTrajectory(), { site }),
      'heading_reference.incompatible',
      'error'
    );
  });

  test('none of the site checks run when no site is supplied', () => {
    const trajectory = validTrajectory({
      points: [
        point({ east_m: 9000, north_m: 9000, altitude_m: 9000 }),
        point({ east_m: 9100, north_m: 9100, altitude_m: 9000 }),
      ],
    });
    const findings = validateTrajectory(trajectory);
    assert.deepEqual(findings, [], `unexpected findings: ${JSON.stringify(findings)}`);
  });
});

describe('validation: site checks on an incomplete trajectory', (test) => {
  test('containment is checked without an altitude reference being chosen yet', () => {
    const findings = validateAgainstSite(
      {
        points: [p(0, 0), p(9000, 0)],
        closed: false,
        altitudeReference: null,
      },
      demoSite()
    );
    assertFinding(findings, 'points.outside_safety_area', 'error');
  });

  test('the band is not checked until a reference is known', () => {
    const findings = validateAgainstSite(
      {
        points: [{ east_m: 0, north_m: 0, altitude_m: -500 }],
        closed: false,
        altitudeReference: null,
      },
      siteWith({ min: 20, max: 100, altitudeReference: 'AGL' })
    );
    assertNoFinding(findings, 'points.below_site_minimum');
  });

  test('no site means no findings at all', () => {
    assert.deepEqual(
      validateAgainstSite({ points: [p(0, 0), p(1, 1)], closed: false, altitudeReference: 'AGL' }, null),
      []
    );
  });
});

describe('trajectory: recorded site context', (test) => {
  test('a document built with a site records the frame it belongs to', () => {
    const site = demoSite();
    const document_ = buildTrajectoryDocument({
      name: 't',
      points: [point(), point({ east_m: 10 })],
      speedMps: 5,
      altitudeReference: 'AGL',
      closed: false,
      site,
    });
    assert.equal(document_.site_context.site_id, 'demo_site');
    assert.equal(document_.site_context.site_name, 'demo_site');
    assert.equal(document_.site_context.origin.latitude_deg, site.origin.latitude_deg);
    assert.equal(document_.site_context.origin.longitude_deg, site.origin.longitude_deg);
    assert.equal(document_.site_context.local_frame.type, 'ENU');
  });

  test('a document built without a site claims no frame it cannot back up', () => {
    const document_ = buildTrajectoryDocument({
      name: 't',
      points: [point(), point({ east_m: 10 })],
      speedMps: 5,
      altitudeReference: 'AGL',
      closed: false,
    });
    assert.equal('site_context' in document_, false);
  });

  test('the context records no origin altitude when the site states none', () => {
    const site = demoSite();
    delete site.origin.altitude_amsl_m;
    const context = buildSiteContext(site);
    assert.equal('altitude_amsl_m' in context.origin, false);
  });

  test('a site with nothing identifying in it produces no context block', () => {
    assert.equal(buildSiteContext({}), null);
    assert.equal(buildSiteContext(null), null);
  });

  test('a recorded site_id that disagrees with the loaded site is a warning', () => {
    const site = siteWith({ siteId: 'the_real_site' });
    const trajectory = validTrajectory({ site_context: { site_id: 'some_other_site' } });
    assertFinding(validateTrajectory(trajectory, { site }), 'site_context.site_id_mismatch', 'warning');
  });

  test('a malformed site_context is an error, because it looks authoritative', () => {
    assertFinding(
      validateTrajectory(validTrajectory({ site_context: 'demo_site' })),
      'site_context.type',
      'error'
    );
    assertFinding(
      validateTrajectory(validTrajectory({ site_context: { site_id: '' } })),
      'site_context.site_id',
      'error'
    );
    assertFinding(
      validateTrajectory(
        validTrajectory({ site_context: { origin: { latitude_deg: 200, longitude_deg: 0 } } })
      ),
      'site_context.origin.range',
      'error'
    );
  });

  test('a schema-1 trajectory with no site_context is still accepted', () => {
    // Backward compatibility: site_context was added after the format shipped
    // and is optional, so an older file must not become invalid.
    const older = validTrajectory();
    assert.equal('site_context' in older, false);
    assert.equal(hasErrors(validateTrajectory(older)), false);
    assert.equal(older.schema_version, 1);
  });
});

describe('validation: the optional site_id field', (test) => {
  test('a site without a site_id is still valid', () => {
    const site = demoSite();
    delete site.site_id;
    assert.deepEqual(validateSite(site), []);
  });

  test('an empty or non-string site_id is an error', () => {
    assertFinding(validateSite(siteWith({ siteId: '' })), 'site_id.type', 'error');
    assertFinding(validateSite(siteWith({ siteId: 42 })), 'site_id.type', 'error');
  });

  test('an id with awkward characters is a warning, not a rejection', () => {
    assertFinding(validateSite(siteWith({ siteId: 'a site/with spaces' })), 'site_id.charset', 'warning');
  });

  test('the shipped demo site carries a usable id', () => {
    assert.equal(demoSite().site_id, 'demo_site');
    assert.deepEqual(validateSite(demoSite()), []);
  });
});
