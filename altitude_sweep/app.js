/**
 * Altitude sweep.
 *
 * Loads a trajectory CSV, produces one variant per altitude in a range, and
 * verifies each variant before allowing it to be downloaded.
 *
 * The verification is deliberately paranoid: a variant is serialised to CSV
 * text, parsed back from that text, and then compared row by row against the
 * source. What is checked is therefore the bytes that will actually land in the
 * downloaded file, not an in-memory object that happens to look right.
 */

import {
  boundingBox,
  pathLengthM,
} from '../shared/js/geo.js';
import {
  downloadJson,
  downloadText,
  fetchJson,
  fetchText,
  readFileAsText,
  sanitizeFilenamePart,
} from '../shared/js/io.js';
import {
  parseTrajectoryCsv,
  trajectoryToCsv,
  withAltitude,
} from '../shared/js/trajectory.js';
import { ALTITUDE_REFERENCES, verifyAltitudeVariant } from '../shared/js/validation.js';
import {
  NO_VALUE,
  clear,
  definitionList,
  el,
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

const MANIFEST_URL = '../examples/manifest.json';
/** Refuse absurd sweeps rather than freezing the tab. */
const MAX_VARIANTS = 200;
/** Rows shown in the preview table. */
const PREVIEW_ROW_LIMIT = 25;
/** Gap between the downloads of a "download all", in milliseconds. */
const MULTI_DOWNLOAD_INTERVAL_MS = 300;
/** Altitudes are compared after rounding to this many decimals. */
const ALTITUDE_DECIMALS = 3;

const state = {
  /** @type {Array<object>|null} parsed source points */
  basePoints: null,
  sourceLabel: null,
  sourceBaseName: 'trajectory',
  /** @type {Array<{altitudeM:number, csv:string, points:Array<object>, ok:boolean, findings:Array<object>, filename:string}>} */
  variants: [],
  /** @type {URL|null} */
  manifestUrl: null,
  /** @type {Array<object>} */
  manifestTrajectories: [],
  selectedVariantIndex: null,
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  installGlobalErrorHandlers(els.status);
  must('#help-altref').append(helpFor('AGL'));
  fillAltitudeReferenceSelect();
  wireEvents();
  loadManifest();
});

function cacheElements() {
  els.status = must('#status');
  els.exampleSelect = must('#example-select');
  els.loadExample = must('#load-example');
  els.csvFile = must('#csv-file');
  els.sourceAltRef = must('#source-alt-ref');
  els.sourceSummary = must('#source-summary');

  els.startAlt = must('#start-alt');
  els.endAlt = must('#end-alt');
  els.stepAlt = must('#step-alt');
  els.generate = must('#generate');
  els.downloadAll = must('#download-all');

  els.verification = must('#verification');
  els.variantRows = must('#variant-rows');
  els.previewLabel = must('#preview-label');
  els.previewRows = must('#preview-rows');

  els.ctxSource = must('#ctx-source');
  els.ctxRows = must('#ctx-rows');
  els.ctxAltRef = must('#ctx-altref');
  els.ctxVerdict = must('#ctx-verdict');
}

function fillAltitudeReferenceSelect() {
  clear(els.sourceAltRef);
  els.sourceAltRef.append(el('option', { value: '', text: '— not set —' }));
  for (const reference of ALTITUDE_REFERENCES) {
    els.sourceAltRef.append(el('option', { value: reference, text: reference }));
  }
}

function wireEvents() {
  els.loadExample.addEventListener('click', () => loadSelectedExample());
  els.csvFile.addEventListener('change', (event) => {
    const [file] = event.target.files ?? [];
    if (file) loadCsvFromFile(file);
  });
  els.sourceAltRef.addEventListener('change', () => {
    // The reference is metadata about the source; changing it invalidates
    // nothing numerically, but the generated manifest must stay in step.
    renderSourceSummary();
    renderVariantTable();
    renderContext();
  });
  els.generate.addEventListener('click', () => generateVariants());
  els.downloadAll.addEventListener('click', () => downloadAll());
  els.downloadAll.disabled = true;
}

// --- loading ----------------------------------------------------------------

async function loadManifest() {
  try {
    state.manifestUrl = new URL(MANIFEST_URL, window.location.href);
    const manifest = await fetchJson(state.manifestUrl.href);
    const sites = Array.isArray(manifest?.sites) ? manifest.sites : [];

    state.manifestTrajectories = [];
    for (const site of sites) {
      for (const trajectory of site.trajectories ?? []) {
        state.manifestTrajectories.push({ site, trajectory });
      }
    }

    clear(els.exampleSelect);
    if (state.manifestTrajectories.length === 0) {
      els.exampleSelect.append(el('option', { value: '', text: 'no examples listed' }));
      els.loadExample.disabled = true;
      setStatus(els.status, 'examples/manifest.json lists no trajectories.', 'warning');
      return;
    }
    state.manifestTrajectories.forEach((entry, index) => {
      els.exampleSelect.append(
        el('option', {
          value: String(index),
          text: `${entry.site.name ?? entry.site.id}: ${entry.trajectory.name ?? entry.trajectory.id}`,
        })
      );
    });
    await loadSelectedExample();
  } catch (err) {
    els.loadExample.disabled = true;
    reportError(els.status, err, 'Could not read the example manifest');
  }
}

