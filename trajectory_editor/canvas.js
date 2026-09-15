/**
 * SVG canvas for the trajectory editor.
 *
 * Top-down view of the local ENU plane. The mapping between the model and SVG
 * user units is deliberately trivial:
 *
 *     x =  east_m
 *     y = -north_m
 *
 * so north points up on screen and no mirroring transform is applied (which
 * would also mirror the labels). Zooming is done by changing the viewBox, so
 * stroke widths and font sizes have to be expressed in user units (metres) and
 * rescaled on every render.
 *
 * Two things make that predictable:
 *
 *  - The viewBox is stretched to the element's own aspect ratio before
 *    drawing, so "meet" never letterboxes it. The viewBox is then exactly the
 *    visible area, which is what lets a label be placed against an edge and
 *    actually land there.
 *  - Sizes are derived from the *rendered* pixel size, not from the extent of
 *    the data. Deriving them from the extent — as an earlier version did — ties
 *    label size to how far apart the waypoints happen to be, so a compact path
 *    gets enormous text and a sprawling one gets unreadably small text.
 *    #renderGeometry() converts both once per render; everything below is
 *    expressed in CSS pixels.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Empty-canvas extent, in metres, when there is nothing to fit. */
const DEFAULT_HALF_EXTENT_M = 100;
/** Fraction of the fitted extent added as margin. */
const FIT_MARGIN_FRACTION = 0.12;
/** Minimum margin so a degenerate path is still visible. */
const MIN_MARGIN_M = 5;
/** Roughly how many grid divisions to aim for across the view. */
const TARGET_GRID_DIVISIONS = 8;

/** On-screen sizes, in CSS pixels, independent of zoom and of the data extent. */
const PX = Object.freeze({
  gridLine: 1,
  axisLine: 1.5,
  path: 2,
  pointRadius: 4.5,
  selectedPointRadius: 6.5,
  pointStroke: 1.5,
  originRadius: 3.5,
  label: 10,
  caption: 11,
  labelPad: 4,
  siteArea: 1.5,
  sitePointRadius: 3,
});

/**
 * Every local point of a site, so the view can be fitted to it.
 * @param {object|null} site
 * @returns {Array<{east_m:number,north_m:number}>}
 */
function siteExtentPoints(site) {
  if (site === null || typeof site !== 'object') return [];
  const ring = Array.isArray(site.safety_area?.horizontal) ? site.safety_area.horizontal : [];
  const points = Array.isArray(site.mission_points) ? site.mission_points : [];
  return [...ring, ...points].filter(
    (p) => p && Number.isFinite(p.east_m) && Number.isFinite(p.north_m)
  );
}

