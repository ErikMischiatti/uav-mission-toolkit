/**
 * trajectory_editor/presets.js - pure shape generation in the local ENU plane.
 *
 * Presets produce geometry only. Altitude, speed and heading are applied by the
 * editor, so nothing here should ever emit one.
 */

import {
  boundingBox,
  distance2dM,
  pathLengthM,
  polygonAreaM2,
  polygonSelfIntersections,
} from '../shared/js/geo.js';
import { PRESET_IDS, buildPreset } from '../trajectory_editor/presets.js';
import { assert, assertClose, assertThrowsWith, describe } from './harness.mjs';

/** Parameters that every preset is happy with, used for the shared checks. */
const SAMPLE_PARAMS = {
  straight: { length_m: 100, heading_deg: 90 },
  circle: { radius_m: 50, samples: 12 },
  racetrack: { straight_length_m: 100, turn_radius_m: 35, arc_segments: 8 },
  figure_eight: { width_m: 100, height_m: 60, samples: 16 },
};

describe('presets: every preset', (test) => {
  test('the exported id list is frozen and covers exactly the four shapes', () => {
    assert.deepEqual([...PRESET_IDS], ['straight', 'circle', 'racetrack', 'figure_eight']);
    assert.ok(Object.isFrozen(PRESET_IDS));
  });

  test('builds finite local points and an explicit closed flag', () => {
    for (const id of PRESET_IDS) {
      const { points, closed } = buildPreset(id, SAMPLE_PARAMS[id]);
      assert.ok(points.length >= 2, `${id} produced ${points.length} points`);
      assert.equal(typeof closed, 'boolean', `${id} closed flag`);
      for (const point of points) {
        assert.ok(Number.isFinite(point.east_m), `${id}: east_m`);
        assert.ok(Number.isFinite(point.north_m), `${id}: north_m`);
        assert.deepEqual(Object.keys(point).sort(), ['east_m', 'north_m'], `${id}: keys`);
      }
    }
  });

  test('is deterministic: the same parameters give the same points', () => {
    for (const id of PRESET_IDS) {
      assert.deepEqual(buildPreset(id, SAMPLE_PARAMS[id]), buildPreset(id, SAMPLE_PARAMS[id]));
    }
  });

  test('an unknown preset id is an error', () => {
    assertThrowsWith(() => buildPreset('spiral', {}), 'Unknown trajectory preset "spiral"');
    assertThrowsWith(() => buildPreset('', {}), 'Unknown trajectory preset');
  });
});

describe('presets: straight', (test) => {
  test('runs the requested distance in the requested direction', () => {
    const cardinals = [
      [0, 0, 100],
      [90, 100, 0],
      [180, 0, -100],
      [270, -100, 0],
    ];
    for (const [heading_deg, east, north] of cardinals) {
      const { points, closed } = buildPreset('straight', { length_m: 100, heading_deg });
      assert.equal(points.length, 2);
      assert.equal(closed, false);
      assert.deepEqual(points[0], { east_m: 0, north_m: 0 }, 'starts at the local origin');
      assertClose(points[1].east_m, east, 1e-9, `east for heading ${heading_deg}`);
      assertClose(points[1].north_m, north, 1e-9, `north for heading ${heading_deg}`);
    }
  });

  test('its length is exactly the length that was asked for', () => {
    const { points } = buildPreset('straight', { length_m: 237.5, heading_deg: 33 });
    assertClose(distance2dM(points[0], points[1]), 237.5, 1e-9);
  });

  test('rejects a non-positive length and a non-numeric direction', () => {
    assertThrowsWith(() => buildPreset('straight', { length_m: 0, heading_deg: 0 }), 'Length');
    assertThrowsWith(() => buildPreset('straight', { length_m: -1, heading_deg: 0 }), 'Length');
    assertThrowsWith(() => buildPreset('straight', { length_m: 100 }), 'Direction');
  });
});

