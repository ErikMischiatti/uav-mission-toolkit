/**
 * shared/js/trajectory.js and the CSV layer in shared/js/io.js.
 *
 * The recurring theme is that this toolkit never invents a number: a missing
 * cell, a ragged row or an unparseable value has to raise an error that names
 * the line and the column, because the alternative is a waypoint that quietly
 * became zero.
 */

import {
  DEFAULT_COORDINATE_DECIMALS,
  formatFixed,
  parseCsv,
  parseJson,
  parseStrictNumber,
  roundTo,
  sanitizeFilenamePart,
  toCsv,
} from '../shared/js/io.js';
import {
  TRAJECTORY_CSV_COLUMNS,
  buildTrajectoryDocument,
  computePathHeadings,
  longestSegmentM,
  parseTrajectoryCsv,
  trajectoryMetrics,
  trajectoryToCsv,
  withAltitude,
} from '../shared/js/trajectory.js';
import { validateTrajectory } from '../shared/js/validation.js';
import { demoTrajectoryCsv, p, point } from './fixtures.mjs';
import { assert, assertClose, assertThrowsWith, describe } from './harness.mjs';

const HEADER = TRAJECTORY_CSV_COLUMNS.join(',');

/** A small valid CSV built from rows of raw text. */
function csv(...rows) {
  return [HEADER, ...rows].join('\n') + '\n';
}

