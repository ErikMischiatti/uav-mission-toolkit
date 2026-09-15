/**
 * Trajectory editor.
 *
 * Holds a list of control points in the local ENU plane plus the flight
 * parameters that turn them into a trajectory document. The geometry presets
 * live in presets.js and the drawing in canvas.js; this file is the glue and
 * the export path.
 *
 * Altitude and altitude reference start empty on purpose. Export is refused
 * until both are set, because a bare altitude number means nothing.
 */

import { distance2dM } from '../shared/js/geo.js';
import { downloadJson, downloadText, sanitizeFilenamePart } from '../shared/js/io.js';
import {
  buildTrajectoryDocument,
  computePathHeadings,
  longestSegmentM,
  trajectoryMetrics,
  trajectoryToCsv,
} from '../shared/js/trajectory.js';
import {
  ALTITUDE_REFERENCES,
  SEVERITY,
  hasErrors,
  validateTrajectory,
} from '../shared/js/validation.js';
import {
  NO_VALUE,
  clear,
  definitionList,
  el,
  formatDuration,
  formatMeters,
  installGlobalErrorHandlers,
  must,
  numberToInput,
  readNumberInput,
  renderFindings,
  reportError,
  setStatus,
} from '../shared/js/ui.js';
import { TrajectoryCanvas } from './canvas.js';
import { buildPreset } from './presets.js';

/** A path needs at least two control points. */
const MIN_POINTS = 2;
/** Segments shorter than this are reported: they make the heading ill-defined. */
const DEGENERATE_SEGMENT_M = 0.01;
/**
 * Heading used only if the path is so degenerate that no bearing can be
 * computed at all (every control point in the same place). That case is also
 * reported as a validation error, so this never silently reaches a file.
 */
const DEGENERATE_PATH_HEADING_DEG = 0;

const state = {
  /** @type {Array<{east_m: number, north_m: number}>} */
  points: [],
  closed: true,
  /** @type {number|null} */
  selectedIndex: null,
  /** @type {TrajectoryCanvas|null} */
  canvas: null,
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  installGlobalErrorHandlers(els.status);
  fillAltitudeReferenceSelect();
  wireEvents();
  initCanvas();
  updatePresetVisibility();
  generateFromPreset({ announce: false });
  setStatus(
    els.status,
    'Racetrack preset loaded. Set an altitude and an altitude reference before exporting.',
    'info'
  );
});

function cacheElements() {
  els.status = must('#status');
  els.presetSelect = must('#preset-select');
  els.generate = must('#generate');
  els.paramGroups = Array.from(document.querySelectorAll('.param-group'));

  els.name = must('#traj-name');
  els.altitude = must('#altitude');
  els.altitudeRef = must('#altitude-ref');
  els.speed = must('#speed');
  els.closed = must('#closed');
  els.headingMode = must('#heading-mode');
  els.fixedHeadingField = must('#fixed-heading-field');
  els.fixedHeading = must('#fixed-heading');

  els.metrics = must('#metrics');
  els.validation = must('#validation');
  els.downloadJson = must('#download-json');
  els.downloadCsv = must('#download-csv');

  els.insertPoint = must('#insert-point');
  els.removePoint = must('#remove-point');
  els.pointRows = must('#point-rows');

  els.canvas = must('#canvas');
  els.fitView = must('#fit-view');
  els.cursorReadout = must('#cursor-readout');
}

function fillAltitudeReferenceSelect() {
  clear(els.altitudeRef);
  els.altitudeRef.append(el('option', { value: '', text: '— not set —' }));
  for (const reference of ALTITUDE_REFERENCES) {
    els.altitudeRef.append(el('option', { value: reference, text: reference }));
  }
}

function wireEvents() {
  els.presetSelect.addEventListener('change', () => updatePresetVisibility());
  els.generate.addEventListener('click', () => generateFromPreset({ announce: true }));

  for (const input of [els.altitude, els.speed, els.fixedHeading, els.name]) {
    input.addEventListener('input', () => refresh({ rebuildTable: true }));
  }
  els.altitudeRef.addEventListener('change', () => refresh({ rebuildTable: false }));
  els.closed.addEventListener('change', () => {
    state.closed = els.closed.checked;
    refresh({ rebuildTable: true });
  });
  els.headingMode.addEventListener('change', () => {
    els.fixedHeadingField.hidden = els.headingMode.value !== 'fixed';
    refresh({ rebuildTable: true });
  });

  els.downloadJson.addEventListener('click', () => exportJson());
  els.downloadCsv.addEventListener('click', () => exportCsv());

  els.insertPoint.addEventListener('click', () => insertAfterSelected());
  els.removePoint.addEventListener('click', () => removeSelected());
  els.fitView.addEventListener('click', () => {
    state.canvas?.fit();
  });
}

