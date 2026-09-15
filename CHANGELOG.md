# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