async function loadSelectedExample() {
  try {
    const entry = state.manifestTrajectories[Number(els.exampleSelect.value)];
    if (!entry?.trajectory?.csv_path) {
      throw new Error('The selected manifest entry has no "csv_path".');
    }
    const csvUrl = new URL(entry.trajectory.csv_path, state.manifestUrl);
    const text = await fetchText(csvUrl.href);
    const label = `examples/${entry.trajectory.csv_path}`;

    adoptCsv(text, label);

    // The manifest states the altitude reference explicitly; adopt it and say
    // so, rather than leaving the user to guess.
    const reference = entry.trajectory.altitude_reference;
    if (ALTITUDE_REFERENCES.includes(reference)) {
      els.sourceAltRef.value = reference;
      renderSourceSummary();
      renderContext();
      setStatus(
        els.status,
        `Loaded "${label}" with ${state.basePoints.length} rows. Altitude reference ` +
          `${reference} taken from the example manifest.`,
        'ok'
      );
    } else {
      els.sourceAltRef.value = '';
      renderSourceSummary();
      renderContext();
      setStatus(
        els.status,
        `Loaded "${label}", but the manifest does not state an altitude reference. Choose one.`,
        'warning'
      );
    }
  } catch (err) {
    reportError(els.status, err, 'Could not load the example trajectory');
  }
}

/** @param {File} file */
async function loadCsvFromFile(file) {
  try {
    const text = await readFileAsText(file);
    adoptCsv(text, file.name);
    // Nothing in a local file says what its altitudes are measured against.
    els.sourceAltRef.value = '';
    renderSourceSummary();
    renderContext();
    setStatus(
      els.status,
      `Loaded "${file.name}" with ${state.basePoints.length} rows. Set the altitude reference ` +
        `before generating variants.`,
      'warning'
    );
  } catch (err) {
    reportError(els.status, err, `Could not load "${file.name}"`);
  }
}

/**
 * Parse and take ownership of a source CSV.
 * @param {string} text
 * @param {string} label
 */
function adoptCsv(text, label) {
  const { points } = parseTrajectoryCsv(text, label);
  state.basePoints = points;
  state.sourceLabel = label;
  // The base name is only ever used to build a human-readable filename; no
  // logic in this toolkit reads meaning back out of a filename.
  state.sourceBaseName = sanitizeFilenamePart(
    label.split('/').pop().replace(/\.csv$/i, '')
  );
  state.variants = [];
  state.selectedVariantIndex = null;
  els.downloadAll.disabled = true;

  renderSourceSummary();
  renderVariantTable();
  renderVerification([]);
  renderPreview();
  renderContext();
}

/** Keep the context bar in step with what is loaded. */
function renderContext() {
  setContext(els.ctxSource, state.sourceLabel, 'nothing loaded');
  setContext(els.ctxRows, state.basePoints === null ? null : String(state.basePoints.length), '—');
  setContext(els.ctxAltRef, els.sourceAltRef.value || null);
}

// --- sweep ------------------------------------------------------------------

function generateVariants() {
  try {
    if (state.basePoints === null) {
      setStatus(els.status, 'Load a trajectory CSV first.', 'warning');
      return;
    }
    if (!ALTITUDE_REFERENCES.includes(els.sourceAltRef.value)) {
      setStatus(
        els.status,
        'Choose the altitude reference of the source file before generating variants.',
        'error'
      );
      return;
    }

    const altitudes = planAltitudes();
    state.variants = altitudes.map((altitudeM) => buildVariant(altitudeM));
    state.selectedVariantIndex = state.variants.length > 0 ? 0 : null;

    const failed = state.variants.filter((variant) => !variant.ok);
    els.downloadAll.disabled = state.variants.length === 0 || failed.length > 0;

    renderVariantTable();
    renderVerification(state.variants.flatMap((variant) => variant.findings));
    renderPreview();

    if (failed.length === 0) {
      setStatus(
        els.status,
        `Generated and verified ${state.variants.length} variant(s): only the altitude column ` +
          `differs from the source.`,
        'ok'
      );
    } else {
      setStatus(
        els.status,
        `${failed.length} of ${state.variants.length} variant(s) failed verification and cannot ` +
          `be downloaded. See the findings below.`,
        'error'
      );
    }
  } catch (err) {
    reportError(els.status, err, 'Could not generate the sweep');
  }
}

