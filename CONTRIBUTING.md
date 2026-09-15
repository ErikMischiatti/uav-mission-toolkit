# Contributing

Thanks for taking a look. This is a small project; the process is deliberately
light.

## Workflow

1. **Create a branch.** Work on a branch named after the change, for example
   `trajectory-per-point-altitude`. Do not commit directly to `main`.
2. **Keep changes small.** One topic per branch and per pull request. A change
   to the file formats and a change to the CSS belong in different branches.
3. **Test locally** before you push (see below).
4. **Update the docs in the same change.** If you touch a file format, update
   `docs/file_formats.md`. If you touch a convention, update
   `docs/coordinate_frames.md`. A change that makes the docs wrong is not
   finished.
5. **Add a `CHANGELOG.md` entry** under `## [Unreleased]`, in Keep a Changelog
   style.

## Testing locally

There is no build step and no test runner yet.

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Before opening a pull request, walk through the tools you touched:

- Every page loads without an error in the browser console.
- The demo site loads in the site editor and the site viewer.
- The trajectory editor generates each of the four presets, and export produces
  a file you can load back into the altitude sweep.
- The altitude sweep verifies its variants and reports no failures on the
  example data.
- Deliberately break something (clear an altitude field, drag a mission point
  outside the polygon) and confirm the validation panel says so.

Note that `file://` does not work: ES modules and `fetch` both need HTTP.

## Code conventions

- ES modules, 2-space indentation, LF line endings, UTF-8 (see
  `.editorconfig`).
- Shared logic goes in `shared/js/`. Do not re-implement geometry, parsing or
  validation inside a tool.
- SI units internally, with the unit in the field name: `_m`, `_deg`, `_mps`.
- **No silent defaults for safety-critical values.** A missing altitude stays
  missing and gets reported; it never becomes `0`.
- **No silent failures.** Errors reach the user through the status line with
  text that says what to do next.
- Name constants instead of leaving unexplained numbers in the code.
- Comments explain *why*, not *what the syntax does*.
- Text goes into the DOM through `textContent`, never `innerHTML`.

## Things that must not be committed

- **No secrets.** No API keys, tokens, credentials or private URLs. There is no
  backend, so there should be nothing to hide; if you find yourself adding a
  key, stop and raise it first.
- **No real operational site data.** Example data must be newly invented for
  this repository: no real operating areas, no customer or partner site names,
  no coordinates taken from an actual flight, no real vehicle identifiers. The
  shipped `demo_site` is fictional and anything added should be too.
- **No third-party source code** copied into the repository without checking its
  license and recording it in `THIRD_PARTY_NOTICES.md`.
- **No generated output** — downloaded `site.json`, sweep variants and the like
  belong outside the repository.

## Dependencies

v0.1 has exactly one: Leaflet, from a pinned CDN URL. Adding a dependency is a
decision, not a detail — raise it in an issue first. In particular, do not
introduce npm or a bundler to manage a single library.

## Reporting problems

Open an issue describing what you did, what you expected and what happened.
For anything that looks security-relevant, read [SECURITY.md](SECURITY.md)
first.
