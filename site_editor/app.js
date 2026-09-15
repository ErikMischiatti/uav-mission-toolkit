/**
 * Site editor.
 *
 * Owns one mutable site object. Every user action (form input, table edit, map
 * drag) writes into that object and then re-runs the shared validator, so what
 * the validation panel says is always true of what the download button would
 * produce.
 *
 * Deliberate behaviour worth knowing about:
 *  - An emptied or unparseable numeric field becomes null, not 0. Validation
 *    then reports it. Nothing in this file substitutes a plausible value.
 *  - A newly added mission point has no altitude and no altitude reference.
 *    The user has to choose them.
 */

import { enuToGeodetic, verticesMean } from '../shared/js/geo.js';
import {
  downloadJson,
  fetchJson,
  parseJson,
  readFileAsText,
  sanitizeFilenamePart,
} from '../shared/js/io.js';
import { SiteMapView } from '../shared/js/site_map.js';
import {
  ALTITUDE_REFERENCES,
  HEADING_REFERENCES,
  LOCAL_FRAME_TYPES,
  SITE_SCHEMA_VERSION,
  hasErrors,
  siteStatistics,
  validateSite,
} from '../shared/js/validation.js';
import {
  NO_VALUE,
  clear,
  definitionList,
  el,
  formatArea,
  formatLatLon,
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

/** Example index. The toolkit never scrapes an HTTP directory listing. */
const MANIFEST_URL = '../examples/manifest.json';
/** A polygon needs three vertices; the delete button is disabled at that point. */
const MIN_POLYGON_VERTICES = 3;
/** Decimals kept for local coordinates written to file: 1 mm. */
const COORDINATE_DECIMALS = 3;

const state = {
  /** @type {object|null} */
  site: null,
  sourceLabel: 'nothing yet',
  /** @type {SiteMapView|null} */
  mapView: null,
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  installGlobalErrorHandlers(els.status);
  installHelp();
  populateSelects();
  wireEvents();
  initMap();
  loadDemoSite();
});

function cacheElements() {
  els.status = must('#status');
  els.loadDemo = must('#load-demo');
  els.downloadSite = must('#download-site');
  els.siteFile = must('#site-file');

  els.siteName = must('#site-name');
  els.originLat = must('#origin-lat');
  els.originLon = must('#origin-lon');
  els.originAlt = must('#origin-alt');
  els.frameType = must('#frame-type');
  els.frameHeadingRef = must('#frame-heading-ref');

  els.minAlt = must('#min-alt');
  els.maxAlt = must('#max-alt');
  els.altRef = must('#alt-ref');
  els.vertexRows = must('#vertex-rows');
  els.addVertex = must('#add-vertex');

  els.missionRows = must('#mission-rows');
  els.addMissionPoint = must('#add-mission-point');

  els.validation = must('#validation');
  els.statistics = must('#statistics');
  els.map = must('#map');
  els.fitView = must('#fit-view');

  els.ctxSource = must('#ctx-source');
  els.ctxFrame = must('#ctx-frame');
  els.ctxAltRef = must('#ctx-altref');
  els.ctxVerdict = must('#ctx-verdict');
}

/**
 * Attach the `?` explanations for the jargon this tool cannot avoid. The text
 * lives in shared/js/ui.js so every tool defines ENU and AGL the same way.
 */
function installHelp() {
  must('#help-enu').append(helpFor('ENU'));
  must('#help-heading').append(helpFor('heading'));
  must('#help-altref').append(helpFor('AGL'));
}

function populateSelects() {
  fillSelect(els.altRef, ALTITUDE_REFERENCES, 'select a reference');
  fillSelect(els.frameType, LOCAL_FRAME_TYPES, 'select a frame');
  fillSelect(els.frameHeadingRef, HEADING_REFERENCES, 'select a reference');
}

/**
 * Populate a <select>. The blank first option exists so that a missing value
 * shows up as missing instead of silently becoming the first valid choice.
 */
function fillSelect(select, values, placeholder) {
  clear(select);
  select.append(el('option', { value: '', text: `— ${placeholder} —` }));
  for (const value of values) {
    select.append(el('option', { value, text: value }));
  }
}