function initCanvas() {
  state.canvas = new TrajectoryCanvas(els.canvas, {
    onPointSelect: (index) => {
      state.selectedIndex = index;
      refresh({ rebuildTable: true, fitCanvas: false });
    },
    onPointDrag: (index, enu) => {
      const point = state.points[index];
      if (!point) return;
      point.east_m = round(enu.east_m);
      point.north_m = round(enu.north_m);
      // Only the drawing is refreshed while dragging; the table and the
      // validation panel are rebuilt once the drag ends.
      drawCanvas({ fit: false });
    },
    onPointDragEnd: () => refresh({ rebuildTable: true, fitCanvas: false }),
    onCursorMove: (enu) => {
      els.cursorReadout.textContent =
        enu === null
          ? ' '
          : `E ${enu.east_m.toFixed(1)} m  N ${enu.north_m.toFixed(1)} m`;
    },
  });
}

function updatePresetVisibility() {
  const preset = els.presetSelect.value;
  for (const group of els.paramGroups) {
    group.hidden = group.dataset.preset !== preset;
  }
}

// --- model actions ----------------------------------------------------------

function generateFromPreset({ announce }) {
  try {
    const preset = els.presetSelect.value;
    const { points, closed } = buildPreset(preset, collectPresetParams(preset));
    state.points = points.map((point) => ({
      east_m: round(point.east_m),
      north_m: round(point.north_m),
    }));
    state.closed = closed;
    state.selectedIndex = null;
    els.closed.checked = closed;
    refresh({ rebuildTable: true, fitCanvas: true });
    if (announce) {
      setStatus(els.status, `Generated ${points.length} control points (${preset}).`, 'ok');
    }
  } catch (err) {
    reportError(els.status, err, 'Could not generate the preset');
  }
}

/**
 * Read the numeric parameters belonging to a preset. A missing value raises,
 * so a blank field never turns into a silent zero.
 */
function collectPresetParams(preset) {
  switch (preset) {
    case 'straight':
      return {
        length_m: requireInput('#p-length', 'Length'),
        heading_deg: requireInput('#p-line-heading', 'Direction'),
      };
    case 'circle':
      return {
        radius_m: requireInput('#p-radius', 'Radius'),
        samples: requireInput('#p-circle-samples', 'Number of points'),
      };
    case 'racetrack':
      return {
        straight_length_m: requireInput('#p-straight-length', 'Straight length'),
        turn_radius_m: requireInput('#p-turn-radius', 'Turn radius'),
        arc_segments: requireInput('#p-arc-segments', 'Arc segments'),
      };
    case 'figure_eight':
      return {
        width_m: requireInput('#p-width', 'Width'),
        height_m: requireInput('#p-height', 'Height'),
        samples: requireInput('#p-eight-samples', 'Number of points'),
      };
    default:
      throw new Error(`Unknown preset "${preset}".`);
  }
}

function requireInput(selector, label) {
  const value = readNumberInput(/** @type {HTMLInputElement} */ (must(selector)));
  if (value === null) throw new Error(`${label} must be filled in with a number.`);
  return value;
}

function insertAfterSelected() {
  if (state.points.length === 0) return;
  const index = state.selectedIndex ?? state.points.length - 1;
  const current = state.points[index];
  const nextIndex = (index + 1) % state.points.length;
  const next = state.points[nextIndex];

  // Midpoint of the following segment; for the last point of an open path
  // there is no following segment, so extend the previous one instead.
  let inserted;
  if (nextIndex === 0 && !state.closed) {
    const previous = state.points[Math.max(index - 1, 0)];
    inserted = {
      east_m: round(current.east_m + (current.east_m - previous.east_m) / 2),
      north_m: round(current.north_m + (current.north_m - previous.north_m) / 2),
    };
  } else {
    inserted = {
      east_m: round((current.east_m + next.east_m) / 2),
      north_m: round((current.north_m + next.north_m) / 2),
    };
  }

  state.points.splice(index + 1, 0, inserted);
  state.selectedIndex = index + 1;
  refresh({ rebuildTable: true });
  setStatus(els.status, `Inserted control point at index ${index + 1}.`, 'ok');
}

function removeSelected() {
  if (state.selectedIndex === null) {
    setStatus(els.status, 'Select a control point first (click one on the canvas).', 'warning');
    return;
  }
  if (state.points.length <= MIN_POINTS) {
    setStatus(els.status, `A trajectory needs at least ${MIN_POINTS} control points.`, 'warning');
    return;
  }
  const removed = state.selectedIndex;
  state.points.splice(removed, 1);
  state.selectedIndex = Math.min(removed, state.points.length - 1);
  refresh({ rebuildTable: true });
  setStatus(els.status, `Removed control point ${removed}.`, 'ok');
}

