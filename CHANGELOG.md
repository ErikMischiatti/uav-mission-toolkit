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
- A shared application shell across all four tools: a header, a context bar
  stating what is loaded, which frame is active, the altitude reference and a
  one-line validation verdict, a scrolling control sidebar, a workspace that
  takes the remaining height, and a status bar
- A small design system in `shared/css/common.css`: colour, spacing, radius and
  type tokens with light and dark values, one control height, a four-level
  button hierarchy, and geometry colours shared by the map and the canvas
- Contextual help for ENU, AGL, AMSL, ATO and the heading convention
- New test groups: `vendor`, `ui`, `forms`

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