/**
 * Work out the altitudes of the sweep.
 * @returns {number[]}
 */
function planAltitudes() {
  const start = readNumberInput(els.startAlt);
  const end = readNumberInput(els.endAlt);
  const step = readNumberInput(els.stepAlt);

  if (start === null) throw new Error('Start altitude must be a number.');
  if (end === null) throw new Error('End altitude must be a number.');
  if (step === null || step <= 0) throw new Error('Step must be a positive number of metres.');

  if (start === end) return [round(start)];

  const direction = end > start ? 1 : -1;
  const span = Math.abs(end - start);
  const count = Math.floor(span / step + 1e-9) + 1;
  if (count > MAX_VARIANTS) {
    throw new Error(
      `That sweep would produce ${count} variants; the limit is ${MAX_VARIANTS}. ` +
        `Use a larger step or a narrower range.`
    );
  }

  const altitudes = [];
  for (let i = 0; i < count; i += 1) {
    altitudes.push(round(start + direction * step * i));
  }
  // Include the end altitude when the step does not divide the span exactly,
  // so the requested range is always covered end to end.
  const last = altitudes[altitudes.length - 1];
  if (Math.abs(last - end) > 10 ** -ALTITUDE_DECIMALS / 2) {
    altitudes.push(round(end));
  }
  return altitudes;
}

/**
 * Build one variant and verify it through a full CSV round trip.
 * @param {number} altitudeM
 */
function buildVariant(altitudeM) {
  const points = withAltitude(state.basePoints, altitudeM);
  const csv = trajectoryToCsv(points);
  const filename = `${state.sourceBaseName}_alt${formatAltitudeForName(altitudeM)}m.csv`;

  // Round trip: verify the text that will be written, not the objects in memory.
  const { points: reparsed } = parseTrajectoryCsv(csv, filename);
  const { ok, findings } = verifyAltitudeVariant(state.basePoints, reparsed, altitudeM);

  return { altitudeM, csv, points: reparsed, ok, findings, filename };
}

function formatAltitudeForName(altitudeM) {
  const text = altitudeM.toFixed(ALTITUDE_DECIMALS).replace(/\.?0+$/, '');
  return text.replace('.', 'p').replace('-', 'minus');
}

// --- download ---------------------------------------------------------------

/** @param {number} index */
function downloadVariant(index) {
  const variant = state.variants[index];
  if (!variant) return;
  if (!variant.ok) {
    setStatus(
      els.status,
      `"${variant.filename}" failed verification and will not be downloaded.`,
      'error'
    );
    return;
  }
  downloadText(variant.filename, variant.csv, 'text/csv;charset=utf-8');
  setStatus(els.status, `Downloaded "${variant.filename}".`, 'ok');
}

/**
 * Download every verified variant plus a manifest describing the sweep.
 *
 * The manifest exists because the CSV files cannot record their own altitude
 * reference or source; without it a folder of variants is ambiguous.
 */
function downloadAll() {
  if (state.variants.length === 0) {
    setStatus(els.status, 'Generate the variants first.', 'warning');
    return;
  }
  const failed = state.variants.filter((variant) => !variant.ok);
  if (failed.length > 0) {
    setStatus(
      els.status,
      `Refusing to download: ${failed.length} variant(s) failed verification.`,
      'error'
    );
    return;
  }

  state.variants.forEach((variant, index) => {
    setTimeout(
      () => downloadText(variant.filename, variant.csv, 'text/csv;charset=utf-8'),
      index * MULTI_DOWNLOAD_INTERVAL_MS
    );
  });

  const manifest = {
    schema_version: 1,
    generated_by: 'uav-mission-toolkit altitude_sweep',
    generated_utc: new Date().toISOString(),
    source_file: state.sourceLabel,
    source_row_count: state.basePoints.length,
    altitude_reference: els.sourceAltRef.value,
    frame: 'local_enu',
    heading_reference: 'true_north',
    variants: state.variants.map((variant) => ({
      filename: variant.filename,
      altitude_m: variant.altitudeM,
      row_count: variant.points.length,
      verified: variant.ok,
    })),
  };
  setTimeout(
    () => downloadJson(`${state.sourceBaseName}_altitude_sweep.json`, manifest),
    state.variants.length * MULTI_DOWNLOAD_INTERVAL_MS
  );

  setStatus(
    els.status,
    `Downloading ${state.variants.length} variant(s) and a sweep manifest. Your browser may ask ` +
      `for permission to save multiple files.`,
    'ok'
  );
}

// --- rendering --------------------------------------------------------------