function wireEvents() {
  els.loadDemo.addEventListener('click', () => loadDemoSite());
  els.downloadSite.addEventListener('click', () => downloadSite());
  els.siteFile.addEventListener('change', (event) => {
    const [file] = event.target.files ?? [];
    if (file) loadSiteFromFile(file);
  });

  els.siteName.addEventListener('input', () => {
    if (state.site === null) return;
    state.site.name = els.siteName.value;
    refresh({ rebuildTables: false });
  });

  bindNumber(els.originLat, (value) => {
    state.site.origin.latitude_deg = value;
  });
  bindNumber(els.originLon, (value) => {
    state.site.origin.longitude_deg = value;
  });
  bindNumber(els.originAlt, (value) => {
    state.site.origin.altitude_amsl_m = value;
  });

  els.frameType.addEventListener('change', () => {
    if (state.site === null) return;
    state.site.local_frame.type = els.frameType.value || null;
    refresh({ rebuildTables: false });
  });
  els.frameHeadingRef.addEventListener('change', () => {
    if (state.site === null) return;
    state.site.local_frame.heading_reference = els.frameHeadingRef.value || null;
    refresh({ rebuildTables: false });
  });

  bindNumber(els.minAlt, (value) => {
    state.site.safety_area.min_altitude_m = value;
  });
  bindNumber(els.maxAlt, (value) => {
    state.site.safety_area.max_altitude_m = value;
  });
  els.altRef.addEventListener('change', () => {
    if (state.site === null) return;
    state.site.safety_area.altitude_reference = els.altRef.value || null;
    refresh({ rebuildTables: true });
  });

  els.addVertex.addEventListener('click', () => {
    if (state.site !== null) addVertex();
  });
  els.addMissionPoint.addEventListener('click', () => {
    if (state.site !== null) addMissionPoint();
  });
  els.fitView.addEventListener('click', () => state.mapView?.fit());
}

/**
 * Wire a numeric input so that an empty or unparseable value becomes null.
 * @param {HTMLInputElement} input
 * @param {(value: number|null) => void} apply
 * @param {{rebuildTables?: boolean}} [options]
 */
function bindNumber(input, apply, options = {}) {
  input.addEventListener('input', () => {
    if (state.site === null) return;
    apply(readNumberInput(input));
    refresh({ rebuildTables: options.rebuildTables ?? false });
  });
}

// --- loading ----------------------------------------------------------------

async function loadDemoSite() {
  try {
    setStatus(els.status, 'Loading the demo site…', 'info');
    const manifestUrl = new URL(MANIFEST_URL, window.location.href);
    const manifest = await fetchJson(manifestUrl.href);
    const entry = Array.isArray(manifest?.sites) ? manifest.sites[0] : undefined;
    if (!entry?.site_path) {
      throw new Error('examples/manifest.json does not list any site.');
    }
    const siteUrl = new URL(entry.site_path, manifestUrl);
    const site = await fetchJson(siteUrl.href);
    adoptSite(site, `examples/${entry.site_path}`);
  } catch (err) {
    reportError(els.status, err, 'Could not load the demo site');
  }
}

/** @param {File} file */
async function loadSiteFromFile(file) {
  try {
    const text = await readFileAsText(file);
    adoptSite(parseJson(text, file.name), file.name);
  } catch (err) {
    reportError(els.status, err, `Could not load "${file.name}"`);
  }
}

/**
 * Take ownership of a parsed site document.
 * @param {unknown} site
 * @param {string} sourceLabel
 */
function adoptSite(site, sourceLabel) {
  if (site === null || typeof site !== 'object' || Array.isArray(site)) {
    throw new Error(`"${sourceLabel}" does not contain a site object.`);
  }
  state.site = ensureContainers(site);
  state.sourceLabel = sourceLabel;
  setContext(els.ctxSource, sourceLabel);
  renderFields();
  refresh({ rebuildTables: true, fitMap: true });

  // The tile state is asked for rather than pushed, because a tile failure
  // usually happens before the file finishes loading and would otherwise be
  // overwritten by this very message.
  const tileNote = state.mapView?.tileNote() ?? '';
  const findings = validateSite(state.site);
  if (hasErrors(findings)) {
    setStatus(
      els.status,
      `Loaded "${sourceLabel}" with validation errors, see below.${tileNote}`,
      'warning'
    );
  } else if (tileNote !== '') {
    setStatus(els.status, `Loaded "${sourceLabel}".${tileNote}`, 'warning');
  } else {
    setStatus(els.status, `Loaded "${sourceLabel}".`, 'ok');
  }
}