describe('trajectory: CSV parsing', (test) => {
  test('the column list is the documented one, and it is frozen', () => {
    assert.deepEqual(
      [...TRAJECTORY_CSV_COLUMNS],
      ['east_m', 'north_m', 'altitude_m', 'heading_deg', 'speed_mps']
    );
    assert.ok(Object.isFrozen(TRAJECTORY_CSV_COLUMNS));
  });

  test('parses the shipped demo trajectory', () => {
    const { points, headers } = parseTrajectoryCsv(demoTrajectoryCsv());
    assert.equal(points.length, 18);
    assert.deepEqual(headers, [...TRAJECTORY_CSV_COLUMNS]);
    assert.deepEqual(points[0], {
      east_m: -50,
      north_m: -35,
      altitude_m: 40,
      heading_deg: 90,
      speed_mps: 5,
      line: 2,
    });
    assert.equal(points[17].line, 19);
    assert.ok(points.every((row) => row.altitude_m === 40 && row.speed_mps === 5));
  });

  test('reports the real file line number, which is not the row index', () => {
    const { points } = parseTrajectoryCsv(`${HEADER}\n\n1,2,3,4,5\n`);
    assert.equal(points[0].line, 3, 'the blank line still counts towards the line number');
  });

  test('looks columns up by name, so column order does not matter', () => {
    const reordered = 'speed_mps,altitude_m,north_m,heading_deg,east_m\n5,40,-35,90,-50\n';
    const { points } = parseTrajectoryCsv(reordered);
    assert.equal(points[0].east_m, -50);
    assert.equal(points[0].north_m, -35);
    assert.equal(points[0].speed_mps, 5);
  });

  test('accepts extra columns without letting them change anything', () => {
    const extra = `${HEADER},comment\n1,2,3,4,5,ignored\n`;
    const { points } = parseTrajectoryCsv(extra);
    assert.equal(points[0].east_m, 1);
    assert.equal(points[0].comment, undefined);
  });

  test('accepts CRLF and a missing final newline', () => {
    const crlf = `${HEADER}\r\n1,2,3,4,5\r\n6,7,8,9,10`;
    const { points } = parseTrajectoryCsv(crlf);
    assert.equal(points.length, 2);
    assert.equal(points[1].speed_mps, 10);
  });

  test('accepts quoted fields and doubled quotes', () => {
    const { rows } = parseCsv('a,b\n"x,y","say ""hi"""\n');
    assert.equal(rows[0].a, 'x,y');
    assert.equal(rows[0].b, 'say "hi"');
  });

  test('a missing required column names what is missing and what was found', () => {
    assertThrowsWith(
      () => parseTrajectoryCsv('east_m,north_m,altitude_m\n1,2,3\n'),
      'heading_deg'
    );
    assertThrowsWith(
      () => parseTrajectoryCsv('east_m,north_m,altitude_m\n1,2,3\n'),
      'speed_mps'
    );
  });

  test('a ragged row is an error that names the line, never padded out', () => {
    assertThrowsWith(() => parseTrajectoryCsv(csv('1,2,3,4,5', '1,2,3,4')), 'line 3');
    assertThrowsWith(() => parseTrajectoryCsv(csv('1,2,3,4,5,6')), 'found 6');
  });

  test('an empty cell is an error rather than a silent zero', () => {
    assertThrowsWith(() => parseTrajectoryCsv(csv('1,2,,4,5')), 'does not substitute a default');
    assertThrowsWith(() => parseTrajectoryCsv(csv('1,2,,4,5')), 'column altitude_m');
    assertThrowsWith(() => parseTrajectoryCsv(csv('1,2,   ,4,5')), 'column altitude_m');
  });

  test('a non-numeric cell is an error that quotes the offending value', () => {
    assertThrowsWith(() => parseTrajectoryCsv(csv('1,2,forty,4,5')), '"forty"');
    assertThrowsWith(() => parseTrajectoryCsv(csv('1,2,3,4,5', 'a,2,3,4,5')), 'line 3');
    assertThrowsWith(() => parseTrajectoryCsv(csv('1,2,NaN,4,5')), 'altitude_m');
    assertThrowsWith(() => parseTrajectoryCsv(csv('1,2,Infinity,4,5')), 'altitude_m');
  });

  test('a header without data rows is an error', () => {
    assertThrowsWith(() => parseTrajectoryCsv(`${HEADER}\n`), 'no data rows');
  });

  test('an empty file, a duplicate column and an empty column name are all errors', () => {
    assertThrowsWith(() => parseTrajectoryCsv(''), 'is empty');
    assertThrowsWith(() => parseCsv('a,b,a\n1,2,3\n'), 'duplicate column name');
    assertThrowsWith(() => parseCsv('a,,b\n1,2,3\n'), 'empty column name');
    assertThrowsWith(() => parseCsv('a,b\n"unterminated,2\n'), 'unterminated quoted field');
  });

  test('the source label given by the caller appears in the message', () => {
    assertThrowsWith(
      () => parseTrajectoryCsv(csv('1,2,,4,5'), 'sweep_alt40m.csv'),
      'sweep_alt40m.csv'
    );
  });

  test('parseStrictNumber accepts numbers and numeric strings, nothing else', () => {
    assert.equal(parseStrictNumber(' -12.5 ', 'x'), -12.5);
    assert.equal(parseStrictNumber(0, 'x'), 0);
    assert.equal(parseStrictNumber('1e3', 'x'), 1000);
    assertThrowsWith(() => parseStrictNumber(undefined, 'field'), 'field');
    assertThrowsWith(() => parseStrictNumber(Number.NaN, 'field'), 'not a finite number');
  });

  test('parseJson names the source when the text is not JSON', () => {
    assertThrowsWith(() => parseJson('{oops', 'site.json'), 'site.json');
    assert.deepEqual(parseJson('{"a":1}', 'x'), { a: 1 });
  });
});

