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
 *
 * A site may be loaded as *context*. It sets the local frame the trajectory is
 * expressed in, is drawn behind the path, and is what the trajectory is
 * validated against. It is strictly read-only here: nothing in this file writes
 * to the site object, and the trajectory editor is deliberately not a second
 * place to edit a site.
 */

import { distance2dM, pathSegmentsLeavingPolygon, pointInPolygon } from '../shared/js/geo.js';
import { History, attachHistoryControls } from '../shared/js/history.js';
import {
  downloadJson,
  downloadText,
  fetchJson,
  parseJson,
  readFileAsText,
  sanitizeFilenamePart,
} from '../shared/js/io.js';
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
  validateAgainstSite,
  validateSite,
  validateTrajectory,
} from '../shared/js/validation.js';
import {
  NO_VALUE,
  clear,
  definitionList,
  el,
  formatDuration,
  formatMeters,
  helpFor,
  installGlobalErrorHandlers,
  must,
  numberToInput,
  readNumberInput,
  renderFindings,
  renderVerdict,
  reportError,
  setContext,
  setStatus,
  summarizeFindings,
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

/** Example index. The toolkit never scrapes an HTTP directory listing. */
const MANIFEST_URL = '../examples/manifest.json';

const state = {
  /** @type {Array<{east_m: number, north_m: number}>} */
  points: [],
  closed: true,
  /** @type {number|null} */
  selectedIndex: null,
  /** @type {TrajectoryCanvas|null} */
  canvas: null,
  /**
   * Read-only site context, or null for the abstract local plane.
   * @type {object|null}
   */
  site: null,
  siteLabel: null,
  /** @type {URL|null} */
  manifestUrl: null,
  /** @type {Array<object>} */
  manifestSites: [],
  /**
   * Undo/redo over the editable part of the trajectory: the control points,
   * the closed flag and the selection. The site is context, not content, so it
   * is deliberately not part of the history — choosing a different site is not
   * an edit to the trajectory.
   */
  history: new History(),
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  installGlobalErrorHandlers(els.status);
  installHelp();
  fillAltitudeReferenceSelect();
  wireEvents();
  initCanvas();
  updatePresetVisibility();
  renderSiteSummary();
  generateFromPreset({ announce: false });
  setStatus(
    els.status,
    'Racetrack preset loaded. Choose a site for context, and set an altitude and an altitude ' +
      'reference before exporting.',
    'info'
  );
  loadSiteManifest();
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

  els.siteSource = must('#site-source');
  els.siteFile = must('#site-file');
  els.siteSummary = must('#site-summary');

  els.undo = must('#undo');
  els.redo = must('#redo');

  els.ctxSite = must('#ctx-site');
  els.ctxFrame = must('#ctx-frame');
  els.ctxAltitude = must('#ctx-altitude');
  els.ctxVerdict = must('#ctx-verdict');
}

/** Attach the `?` explanations for the jargon this tool cannot avoid. */
function installHelp() {
  must('#help-altref').append(helpFor('AGL'));
  must('#help-heading').append(helpFor('heading'));
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
    commit(state.closed ? 'Close the path' : 'Open the path');
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

  // Flight parameters are part of the document, so a committed change to one
  // is undoable. The model updates on every keystroke (validation stays live);
  // only the committed value becomes a history entry.
  for (const input of [els.altitude, els.speed, els.fixedHeading, els.name]) {
    input.addEventListener('change', () => commit(`Change ${input.id.replace(/-/g, ' ')}`));
  }
  els.altitudeRef.addEventListener('change', () => commit('Change altitude reference'));
  els.headingMode.addEventListener('change', () => commit('Change heading mode'));

  attachHistoryControls({
    history: state.history,
    undoButton: els.undo,
    redoButton: els.redo,
    apply: (snapshot, direction, label) => {
      restoreSnapshot(snapshot);
      refresh({ rebuildTable: true });
      setStatus(
        els.status,
        `${direction === 'undo' ? 'Undid' : 'Redid'}: ${label ?? 'the last change'}.`,
        'info'
      );
    },
  });

  els.siteSource.addEventListener('change', () => onSiteSourceChanged());
  els.siteFile.addEventListener('change', (event) => {
    const [file] = event.target.files ?? [];
    if (file) loadSiteFromFile(file);
  });
}

// --- site context -----------------------------------------------------------

/**
 * Fill the site picker from the example manifest.
 *
 * "No site" stays the first option and the default: working without a site is a
 * legitimate choice, not a degraded state, and the tool must not imply that one
 * of the shipped examples is the right frame for whatever the user is drawing.
 */
async function loadSiteManifest() {
  try {
    state.manifestUrl = new URL(MANIFEST_URL, window.location.href);
    const manifest = await fetchJson(state.manifestUrl.href);
    state.manifestSites = Array.isArray(manifest?.sites) ? manifest.sites : [];
    state.manifestSites.forEach((entry, index) => {
      els.siteSource.append(
        el('option', {
          value: `example:${index}`,
          text: entry.name ?? entry.id ?? entry.site_path,
        })
      );
    });
  } catch (err) {
    // A missing manifest must not take the tool down: the local-file path and
    // the no-site path both still work.
    reportError(els.status, err, 'Could not read the example site manifest');
  }
}

function onSiteSourceChanged() {
  const value = els.siteSource.value;
  if (value === 'none') {
    adoptSite(null, null);
    setStatus(els.status, 'Working without a site, in an abstract local plane.', 'info');
    return;
  }
  const index = Number(value.slice('example:'.length));
  loadExampleSite(index);
}

async function loadExampleSite(index) {
  try {
    const entry = state.manifestSites[index];
    if (!entry?.site_path) throw new Error('That manifest entry has no "site_path".');
    const site = await fetchJson(new URL(entry.site_path, state.manifestUrl).href);
    adoptSite(site, `examples/${entry.site_path}`);
  } catch (err) {
    reportError(els.status, err, 'Could not load the site');
  }
}

/** @param {File} file */
async function loadSiteFromFile(file) {
  try {
    const text = await readFileAsText(file);
    const site = parseJson(text, file.name);
    if (site === null || typeof site !== 'object' || Array.isArray(site)) {
      throw new Error(`"${file.name}" does not contain a site object.`);
    }
    // A local file is not in the picker, so give it an entry and select it.
    let option = els.siteSource.querySelector('option[value="local"]');
    if (option === null) {
      option = el('option', { value: 'local' });
      els.siteSource.append(option);
    }
    option.textContent = file.name;
    els.siteSource.value = 'local';
    adoptSite(site, file.name);
  } catch (err) {
    reportError(els.status, err, `Could not load "${file.name}"`);
  }
}

/**
 * Take a site as context.
 *
 * The site is validated first: checking a trajectory against a site that is
 * itself broken produces findings that blame the wrong document. A site with
 * errors is still adopted — it is the user's data and they may be mid-repair —
 * but the tool says so rather than quietly treating it as authoritative.
 *
 * @param {object|null} site
 * @param {string|null} label
 */
function adoptSite(site, label) {
  state.site = site;
  state.siteLabel = label;
  renderSiteSummary();
  refresh({ rebuildTable: false, fitCanvas: true });

  if (site === null) return;

  const findings = validateSite(site);
  if (hasErrors(findings)) {
    setStatus(
      els.status,
      `Loaded "${label}" as context, but that site definition has validation errors. ` +
        `Checks against it may be misleading — repair it in the Site Editor.`,
      'warning'
    );
  } else {
    setStatus(els.status, `Site context: "${label}". The trajectory is checked against it.`, 'ok');
  }
}

function renderSiteSummary() {
  clear(els.siteSummary);
  const site = state.site;
  if (site === null) {
    els.siteSummary.append(
      el('p', {
        class: 'panel__hint',
        text:
          'No site. Coordinates are metres in an abstract local plane, and nothing checks them ' +
          'against a safety area or an altitude band.',
      })
    );
    return;
  }

  const safety = site.safety_area ?? {};
  const band =
    Number.isFinite(safety.min_altitude_m) && Number.isFinite(safety.max_altitude_m)
      ? `${safety.min_altitude_m} … ${safety.max_altitude_m} m ${safety.altitude_reference ?? '(reference not set)'}`
      : NO_VALUE;

  els.siteSummary.append(
    definitionList([
      ['Name', typeof site.name === 'string' ? site.name : NO_VALUE],
      ['Site id', typeof site.site_id === 'string' ? site.site_id : 'not set'],
      ['Frame', site.local_frame?.type ?? NO_VALUE],
      ['Altitude band', band],
      [
        'Safety vertices',
        String(Array.isArray(safety.horizontal) ? safety.horizontal.length : 0),
      ],
      [
        'Mission points',
        String(Array.isArray(site.mission_points) ? site.mission_points.length : 0),
      ],
    ])
  );
}

/**
 * Which control points fall outside the site's safety area, and which segments
 * leave it. Used to mark them on the canvas; the validation panel gets the same
 * facts from shared/js/validation.js.
 *
 * @returns {{outsidePointIndices: number[], leavingSegmentIndices: number[]}}
 */
function siteViolations() {
  const ring = state.site?.safety_area?.horizontal;
  const polygon = Array.isArray(ring) && ring.length >= 3 ? ring : null;
  if (polygon === null) return { outsidePointIndices: [], leavingSegmentIndices: [] };

  const outsidePointIndices = [];
  state.points.forEach((point, index) => {
    if (!pointInPolygon(point, polygon)) outsidePointIndices.push(index);
  });

  return {
    outsidePointIndices,
    leavingSegmentIndices: pathSegmentsLeavingPolygon(state.points, polygon, {
      closed: state.closed,
    }),
  };
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
    onPointDragEnd: (index) => {
      // One entry per gesture. The intermediate positions were never pushed,
      // so there is nothing to coalesce away here.
      commit(`Move control point ${index}`);
      refresh({ rebuildTable: true, fitCanvas: false });
    },
    onCursorMove: (enu) => {
      els.cursorReadout.textContent =
        enu === null
          ? ' '
          : `E ${enu.east_m.toFixed(1)} m  N ${enu.north_m.toFixed(1)} m`;
    },
  });
}

