# UAV Mission Toolkit

A small, self-contained toolkit for preparing UAV missions in a web browser.
Four tools for defining an operating site, sanity-checking it, designing a
trajectory, and generating verified altitude variants of that trajectory.

Everything runs locally: no backend, no build step, no database, and no data
leaves the machine. Serve the repository with any static file server and open
it.

The design is informed by practical UAV mission-planning workflows — define a
site once, express everything else in a local frame relative to it, and never
let an altitude travel without saying what it is measured against.

## Status

**v0.1 — early development.** The tools work and are usable, the file formats
are documented and versioned, the validation is real, and the headless core is
covered by a regression suite (see [Tests](#tests)). What is missing is listed
honestly under [Known limitations](#known-limitations); the most significant
absence is any kind of terrain model.

This is not a flight-safety system. See [SECURITY.md](SECURITY.md).

## Features

- Map-based site editor with a safety polygon, altitude limits and mission
  points, all editable by form or by dragging on the map.
- A shared validator, used identically by the editor and the viewer: origin
  ranges, polygon sanity, altitude bands, unique ids, containment.
- Read-only site viewer showing local ENU and WGS84 coordinates side by side,
  plus dimensions and area.
- Trajectory editor with straight, circle, racetrack and figure-eight presets,
  draggable control points, path length and a duration estimate. A site can be
  loaded as read-only context: it is drawn behind the path, it defines the local
  frame, and the trajectory is checked against its safety area and altitude band
  as it is drawn.
- Undo and redo in both editors, from one shared history, with the usual
  keyboard shortcuts. A drag is a single undoable operation.
- Generic GeoJSON import with an explicit mapping step — nothing is imported
  until you say what each feature becomes — and GeoJSON export for inspection in
  a GIS.
- Altitude sweep that generates a range of altitude variants and verifies each
  generated file by parsing it back and comparing it to the source.
- Project-owned JSON and CSV formats, versioned from the first release and
  documented in [docs/file_formats.md](docs/file_formats.md). A trajectory can
  record which site's local frame it belongs to, by an explicit id — never by a
  filename.
- One application shell across all four tools: a context bar always states what
  is loaded, which frame is active, what altitudes are measured against, and
  whether the document is valid.
- Runs with no internet connection: Leaflet is vendored. Only the map tiles come
  from the network, and their absence is handled visibly.
- No silent defaults anywhere for safety-critical values.

## Tools

### Site Editor — `site_editor/`

Define an operating site: WGS84 origin, ENU safety polygon, altitude band with
an explicit reference, and mission points. Mission points and polygon vertices
can be dragged on a Leaflet map or typed into tables. Validation re-runs on
every change, and the download produces a `*.site.json` that matches exactly
what the panel describes.

### Site Viewer — `site_viewer/`

Read-only counterpart. Loads a site from the example manifest or from a local
file and shows the geometry, the statistics, the mission points in both frames,
and the same validation findings. Nothing on the page writes.

### Trajectory Editor — `trajectory_editor/`

A 2D top-down designer for the local plane. Pick a preset, adjust its geometric
parameters, then drag individual control points. Set altitude, altitude
reference and target speed; read off path length and estimated duration; export
as a trajectory JSON document or as a flat CSV.

### Altitude Sweep — `altitude_sweep/`

Load a trajectory CSV, give a start altitude, end altitude and step, and get one
variant per altitude. Every variant is written to CSV, parsed back from that
text, and compared row by row against the source. A variant that fails cannot
be downloaded. A bulk download includes a manifest recording the altitude
reference and the source file, because the CSVs themselves cannot.

## Repository structure

```text
uav-mission-toolkit/
├── index.html                  launcher
├── README.md
├── LICENSE                     MIT
├── CONTRIBUTING.md
├── CHANGELOG.md
├── SECURITY.md
├── THIRD_PARTY_NOTICES.md
├── .gitignore
├── .editorconfig
│
├── docs/
│   ├── architecture.md         layering, design rules, the sweep verification
│   ├── coordinate_frames.md    WGS84, local ENU, heading, altitude references
│   └── file_formats.md         site, trajectory, CSV, manifests
│
├── shared/
│   ├── css/
│   │   └── common.css
│   └── js/
│       ├── geo.js              the only frame conversion in the project
│       ├── io.js               files, strict CSV, downloads
│       ├── validation.js       every validation rule
│       ├── trajectory.js       the trajectory format and its metrics
│       ├── site_map.js         Leaflet rendering, editable or read-only
│       └── ui.js               DOM helpers, findings, status, errors
│   └── vendor/
│       └── leaflet/            Leaflet 1.9.4, vendored so the map works offline
│
├── site_editor/                index.html, app.js, style.css
├── site_viewer/                index.html, app.js, style.css
├── trajectory_editor/          index.html, app.js, canvas.js, presets.js, style.css
├── altitude_sweep/             index.html, app.js, style.css
│
├── tests/                      regression suite, run with plain Node
│   ├── run_tests.mjs           the only entry point
│   ├── harness.mjs             ~100 lines of assertions, no dependencies
│   ├── fixtures.mjs            shared test data
│   └── *.test.mjs              geo, trajectory, validation, presets, sweep
│
└── examples/
    ├── manifest.json
    └── demo_site/
        ├── site.json
        └── example_trajectory.csv
```

Two files sit outside the minimal layout, both in `trajectory_editor/`:
`presets.js` (pure shape generation) and `canvas.js` (the SVG view). They are
tool-specific, so they do not belong in `shared/`, and keeping them separate
keeps `app.js` readable.

## Quick start

```bash
git clone <this repository>
cd uav-mission-toolkit
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

Any static file server works — `npx serve`, `php -S`, nginx. There is nothing
to install and nothing to build.

**`file://` will not work.** The tools use ES modules and `fetch`, both of which
browsers restrict on the filesystem protocol. If you open the pages directly you
will get a CORS or module-loading error; serve over HTTP instead.

## Tests

```bash
node tests/run_tests.mjs
```

That is the whole command. There is no package.json, no install step and no
test framework: the suite is plain Node.js ES modules and the assertions come
from the built-in `node:assert`. Node 18.19 or newer. Every test runs, failures
are printed together at the end, and any failure exits non-zero, so it drops
straight into CI or a pre-commit hook.

Run a subset by passing filters, which match against group names:

```bash
node tests/run_tests.mjs geo presets
```

What is covered, all of it headless:

| Area | Checks |
| --- | --- |
| `shared/js/geo.js` | ENU ↔ geodetic round-trips at several latitudes, the antimeridian, the pole guard, heading normalization and cardinal bearings, polygon area and perimeter, point-in-polygon including a concave ring, self-intersection detection |
| `shared/js/validation.js` | The shipped demo site validates with no findings; one test per invalid site case — schema version, origin range, missing altitude reference, inverted altitude band, self-intersecting polygon, duplicate ids, points outside the safety area, mixed altitude references — plus the trajectory rules |
| `shared/js/trajectory.js`, `shared/js/io.js` | CSV parsing and serialization round trips, column lookup by name, and the refusal to invent a value for a missing, ragged or unparseable cell |
| `trajectory_editor/presets.js` | Geometry of all four presets and the parameter validation that guards them |
| Altitude sweep | The full generate-serialize-reparse-verify pipeline, and that a variant whose position, heading, speed, row count or altitude was tampered with is rejected |
| `examples/` | The manifest points at files that exist, and the demo data is mutually consistent |

The DOM layers (`app.js`, `canvas.js`, `site_map.js`, `ui.js`) are **not**
covered; testing them would need a browser or a DOM shim, and a shim would be a
dependency. Those still need a manual pass in a browser.

One implementation note: the project has no `package.json`, so Node would read
the toolkit's `.js` sources as CommonJS and choke on the first `export`. The
runner installs a small module hook (`tests/esm_js_hook.mjs`) that tells Node to
treat them as ES modules — which is what the browser does anyway. Nothing the
tools ship depends on it.

## File formats

Two project-owned formats, both versioned with `schema_version` from v0.1:

- **Site definition** (`*.site.json`) — origin, local frame, safety area,
  mission points.
- **Trajectory** (`*.trajectory.json`) — frame, altitude reference, closed flag,
  speed and points. Plus a flat CSV form with the header
  `east_m,north_m,altitude_m,heading_deg,speed_mps`.

The CSV is an interchange form and **cannot** record its own altitude reference,
frame or closed flag. Tools that read one ask for the missing metadata rather
than assuming it. Full field tables, validation rules and the manifest formats
are in [docs/file_formats.md](docs/file_formats.md).

## Coordinate conventions

Defined once, in [docs/coordinate_frames.md](docs/coordinate_frames.md), and
implemented once, in [`shared/js/geo.js`](shared/js/geo.js).

- **Global:** WGS84 latitude/longitude, degrees; origin altitude in metres AMSL.
- **Local:** East-North-Up in metres, relative to the site origin.
- **Heading:** degrees clockwise from **true** north, `[0, 360)`. 0 = north,
  90 = east. No magnetic model.
- **Altitude:** always accompanied by a reference — `AGL`, `AMSL` or `ATO`
  (above take-off). The toolkit never guesses one and never converts between
  them, because converting would require terrain data it does not have.
- **Units:** SI throughout, with the unit in the field name (`_m`, `_deg`,
  `_mps`).

The geodetic conversion is a **local tangent-plane approximation**, not
survey-grade geodesy. It freezes the WGS84 radii of curvature at the origin
latitude. Expect errors on the order of decimetres at 1 km from the origin and
around a metre at 5 km; the validator warns beyond 5 km. The derivation and
error budget are in the coordinate document, and swapping in a real geodesy
library means rewriting two functions.

## Browser compatibility

Requires a current desktop browser. The code uses ES modules, private class
fields, `Pointer Events`, `Number.isFinite`, optional chaining and nullish
coalescing — all baseline in browsers from 2022 onwards.

| Browser | Status |
| --- | --- |
| Firefox (recent) | Developed and smoke-tested against this class of browser |
| Chromium / Chrome, Edge (recent) | Expected to work; same feature set |
| Safari 16+ | Expected to work; not verified |
| Mobile browsers | Layout adapts below 900 px, but dragging control points on a touch screen is untested |
| Internet Explorer | Not supported |

### Offline behaviour

Leaflet is **vendored** under `shared/vendor/leaflet/`, so the toolkit needs no
internet connection to run: every page, including both map tools, loads entirely
from the repository.

The one remaining network dependency is the **map tiles**, which come from
OpenStreetMap. When they cannot be fetched the map does not fail silently: after
a short run of tile errors the tile layer is dropped, the map falls back to a
plain graticule background with a "Map tiles unavailable — geometry only" badge,
and the status line says so. Panning, zooming, the scale bar, the safety
polygon, the mission points and every drag handle keep working — only the
background imagery is missing.

## Known limitations

Stated plainly, because a planning tool that oversells itself is worse than no
tool:

- **The browser layer is not covered by tests.** The headless core is (see
  [Tests](#tests)), but the DOM modules, the map and the SVG canvas are verified
  by hand.
- **The geodetic conversion is an approximation.** Documented above and in
  `docs/coordinate_frames.md`. Do not use it for anything that needs better than
  roughly a metre over a few kilometres.
- **Origin altitude is metadata only.** Nothing in v0.1 computes with it.
- **No terrain model,** so no conversion between AGL, AMSL and ATO. Mixing
  references inside one site is reported as an error rather than resolved.
- **The trajectory CSV loses metadata.** Frame, altitude reference and the
  closed flag are not in the file. The JSON document is authoritative.
- **A trajectory holds one altitude** for the whole path in v0.1; per-point
  altitude profiles are not supported by the editor (the format allows them).
- **The duration estimate is first-order:** length divided by target speed. It
  ignores acceleration, deceleration, turn radius and hold time.
- **No obstacle, airspace, geofence-margin or no-fly-zone awareness.** The
  safety polygon is a shape the user draws; nothing validates it against reality.
- **No undo/redo and no persistence.** Reloading the page loses unsaved work.
- **Bulk download** issues one browser download per file; browsers may ask for
  permission or throttle. There is no ZIP, because that would mean a dependency.
- **Touch-screen editing is untested.**
- **Map tiles still need an internet connection.** Leaflet itself is vendored
  and works offline; the imagery is not. The map degrades to geometry on a
  graticule background, which is enough to keep working but is not a basemap.

## Roadmap

Roughly in the order it would make sense to do the work:

1. Browser-level coverage for the DOM modules, without taking on a dependency.
   The headless core is well covered; the pages themselves are still checked by
   hand.
2. Per-point altitude profiles, including a climb/descent-aware duration
   estimate.
3. Replace the tangent-plane approximation with a proper geodesy implementation
   behind the existing two-function interface.
4. Loading an existing trajectory back into the trajectory editor. It can be
   written and swept, but not reopened.
5. Plain waypoint CSV import, with the same explicit mapping step GeoJSON uses.
6. Draft persistence in `localStorage`, so a reload does not lose work.
7. A printable mission summary.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: branch, keep changes
small, run `node tests/run_tests.mjs`, check it in a browser with
`python3 -m http.server`, no secrets, and no real operational site data in the
examples.

## License

MIT — see [LICENSE](LICENSE).

Third-party components and their licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