describe('trajectory: CSV serialization', (test) => {
  test('writes a header row followed by the points, ending with a newline', () => {
    const text = trajectoryToCsv([point({ east_m: 1, north_m: 2 })]);
    const lines = text.split('\n');
    assert.equal(lines[0], HEADER);
    assert.equal(lines[1], '1,2,40,0,5');
    assert.equal(text.endsWith('\n'), true);
  });

  test('serialising then parsing the demo trajectory returns the same numbers', () => {
    const { points } = parseTrajectoryCsv(demoTrajectoryCsv());
    const { points: roundTripped } = parseTrajectoryCsv(trajectoryToCsv(points));
    assert.equal(roundTripped.length, points.length);
    for (let i = 0; i < points.length; i += 1) {
      for (const column of TRAJECTORY_CSV_COLUMNS) {
        assert.equal(roundTripped[i][column], points[i][column], `row ${i} column ${column}`);
      }
    }
  });

  test('survives a second round trip byte for byte', () => {
    const { points } = parseTrajectoryCsv(demoTrajectoryCsv());
    const once = trajectoryToCsv(points);
    const twice = trajectoryToCsv(parseTrajectoryCsv(once).points);
    assert.equal(once, twice);
  });

  test('refuses to write a point with a non-finite column', () => {
    assertThrowsWith(() => trajectoryToCsv([point({ altitude_m: Number.NaN })]), 'altitude_m');
    assertThrowsWith(() => trajectoryToCsv([point({ east_m: undefined })]), 'east_m');
    assertThrowsWith(() => trajectoryToCsv([point(), point({ speed_mps: null })]), 'point 1');
  });

  test('numbers keep millimetre resolution but lose their trailing zeros', () => {
    assert.equal(DEFAULT_COORDINATE_DECIMALS, 3);
    assert.equal(formatFixed(30), '30');
    assert.equal(formatFixed(30.5), '30.5');
    assert.equal(formatFixed(-63.3939), '-63.394');
    assert.equal(formatFixed(0.0001), '0');
    assert.equal(formatFixed(100.1), '100.1');
    assert.equal(formatFixed(1000), '1000');
    assert.equal(formatFixed(10.01), '10.01');
  });

  test('a value that rounds to negative zero is written as plain zero', () => {
    assert.equal(formatFixed(-0.0001), '0');
    assert.equal(formatFixed(-0), '0');
  });

  test('formatFixed and roundTo refuse non-finite values outright', () => {
    assertThrowsWith(() => formatFixed(Number.NaN), 'non-finite');
    assertThrowsWith(() => roundTo(Infinity), 'non-finite');
    assert.equal(roundTo(1.23456), 1.235);
    assert.equal(roundTo(1.23456, 1), 1.2);
  });

  test('toCsv quotes only the fields that need it', () => {
    const text = toCsv(['a', 'b'], [{ a: 'plain', b: 'has,comma' }, { a: 'has"quote', b: '' }]);
    assert.equal(text, 'a,b\nplain,"has,comma"\n"has""quote",\n');
    assertThrowsWith(() => toCsv([], []), 'non-empty header list');
  });

  test('filename parts are sanitised without ever encoding meaning', () => {
    assert.equal(sanitizeFilenamePart('demo racetrack/40 m'), 'demo_racetrack_40_m');
    assert.equal(sanitizeFilenamePart('   '), 'untitled');
    assert.equal(sanitizeFilenamePart('keep-this.name'), 'keep-this.name');
  });
});

