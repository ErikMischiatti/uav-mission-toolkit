# Architecture

## Shape of the thing

Four static pages plus a shared module directory. No framework, no bundler, no
Node runtime, no backend, no database. Every page is loaded directly by the
browser and pulls its JavaScript in as ES modules.

```
index.html              launcher
shared/js/*.js          the only place shared logic lives
shared/css/common.css   the only place shared styling lives
<tool>/index.html       markup for one tool
<tool>/app.js           that tool's glue: state, events, rendering
<tool>/style.css        that tool's small deviations from the shared CSS
examples/               one fictional demo site, indexed by manifest.json
docs/                   this directory
```

The one hard rule: **geometry, coordinate conversion, file parsing and
validation live in `shared/js/` and nowhere else.** A tool's `app.js` is allowed
to know about the DOM and about its own workflow. It is not allowed to
re-implement a distance formula, a CSV parser or a validation rule.

## Why no build step

The tools are small, the target audience is engineers with a terminal, and a
build step is a thing that breaks in two years when nobody is looking. Serving
the repository directly means the code that runs is the code in Git.

The cost of that choice is real and worth stating: no TypeScript, no automatic
dependency management, no tree shaking, and no unit-test runner in v0.1. The
code compensates with JSDoc type annotations, small modules and functions that
fail loudly.

Consequence to be aware of: ES modules and `fetch` both require HTTP. Opening
`index.html` from the filesystem with `file://` will not work, and the error
messages in `shared/js/io.js` say so explicitly.

## The shared layer

| Module | Responsibility |
| --- | --- |
| `geo.js` | WGS84 ↔ local ENU, distances, bearings, polygon geometry. The **only** module that converts between frames. |
| `io.js` | Reading files and URLs, strict CSV parse/serialise, number formatting, browser downloads. |
| `validation.js` | Schema constants and all validation rules for sites, trajectories and altitude variants. |
| `trajectory.js` | The trajectory format: CSV columns, document construction, path headings, metrics. |
| `site_map.js` | Leaflet rendering of a site, in editable or read-only mode. |
| `ui.js` | DOM helpers, findings rendering, status messages, number formatting, global error handlers. |

Dependency direction is one way: `geo.js` depends on nothing; `validation.js`
and `trajectory.js` depend on `geo.js` and `io.js`; `site_map.js` depends on
`geo.js`, `io.js` and `ui.js`; every tool depends on the shared layer and never
the reverse. There are no cycles.

`geo.js` is isolated on purpose. Replacing the flat-earth approximation with
GeographicLib or proj4js means rewriting exactly two functions —
`geodeticToEnu()` and `enuToGeodetic()` — and nothing else.

## The four tools

### Site editor

Owns one mutable site object. Every interaction — a form field, a table cell, a
marker dragged on the map — writes into that object and then re-runs
`validateSite()`. The validation panel therefore always describes the object the
download button would serialise, which is the property that makes the panel
worth reading.

Loading a malformed file creates the missing *containers* (`origin`,
`safety_area`, `mission_points`) so the file can be opened and repaired in the
UI, but never fills in a *value*. A site that arrives without an origin altitude
still has no origin altitude, and validation says so.

The map (`SiteMapView`) reports drags back through callbacks and knows nothing
about the editor's state. That is what lets the viewer reuse it unchanged.

### Site viewer

The same rendering and the same validator, with nothing that writes. Its purpose
is a second pair of eyes before a flight: coordinates in both frames,
dimensions, and the identical findings list the editor shows.

### Trajectory editor

Three parts:

- `presets.js` — pure functions producing control points for the straight,
  circle, racetrack and figure-eight shapes. No DOM, no state.
- `canvas.js` — an SVG view of the local plane. The model-to-screen mapping is
  `x = east_m`, `y = −north_m`, and zooming changes the `viewBox`, so stroke
  widths and font sizes are expressed in metres and rescaled on each render.
  No mirroring transform is used, because that would mirror the labels too.
- `app.js` — state, flight parameters, metrics, validation and export.

Headings default to the path tangent (bearing to the next point), with a fixed
heading as an alternative. The estimated duration is length divided by target
speed: a first-order figure that ignores acceleration, turn radius and hold
times, and says so in the UI.

Altitude and altitude reference start empty and export is refused until both are
set. A trajectory with a plausible-looking but invented altitude is worse than
no trajectory at all.

### Altitude sweep

Loads a trajectory CSV, generates one variant per altitude in a range, and
verifies each one before it can be downloaded.

#### Altitude sweep verification

The check is deliberately paranoid, because "only the altitude changed" is the
entire promise of the tool:

1. Apply the new altitude to the parsed source points.
2. Serialise the result to CSV **text**.
3. Parse that text back into points.
4. Compare the re-parsed points against the source, row by row.

Step 3 is the point of the exercise. Comparing in-memory objects would prove
that the object was built correctly; comparing a round trip proves that the
bytes which will actually land in the file are correct, including anything
decimal formatting might have done to them.

What is compared, per row: row count, `east_m`, `north_m`, `heading_deg`,
`speed_mps` (all must be unchanged within a tolerance far below any
operationally meaningful value) and `altitude_m` (must equal the requested
altitude exactly). Any failure disables the download for that variant and is
listed in the findings panel.

The tool also refuses to run until the user states the altitude reference of the
source file, because the CSV cannot say. A bulk download includes a sweep
manifest recording the reference, the source and every generated file.

## Cross-cutting rules

These come up in review often enough to write down.

**No silent defaults for safety-critical values.** An empty numeric field
becomes `null`, not `0`. A missing altitude reference stays missing. New mission
points are created *incomplete* on purpose, and validation immediately says
what is missing.

**No silent failures.** Every tool installs `window.onerror` and
`unhandledrejection` handlers that route into the visible status line, so a
broken module or a rejected promise never looks like the tool simply doing
nothing. Errors carry actionable text (which file, which line, what to do).

**Filenames are labels.** Nothing parses a filename to decide what a file means.
Metadata belongs in the file, or in a manifest next to it.

**CSV is read by header name, never by column position.**

**Text into the DOM goes through `textContent`.** `el()` in `ui.js` has no
`innerHTML` path, so no loaded file can inject markup.

**One convention for headings, one set of altitude references, one unit system.**
See [coordinate_frames.md](coordinate_frames.md).

## External dependencies

Leaflet 1.9.4 for map rendering in the site editor and site viewer, loaded from
a pinned CDN URL. Nothing else. The trajectory editor and the altitude sweep
have no third-party dependency at all.

If Leaflet fails to load, `ensureLeaflet()` throws a message that says what
happened and what to do; the tool reports it in the status line and the rest of
the page keeps working. If the map *tiles* fail (no internet, but Leaflet
cached), the vector overlay still renders on a blank background and the user is
told.

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## What is deliberately absent in v0.1

- No automated tests. The validators are pure functions and are the obvious
  first thing to test once a runner is chosen.
- No terrain model, and therefore no conversion between altitude references.
- No import from or export to any vendor mission format.
- No undo/redo, and no persistence between page loads.
- No multi-site or multi-trajectory projects.