// --- derived values ---------------------------------------------------------

/**
 * Heading for every control point, following the current heading mode.
 * @returns {Array<number|null>}
 */
function currentHeadings() {
  if (els.headingMode.value === 'fixed') {
    const fixed = readNumberInput(els.fixedHeading);
    return state.points.map(() => fixed);
  }
  if (state.points.length < MIN_POINTS) return state.points.map(() => null);
  return computePathHeadings(state.points, {
    closed: state.closed,
    fallbackHeadingDeg: DEGENERATE_PATH_HEADING_DEG,
  });
}

/**
 * Collect the flight parameters, reporting whatever is missing instead of
 * filling it in.
 * @returns {{document: object|null, findings: Array<object>}}
 */
function buildDocumentOrFindings() {
  const findings = [];
  const name = els.name.value.trim();
  const altitude = readNumberInput(els.altitude);
  const altitudeReference = els.altitudeRef.value;
  const speed = readNumberInput(els.speed);
  const headings = currentHeadings();

  if (name === '') {
    findings.push(makeFinding(SEVERITY.ERROR, 'name', 'Give the trajectory a name.'));
  }
  if (state.points.length < MIN_POINTS) {
    findings.push(
      makeFinding(
        SEVERITY.ERROR,
        'points',
        `A trajectory needs at least ${MIN_POINTS} control points, there are ${state.points.length}.`
      )
    );
  }
  if (altitude === null) {
    findings.push(
      makeFinding(SEVERITY.ERROR, 'altitude', 'Altitude is not set. There is no default altitude.')
    );
  }
  if (!ALTITUDE_REFERENCES.includes(altitudeReference)) {
    findings.push(
      makeFinding(
        SEVERITY.ERROR,
        'altitude_reference',
        `Altitude reference is not set. Choose one of ${ALTITUDE_REFERENCES.join(', ')}.`
      )
    );
  }
  if (speed === null || speed <= 0) {
    findings.push(
      makeFinding(SEVERITY.ERROR, 'speed', 'Target speed must be a positive number of m/s.')
    );
  }
  if (headings.some((heading) => heading === null)) {
    findings.push(
      makeFinding(
        SEVERITY.ERROR,
        'heading',
        'Heading could not be determined for every point. Set a fixed heading or add points.'
      )
    );
  }

  const shortSegments = countShortSegments();
  if (shortSegments > 0) {
    findings.push(
      makeFinding(
        SEVERITY.WARNING,
        'segment_length',
        `${shortSegments} segment(s) are shorter than ${DEGENERATE_SEGMENT_M} m. The path ` +
          `tangent there is ill-defined and the previous heading is carried over.`
      )
    );
  }

  if (hasErrors(findings)) return { document: null, findings };

  const points = state.points.map((point, index) => ({
    east_m: point.east_m,
    north_m: point.north_m,
    altitude_m: altitude,
    heading_deg: headings[index],
    speed_mps: speed,
  }));

  const document_ = buildTrajectoryDocument({
    name,
    points,
    speedMps: speed,
    altitudeReference,
    closed: state.closed,
  });

  return { document: document_, findings: [...findings, ...validateTrajectory(document_)] };
}

function countShortSegments() {
  let count = 0;
  const limit = state.closed ? state.points.length : state.points.length - 1;
  for (let i = 0; i < limit; i += 1) {
    const next = state.points[(i + 1) % state.points.length];
    if (distance2dM(state.points[i], next) < DEGENERATE_SEGMENT_M) count += 1;
  }
  return count;
}

function makeFinding(severity, code, message) {
  return { severity, code, message };
}

// --- rendering --------------------------------------------------------------

function refresh(options = {}) {
  const { rebuildTable = true, fitCanvas = false } = options;
  drawCanvas({ fit: fitCanvas });
  if (rebuildTable) renderPointTable();
  renderMetrics();
  renderValidation();
}

function drawCanvas({ fit }) {
  state.canvas?.setData(
    {
      points: state.points,
      closed: state.closed,
      headings: currentHeadings(),
      selectedIndex: state.selectedIndex,
    },
    { fit }
  );
}