describe('presets: circle', (test) => {
  test('places every sample on the requested radius, starting due north', () => {
    const { points, closed } = buildPreset('circle', { radius_m: 50, samples: 12 });
    assert.equal(points.length, 12);
    assert.equal(closed, true);
    assert.deepEqual(points[0], { east_m: 0, north_m: 50 }, 'the first sample is due north');
    for (const point of points) {
      assertClose(Math.hypot(point.east_m, point.north_m), 50, 1e-9);
    }
  });

  test('is sampled clockwise, matching the heading convention', () => {
    const { points } = buildPreset('circle', { radius_m: 50, samples: 4 });
    assertClose(points[1].east_m, 50, 1e-9, 'the second sample is due east');
    assertClose(points[1].north_m, 0, 1e-9);
  });

  test('approaches the true circle area as the sample count rises', () => {
    const coarse = polygonAreaM2(buildPreset('circle', { radius_m: 50, samples: 8 }).points);
    const fine = polygonAreaM2(buildPreset('circle', { radius_m: 50, samples: 720 }).points);
    const exact = Math.PI * 50 * 50;
    assert.ok(coarse < fine && fine < exact, 'an inscribed polygon is always smaller');
    assertClose(fine, exact, exact * 0.001, 'within 0.1 % at 720 samples');
    assertClose(
      pathLengthM(buildPreset('circle', { radius_m: 50, samples: 720 }).points, { closed: true }),
      2 * Math.PI * 50,
      0.01
    );
  });

  test('never crosses itself', () => {
    assert.deepEqual(polygonSelfIntersections(buildPreset('circle', { radius_m: 50, samples: 36 }).points), []);
  });

  test('rejects a non-positive radius and fewer than three samples', () => {
    assertThrowsWith(() => buildPreset('circle', { radius_m: 0, samples: 12 }), 'Radius');
    assertThrowsWith(() => buildPreset('circle', { radius_m: 50, samples: 2 }), 'at least 3');
    assertThrowsWith(() => buildPreset('circle', { radius_m: 50, samples: 12.5 }), 'whole number');
  });
});

describe('presets: racetrack', (test) => {
  test('is a closed ring of two straights joined by two arcs', () => {
    const { points, closed } = buildPreset('racetrack', {
      straight_length_m: 100,
      turn_radius_m: 35,
      arc_segments: 8,
    });
    assert.equal(closed, true);
    // Two straight legs (2 points each) plus the interior points of two arcs.
    assert.equal(points.length, 4 + 2 * 7);
  });

  test('its extent is the straight length plus a turn diameter', () => {
    const { points } = buildPreset('racetrack', {
      straight_length_m: 100,
      turn_radius_m: 35,
      arc_segments: 8,
    });
    const box = boundingBox(points);
    assertClose(box.width_m, 100 + 2 * 35, 1e-9, 'east-west extent');
    assertClose(box.height_m, 2 * 35, 1e-9, 'north-south extent');
  });

  test('never crosses itself, at any turn radius', () => {
    for (const turn_radius_m of [5, 35, 200]) {
      const { points } = buildPreset('racetrack', {
        straight_length_m: 100,
        turn_radius_m,
        arc_segments: 6,
      });
      assert.deepEqual(polygonSelfIntersections(points), [], `turn radius ${turn_radius_m}`);
    }
  });

  test('degenerates to a circle when the straights have zero length', () => {
    const { points } = buildPreset('racetrack', {
      straight_length_m: 0,
      turn_radius_m: 40,
      arc_segments: 12,
    });
    for (const point of points) {
      assertClose(Math.hypot(point.east_m, point.north_m), 40, 1e-9);
    }
  });

  test('rejects a negative straight, a non-positive radius and a zero segment count', () => {
    const base = { straight_length_m: 100, turn_radius_m: 35, arc_segments: 8 };
    assertThrowsWith(() => buildPreset('racetrack', { ...base, straight_length_m: -1 }), 'Straight length');
    assertThrowsWith(() => buildPreset('racetrack', { ...base, turn_radius_m: 0 }), 'Turn radius');
    assertThrowsWith(() => buildPreset('racetrack', { ...base, arc_segments: 0 }), 'Arc segments');
  });
});

describe('presets: figure eight', (test) => {
  test('spans exactly the requested width and height', () => {
    const { points, closed } = buildPreset('figure_eight', {
      width_m: 100,
      height_m: 60,
      samples: 64,
    });
    assert.equal(closed, true);
    assert.equal(points.length, 64);
    const box = boundingBox(points);
    assertClose(box.width_m, 100, 1e-9);
    assertClose(box.height_m, 60, 1e-9);
  });

  test('is centred on the local origin and crosses itself there', () => {
    const { points } = buildPreset('figure_eight', { width_m: 100, height_m: 60, samples: 16 });
    assert.deepEqual(points[0], { east_m: 0, north_m: 0 });
    assert.ok(
      polygonSelfIntersections(points).length >= 1,
      'a figure eight is expected to cross itself - this is the shape, not a defect'
    );
  });

  test('rejects non-positive dimensions and too few samples', () => {
    const base = { width_m: 100, height_m: 60, samples: 16 };
    assertThrowsWith(() => buildPreset('figure_eight', { ...base, width_m: 0 }), 'Width');
    assertThrowsWith(() => buildPreset('figure_eight', { ...base, height_m: -1 }), 'Height');
    assertThrowsWith(() => buildPreset('figure_eight', { ...base, samples: 7 }), 'at least 8');
  });
});
