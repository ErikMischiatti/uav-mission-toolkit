# Third-party notices

This file records the third-party components the UAV Mission Toolkit ships or
loads, and their licenses.

One library is vendored into the repository (Leaflet); one network data source
is used at runtime (OpenStreetMap tiles). Everything else in the toolkit is
first-party code with no dependencies.

## Leaflet 1.9.4

- **Used by:** `site_editor/index.html`, `site_viewer/index.html`
- **Purpose:** interactive map rendering
- **License:** BSD 2-Clause
- **Project:** <https://leafletjs.com/>
- **Vendored at:** `shared/vendor/leaflet/`

Leaflet is **vendored into this repository**, not fetched from a CDN. The map
tools therefore work with no internet connection at all, and no third-party
script is executed from a host this project does not control.

### What is redistributed

| File | Origin |
| --- | --- |
| `shared/vendor/leaflet/leaflet.js` | `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` |
| `shared/vendor/leaflet/leaflet.css` | `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css` |
| `shared/vendor/leaflet/images/layers.png` | `.../dist/images/layers.png` |
| `shared/vendor/leaflet/images/layers-2x.png` | `.../dist/images/layers-2x.png` |
| `shared/vendor/leaflet/images/marker-icon.png` | `.../dist/images/marker-icon.png` |
| `shared/vendor/leaflet/images/marker-icon-2x.png` | `.../dist/images/marker-icon-2x.png` |
| `shared/vendor/leaflet/images/marker-shadow.png` | `.../dist/images/marker-shadow.png` |
| `shared/vendor/leaflet/LICENSE` | `https://unpkg.com/leaflet@1.9.4/LICENSE` |

The files are unmodified. Because this repository now redistributes Leaflet, its
BSD 2-Clause license text is included verbatim alongside the code, as that
license requires. `leaflet.css` refers to the images by relative path, so the
directory layout above must be preserved.

The images are vendored even though this toolkit draws all of its markers with
`L.divIcon` and never uses Leaflet's default marker: a partial copy of a library
is a trap for whoever touches the map code next.

### Digests

Recorded so the vendored copy can be checked against the upstream release:

```text
leaflet.js   sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH
leaflet.css  sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H
```

Reproduce with:

```bash
openssl dgst -sha384 -binary shared/vendor/leaflet/leaflet.js | openssl base64 -A
```

Subresource Integrity attributes are deliberately **not** used on the tags: SRI
protects a resource fetched over the network, and these are local files served
from the same origin as the page. `tests/vendor.test.mjs` checks that the files
are present, that the version matches this document, that the license text is
there, and that no page has regressed to a CDN URL.

### Upgrading

1. Replace the files above from the new release, keeping the layout.
2. Update `LEAFLET_VERSION` in `tests/vendor.test.mjs`.
3. Update the version, the table and the digests here.
4. Run `node tests/run_tests.mjs vendor`.

### If Leaflet does not load

`ensureLeaflet()` in `shared/js/ui.js` raises an error naming the vendored path;
the tool shows it in the status line, replaces the map area with the message,
and the rest of the page — tables, validation, export — keeps working.

## OpenStreetMap tiles

- **Used by:** the map in the site editor and site viewer
- **Source:** `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- **Data license:** Open Database License (ODbL) — © OpenStreetMap contributors
- **Attribution:** rendered on the map by Leaflet, as required

Tiles are fetched directly by the browser at usage levels appropriate to a
development tool. Anything beyond occasional interactive use should respect the
[OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
and point at a different tile source — change `TILE_URL` in
`shared/js/site_map.js`, and update the attribution to match.

### When tiles cannot be fetched

Leaflet itself is vendored and works offline; the tiles are the one part of the
map that still needs the network. `SiteMapView` watches for tile errors and,
after a short run of consecutive failures, drops the tile layer, gives the map a
plain graticule background and adds a "Map tiles unavailable — geometry only"
badge. Panning, zooming, the scale bar, the safety polygon, the mission points
and every drag handle keep working; only the imagery is missing. The tool's
status line says so as well, so the condition is never silent.

## Fonts

No web fonts are loaded. The stylesheet uses the system UI and system monospace
font stacks.