export class TrajectoryCanvas {
  /**
   * @param {SVGSVGElement} svg
   * @param {{
   *   onPointDrag?: (index: number, enu: {east_m:number,north_m:number}) => void,
   *   onPointDragEnd?: (index: number) => void,
   *   onPointSelect?: (index: number) => void,
   *   onCursorMove?: (enu: {east_m:number,north_m:number}|null) => void,
   * }} [callbacks]
   */
  constructor(svg, callbacks = {}) {
    this.svg = svg;
    this.callbacks = callbacks;
    this.data = {
      points: [],
      closed: false,
      headings: [],
      selectedIndex: null,
      /** Read-only site context, or null. Never mutated by this class. */
      site: null,
      /** Indices of control points outside the site's safety area. */
      outsidePointIndices: [],
      /** Indices of path segments that leave the site's safety area. */
      leavingSegmentIndices: [],
    };
    this.view = {
      minX: -DEFAULT_HALF_EXTENT_M,
      minY: -DEFAULT_HALF_EXTENT_M,
      width: DEFAULT_HALF_EXTENT_M * 2,
      height: DEFAULT_HALF_EXTENT_M * 2,
    };
    this.renderView = { ...this.view };
    this.dragIndex = null;

    this.svg.addEventListener('pointerdown', (event) => this.#onPointerDown(event));
    this.svg.addEventListener('pointermove', (event) => this.#onPointerMove(event));
    this.svg.addEventListener('pointerup', (event) => this.#onPointerUp(event));
    this.svg.addEventListener('pointercancel', (event) => this.#onPointerUp(event));
    this.svg.addEventListener('pointerleave', () => this.callbacks.onCursorMove?.(null));
  }

  /**
   * @param {{points: Array<{east_m:number,north_m:number}>, closed: boolean,
   *          headings: Array<number|null>, selectedIndex: number|null,
   *          site?: object|null, outsidePointIndices?: number[],
   *          leavingSegmentIndices?: number[]}} data
   * @param {{fit?: boolean}} [options]
   */
  setData(data, options = {}) {
    this.data = data;
    if (options.fit) this.fit();
    else this.render();
  }

  /**
   * Recompute the viewBox from the current points and the site context.
   *
   * The site is included so that "fit view" frames the whole working area, not
   * just the path: a trajectory tucked in one corner of a large safety area is
   * exactly the case where the surrounding context matters most.
   */
  fit() {
    const points = [...this.data.points, ...siteExtentPoints(this.data.site)];
    if (points.length === 0) {
      this.view = {
        minX: -DEFAULT_HALF_EXTENT_M,
        minY: -DEFAULT_HALF_EXTENT_M,
        width: DEFAULT_HALF_EXTENT_M * 2,
        height: DEFAULT_HALF_EXTENT_M * 2,
      };
      this.render();
      return;
    }

    let minEast = Infinity;
    let maxEast = -Infinity;
    let minNorth = Infinity;
    let maxNorth = -Infinity;
    for (const point of points) {
      if (!Number.isFinite(point.east_m) || !Number.isFinite(point.north_m)) continue;
      minEast = Math.min(minEast, point.east_m);
      maxEast = Math.max(maxEast, point.east_m);
      minNorth = Math.min(minNorth, point.north_m);
      maxNorth = Math.max(maxNorth, point.north_m);
    }
    if (!Number.isFinite(minEast) || !Number.isFinite(minNorth)) {
      this.render();
      return;
    }
    // Always keep the local origin in view: it is the site reference point.
    minEast = Math.min(minEast, 0);
    maxEast = Math.max(maxEast, 0);
    minNorth = Math.min(minNorth, 0);
    maxNorth = Math.max(maxNorth, 0);

    const spanEast = Math.max(maxEast - minEast, 1);
    const spanNorth = Math.max(maxNorth - minNorth, 1);
    const margin = Math.max(
      MIN_MARGIN_M,
      FIT_MARGIN_FRACTION * Math.max(spanEast, spanNorth)
    );

    this.view = {
      minX: minEast - margin,
      minY: -(maxNorth + margin),
      width: spanEast + 2 * margin,
      height: spanNorth + 2 * margin,
    };
    this.render();
  }

  /** Redraw everything from the current data and viewBox. */
  render() {
    const { view, u } = this.#renderGeometry();
    // `this.view` stays the *fitted* extent. Only the derived render extent is
    // stretched, so repeated renders (and window resizes) cannot compound the
    // stretch and slowly zoom the canvas out.
    this.renderView = view;
    this.svg.setAttribute('viewBox', `${view.minX} ${view.minY} ${view.width} ${view.height}`);
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

    this.#drawGrid(u);
    this.#drawAxes(u);
    // The site is context, so it is drawn behind the trajectory it contains.
    this.#drawSite(u);
    this.#drawPath(u);
    this.#drawPoints(u);
  }

  /**
   * Draw the loaded site behind the trajectory: safety polygon, origin and
   * mission points.
   *
   * Everything here is read-only. Nothing in this method is interactive, and
   * nothing anywhere in this class writes back to the site object — the
   * trajectory editor must never become a second, divergent site editor.
   */
  #drawSite(u) {
    const site = this.data.site;
    if (site === null || typeof site !== 'object') return;
    const group = svgEl('g', { class: 'canvas-site' });

    const ring = site.safety_area?.horizontal;
    if (Array.isArray(ring) && ring.length >= 3) {
      const usable = ring.filter(
        (v) => v && Number.isFinite(v.east_m) && Number.isFinite(v.north_m)
      );
      if (usable.length >= 3) {
        group.append(
          svgEl('polygon', {
            points: usable.map((v) => `${v.east_m},${-v.north_m}`).join(' '),
            class: 'canvas-site-area',
            'stroke-width': PX.siteArea * u,
            'stroke-dasharray': `${6 * u} ${4 * u}`,
          })
        );
      }
    }

    for (const point of site.mission_points ?? []) {
      if (!point || !Number.isFinite(point.east_m) || !Number.isFinite(point.north_m)) continue;
      group.append(
        svgEl('circle', {
          cx: point.east_m,
          cy: -point.north_m,
          r: PX.sitePointRadius * u,
          class: 'canvas-site-point',
        })
      );
      group.append(
        svgEl('text', {
          x: point.east_m + PX.sitePointRadius * u * 1.8,
          y: -point.north_m + PX.label * u * 0.35,
          'font-size': PX.label * u,
          class: 'canvas-site-label',
        }, String(point.id ?? ''))
      );
    }

    this.svg.append(group);
  }

  /**
   * The viewBox actually used for this render, stretched to the element's
   * aspect ratio, together with how many user units (metres) one CSS pixel
   * covers at that zoom.
   *
   * Stretching rather than letterboxing means the viewBox *is* the visible
   * area: a label placed at `minX + width` sits against the right edge instead
   * of somewhere in the middle of an invisible margin. The fitted extent is
   * only ever grown, never cropped, so nothing the user fitted to disappears.
   *
   * @returns {{view: {minX:number,minY:number,width:number,height:number}, u: number}}
   */
  #renderGeometry() {
    const view = { ...this.view };
    const rect = this.svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      // Not laid out yet (hidden tab, first paint). Any finite value keeps the
      // markup valid; the next render, after layout, gets it right.
      return { view, u: Math.max(view.width, view.height) / 800 };
    }

    const elementAspect = rect.width / rect.height;
    const viewAspect = view.width / view.height;
    if (elementAspect > viewAspect) {
      const width = view.height * elementAspect;
      view.minX -= (width - view.width) / 2;
      view.width = width;
    } else {
      const height = view.width / elementAspect;
      view.minY -= (height - view.height) / 2;
      view.height = height;
    }

    return { view, u: view.width / rect.width };
  }

  #drawGrid(u) {
    const { minX, minY, width, height } = this.renderView;
    const step = niceStep(Math.max(width, height));
    const group = svgEl('g', { class: 'canvas-grid' });
    const pad = PX.labelPad * u;
    const labelSize = PX.label * u;
    // Space a horizontal label needs; used to drop the ones that would run off
    // the right edge instead of letting them be clipped mid-digit.
    const labelRoom = labelSize * 3;

    for (let x = Math.ceil(minX / step) * step; x <= minX + width; x += step) {
      group.append(
        svgEl('line', { x1: x, y1: minY, x2: x, y2: minY + height, 'stroke-width': PX.gridLine * u })
      );
      if (x + labelRoom <= minX + width) {
        group.append(
          svgEl('text', {
            x: x + pad,
            y: minY + height - pad,
            'font-size': labelSize,
            class: 'canvas-grid__label',
          }, formatGridLabel(x))
        );
      }
    }
    for (let y = Math.ceil(minY / step) * step; y <= minY + height; y += step) {
      group.append(
        svgEl('line', { x1: minX, y1: y, x2: minX + width, y2: y, 'stroke-width': PX.gridLine * u })
      );
      // Skip a label that would sit under the top edge or over the x labels.
      if (y - labelSize >= minY && y <= minY + height - labelSize * 2) {
        group.append(
          svgEl('text', {
            x: minX + pad,
            y: y - pad,
            'font-size': labelSize,
            class: 'canvas-grid__label',
          }, formatGridLabel(-y))
        );
      }
    }
    group.append(
      svgEl('text', {
        x: minX + width - pad,
        y: minY + PX.caption * u + pad,
        'font-size': PX.caption * u,
        'text-anchor': 'end',
        class: 'canvas-grid__caption',
      }, `grid ${formatGridLabel(step)} m`)
    );
    this.svg.append(group);
  }

