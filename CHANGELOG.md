# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Leaflet is vendored** under `shared/vendor/leaflet/`, with its BSD 2-Clause
  license text. The toolkit now runs with no internet connection at all; only
  the map tiles still come from the network. When tiles cannot be fetched the
  map drops the tile layer, falls back to a graticule background with a
  "Map tiles unavailable — geometry only" badge, and keeps every geometry and
  editing feature working
- **The trajectory editor is site-aware.** A site can be chosen from the example
  manifest or opened from a local `site.json`, or omitted entirely to work in an
  abstract local plane. The site is read-only context: it is drawn behind the
  trajectory, it sets the local frame, and the trajectory is continuously
  checked against it — points outside the safety area, segments that leave it
  between two interior waypoints, altitudes outside the site band, altitude
  reference mismatch, frame and heading-reference incompatibility
- `site_context` on a trajectory document: an optional block recording the site
  id, name, origin and frame a trajectory was drawn in, so a file says which
  coordinate system it belongs to without being bound to a filename
- `site_id` on a site definition: an optional, explicit, stable identifier
- **Browser-local drafts** under `shared/js/persistence.js`. Both editors keep
  the document being edited in `localStorage` and restore it after a reload,
  under namespaced, versioned keys (`uav-mission-toolkit:v1:<tool>:draft`). A
  restored document is marked in the context bar, starts with an empty undo
  stack, and can be discarded explicitly; opening the demo or a file replaces
  the draft, and exporting never deletes it. Map centre/zoom and the trajectory
  canvas viewport are remembered in their own slots. Stored data that cannot be
  read is reported and removed rather than repaired, and unavailable storage is
  reported once without taking the tool down
- **Undo and redo**, from one shared history under `shared/js/history.js`, in
  the site editor and the trajectory editor. Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and
  Ctrl/Cmd+Y, plus toolbar buttons that disable themselves and name the
  operation they would reverse. A drag is one operation, the redo branch is
  discarded on the next edit, history is bounded, and loading a document resets
  it so undo cannot walk back into the previous file
- **Generic GeoJSON import** in the site editor, with an explicit mapping step:
  every feature in the file is listed and nothing is imported until the user
  says what it becomes. Supports `Point`, `Polygon`, `Feature`,
  `FeatureCollection`, and `MultiPoint`/`MultiPolygon` only when they hold
  exactly one geometry. An origin is never invented: without one the import is
  refused, unless a point is explicitly marked as the origin
- **GeoJSON export** of a site, for inspection in a GIS. Deliberately lossy and
  says so: altitudes and their references travel as feature properties
- A shared application shell across all four tools: a header, a context bar
  stating what is loaded, which frame is active, the altitude reference and a
  one-line validation verdict, a scrolling control sidebar, a workspace that
  takes the remaining height, and a status bar
- A small design system in `shared/css/common.css`: colour, spacing, radius and
  type tokens with light and dark values, one control height, a four-level
  button hierarchy, and geometry colours shared by the map and the canvas
- Contextual help for ENU, AGL, AMSL, ATO and the heading convention
- New test groups: `history`, `geojson`, `site_aware`, `ui`, `forms`, `vendor`

### Changed

- The trajectory canvas sizes its text and line weights from the rendered pixel
  size rather than from the extent of the data, and stretches its viewBox to the
  element's aspect ratio. Labels used to scale with how far apart the waypoints
  happened to be, and the last grid label was clipped
- Export buttons in the trajectory editor are disabled, with an explanation,
  while validation fails, instead of accepting the click and then refusing
- Numeric inputs use `step="any"` for continuous quantities. A coarse step
  combined with a `min` makes the browser mark ordinary values invalid, because
  it validates against a grid anchored at `min`
- The validation panel shows a quiet line rather than a green card when there is
  nothing to report

### Fixed

- Site containment findings in the trajectory editor no longer stay hidden
  behind unrelated errors such as an unset altitude reference
- A tile failure is no longer overwritten in the status line by the file-load
  message that usually follows it

### Added in the initial baseline

- Initial repository structure
- Site editor
- Site viewer
- Trajectory editor
- Altitude sweep tool
- Shared layer: `geo.js` (WGS84 ↔ local ENU, polygon geometry), `io.js`
  (strict CSV, file loading, downloads), `validation.js` (all validation
  rules), `trajectory.js` (trajectory format and metrics), `site_map.js`
  (Leaflet rendering), `ui.js` (DOM helpers and error surfacing)
- Versioned site definition and trajectory formats (`schema_version: 1`),
  including the flat trajectory CSV and the example and sweep manifests
- Round-trip verification of generated altitude variants: each file is
  serialised, parsed back and compared to the source row by row
- Dependency-free regression test suite under `tests/`, written as plain
  Node.js ES modules with no package manager, build step or test framework.
  It covers the geometry and geodesy helpers, the validation rules, the
  trajectory JSON and CSV formats, the trajectory presets, the altitude sweep
  verification, and the integrity of the shipped example data. Run it with
  `node tests/run_tests.mjs`
- Documentation: `docs/architecture.md`, `docs/coordinate_frames.md`,
  `docs/file_formats.md`
- One fictional demo site under `examples/`, indexed by `examples/manifest.json`
- Toolkit launcher at the repository root
- Repository hygiene: MIT license, contributing guide, security policy,
  third-party notices, `.gitignore`, `.editorconfig`
