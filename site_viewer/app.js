/**
 * Site viewer: read-only counterpart of the site editor.
 *
 * It shares the map rendering (shared/js/site_map.js) and the validation rules
 * (shared/js/validation.js) with the editor, so a file that looks acceptable
 * here is exactly the file the editor considers acceptable. The only difference
 * is that nothing on this page writes to the loaded object.
 */

import { enuToGeodetic, polygonPerimeterM } from '../shared/js/geo.js';
import { fetchJson, parseJson, readFileAsText } from '../shared/js/io.js';
import { SiteMapView } from '../shared/js/site_map.js';
import {
  hasErrors,
  severityCounts,
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
  installGlobalErrorHandlers,
  must,
  renderFindings,
  reportError,
  setStatus,
} from '../shared/js/ui.js';

const MANIFEST_URL = '../examples/manifest.json';

const state = {
  /** @type {object|null} */
  site: null,
  /** @type {SiteMapView|null} */
  mapView: null,
  /** @type {URL|null} */
  manifestUrl: null,
  /** @type {Array<object>} */
  manifestSites: [],
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  installGlobalErrorHandlers(els.status);
  wireEvents();
  initMap();
  loadManifest();
});

function cacheElements() {
  els.status = must('#status');
  els.sourceLabel = must('#source-label');
  els.exampleSelect = must('#example-select');
  els.loadExample = must('#load-example');
  els.siteFile = must('#site-file');
  els.siteSummary = must('#site-summary');
  els.statistics = must('#statistics');
  els.validationCounts = must('#validation-counts');
  els.validation = must('#validation');
  els.missionRows = must('#mission-rows');
  els.map = must('#map');
}

function wireEvents() {
  els.loadExample.addEventListener('click', () => loadSelectedExample());
  els.siteFile.addEventListener('change', (event) => {
    const [file] = event.target.files ?? [];
    if (file) loadSiteFromFile(file);
  });
}

