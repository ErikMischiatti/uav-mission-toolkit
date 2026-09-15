# Third-party notices

The UAV Mission Toolkit contains no third-party source code. This file records
the components it loads at runtime, and their licenses.

## Leaflet 1.9.4

- **Used by:** `site_editor/index.html`, `site_viewer/index.html`
- **Purpose:** interactive map rendering
- **License:** BSD 2-Clause — <https://github.com/Leaflet/Leaflet/blob/main/LICENSE>
- **Project:** <https://leafletjs.com/>
- **Loaded from:**
  - `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css`
  - `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js`

The version is pinned exactly. Both tags carry `crossorigin=""`.

The library is fetched at runtime and is not redistributed as part of this
repository, so its license text is not reproduced here; follow the link above.

### No Subresource Integrity hash

The `<script>` and `<link>` tags do **not** carry an `integrity` attribute. A
wrong hash makes the map fail silently for everyone, and the hashes could not be
verified against the real files when this baseline was written. Pinning the
version without an SRI hash still means an unverified third-party script runs in
the page.

If that matters for your deployment, do one of the following — both are
straightforward and either would be a welcome contribution:

1. **Add the hashes.** Fetch each file, compute the digest, and add it:

   ```bash
   curl -sL https://unpkg.com/leaflet@1.9.4/dist/leaflet.js \
     | openssl dgst -sha384 -binary | openssl base64 -A
   ```

   then `integrity="sha384-<digest>" crossorigin="anonymous"` on the tag.

2. **Vendor it locally.** Download both files into `shared/vendor/leaflet/` and
   change the two tags in each tool's `index.html` to point at them. This also
   makes the map work without an internet connection. Record the vendored
   version and its license here, and add the BSD 2-Clause text alongside the
   files, since you would then be redistributing it.

### Graceful degradation

If Leaflet does not load, `ensureLeaflet()` in `shared/js/ui.js` raises an error
that says so; the tool shows it in the status line, replaces the map area with
the message, and the rest of the page — tables, validation, export — keeps
working.

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

If tiles cannot be fetched, the vector overlay (origin, safety polygon, mission
points) still renders on a blank background and the user is told.

## Fonts

No web fonts are loaded. The stylesheet uses the system UI and system monospace
font stacks.