/**
 * Make sure the containers the editor writes into exist, so that a malformed
 * file can still be opened and repaired in the UI.
 *
 * This creates empty objects/arrays only. It never fills in a value: a missing
 * altitude stays missing and is reported by the validator.
 *
 * @param {object} site
 * @returns {object}
 */
function ensureContainers(site) {
  if (typeof site.origin !== 'object' || site.origin === null) site.origin = {};
  if (typeof site.local_frame !== 'object' || site.local_frame === null) site.local_frame = {};
  if (typeof site.safety_area !== 'object' || site.safety_area === null) site.safety_area = {};
  if (!Array.isArray(site.safety_area.horizontal)) site.safety_area.horizontal = [];
  if (!Array.isArray(site.mission_points)) site.mission_points = [];
  return site;
}

// --- rendering --------------------------------------------------------------

/**
 * @param {{rebuildTables?: boolean, fitMap?: boolean}} [options]
 */
function refresh(options = {}) {
  const { rebuildTables = true, fitMap = false } = options;
  if (state.site === null) return;
  if (rebuildTables) {
    renderVertexTable();
    renderMissionTable();
  }
  renderValidation();
  renderStatistics();
  updateMap(fitMap);
}

/** Write the current site into the form controls. Only called on load. */
function renderFields() {
  const site = state.site;
  els.siteName.value = typeof site.name === 'string' ? site.name : '';
  els.originLat.value = numberToInput(site.origin.latitude_deg);
  els.originLon.value = numberToInput(site.origin.longitude_deg);
  els.originAlt.value = numberToInput(site.origin.altitude_amsl_m);
  els.frameType.value = LOCAL_FRAME_TYPES.includes(site.local_frame.type)
    ? site.local_frame.type
    : '';
  els.frameHeadingRef.value = HEADING_REFERENCES.includes(site.local_frame.heading_reference)
    ? site.local_frame.heading_reference
    : '';
  els.minAlt.value = numberToInput(site.safety_area.min_altitude_m);
  els.maxAlt.value = numberToInput(site.safety_area.max_altitude_m);
  els.altRef.value = ALTITUDE_REFERENCES.includes(site.safety_area.altitude_reference)
    ? site.safety_area.altitude_reference
    : '';
}

function renderVertexTable() {
  const ring = state.site.safety_area.horizontal;
  clear(els.vertexRows);

  ring.forEach((vertex, index) => {
    const row = el('tr');
    row.append(el('td', { class: 'mono', text: String(index) }));
    row.append(el('td', { class: 'num' }, [numberCell(vertex.east_m, (value) => {
      vertex.east_m = value;
      refresh({ rebuildTables: false });
    })]));
    row.append(el('td', { class: 'num' }, [numberCell(vertex.north_m, (value) => {
      vertex.north_m = value;
      refresh({ rebuildTables: false });
    })]));

    const remove = el('button', {
      type: 'button',
      class: 'quiet row-remove',
      text: '\u00d7',
      // The visible label is a glyph to keep the table narrow, so the
      // accessible name has to carry the meaning instead.
      'aria-label': `Remove vertex ${index}`,
      title: ring.length <= MIN_POLYGON_VERTICES
        ? `A polygon needs at least ${MIN_POLYGON_VERTICES} vertices.`
        : `Remove vertex ${index}`,
      onClick: () => {
        ring.splice(index, 1);
        refresh({ rebuildTables: true });
      },
    });
    remove.disabled = ring.length <= MIN_POLYGON_VERTICES;
    row.append(el('td', {}, [remove]));

    els.vertexRows.append(row);
  });

  if (ring.length === 0) {
    els.vertexRows.append(
      el('tr', {}, [
        el('td', { colspan: '4', class: 'is-empty', text: 'No vertices yet — add at least three.' }),
      ])
    );
  }
}

