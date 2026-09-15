/**
 * Leaflet rendering of a site definition, shared by the site editor (editable)
 * and the site viewer (read-only).
 *
 * The class knows nothing about either tool's UI: it renders whatever site
 * object it is given and reports drag results back through callbacks. All
 * conversions go through shared/js/geo.js.
 */

import { enuToGeodetic, geodeticToEnu } from './geo.js';
import { roundTo } from './io.js';
import { ensureLeaflet } from './ui.js';

/** Pinned tile source. Tiles require an internet connection. */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TILE_MAX_ZOOM = 19;

/** Zoom used when a site has an origin but no other geometry to fit. */
const FALLBACK_ZOOM = 17;
/** Padding applied when fitting the map to the site geometry, in pixels. */
const FIT_PADDING_PX = 32;

const POLYGON_STYLE = Object.freeze({
  color: '#c2410c',
  weight: 2,
  fillColor: '#f97316',
  fillOpacity: 0.08,
});

export class SiteMapView {
  /**
   * @param {HTMLElement} container
   * @param {{
   *   editable?: boolean,
   *   onMissionPointMoved?: (id: string, enu: {east_m:number,north_m:number}) => void,
   *   onVertexMoved?: (index: number, enu: {east_m:number,north_m:number}) => void,
   *   onTileError?: () => void,
   * }} [options]
   */
  constructor(container, options = {}) {
    this.L = ensureLeaflet();
    this.options = options;
    this.site = null;
    this.tileErrorReported = false;

    this.map = this.L.map(container, {
      zoomControl: true,
      // Keyboard panning would fight with the tool's own keyboard shortcuts.
      keyboard: false,
    });
    // A valid view is required before any layer is added; it is replaced as
    // soon as a site is loaded.
    this.map.setView([0, 0], 2);

    this.tileLayer = this.L.tileLayer(TILE_URL, {
      maxZoom: TILE_MAX_ZOOM,
      attribution: TILE_ATTRIBUTION,
    }).addTo(this.map);

    this.tileLayer.on('tileerror', () => {
      if (this.tileErrorReported) return;
      this.tileErrorReported = true;
      this.options.onTileError?.();
    });

    this.L.control.scale({ imperial: false }).addTo(this.map);

    this.overlay = this.L.layerGroup().addTo(this.map);
  }

  /**
   * Replace the rendered site. Pass null to clear the overlay.
   * @param {object|null} site
   * @param {{fit?: boolean}} [options]
   */
  setSite(site, options = {}) {
    this.site = site;
    this.render();
    if (options.fit !== false) this.fit();
  }

  /** Re-draw the overlay from the current site object. */
  render() {
    this.overlay.clearLayers();
    this.geometryLatLngs = [];

    const origin = this.site?.origin;
    if (!isRenderableOrigin(origin)) return;

    const originLatLng = [origin.latitude_deg, origin.longitude_deg];
    this.geometryLatLngs.push(originLatLng);

    this.#renderSafetyArea(origin);
    this.#renderOrigin(originLatLng);
    this.#renderMissionPoints(origin);
  }

  /** Fit the view to the rendered geometry. */
  fit() {
    if (!this.geometryLatLngs || this.geometryLatLngs.length === 0) return;
    if (this.geometryLatLngs.length === 1) {
      this.map.setView(this.geometryLatLngs[0], FALLBACK_ZOOM);
      return;
    }
    this.map.fitBounds(this.L.latLngBounds(this.geometryLatLngs), {
      padding: [FIT_PADDING_PX, FIT_PADDING_PX],
    });
  }

  /** Leaflet needs a nudge when its container was hidden or resized. */
  invalidateSize() {
    this.map.invalidateSize();
  }

