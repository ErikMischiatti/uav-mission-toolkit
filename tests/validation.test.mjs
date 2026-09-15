/**
 * shared/js/validation.js - the rules the site editor, the site viewer and the
 * altitude sweep all share. If these disagree with each other, two tools can
 * accept two different versions of the same file.
 *
 * The invalid-site tests each break exactly one thing in a known-good site and
 * assert that the corresponding code is reported. They assert on codes rather
 * than on message text so that wording can be improved without breaking them.
 */

import {
  ALTITUDE_REFERENCES,
  HEADING_REFERENCES,
  LOCAL_FRAME_TYPES,
  SEVERITY,
  SITE_SCHEMA_VERSION,
  TRAJECTORY_SCHEMA_VERSION,
  hasErrors,
  severityCounts,
  siteStatistics,
  validateSite,
  validateTrajectory,
} from '../shared/js/validation.js';
import { BOWTIE, COLLINEAR, demoSite, point, validTrajectory } from './fixtures.mjs';
import {
  assert,
  assertClose,
  assertFinding,
  assertNoFinding,
  codes,
  describe,
} from './harness.mjs';

/**
 * Validate a copy of the demo site with one field changed.
 * @param {(site: any) => void} mutate
 */
function siteWith(mutate) {
  const site = demoSite();
  mutate(site);
  return validateSite(site);
}

describe('validation: the shipped demo site is valid', (test) => {
  test('reports no findings at all - not even a warning', () => {
    const findings = validateSite(demoSite());
    assert.deepEqual(findings, [], `unexpected findings: ${JSON.stringify(findings)}`);
    assert.equal(hasErrors(findings), false);
    assert.deepEqual(severityCounts(findings), { error: 0, warning: 0, info: 0 });
  });

  test('is still valid after a JSON round trip', () => {
    const reparsed = JSON.parse(JSON.stringify(demoSite()));
    assert.deepEqual(validateSite(reparsed), []);
  });

  test('its statistics match the geometry it declares', () => {
    const stats = siteStatistics(demoSite());
    assert.equal(stats.vertexCount, 6);
    assert.equal(stats.missionPointCount, 4);
    assertClose(stats.areaM2, 43750, 1e-6);
    assert.equal(stats.altitudeBandM, 85);
    assert.equal(stats.bounds.width_m, 235);
    assert.equal(stats.bounds.height_m, 215);
  });

  test('statistics degrade to nulls rather than guesses on an unusable site', () => {
    const stats = siteStatistics({});
    assert.equal(stats.vertexCount, 0);
    assert.equal(stats.missionPointCount, 0);
    assert.equal(stats.areaM2, null);
    assert.equal(stats.bounds, null);
    assert.equal(stats.altitudeBandM, null);
  });

  test('the demo trajectory validates against the demo site', () => {
    const findings = validateTrajectory(validTrajectory(), { site: demoSite() });
    // The fixture predates site_context, so the one expected finding is the note
    // saying the file does not record which frame it belongs to. Nothing else.
    assert.deepEqual(
      findings.filter((f) => f.severity !== 'info'),
      [],
      `unexpected errors or warnings: ${JSON.stringify(findings)}`
    );
    assert.deepEqual(findings.map((f) => f.code), ['site_context.absent']);
  });

  test('a trajectory that records its site context has nothing left to report', () => {
    const site = demoSite();
    const trajectory = validTrajectory({
      site_context: {
        site_id: site.site_id,
        site_name: site.name,
        origin: {
          latitude_deg: site.origin.latitude_deg,
          longitude_deg: site.origin.longitude_deg,
          altitude_amsl_m: site.origin.altitude_amsl_m,
        },
        local_frame: { type: 'ENU', heading_reference: 'true_north' },
      },
    });
    assert.deepEqual(
      validateTrajectory(trajectory, { site }),
      [],
      'a fully described trajectory should produce no findings at all'
    );
  });

  test('the vocabularies the format allows are the documented ones', () => {
    assert.deepEqual([...ALTITUDE_REFERENCES], ['AGL', 'AMSL', 'ATO']);
    assert.deepEqual([...LOCAL_FRAME_TYPES], ['ENU']);
    assert.deepEqual([...HEADING_REFERENCES], ['true_north']);
    assert.equal(SITE_SCHEMA_VERSION, 1);
    assert.equal(TRAJECTORY_SCHEMA_VERSION, 1);
    assert.ok(Object.isFrozen(ALTITUDE_REFERENCES));
  });
});