describe('trajectory: documents, headings and metrics', (test) => {
  const square = [p(0, 0), p(100, 0), p(100, 100), p(0, 100)];

  test('a built document carries the frame and reference the CSV cannot', () => {
    const doc = buildTrajectoryDocument({
      name: 'square',
      points: square.map((v) => point(v)),
      speedMps: 5,
      altitudeReference: 'AGL',
      closed: true,
      description: 'a test',
    });
    assert.equal(doc.schema_version, 1);
    assert.equal(doc.frame, 'local_enu');
    assert.equal(doc.heading_reference, 'true_north');
    assert.equal(doc.altitude_reference, 'AGL');
    assert.equal(doc.closed, true);
    assert.equal(doc.speed_mps, 5);
    assert.equal(doc.points.length, 4);
    assert.equal(doc.description, 'a test');
    assert.deepEqual(validateTrajectory(doc), []);
  });

  test('an empty description is left out rather than written as an empty string', () => {
    const doc = buildTrajectoryDocument({
      name: 'square',
      points: square.map((v) => point(v)),
      speedMps: 5,
      altitudeReference: 'AGL',
      closed: false,
      description: '   ',
    });
    assert.equal('description' in doc, false);
  });

  test('a document refuses to be built without the facts it needs', () => {
    const base = {
      name: 'x',
      points: square.map((v) => point(v)),
      speedMps: 5,
      altitudeReference: 'AGL',
      closed: false,
    };
    assertThrowsWith(() => buildTrajectoryDocument({ ...base, name: ' ' }), 'non-empty name');
    assertThrowsWith(() => buildTrajectoryDocument({ ...base, points: [point()] }), 'at least 2 points');
    assertThrowsWith(() => buildTrajectoryDocument({ ...base, speedMps: 0 }), 'positive speed_mps');
    assertThrowsWith(
      () => buildTrajectoryDocument({ ...base, altitudeReference: '' }),
      'explicit altitude_reference'
    );
    assertThrowsWith(() => buildTrajectoryDocument({ ...base, closed: undefined }), '"closed" flag');
  });

  test('headings follow the path, clockwise from north', () => {
    assert.deepEqual(
      computePathHeadings(square, { closed: true, fallbackHeadingDeg: 0 }),
      [90, 0, 270, 180]
    );
  });

  test('the last point of an open path keeps the heading it arrived on', () => {
    const headings = computePathHeadings(square, { closed: false, fallbackHeadingDeg: 0 });
    assert.deepEqual(headings, [90, 0, 270, 270]);
  });

  test('a repeated point carries the previous heading instead of guessing', () => {
    const withDuplicate = [p(0, 0), p(0, 100), p(0, 100), p(100, 100)];
    assert.deepEqual(
      computePathHeadings(withDuplicate, { closed: false, fallbackHeadingDeg: 0 }),
      [0, 0, 90, 90]
    );
  });

  test('a fully degenerate path falls back to the heading the caller supplied', () => {
    const stack = [p(5, 5), p(5, 5), p(5, 5)];
    assert.deepEqual(
      computePathHeadings(stack, { closed: false, fallbackHeadingDeg: 123 }),
      [123, 123, 123]
    );
  });

  test('the fallback heading must be explicit', () => {
    assertThrowsWith(
      () => computePathHeadings(square, { closed: true }),
      'explicit finite fallbackHeadingDeg'
    );
  });

  test('metrics measure the closed path and the duration it implies', () => {
    const points = square.map((v) => point(v));
    const closed = trajectoryMetrics(points, { closed: true, speedMps: 5 });
    assertClose(closed.lengthM, 400);
    assertClose(closed.durationS, 80);

    const open = trajectoryMetrics(points, { closed: false, speedMps: 5 });
    assertClose(open.lengthM, 300);
    assertClose(open.durationS, 60);
  });

  test('length is measured in 3D, so a climb counts', () => {
    const climb = [point({ east_m: 0, altitude_m: 0 }), point({ east_m: 30, altitude_m: 40 })];
    assertClose(trajectoryMetrics(climb, { closed: false, speedMps: 5 }).lengthM, 50);
  });

  test('duration is null rather than Infinity when the speed is unusable', () => {
    const points = square.map((v) => point(v));
    assert.equal(trajectoryMetrics(points, { closed: false, speedMps: 0 }).durationS, null);
    assert.equal(trajectoryMetrics(points, { closed: false, speedMps: null }).durationS, null);
  });

  test('the longest segment finds a stray point', () => {
    const points = [p(0, 0), p(10, 0), p(1000, 0)].map((v) => point(v));
    assertClose(longestSegmentM(points, false), 990);
    assertClose(longestSegmentM(points, true), 1000, 1e-9, 'the closing leg');
    assert.equal(longestSegmentM([point()], false), 0);
  });

  test('withAltitude changes the altitude and nothing else', () => {
    const { points } = parseTrajectoryCsv(demoTrajectoryCsv());
    const raised = withAltitude(points, 85);
    assert.equal(raised.length, points.length);
    for (let i = 0; i < points.length; i += 1) {
      assert.equal(raised[i].altitude_m, 85);
      assert.equal(raised[i].east_m, points[i].east_m);
      assert.equal(raised[i].north_m, points[i].north_m);
      assert.equal(raised[i].heading_deg, points[i].heading_deg);
      assert.equal(raised[i].speed_mps, points[i].speed_mps);
    }
    assert.equal(points[0].altitude_m, 40, 'the source points are not mutated');
  });

  test('withAltitude refuses a non-finite altitude', () => {
    assertThrowsWith(() => withAltitude([point()], Number.NaN), 'finite altitude');
    assertThrowsWith(() => withAltitude([point()], undefined), 'finite altitude');
  });
});