function renderMissionTable() {
  const points = state.site.mission_points;
  clear(els.missionRows);

  points.forEach((point, index) => {
    const row = el('tr');

    const idInput = el('input', { type: 'text', value: point.id ?? '', size: '10' });
    idInput.addEventListener('input', () => {
      point.id = idInput.value;
      refresh({ rebuildTables: false });
    });
    row.append(el('td', {}, [idInput]));

    row.append(el('td', { class: 'num' }, [numberCell(point.east_m, (value) => {
      point.east_m = value;
      refresh({ rebuildTables: false });
    })]));
    row.append(el('td', { class: 'num' }, [numberCell(point.north_m, (value) => {
      point.north_m = value;
      refresh({ rebuildTables: false });
    })]));
    row.append(el('td', { class: 'num' }, [numberCell(point.altitude_m, (value) => {
      point.altitude_m = value;
      refresh({ rebuildTables: false });
    })]));

    const refSelect = el('select');
    fillSelect(refSelect, ALTITUDE_REFERENCES, 'not set');
    refSelect.value = ALTITUDE_REFERENCES.includes(point.altitude_reference)
      ? point.altitude_reference
      : '';
    refSelect.addEventListener('change', () => {
      point.altitude_reference = refSelect.value || null;
      refresh({ rebuildTables: false });
    });
    row.append(el('td', {}, [refSelect]));

    // An empty heading field means "unspecified", which the validator reports
    // as information rather than substituting 0 degrees.
    row.append(el('td', { class: 'num' }, [numberCell(point.heading_deg, (value) => {
      point.heading_deg = value;
      refresh({ rebuildTables: false });
    })]));

    row.append(el('td', {}, [
      el('button', {
        type: 'button',
        class: 'quiet row-remove',
        text: '\u00d7',
        'aria-label': `Remove mission point ${point.id ?? index}`,
        title: `Remove mission point ${point.id ?? index}`,
        onClick: () => {
          points.splice(index, 1);
          refresh({ rebuildTables: true });
        },
      }),
    ]));

    els.missionRows.append(row);
  });

  if (points.length === 0) {
    els.missionRows.append(
      el('tr', {}, [
        el('td', { colspan: '7', class: 'is-empty', text: 'No mission points defined.' }),
      ])
    );
  }
}

/**
 * A numeric table cell input. Empty input yields null.
 * @param {unknown} value
 * @param {(value: number|null) => void} apply
 */
function numberCell(value, apply) {
  const input = el('input', {
    type: 'number',
    step: 'any',
    class: 'num',
    value: numberToInput(value),
    size: '8',
  });
  input.addEventListener('input', () => apply(readNumberInput(input)));
  return input;
}

/**
 * Re-render validation, the context bar verdict, and the frame/altitude context.
 *
 * The verdict is duplicated into the context bar so that the answer to "is this
 * file safe to export?" is visible without scrolling the sidebar to the
 * validation panel.
 */
function renderValidation() {
  const findings = validateSite(state.site);

  renderVerdict(els.ctxVerdict, summarizeFindings(findings, { idle: state.site === null }));
  renderFindings(els.validation, findings, {
    emptyMessage: 'No findings. Every rule in shared/js/validation.js passes.',
  });

  const frame = state.site?.local_frame?.type;
  setContext(els.ctxFrame, frame ? `${frame} · metres` : null);
  setContext(els.ctxAltRef, state.site?.safety_area?.altitude_reference ?? null);
}