describe('validation: invalid sites - structure and origin', (test) => {
  test('anything that is not a JSON object is rejected outright', () => {
    for (const notASite of [null, [], 'site', 42]) {
      const findings = validateSite(notASite);
      assert.equal(findings.length, 1, `for ${JSON.stringify(notASite)}`);
      assertFinding(findings, 'site.type', SEVERITY.ERROR);
    }
  });

  test('an unsupported schema_version is an error, not a silent upgrade', () => {
    assertFinding(siteWith((s) => { s.schema_version = 2; }), 'schema_version', SEVERITY.ERROR);
    assertFinding(siteWith((s) => { delete s.schema_version; }), 'schema_version', SEVERITY.ERROR);
    assertFinding(siteWith((s) => { s.schema_version = '1'; }), 'schema_version', SEVERITY.ERROR);
  });

  test('a site must be named', () => {
    assertFinding(siteWith((s) => { s.name = '   '; }), 'name.missing', SEVERITY.ERROR);
    assertFinding(siteWith((s) => { delete s.name; }), 'name.missing', SEVERITY.ERROR);
  });

  test('a missing origin is an error', () => {
    assertFinding(siteWith((s) => { delete s.origin; }), 'origin.missing', SEVERITY.ERROR);
  });

  test('latitude and longitude must be inside their real ranges', () => {
    assertFinding(siteWith((s) => { s.origin.latitude_deg = 90.1; }), 'origin.latitude');
    assertFinding(siteWith((s) => { s.origin.latitude_deg = -91; }), 'origin.latitude');
    assertFinding(siteWith((s) => { s.origin.latitude_deg = '48'; }), 'origin.latitude');
    assertFinding(siteWith((s) => { s.origin.longitude_deg = 180.5; }), 'origin.longitude');
    assertFinding(siteWith((s) => { s.origin.longitude_deg = Number.NaN; }), 'origin.longitude');
  });

  test('an origin of exactly 0/0 is flagged as a probable unset value', () => {
    const findings = siteWith((s) => {
      s.origin.latitude_deg = 0;
      s.origin.longitude_deg = 0;
    });
    assertFinding(findings, 'origin.null_island', SEVERITY.WARNING);
  });

  test('the origin altitude is required and is never defaulted', () => {
    assertFinding(siteWith((s) => { delete s.origin.altitude_amsl_m; }), 'origin.altitude', SEVERITY.ERROR);
    assertFinding(siteWith((s) => { s.origin.altitude_amsl_m = null; }), 'origin.altitude', SEVERITY.ERROR);
  });

  test('an implausible origin altitude is a warning, not a rejection', () => {
    const findings = siteWith((s) => { s.origin.altitude_amsl_m = 12000; });
    assertFinding(findings, 'origin.altitude_implausible', SEVERITY.WARNING);
    assert.equal(hasErrors(findings), false);
  });

  test('the local frame must be the one this build implements', () => {
    assertFinding(siteWith((s) => { s.local_frame.type = 'NED'; }), 'local_frame.type');
    assertFinding(
      siteWith((s) => { s.local_frame.heading_reference = 'magnetic'; }),
      'local_frame.heading_reference'
    );
    assertFinding(siteWith((s) => { delete s.local_frame; }), 'local_frame.missing');
  });

  test('a site larger than the tangent-plane approximation supports is flagged', () => {
    const findings = siteWith((s) => {
      s.safety_area.horizontal = [
        { east_m: -9000, north_m: -9000 },
        { east_m: 9000, north_m: -9000 },
        { east_m: 9000, north_m: 9000 },
        { east_m: -9000, north_m: 9000 },
      ];
    });
    assertFinding(findings, 'local_frame.extent', SEVERITY.WARNING);
  });
});