/**
 * Everything an undo has to restore.
 *
 * The flight parameters live in the DOM rather than in `state`, so they are
 * read out here; restoring writes them back. Keeping the snapshot explicit (as
 * opposed to cloning `state`) also documents exactly what is and is not
 * undoable.
 *
 * @returns {object}
 */
function snapshot() {
  return {
    points: state.points.map((point) => ({ ...point })),
    closed: state.closed,
    selectedIndex: state.selectedIndex,
    name: els.name.value,
    altitude: els.altitude.value,
    altitudeReference: els.altitudeRef.value,
    speed: els.speed.value,
    headingMode: els.headingMode.value,
    fixedHeading: els.fixedHeading.value,
    preset: els.presetSelect.value,
  };
}

/** @param {object} snap */
function restoreSnapshot(snap) {
  state.points = snap.points.map((point) => ({ ...point }));
  state.closed = snap.closed;
  state.selectedIndex = snap.selectedIndex;
  els.name.value = snap.name;
  els.altitude.value = snap.altitude;
  els.altitudeRef.value = snap.altitudeReference;
  els.speed.value = snap.speed;
  els.headingMode.value = snap.headingMode;
  els.fixedHeading.value = snap.fixedHeading;
  els.presetSelect.value = snap.preset;
  els.closed.checked = snap.closed;
  els.fixedHeadingField.hidden = snap.headingMode !== 'fixed';
  updatePresetVisibility();
}