function renderStatistics() {
  const site = state.site;
  const stats = siteStatistics(site);
  clear(els.statistics);

  const bounds = stats.bounds;
  els.statistics.append(
    definitionList([
      ['Polygon vertices', String(stats.vertexCount)],
      ['Polygon area', stats.areaM2 === null ? NO_VALUE : formatArea(stats.areaM2)],
      ['Extent east', bounds ? formatMeters(bounds.width_m) : NO_VALUE],
      ['Extent north', bounds ? formatMeters(bounds.height_m) : NO_VALUE],
      [
        'Altitude band',
        stats.altitudeBandM === null
          ? NO_VALUE
          : `${formatMeters(stats.altitudeBandM)} (${site.safety_area.altitude_reference ?? 'reference not set'})`,
      ],
      ['Mission points', String(stats.missionPointCount)],
    ])
  );

  els.statistics.append(el('h3', { text: 'Mission points in WGS84' }));
  const canProject =
    Number.isFinite(site.origin.latitude_deg) && Number.isFinite(site.origin.longitude_deg);
  if (!canProject) {
    els.statistics.append(
      el('p', {
        class: 'panel__hint',
        text: 'A valid origin latitude and longitude are required to project local coordinates.',
      })
    );
    return;
  }

  const table = el('table', { class: 'data' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'id' }),
        el('th', { class: 'num', text: 'latitude_deg' }),
        el('th', { class: 'num', text: 'longitude_deg' }),
      ]),
    ]),
  ]);
  const body = el('tbody');
  for (const point of site.mission_points) {
    let latitude = NO_VALUE;
    let longitude = NO_VALUE;
    if (Number.isFinite(point.east_m) && Number.isFinite(point.north_m)) {
      const geo = enuToGeodetic(site.origin, point);
      latitude = formatLatLon(geo.latitude_deg);
      longitude = formatLatLon(geo.longitude_deg);
    }
    body.append(
      el('tr', {}, [
        el('td', { text: point.id ?? NO_VALUE }),
        el('td', { class: 'num', text: latitude }),
        el('td', { class: 'num', text: longitude }),
      ])
    );
  }
  table.append(body);
  els.statistics.append(el('div', { class: 'table-scroll' }, [table]));
}

// --- map --------------------------------------------------------------------

function initMap() {
  try {
    state.mapView = new SiteMapView(els.map, {
      editable: true,
      onMissionPointMoved: (id, enu) => {
        const point = state.site?.mission_points.find((candidate) => candidate.id === id);
        if (!point) return;
        point.east_m = enu.east_m;
        point.north_m = enu.north_m;
        refresh({ rebuildTables: true });
      },
      onVertexMoved: (index, enu) => {
        const vertex = state.site?.safety_area.horizontal[index];
        if (!vertex) return;
        vertex.east_m = enu.east_m;
        vertex.north_m = enu.north_m;
        refresh({ rebuildTables: true });
      },
      onTileError: () => {
        setStatus(
          els.status,
          'Map tiles could not be fetched. Geometry is still drawn on a blank background.',
          'warning'
        );
      },
    });
  } catch (err) {
    state.mapView = null;
    els.map.classList.add('map--unavailable');
    els.map.textContent = err instanceof Error ? err.message : String(err);
    reportError(els.status, err, 'Map unavailable');
  }
}

/**
 * Schedule a map redraw.
 *
 * The redraw is deferred to the next task for two reasons: a drag callback
 * would otherwise destroy the very marker whose Leaflet event is still being
 * dispatched, and typing in a form field would rebuild every layer on each
 * keystroke. Pending requests coalesce, and a requested fit is never lost.
 */
let pendingMapUpdate = null;
let pendingMapFit = false;

function updateMap(fit) {
  if (state.mapView === null) return;
  pendingMapFit = pendingMapFit || fit;
  if (pendingMapUpdate !== null) return;
  pendingMapUpdate = setTimeout(() => {
    const shouldFit = pendingMapFit;
    pendingMapUpdate = null;
    pendingMapFit = false;
    state.mapView.setSite(state.site, { fit: shouldFit });
  }, 0);
}

// --- editing actions --------------------------------------------------------

/**
 * Insert a vertex at the midpoint of the last polygon edge, or at the origin
 * for an empty polygon. A midpoint is a geometric consequence of the existing
 * shape, not an invented safety value.
 */
function addVertex() {
  const ring = state.site.safety_area.horizontal;
  if (ring.length >= 2) {
    const last = ring[ring.length - 1];
    const first = ring[0];
    ring.push({
      east_m: round((last.east_m + first.east_m) / 2),
      north_m: round((last.north_m + first.north_m) / 2),
    });
  } else {
    ring.push({ east_m: 0, north_m: 0 });
  }
  refresh({ rebuildTables: true });
}

