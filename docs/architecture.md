# Architecture

## Shape of the thing

Four static pages plus a shared module directory. No framework, no bundler, no
Node runtime, no backend, no database. Every page is loaded directly by the
browser and pulls its JavaScript in as ES modules.

```
index.html              launcher
shared/js/*.js          the only place shared logic lives
shared/css/common.css   the only place shared styling lives
shared/vendor/leaflet/  Leaflet, vendored so the map works offline
<tool>/index.html       markup for one tool
<tool>/app.js           that tool's glue: state, events, rendering
<tool>/style.css        that tool's small deviations from the shared CSS
examples/               one fictional demo site, indexed by manifest.json
docs/                   this directory
```

The one hard rule: **geometry, coordinate conversion, file parsing and
validation live in `shared/js/` and nowhere else.** A tool's `app.js` is allowed
to know about the DOM and about its own workflow. It is not allowed to
re-implement a distance formula, a CSV parser, a validation rule or an undo
stack.

The same applies to the look of the thing. Every page uses one shell — header,
context bar, sidebar, workspace, status bar — defined once in
`shared/css/common.css`, and every colour, spacing step and control height comes
from a custom property there. A tool's own `style.css` holds only what is
genuinely specific to it, such as the trajectory canvas or the sweep badges.

### The application shell

```
┌────────────────────────────────────────────────────────────┐
│ UAV Mission Toolkit │ Tool name          nav               │  header
├────────────────────────────────────────────────────────────┤
│ SITE file.json   FRAME ENU·m   ALT REF AGL        ✓ Valid  │  context bar
├───────────────────┬────────────────────────────────────────┤
│ controls          │                                        │
│ (scrolls)         │   workspace: map or canvas             │
│                   │   (takes the remaining height)         │
├───────────────────┴────────────────────────────────────────┤
│ status line                                                │  status bar
└────────────────────────────────────────────────────────────┘
```

The context bar exists because the four things a reader most needs — what is
loaded, which frame is active, what altitudes are measured against, and whether
the document is valid — were previously only discoverable by scrolling through
unrelated controls. The workspace, not the control column, gets the screen.

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
| `ui.js` | DOM helpers, findings rendering, the validation verdict, the context bar, status messages, contextual help, global error handlers. |
| `history.js` | Undo/redo. One implementation, used by every tool that edits a document. |
| `persistence.js` | Browser-local draft storage: versioned keys, a refusing reader, and a debounce. |
| `geojson.js` | Generic GeoJSON import and export, and the mapping step that keeps it explicit. |

Dependency direction is one way: `geo.js` depends on nothing; `validation.js`
and `trajectory.js` depend on `geo.js` and `io.js`; `geojson.js` depends on
`geo.js`, `io.js` and `validation.js`; `site_map.js` depends on `geo.js`,
`io.js` and `ui.js`; `history.js` and `persistence.js` depend on nothing at all;
every tool depends on the shared layer and never the reverse. There are no
cycles.

### Why undo/redo stores snapshots

`history.js` keeps a deep copy of the document per operation rather than a pair
of inverse commands. The documents here are small plain-JSON objects, so the
memory is irrelevant, and the choice removes a class of bug that matters for
this project in particular: an inverse command that is subtly wrong corrupts a
document in a way nobody notices until it is flown, whereas a snapshot either
restores the document exactly or fails loudly.

The cost is that an entry records *that* something changed, not *what*. Each one
therefore carries a human label, which is what the toolbar shows.

A drag would otherwise leave one entry per pointer event. Callers either commit
once at the end of the gesture, or pass a `coalesceKey` so consecutive pushes
carrying the same key replace each other. Loading a document calls `reset()`, so
undo can never walk backwards out of the file the user is looking at.

### Browser-local drafts

`persistence.js` keeps the document being edited in `localStorage`, so closing a
tab or reloading does not lose it. That is the entire scope: **recovery for one
browser on one machine**, not storage and not sync. The exported file is still
the artefact that matters, and the UI says so wherever a draft is involved.

Keys are namespaced and versioned:

```text
uav-mission-toolkit:v1:site_editor:draft
uav-mission-toolkit:v1:site_editor:view
uav-mission-toolkit:v1:trajectory_editor:draft
uav-mission-toolkit:v1:trajectory_editor:view
```

The prefix keeps the toolkit from colliding with anything else on the same
origin. The `v1` is the *envelope* version, not the document `schema_version`: a
future envelope writes different keys, so old and new drafts coexist rather than
one silently overwriting the other, and an envelope from a version this build
does not know is refused instead of guessed at.

The viewport lives in its own slot on purpose. A corrupt stored viewport then
costs a fallback to fitting the geometry, not the draft.

**The reader never repairs anything.** A stored value is either returned exactly
as written or refused with a reason. This matters more than for a file, because
a draft is restored at start-up rather than chosen by a human: there is no point
at which somebody looks at it and decides it is the right data.

**What counts as restorable is weaker than what a file must satisfy.** A draft is
work in progress — an altitude not yet filled in, a polygon mid-edit — and those
are exactly the states worth recovering. So the only question asked is
structural ("is this the kind of document this tool edits?"); everything about
its content is reported on screen by `validation.js`, in the usual way. Restoring
a draft therefore tells the reader no less than loading the same file would.

**Storage failure is normal, not exceptional.** A private window, blocked site
data or a full quota all throw, so every access is wrapped and every method
returns a result. A tool that cannot persist still works; it says so once and
carries on. A failed write leaves the previous draft alone rather than
destroying it as well.

Rules the tools follow, rather than the module:

- Opening the demo or a file makes that document the active editing state and
  replaces the stored draft, so the previous one cannot reappear later.
- Exporting does **not** clear the draft. The file and the draft are separate
  things, and finishing one is no reason to destroy the other.
- A restored document starts with an empty undo stack. Undo must not walk back
  into the state a draft happened to be saved in, which is not a state the user
  did anything to reach.
- Undo and redo re-save, so a reload cannot resurrect a state that was undone.
- "Discard local draft" is the explicit way out: it clears the slots and reloads.

### Why the trajectory editor cannot edit a site

The trajectory editor loads a site as **read-only context**. It draws it, it
expresses the trajectory in its frame, and it validates against it — and nothing
in `trajectory_editor/` writes to the site object. Two places that can edit the
same document is how two places end up disagreeing about it; there is one site
editor, and it is `site_editor/`.

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