function renderSourceSummary() {
  clear(els.sourceSummary);
  if (state.basePoints === null) {
    els.sourceSummary.append(
      el('p', { class: 'panel__hint', text: 'No source trajectory loaded yet.' })
    );
    return;
  }

  const points = state.basePoints;
  const bounds = boundingBox(points);
  const altitudes = [...new Set(points.map((point) => point.altitude_m))];
  const speeds = [...new Set(points.map((point) => point.speed_mps))];
  const reference = els.sourceAltRef.value;

  els.sourceSummary.append(
    definitionList([
      ['Rows', String(points.length)],
      [
        'Altitude reference',
        reference === '' ? 'not set — choose one above' : reference,
      ],
      [
        'Source altitudes',
        altitudes.length <= 4 ? altitudes.join(', ') : `${altitudes.length} distinct values`,
      ],
      ['Speeds', speeds.length <= 4 ? speeds.join(', ') : `${speeds.length} distinct values`],
      ['Extent east', bounds ? formatMeters(bounds.width_m) : NO_VALUE],
      ['Extent north', bounds ? formatMeters(bounds.height_m) : NO_VALUE],
      ['Open path length', formatMeters(pathLengthM(points, { closed: false, threeD: true }))],
    ])
  );
  els.sourceSummary.append(
    el('p', {
      class: 'panel__hint',
      text:
        'The path length assumes an open path: whether the trajectory closes is recorded in the ' +
        'JSON document, not in the CSV.',
    })
  );
}

function renderVariantTable() {
  clear(els.variantRows);
  if (state.variants.length === 0) {
    els.variantRows.append(
      el('tr', {}, [
        el('td', {
          colspan: '5',
          class: 'is-empty',
          text: 'No variants yet. Set a range and choose "Generate variants".',
        }),
      ])
    );
    return;
  }

  state.variants.forEach((variant, index) => {
    const row = el('tr', {
      class: index === state.selectedVariantIndex ? 'is-selected' : '',
      onClick: () => {
        state.selectedVariantIndex = index;
        renderVariantTable();
        renderPreview();
      },
    });
    row.append(el('td', { class: 'num', text: String(variant.altitudeM) }));
    row.append(el('td', { class: 'num', text: String(variant.points.length) }));
    row.append(
      el('td', {}, [
        el('span', {
          class: variant.ok ? 'badge badge--ok' : 'badge badge--error',
          text: variant.ok ? 'verified' : `${variant.findings.length} problem(s)`,
        }),
      ])
    );
    row.append(el('td', { class: 'mono', text: variant.filename }));

    const button = el('button', {
      type: 'button',
      text: 'Download',
      onClick: (event) => {
        event.stopPropagation();
        downloadVariant(index);
      },
    });
    button.disabled = !variant.ok;
    row.append(el('td', {}, [button]));

    els.variantRows.append(row);
  });
}

function renderVerification(findings) {
  renderVerdict(
    els.ctxVerdict,
    state.variants.length === 0
      ? { level: 'idle', glyph: '·', text: 'Nothing generated' }
      : {
          ...summarizeFindings(findings),
          ...(findings.length === 0
            ? { text: `${state.variants.length} variants verified` }
            : {}),
        }
  );
  renderFindings(els.verification, findings, {
    emptyMessage:
      state.variants.length === 0
        ? 'Nothing verified yet.'
        : 'Every variant matches the source except for the altitude column.',
  });
}

function renderPreview() {
  clear(els.previewRows);
  const variant =
    state.selectedVariantIndex === null ? null : state.variants[state.selectedVariantIndex];

  if (variant === undefined || variant === null) {
    els.previewLabel.textContent = 'Select a variant to preview it.';
    return;
  }

  const shown = variant.points.slice(0, PREVIEW_ROW_LIMIT);
  els.previewLabel.textContent =
    `${variant.filename} — showing ${shown.length} of ${variant.points.length} rows ` +
    `(altitude ${variant.altitudeM} m ${els.sourceAltRef.value || 'reference not set'}).`;

  shown.forEach((point, index) => {
    const base = state.basePoints[index];
    const altitudeChanged = base !== undefined && base.altitude_m !== point.altitude_m;
    els.previewRows.append(
      el('tr', {}, [
        el('td', { class: 'num', text: String(index + 1) }),
        el('td', { class: 'num', text: numberToInput(point.east_m) }),
        el('td', { class: 'num', text: numberToInput(point.north_m) }),
        el('td', {
          class: altitudeChanged ? 'num cell--changed' : 'num',
          text: numberToInput(point.altitude_m),
        }),
        el('td', { class: 'num', text: numberToInput(point.heading_deg) }),
        el('td', { class: 'num', text: numberToInput(point.speed_mps) }),
      ])
    );
  });
}

function round(value) {
  const factor = 10 ** ALTITUDE_DECIMALS;
  return Math.round(value * factor) / factor;
}