/**
 * Add a mission point at the mean of the polygon vertices (or the origin).
 * Altitude, altitude reference and heading are left unset on purpose.
 */
function addMissionPoint() {
  const ring = state.site.safety_area.horizontal;
  const seed = verticesMean(ring) ?? { east_m: 0, north_m: 0 };
  state.site.mission_points.push({
    id: nextPointId(),
    east_m: round(seed.east_m),
    north_m: round(seed.north_m),
    altitude_m: null,
    altitude_reference: null,
    heading_deg: null,
  });
  refresh({ rebuildTables: true });
  setStatus(
    els.status,
    'Mission point added. Set its altitude and altitude reference before exporting.',
    'warning'
  );
}

function nextPointId() {
  const existing = new Set(state.site.mission_points.map((point) => point.id));
  for (let i = 1; ; i += 1) {
    const candidate = `point_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function round(value) {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

// --- export -----------------------------------------------------------------

function downloadSite() {
  try {
    if (state.site === null) {
      setStatus(els.status, 'Nothing to export: load a site first.', 'warning');
      return;
    }
    const findings = validateSite(state.site);
    if (hasErrors(findings)) {
      const proceed = window.confirm(
        'This site definition currently has validation errors and the exported file will be ' +
          'invalid. Download it anyway?'
      );
      if (!proceed) {
        setStatus(els.status, 'Download cancelled; fix the validation errors first.', 'warning');
        return;
      }
    }
    const document_ = buildSiteDocument(state.site);
    const filename = `${sanitizeFilenamePart(state.site.name ?? 'site')}.site.json`;
    downloadJson(filename, document_);
    setStatus(els.status, `Downloaded "${filename}".`, 'ok');
  } catch (err) {
    reportError(els.status, err, 'Export failed');
  }
}

/**
 * Produce the document that gets written to disk: stable key order, local
 * coordinates rounded to millimetres, and nothing invented. Values that are
 * missing in the editor stay missing in the file.
 * @param {object} site
 */
function buildSiteDocument(site) {
  const document_ = {
    schema_version: SITE_SCHEMA_VERSION,
    name: site.name ?? null,
  };
  if (typeof site.description === 'string') document_.description = site.description;
  if (typeof site.created_utc === 'string') document_.created_utc = site.created_utc;

  document_.origin = {
    latitude_deg: keepOrRound(site.origin.latitude_deg, 9),
    longitude_deg: keepOrRound(site.origin.longitude_deg, 9),
    altitude_amsl_m: keepOrRound(site.origin.altitude_amsl_m, COORDINATE_DECIMALS),
  };
  document_.local_frame = {
    type: site.local_frame.type ?? null,
    heading_reference: site.local_frame.heading_reference ?? null,
  };
  document_.safety_area = {
    horizontal: site.safety_area.horizontal.map((vertex) => ({
      east_m: keepOrRound(vertex.east_m, COORDINATE_DECIMALS),
      north_m: keepOrRound(vertex.north_m, COORDINATE_DECIMALS),
    })),
    min_altitude_m: keepOrRound(site.safety_area.min_altitude_m, COORDINATE_DECIMALS),
    max_altitude_m: keepOrRound(site.safety_area.max_altitude_m, COORDINATE_DECIMALS),
    altitude_reference: site.safety_area.altitude_reference ?? null,
  };
  document_.mission_points = site.mission_points.map((point) => ({
    id: point.id ?? null,
    east_m: keepOrRound(point.east_m, COORDINATE_DECIMALS),
    north_m: keepOrRound(point.north_m, COORDINATE_DECIMALS),
    altitude_m: keepOrRound(point.altitude_m, COORDINATE_DECIMALS),
    altitude_reference: point.altitude_reference ?? null,
    heading_deg: keepOrRound(point.heading_deg, 3),
  }));

  return document_;
}

/**
 * Round a finite number; pass anything else through unchanged so that a
 * missing value is visibly missing in the exported file.
 */
function keepOrRound(value, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value ?? null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