  #renderOrigin(originLatLng) {
    this.L.circleMarker(originLatLng, {
      radius: 7,
      color: '#0f172a',
      weight: 2,
      fillColor: '#38bdf8',
      fillOpacity: 1,
    })
      .bindTooltip('Origin (E 0 m, N 0 m)', { direction: 'top' })
      .addTo(this.overlay);
  }

  #renderSafetyArea(origin) {
    const ring = this.site?.safety_area?.horizontal;
    if (!Array.isArray(ring) || ring.length < 3) return;

    const latLngs = [];
    for (const vertex of ring) {
      if (!Number.isFinite(vertex?.east_m) || !Number.isFinite(vertex?.north_m)) return;
      const geo = enuToGeodetic(origin, vertex);
      latLngs.push([geo.latitude_deg, geo.longitude_deg]);
    }
    this.geometryLatLngs.push(...latLngs);

    const polygon = this.L.polygon(latLngs, POLYGON_STYLE).addTo(this.overlay);
    polygon.bindTooltip('Safety area', { sticky: true });

    if (!this.options.editable || !this.options.onVertexMoved) return;

    latLngs.forEach((latLng, index) => {
      const handle = this.L.marker(latLng, {
        draggable: true,
        keyboard: false,
        icon: this.L.divIcon({
          className: 'map-handle map-handle--vertex',
          iconSize: [12, 12],
          html: '',
        }),
        title: `Safety polygon vertex ${index}`,
      }).addTo(this.overlay);

      handle.on('drag', (event) => {
        // Live feedback: reshape the polygon while the handle is moving.
        const current = polygon.getLatLngs()[0];
        current[index] = event.target.getLatLng();
        polygon.setLatLngs([current]);
      });
      handle.on('dragend', (event) => {
        this.options.onVertexMoved(index, this.#latLngToEnu(origin, event.target.getLatLng()));
      });
    });
  }

  #renderMissionPoints(origin) {
    const points = this.site?.mission_points;
    if (!Array.isArray(points)) return;

    const pathLatLngs = [];
    points.forEach((point) => {
      if (!Number.isFinite(point?.east_m) || !Number.isFinite(point?.north_m)) return;
      const geo = enuToGeodetic(origin, point);
      const latLng = [geo.latitude_deg, geo.longitude_deg];
      pathLatLngs.push(latLng);
      this.geometryLatLngs.push(latLng);

      const draggable = Boolean(this.options.editable && this.options.onMissionPointMoved);
      const marker = this.L.marker(latLng, {
        draggable,
        keyboard: false,
        icon: this.L.divIcon({
          className: 'map-handle map-handle--point',
          iconSize: [14, 14],
          html: '',
        }),
        title: String(point.id ?? ''),
      }).addTo(this.overlay);

      marker.bindTooltip(describeMissionPoint(point), { direction: 'top' });

      if (draggable) {
        marker.on('dragend', (event) => {
          this.options.onMissionPointMoved(
            point.id,
            this.#latLngToEnu(origin, event.target.getLatLng())
          );
        });
      }
    });

    if (pathLatLngs.length >= 2) {
      this.L.polyline(pathLatLngs, {
        color: '#2563eb',
        weight: 1.5,
        dashArray: '6 4',
        interactive: false,
      }).addTo(this.overlay);
    }
  }

  #latLngToEnu(origin, latLng) {
    const enu = geodeticToEnu(origin, {
      latitude_deg: latLng.lat,
      longitude_deg: latLng.lng,
    });
    return { east_m: roundTo(enu.east_m), north_m: roundTo(enu.north_m) };
  }
}

function isRenderableOrigin(origin) {
  return (
    origin !== null &&
    typeof origin === 'object' &&
    Number.isFinite(origin.latitude_deg) &&
    Number.isFinite(origin.longitude_deg) &&
    Math.abs(origin.latitude_deg) <= 90 &&
    Math.abs(origin.longitude_deg) <= 180
  );
}

function describeMissionPoint(point) {
  const altitude = Number.isFinite(point.altitude_m)
    ? `${point.altitude_m} m ${point.altitude_reference ?? '(reference not set)'}`
    : 'altitude not set';
  const heading =
    point.heading_deg === undefined || point.heading_deg === null
      ? 'heading not set'
      : `${point.heading_deg}°`;
  return `${point.id ?? '(no id)'} — E ${point.east_m} m, N ${point.north_m} m, ${altitude}, ${heading}`;
}