  #drawAxes(u) {
    const { minX, minY, width, height } = this.renderView;
    const group = svgEl('g', { class: 'canvas-axes' });
    group.append(
      svgEl('line', { x1: minX, y1: 0, x2: minX + width, y2: 0, 'stroke-width': PX.axisLine * u })
    );
    group.append(
      svgEl('line', { x1: 0, y1: minY, x2: 0, y2: minY + height, 'stroke-width': PX.axisLine * u })
    );
    group.append(svgEl('circle', { cx: 0, cy: 0, r: PX.originRadius * u, class: 'canvas-origin' }));
    this.svg.append(group);
  }

  /**
   * Draw the path.
   *
   * Segments that leave the site's safety area are drawn separately, on top and
   * in the danger colour, so an unsafe leg is visible on the canvas and not
   * only in the validation panel. The dash pattern means the distinction
   * survives for a reader who cannot rely on the colour.
   */
  #drawPath(u) {
    const points = this.data.points;
    if (points.length < 2) return;

    const coordinates = points.map((point) => `${point.east_m},${-point.north_m}`);
    if (this.data.closed) coordinates.push(coordinates[0]);
    this.svg.append(
      svgEl('polyline', {
        points: coordinates.join(' '),
        class: 'canvas-path',
        'stroke-width': PX.path * u,
        fill: 'none',
      })
    );

    for (const index of this.data.leavingSegmentIndices ?? []) {
      const from = points[index];
      const to = points[(index + 1) % points.length];
      if (!from || !to) continue;
      this.svg.append(
        svgEl('line', {
          x1: from.east_m,
          y1: -from.north_m,
          x2: to.east_m,
          y2: -to.north_m,
          class: 'canvas-path canvas-path--violating',
          'stroke-width': PX.path * u * 1.5,
          'stroke-dasharray': `${5 * u} ${3 * u}`,
        })
      );
    }
  }

  #drawPoints(u) {
    const group = svgEl('g', { class: 'canvas-points' });
    const outside = new Set(this.data.outsidePointIndices ?? []);
    this.data.points.forEach((point, index) => {
      const isSelected = index === this.data.selectedIndex;
      const classes = ['canvas-point'];
      if (isSelected) classes.push('canvas-point--selected');
      if (outside.has(index)) classes.push('canvas-point--outside');
      group.append(
        svgEl('circle', {
          cx: point.east_m,
          cy: -point.north_m,
          r: (isSelected ? PX.selectedPointRadius : PX.pointRadius) * u,
          'stroke-width': PX.pointStroke * u,
          'data-point-index': String(index),
          class: classes.join(' '),
        })
      );
    });
    // Label only the first point; numbering every point turns into noise.
    const first = this.data.points[0];
    if (first) {
      group.append(
        svgEl('text', {
          x: first.east_m + PX.selectedPointRadius * u * 1.6,
          y: -first.north_m - PX.selectedPointRadius * u,
          'font-size': PX.label * u,
          class: 'canvas-point__label',
        }, 'start')
      );
    }
    this.svg.append(group);
  }

  #onPointerDown(event) {
    const target = /** @type {Element} */ (event.target);
    const attribute = target.getAttribute?.('data-point-index');
    if (attribute === null || attribute === undefined) return;
    const index = Number(attribute);
    this.dragIndex = index;
    this.svg.setPointerCapture(event.pointerId);
    this.callbacks.onPointSelect?.(index);
    event.preventDefault();
  }

  #onPointerMove(event) {
    const enu = this.#clientToLocal(event);
    if (enu === null) return;
    this.callbacks.onCursorMove?.(enu);
    if (this.dragIndex === null) return;
    this.callbacks.onPointDrag?.(this.dragIndex, enu);
  }

  #onPointerUp(event) {
    if (this.dragIndex === null) return;
    const index = this.dragIndex;
    this.dragIndex = null;
    if (this.svg.hasPointerCapture(event.pointerId)) {
      this.svg.releasePointerCapture(event.pointerId);
    }
    this.callbacks.onPointDragEnd?.(index);
  }

  /** @returns {{east_m:number,north_m:number}|null} */
  #clientToLocal(event) {
    const matrix = this.svg.getScreenCTM();
    if (matrix === null) return null; // the SVG is not rendered (hidden tab)
    // DOMPoint is the current API; createSVGPoint is the fallback for older
    // WebKit builds that predate it.
    const point =
      typeof DOMPoint === 'function'
        ? new DOMPoint(event.clientX, event.clientY)
        : Object.assign(this.svg.createSVGPoint(), { x: event.clientX, y: event.clientY });
    const user = point.matrixTransform(matrix.inverse());
    return { east_m: user.x, north_m: -user.y };
  }
}

/**
 * Create an SVG element with attributes and optional text content.
 * @param {string} tag
 * @param {Record<string, string|number>} attrs
 * @param {string} [text]
 */
function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Pick a 1/2/5 x 10^n grid step so the view shows roughly
 * TARGET_GRID_DIVISIONS divisions.
 * @param {number} extent metres
 * @returns {number} metres
 */
function niceStep(extent) {
  if (!Number.isFinite(extent) || extent <= 0) return 1;
  const raw = extent / TARGET_GRID_DIVISIONS;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  let factor = 10;
  if (normalized <= 1) factor = 1;
  else if (normalized <= 2) factor = 2;
  else if (normalized <= 5) factor = 5;
  return factor * magnitude;
}

function formatGridLabel(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