describe('validation: invalid sites - safety area', (test) => {
  test('a missing safety area is an error', () => {
    assertFinding(siteWith((s) => { delete s.safety_area; }), 'safety_area.missing');
  });

  test('the polygon must be an array of at least three valid vertices', () => {
    assertFinding(
      siteWith((s) => { s.safety_area.horizontal = 'a polygon'; }),
      'safety_area.horizontal.type'
    );
    assertFinding(
      siteWith((s) => { s.safety_area.horizontal = [{ east_m: 0, north_m: 0 }, { east_m: 1, north_m: 1 }]; }),
      'safety_area.horizontal.too_few'
    );
    assertFinding(
      siteWith((s) => { s.safety_area.horizontal[2] = { east_m: 10 }; }),
      'safety_area.horizontal.vertex'
    );
    assertFinding(
      siteWith((s) => { s.safety_area.horizontal[0] = null; }),
      'safety_area.horizontal.vertex'
    );
  });

  test('a self-intersecting safety polygon is an error, because "inside" is undefined', () => {
    const findings = siteWith((s) => { s.safety_area.horizontal = BOWTIE.map((v) => ({ ...v })); });
    assertFinding(findings, 'safety_area.horizontal.self_intersecting', SEVERITY.ERROR);
    assert.equal(hasErrors(findings), true);
  });

  test('a polygon with no area is an error', () => {
    assertFinding(
      siteWith((s) => { s.safety_area.horizontal = COLLINEAR.map((v) => ({ ...v })); }),
      'safety_area.horizontal.degenerate'
    );
  });

  test('a redundantly closed ring is a warning', () => {
    const findings = siteWith((s) => {
      const ring = s.safety_area.horizontal;
      ring.push({ ...ring[0] });
    });
    assertFinding(findings, 'safety_area.horizontal.closed_ring', SEVERITY.WARNING);
  });

  test('the altitude reference must be stated and must be one of the three', () => {
    assertFinding(
      siteWith((s) => { delete s.safety_area.altitude_reference; }),
      'safety_area.altitude_reference'
    );
    assertFinding(
      siteWith((s) => { s.safety_area.altitude_reference = 'WGS84'; }),
      'safety_area.altitude_reference'
    );
    assertFinding(
      siteWith((s) => { s.safety_area.altitude_reference = 'agl'; }),
      'safety_area.altitude_reference'
    );
  });

  test('the altitude band needs two finite numbers in the right order', () => {
    assertFinding(siteWith((s) => { delete s.safety_area.min_altitude_m; }), 'safety_area.min_altitude');
    assertFinding(siteWith((s) => { s.safety_area.max_altitude_m = 'high'; }), 'safety_area.max_altitude');
    assertFinding(
      siteWith((s) => { s.safety_area.min_altitude_m = 100; s.safety_area.max_altitude_m = 15; }),
      'safety_area.altitude_band'
    );
    assertFinding(
      siteWith((s) => { s.safety_area.min_altitude_m = 50; s.safety_area.max_altitude_m = 50; }),
      'safety_area.altitude_band'
    );
  });
});

describe('validation: invalid sites - mission points', (test) => {
  test('mission_points must be an array, though it may be empty', () => {
    assertFinding(siteWith((s) => { s.mission_points = {}; }), 'mission_points.type');
    const empty = siteWith((s) => { s.mission_points = []; });
    assertFinding(empty, 'mission_points.empty', SEVERITY.INFO);
    assert.equal(hasErrors(empty), false);
  });

  test('ids are required and must be unique within a site', () => {
    assertFinding(siteWith((s) => { s.mission_points[1].id = ''; }), 'mission_point.id');
    assertFinding(
      siteWith((s) => { s.mission_points[1].id = s.mission_points[0].id; }),
      'mission_point.duplicate_id'
    );
  });

  test('a mission point needs a finite position and altitude', () => {
    assertFinding(siteWith((s) => { delete s.mission_points[0].east_m; }), 'mission_point.position');
    assertFinding(siteWith((s) => { s.mission_points[0].north_m = 'x'; }), 'mission_point.position');
    assertFinding(siteWith((s) => { delete s.mission_points[0].altitude_m; }), 'mission_point.altitude');
    assertFinding(siteWith((s) => { s.mission_points[2] = 'not an object'; }), 'mission_point.type');
  });

  test('an altitude outside the safety band is an error', () => {
    assertFinding(
      siteWith((s) => { s.mission_points[0].altitude_m = 500; }),
      'mission_point.altitude_out_of_band'
    );
    assertFinding(
      siteWith((s) => { s.mission_points[0].altitude_m = 5; }),
      'mission_point.altitude_out_of_band'
    );
  });

  test('mixing altitude references inside one site is reported, never resolved', () => {
    const findings = siteWith((s) => { s.mission_points[0].altitude_reference = 'AMSL'; });
    assertFinding(findings, 'mission_point.altitude_reference_mismatch', SEVERITY.ERROR);
    // The band check is deliberately skipped rather than done across references.
    assertNoFinding(findings, 'mission_point.altitude_out_of_band');
  });

  test('an unknown altitude reference on a mission point is an error', () => {
    assertFinding(
      siteWith((s) => { s.mission_points[0].altitude_reference = 'ASL'; }),
      'mission_point.altitude_reference'
    );
  });

  test('heading must be in [0, 360), and an absent heading is only informational', () => {
    assertFinding(siteWith((s) => { s.mission_points[0].heading_deg = 360; }), 'mission_point.heading');
    assertFinding(siteWith((s) => { s.mission_points[0].heading_deg = -1; }), 'mission_point.heading');
    assertFinding(siteWith((s) => { s.mission_points[0].heading_deg = '90'; }), 'mission_point.heading');
    const unset = siteWith((s) => { s.mission_points[0].heading_deg = null; });
    assertFinding(unset, 'mission_point.heading_unspecified', SEVERITY.INFO);
    assert.equal(hasErrors(unset), false);
  });

  test('a mission point outside the safety polygon is an error', () => {
    const findings = siteWith((s) => {
      s.mission_points[0].east_m = 400;
      s.mission_points[0].north_m = 400;
    });
    assertFinding(findings, 'mission_point.outside_safety_area', SEVERITY.ERROR);
  });

  test('breaking one thing does not raise unrelated findings', () => {
    const findings = siteWith((s) => { s.name = ''; });
    assert.deepEqual(codes(findings), ['name.missing']);
  });
});