function renderPointTable() {
  const headings = currentHeadings();
  clear(els.pointRows);

  state.points.forEach((point, index) => {
    const row = el('tr', {
      class: index === state.selectedIndex ? 'is-selected' : '',
      onClick: () => {
        state.selectedIndex = index;
        refresh({ rebuildTable: true });
      },
    });
    row.append(el('td', { class: 'mono', text: String(index) }));
    row.append(el('td', { class: 'num' }, [
      numberCell(point.east_m, (value) => {
        point.east_m = value;
        refresh({ rebuildTable: false });
      }),
    ]));
    row.append(el('td', { class: 'num' }, [
      numberCell(point.north_m, (value) => {
        point.north_m = value;
        refresh({ rebuildTable: false });
      }),
    ]));
    row.append(
      el('td', {
        class: 'num',
        text: headings[index] === null ? NO_VALUE : headings[index].toFixed(1),
      })
    );
    els.pointRows.append(row);
  });

  if (state.points.length === 0) {
    els.pointRows.append(el('tr', {}, [el('td', { colspan: '4', text: 'No control points.' })]));
  }
}

/**
 * A numeric cell for a control point coordinate. A control point cannot exist
 * without coordinates, so an empty field is refused and flagged on the input
 * rather than written into the model as null.
 *
 * @param {number} value
 * @param {(value: number) => void} apply
 */
function numberCell(value, apply) {
  const input = /** @type {HTMLInputElement} */ (
    el('input', { type: 'number', step: 'any', class: 'num', value: numberToInput(value) })
  );
  input.addEventListener('input', () => {
    const parsed = readNumberInput(input);
    if (parsed === null) {
      input.setCustomValidity('Enter a number.');
      return;
    }
    input.setCustomValidity('');
    apply(parsed);
  });
  input.addEventListener('click', (event) => event.stopPropagation());
  return input;
}

function renderMetrics() {
  const speed = readNumberInput(els.speed);
  const altitude = readNumberInput(els.altitude);
  // v0.1 flies one altitude for the whole path, so every segment is level and
  // the 3D length equals the 2D length. The placeholder used when no altitude
  // has been chosen therefore cannot change the reported numbers.
  const LEVEL_PLACEHOLDER_ALTITUDE_M = 0;
  const points = state.points.map((point) => ({
    ...point,
    altitude_m: altitude === null ? LEVEL_PLACEHOLDER_ALTITUDE_M : altitude,
  }));
  const { lengthM, durationS } = trajectoryMetrics(points, {
    closed: state.closed,
    speedMps: speed ?? Number.NaN,
  });

  clear(els.metrics);
  els.metrics.append(
    definitionList([
      ['Control points', String(state.points.length)],
      ['Closed', state.closed ? 'yes' : 'no'],
      ['Path length', formatMeters(lengthM)],
      ['Longest segment', formatMeters(longestSegmentM(points, state.closed))],
      ['Estimated duration', durationS === null ? NO_VALUE : formatDuration(durationS)],
      [
        'Altitude',
        altitude === null
          ? 'not set'
          : `${altitude} m ${els.altitudeRef.value || '(reference not set)'}`,
      ],
    ])
  );
  els.metrics.append(
    el('p', {
      class: 'panel__hint',
      text:
        'The duration assumes a constant ground speed and ignores acceleration, turn radius ' +
        'and any hold time at a waypoint.',
    })
  );
}

function renderValidation() {
  const { findings } = buildDocumentOrFindings();
  renderFindings(els.validation, findings, {
    emptyMessage: 'The trajectory is complete and satisfies every rule in shared/js/validation.js.',
  });
}

// --- export -----------------------------------------------------------------

function exportJson() {
  const result = buildDocumentOrFindings();
  if (result.document === null || hasErrors(result.findings)) {
    renderFindings(els.validation, result.findings);
    setStatus(els.status, 'Export refused: fix the validation errors listed below.', 'error');
    return;
  }
  const filename = `${sanitizeFilenamePart(result.document.name)}.trajectory.json`;
  downloadJson(filename, result.document);
  setStatus(els.status, `Downloaded "${filename}".`, 'ok');
}

function exportCsv() {
  const result = buildDocumentOrFindings();
  if (result.document === null || hasErrors(result.findings)) {
    renderFindings(els.validation, result.findings);
    setStatus(els.status, 'Export refused: fix the validation errors listed below.', 'error');
    return;
  }
  try {
    const csv = trajectoryToCsv(result.document.points);
    const filename = `${sanitizeFilenamePart(result.document.name)}.csv`;
    downloadText(filename, csv, 'text/csv;charset=utf-8');
    setStatus(
      els.status,
      `Downloaded "${filename}". Remember that the CSV does not record the altitude reference ` +
        `(${result.document.altitude_reference}).`,
      'ok'
    );
  } catch (err) {
    reportError(els.status, err, 'CSV export failed');
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