/**
 * Record the current editable state as one undoable operation.
 * @param {string} label
 * @param {{coalesceKey?: string}} [options]
 */
function commit(label, options = {}) {
  state.history.push(snapshot(), label, options);
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
    commit(`Replace points with ${preset} preset`);
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
  commit(`Insert control point ${index + 1}`);
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
  commit(`Remove control point ${removed}`);
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

  if (hasErrors(findings)) {
    // The document cannot be assembled yet, but the site checks do not depend
    // on it. Run them anyway: "your path leaves the safety area" must not stay
    // hidden behind "you have not chosen an altitude reference".
    return {
      document: null,
      findings: [
        ...findings,
        ...validateAgainstSite(
          { points: state.points, closed: state.closed, altitudeReference },
          state.site
        ),
      ],
    };
  }

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
    site: state.site,
  });

  return {
    document: document_,
    findings: [
      ...findings,
      ...validateTrajectory(document_, state.site === null ? {} : { site: state.site }),
    ],
  };
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
  const violations = siteViolations();
  state.canvas?.setData(
    {
      points: state.points,
      closed: state.closed,
      headings: currentHeadings(),
      selectedIndex: state.selectedIndex,
      site: state.site,
      ...violations,
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
  input.addEventListener('change', () => commit('Edit control point'));
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

/**
 * Re-render validation, the context bar and the export buttons.
 *
 * The export buttons reflect the verdict rather than failing on click: a
 * disabled button that says why is a better answer than a button that looks
 * ready and then refuses.
 */
function renderValidation() {
  const { document: document_, findings } = buildDocumentOrFindings();
  const exportable = document_ !== null && !hasErrors(findings);

  renderFindings(els.validation, findings, {
    emptyMessage: 'No findings. The trajectory is complete and internally consistent.',
  });
  renderVerdict(els.ctxVerdict, summarizeFindings(findings));

  const altitude = readNumberInput(els.altitude);
  const reference = els.altitudeRef.value;
  setContext(
    els.ctxAltitude,
    altitude === null ? null : `${altitude} m ${reference || '(reference not set)'}`
  );
  setContext(
    els.ctxSite,
    state.site === null
      ? null
      : state.site.site_id ?? state.site.name ?? state.siteLabel,
    'no site'
  );
  // The frame slot says something new only when the site disagrees with what
  // the trajectory format assumes; repeating "ENU" twice is just noise.
  const siteFrame = state.site?.local_frame?.type ?? null;
  setContext(
    els.ctxFrame,
    siteFrame !== null && siteFrame !== 'ENU'
      ? `local ENU · metres — site declares ${siteFrame}`
      : 'local ENU · metres'
  );

  for (const button of [els.downloadJson, els.downloadCsv]) {
    button.disabled = !exportable;
    button.title = exportable
      ? ''
      : 'Export is blocked while the trajectory has validation errors. See the Validation panel.';
  }
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