describe('validation: trajectory documents', (test) => {
  test('anything that is not an object is rejected outright', () => {
    for (const notATrajectory of [null, [], 'trajectory']) {
      const findings = validateTrajectory(notATrajectory);
      assert.equal(findings.length, 1);
      assertFinding(findings, 'trajectory.type');
    }
  });

  test('frame, schema version, altitude reference and closed flag are all required', () => {
    assertFinding(validateTrajectory(validTrajectory({ schema_version: 99 })), 'schema_version');
    assertFinding(validateTrajectory(validTrajectory({ frame: 'ENU' })), 'frame');
    assertFinding(validateTrajectory(validTrajectory({ altitude_reference: undefined })), 'altitude_reference');
    assertFinding(validateTrajectory(validTrajectory({ closed: 'yes' })), 'closed');
  });

  test('speed must be positive, and an implausible speed is a warning', () => {
    assertFinding(validateTrajectory(validTrajectory({ speed_mps: 0 })), 'speed');
    assertFinding(validateTrajectory(validTrajectory({ speed_mps: -5 })), 'speed');
    const fast = validateTrajectory(validTrajectory({ speed_mps: 120 }));
    assertFinding(fast, 'speed.implausible', SEVERITY.WARNING);
    assert.equal(hasErrors(fast), false);
  });

  test('a trajectory needs points, and each needs a finite position', () => {
    assertFinding(validateTrajectory(validTrajectory({ points: 'none' })), 'points.type');
    assertFinding(validateTrajectory(validTrajectory({ points: [point()] })), 'points.too_few');
    assertFinding(
      validateTrajectory(validTrajectory({ points: [point(), point({ east_m: 'x' })] })),
      'point.position'
    );
    assertFinding(
      validateTrajectory(validTrajectory({ points: [point(), point({ altitude_m: null })] })),
      'point.altitude'
    );
    assertFinding(
      validateTrajectory(validTrajectory({ points: [point(), point({ heading_deg: 400 })] })),
      'point.heading'
    );
  });

  test('points outside the loaded site are reported once, with a count', () => {
    const trajectory = validTrajectory();
    trajectory.points[0] = point({ east_m: 900, north_m: 900 });
    trajectory.points[1] = point({ east_m: -900, north_m: 900 });
    const findings = validateTrajectory(trajectory, { site: demoSite() });
    assertFinding(findings, 'points.outside_safety_area', SEVERITY.ERROR);
    assert.equal(findings.filter((f) => f.code === 'points.outside_safety_area').length, 1);
    assert.ok(findings.find((f) => f.code === 'points.outside_safety_area').message.includes('2'));
  });

  test('containment is only checked when a site is supplied', () => {
    const trajectory = validTrajectory();
    trajectory.points[0] = point({ east_m: 900, north_m: 900 });
    assert.deepEqual(validateTrajectory(trajectory), []);
  });

  test('a reference that disagrees with the site is a warning and stops the band check', () => {
    const findings = validateTrajectory(
      validTrajectory({ altitude_reference: 'AMSL' }),
      { site: demoSite() }
    );
    assertFinding(findings, 'altitude_reference.mismatch', SEVERITY.WARNING);
    assert.equal(hasErrors(findings), false);
  });
});