function initMap() {
  try {
    state.mapView = new SiteMapView(els.map, {
      editable: false,
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

// --- loading ----------------------------------------------------------------

async function loadManifest() {
  try {
    state.manifestUrl = new URL(MANIFEST_URL, window.location.href);
    const manifest = await fetchJson(state.manifestUrl.href);
    state.manifestSites = Array.isArray(manifest?.sites) ? manifest.sites : [];

    clear(els.exampleSelect);
    if (state.manifestSites.length === 0) {
      els.exampleSelect.append(el('option', { value: '', text: 'no examples listed' }));
      els.loadExample.disabled = true;
      setStatus(els.status, 'examples/manifest.json lists no sites.', 'warning');
      return;
    }
    state.manifestSites.forEach((entry, index) => {
      els.exampleSelect.append(
        el('option', { value: String(index), text: entry.name ?? entry.id ?? entry.site_path })
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
    const entry = state.manifestSites[Number(els.exampleSelect.value)];
    if (!entry?.site_path) {
      throw new Error('The selected manifest entry has no "site_path".');
    }
    const siteUrl = new URL(entry.site_path, state.manifestUrl);
    const site = await fetchJson(siteUrl.href);
    adoptSite(site, `examples/${entry.site_path}`);
  } catch (err) {
    reportError(els.status, err, 'Could not load the example site');
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

function adoptSite(site, sourceLabel) {
  if (site === null || typeof site !== 'object' || Array.isArray(site)) {
    throw new Error(`"${sourceLabel}" does not contain a site object.`);
  }
  state.site = site;
  els.sourceLabel.textContent = sourceLabel;

  const findings = validateSite(site);
  renderSummary(site);
  renderStatistics(site);
  renderValidation(findings);
  renderMissionTable(site);
  if (state.mapView !== null) state.mapView.setSite(site, { fit: true });

  // Asked for rather than pushed: a tile failure usually lands before the file
  // finishes loading, and would otherwise be overwritten by this message.
  const tileNote = state.mapView?.tileNote() ?? '';
  const invalid = hasErrors(findings);
  setStatus(
    els.status,
    invalid
      ? `Loaded "${sourceLabel}". The definition has validation errors, see below.${tileNote}`
      : `Loaded "${sourceLabel}". No validation errors.${tileNote}`,
    invalid || tileNote !== '' ? 'warning' : 'ok'
  );
}

// --- rendering --------------------------------------------------------------

function renderSummary(site) {
  const origin = site.origin ?? {};
  clear(els.siteSummary);
  els.siteSummary.append(
    definitionList([
      ['Name', typeof site.name === 'string' ? site.name : NO_VALUE],
      ['Schema version', String(site.schema_version ?? NO_VALUE)],
      ['Origin latitude', formatLatLon(origin.latitude_deg)],
      ['Origin longitude', formatLatLon(origin.longitude_deg)],
      [
        'Origin altitude',
        Number.isFinite(origin.altitude_amsl_m)
          ? `${formatMeters(origin.altitude_amsl_m)} AMSL`
          : NO_VALUE,
      ],
      ['Local frame', site.local_frame?.type ?? NO_VALUE],
      ['Heading reference', site.local_frame?.heading_reference ?? NO_VALUE],
    ])
  );
  if (typeof site.description === 'string' && site.description.trim() !== '') {
    els.siteSummary.append(el('p', { class: 'panel__hint', text: site.description }));
  }
}

function renderStatistics(site) {
  const stats = siteStatistics(site);
  const ring = Array.isArray(site.safety_area?.horizontal) ? site.safety_area.horizontal : [];
  const usableRing = ring.filter(
    (vertex) => Number.isFinite(vertex?.east_m) && Number.isFinite(vertex?.north_m)
  );
  const bounds = stats.bounds;
  const safety = site.safety_area ?? {};

  clear(els.statistics);
  els.statistics.append(
    definitionList([
      ['Polygon vertices', String(stats.vertexCount)],
      ['Polygon area', stats.areaM2 === null ? NO_VALUE : formatArea(stats.areaM2)],
      [
        'Polygon perimeter',
        usableRing.length >= 3 ? formatMeters(polygonPerimeterM(usableRing)) : NO_VALUE,
      ],
      ['Extent east', bounds ? formatMeters(bounds.width_m) : NO_VALUE],
      ['Extent north', bounds ? formatMeters(bounds.height_m) : NO_VALUE],
      [
        'East range',
        bounds
          ? `${formatMeters(bounds.min_east_m)} … ${formatMeters(bounds.max_east_m)}`
          : NO_VALUE,
      ],
      [
        'North range',
        bounds
          ? `${formatMeters(bounds.min_north_m)} … ${formatMeters(bounds.max_north_m)}`
          : NO_VALUE,
      ],
      [
        'Altitude limits',
        Number.isFinite(safety.min_altitude_m) && Number.isFinite(safety.max_altitude_m)
          ? `${safety.min_altitude_m} … ${safety.max_altitude_m} m ` +
            `${safety.altitude_reference ?? '(reference not set)'}`
          : NO_VALUE,
      ],
      ['Mission points', String(stats.missionPointCount)],
    ])
  );
}

function renderValidation(findings) {
  const counts = severityCounts(findings);
  clear(els.validationCounts);
  els.validationCounts.append(
    el('span', { text: `${counts.error} error(s)` }),
    el('span', { text: `${counts.warning} warning(s)` }),
    el('span', { text: `${counts.info} note(s)` })
  );
  renderFindings(els.validation, findings, {
    emptyMessage: 'The site definition satisfies every rule in shared/js/validation.js.',
  });
}

function renderMissionTable(site) {
  clear(els.missionRows);
  const points = Array.isArray(site.mission_points) ? site.mission_points : [];
  if (points.length === 0) {
    els.missionRows.append(
      el('tr', {}, [el('td', { colspan: '8', text: 'No mission points defined.' })])
    );
    return;
  }

  const origin = site.origin ?? {};
  const canProject =
    Number.isFinite(origin.latitude_deg) && Number.isFinite(origin.longitude_deg);

  for (const point of points) {
    let latitude = NO_VALUE;
    let longitude = NO_VALUE;
    if (canProject && Number.isFinite(point?.east_m) && Number.isFinite(point?.north_m)) {
      const geo = enuToGeodetic(origin, point);
      latitude = formatLatLon(geo.latitude_deg);
      longitude = formatLatLon(geo.longitude_deg);
    }
    els.missionRows.append(
      el('tr', {}, [
        el('td', { text: point?.id ?? NO_VALUE }),
        el('td', { class: 'num', text: numberText(point?.east_m) }),
        el('td', { class: 'num', text: numberText(point?.north_m) }),
        el('td', { class: 'num', text: numberText(point?.altitude_m) }),
        el('td', { text: point?.altitude_reference ?? NO_VALUE }),
        el('td', { class: 'num', text: numberText(point?.heading_deg) }),
        el('td', { class: 'num', text: latitude }),
        el('td', { class: 'num', text: longitude }),
      ])
    );
  }
}

function numberText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : NO_VALUE;
}
