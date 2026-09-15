# File formats

The toolkit owns two formats: a **site definition** (JSON) and a **trajectory**
(JSON, plus a flat CSV form). Both are plain, versioned and readable; neither is
tied to any particular autopilot, ground station or vendor.

Conventions used below and enforced by
[`shared/js/validation.js`](../shared/js/validation.js):

- Field names carry their unit (`_m`, `_deg`, `_mps`). See
  [coordinate_frames.md](coordinate_frames.md).
- Every document starts with `schema_version`. This build accepts version `1`
  and rejects anything else rather than guessing at compatibility.
- There are no optional safety-critical fields and no default values. A missing
  altitude is an error, not a zero.
- Comments are not a place to put meaning. JSON has no comments, and nothing in
  the toolkit parses a `description` field or a filename for semantics.

---

## 1. Site definition (`*.site.json`)

### Example

```json
{
  "schema_version": 1,
  "name": "demo_site",
  "description": "Optional free text for humans.",
  "created_utc": "2026-09-15T00:00:00Z",
  "origin": {
    "latitude_deg": 48.0,
    "longitude_deg": 11.0,
    "altitude_amsl_m": 520.0
  },
  "local_frame": {
    "type": "ENU",
    "heading_reference": "true_north"
  },
  "safety_area": {
    "horizontal": [
      { "east_m": -110, "north_m": -95 },
      { "east_m": 105, "north_m": -100 },
      { "east_m": 120, "north_m": 60 }
    ],
    "min_altitude_m": 15,
    "max_altitude_m": 100,
    "altitude_reference": "AGL"
  },
  "mission_points": [
    {
      "id": "takeoff_pad",
      "east_m": 0,
      "north_m": 0,
      "altitude_m": 20,
      "altitude_reference": "AGL",
      "heading_deg": 0
    }
  ]
}
```

### Fields

| Path | Type | Required | Notes |
| --- | --- | --- | --- |
| `schema_version` | integer | yes | Must be `1`. |
| `name` | string | yes | Non-empty. Used for the download filename; never parsed for meaning. |
| `description` | string | no | Free text for humans. |
| `created_utc` | string | no | ISO 8601 UTC timestamp. Not validated. |
| `origin.latitude_deg` | number | yes | −90 … 90, WGS84. |
| `origin.longitude_deg` | number | yes | −180 … 180, WGS84. |
| `origin.altitude_amsl_m` | number | yes | Metres AMSL. Metadata in v0.1. |
| `local_frame.type` | string | yes | `"ENU"` is the only supported value. |
| `local_frame.heading_reference` | string | yes | `"true_north"` is the only supported value. |
| `safety_area.horizontal` | array | yes | ≥ 3 vertices, each `{east_m, north_m}` in local metres. |
| `safety_area.min_altitude_m` | number | yes | Strictly less than the maximum. |
| `safety_area.max_altitude_m` | number | yes | |
| `safety_area.altitude_reference` | string | yes | `AGL`, `AMSL` or `ATO`. |
| `mission_points[]` | array | yes | May be empty. |
| `mission_points[].id` | string | yes | Non-empty and unique within the site. |
| `mission_points[].east_m` | number | yes | Local metres. |
| `mission_points[].north_m` | number | yes | Local metres. |
| `mission_points[].altitude_m` | number | yes | |
| `mission_points[].altitude_reference` | string | yes | Must match `safety_area.altitude_reference`. |
| `mission_points[].heading_deg` | number or `null` | yes | [0, 360) clockwise from true north. `null` means "not specified" and is reported as such. |

### The polygon ring

`safety_area.horizontal` is an **open ring**: the last vertex is joined back to
the first implicitly. Repeating the first vertex at the end produces a warning
rather than an error, because it is a common habit from other formats, but the
duplicate should be removed.

Winding order is not significant. A self-intersecting ring **is** an error:
"inside" is not well defined for one, and every containment check in the toolkit
depends on it being well defined.

### Validation rules

Implemented in `validateSite()`. All of these are checked, and the same function
runs in the site editor and the site viewer:

**Errors**

- `schema_version` is not 1.
- `name` missing or empty.
- Origin latitude/longitude missing or out of range.
- Origin altitude missing or non-finite.
- `local_frame.type` not `ENU`; `heading_reference` not `true_north`.
- Fewer than 3 polygon vertices, or a vertex that is not a finite pair.
- Polygon is self-intersecting or has zero area.
- `altitude_reference` missing or not one of `AGL` / `AMSL` / `ATO`.
- `min_altitude_m` is not strictly less than `max_altitude_m`.
- A mission point with a missing/duplicate id, non-finite coordinates, missing
  altitude, or a heading outside [0, 360).
- A mission point whose `altitude_reference` differs from the safety area's
  (altitudes across different references cannot be compared).
- A mission point outside the altitude band, or outside the safety polygon.

**Warnings**

- Origin is exactly 0/0 (almost always an unset value).
- Origin altitude outside −500 … 9000 m.
- Polygon ring repeats its first vertex.
- Site extends more than 5 km from the origin, beyond the range where the local
  approximation is recommended.

**Notes**

- No mission points defined.
- A mission point does not specify a heading.

---

## 2. Trajectory document (`*.trajectory.json`)

The authoritative form of a trajectory: it carries the frame and the altitude
reference, which the CSV cannot.

```json
{
  "schema_version": 1,
  "name": "demo_racetrack",
  "frame": "local_enu",
  "heading_reference": "true_north",
  "altitude_reference": "AGL",
  "closed": true,
  "speed_mps": 5,
  "points": [
    {
      "east_m": -50,
      "north_m": -35,
      "altitude_m": 40,
      "heading_deg": 90,
      "speed_mps": 5
    }
  ]
}
```

| Path | Type | Required | Notes |
| --- | --- | --- | --- |
| `schema_version` | integer | yes | Must be `1`. |
| `name` | string | yes | Non-empty. |
| `description` | string | no | Free text for humans. |
| `frame` | string | yes | `"local_enu"`. The trajectory has no origin of its own: it is expressed in the local frame of whichever site it belongs to. |
| `heading_reference` | string | yes | `"true_north"`. |
| `altitude_reference` | string | yes | `AGL`, `AMSL` or `ATO`. |
| `closed` | boolean | yes | Whether the last point connects back to the first. |
| `speed_mps` | number | yes | Target ground speed, > 0. |
| `points[]` | array | yes | ≥ 2 points. |
| `points[].east_m` | number | yes | |
| `points[].north_m` | number | yes | |
| `points[].altitude_m` | number | yes | |
| `points[].heading_deg` | number | yes | [0, 360) clockwise from true north. |
| `points[].speed_mps` | number | yes | Per-point speed. v0.1 writes the same value on every point. |

Deliberate omission: a trajectory does **not** reference a site by name or path.
Binding a trajectory to a site by filename would be exactly the kind of implicit
coupling this project avoids. The site is supplied by whoever loads the
trajectory.

### Validation rules

Implemented in `validateTrajectory()`, optionally against a loaded site:

- Schema version, frame, heading reference, altitude reference and `closed` must
  all be present and valid.
- `speed_mps` must be positive; above 60 m/s produces a units warning.
- At least two points, each with finite coordinates and altitude, and a heading
  in range if present.
- With a site supplied: points outside the safety polygon are an error, and a
  mismatch between the trajectory's and the site's altitude reference is a
  warning (limits are then not checked).

---

## 3. Trajectory CSV

A flat, header-first CSV. This is the interchange form: easy to diff, easy to
paste into a spreadsheet, and the input format of the altitude sweep tool.

```text
east_m,north_m,altitude_m,heading_deg,speed_mps
-50,-35,40,90,5
50,-35,40,78.75,5
```

Rules:

- **The header row is mandatory.** Columns are matched by name, never by
  position, so a file whose columns are in a different order still loads. Extra
  columns are preserved in the parsed row but ignored.
- All five columns must be present and every cell must parse as a finite
  number. A blank cell is an error, not a zero.
- Blank lines are ignored. Quoted fields (RFC 4180 style, with `""` for an
  embedded quote) are supported by the parser, though nothing the toolkit writes
  needs them.
- Numbers are written with up to three decimals (1 mm) and trailing zeros
  stripped.

### What the CSV cannot express

This is the important limitation, and the reason the JSON document exists:

| Not in the CSV | Consequence |
| --- | --- |
| `altitude_reference` | A reader cannot know whether `40` means 40 m AGL, AMSL or above take-off. |
| `frame` | Nothing states that the coordinates are local ENU metres. |
| `closed` | Whether the path returns to its first point is unknown. |
| `name`, `schema_version` | No identity and no version handshake. |

The altitude sweep tool handles this explicitly: it asks the user for the
altitude reference of the file being loaded, takes it from the example manifest
when loading an example, and refuses to generate variants until it is set. It
also writes a sweep manifest (below) alongside the generated files so that a
folder of variants is not ambiguous.

---

## 4. Example manifest (`examples/manifest.json`)

An index of the shipped example data. It exists so that the tools can offer
example files without scraping an HTTP directory listing, which only works on
some servers and is not a contract anyone should rely on.

```json
{
  "schema_version": 1,
  "description": "Index of the example data.",
  "sites": [
    {
      "id": "demo_site",
      "name": "Demo Site (fictional)",
      "site_path": "demo_site/site.json",
      "notes": "Free text.",
      "trajectories": [
        {
          "id": "demo_racetrack",
          "name": "Demo racetrack, 40 m AGL",
          "csv_path": "demo_site/example_trajectory.csv",
          "altitude_reference": "AGL",
          "frame": "local_enu",
          "closed": true,
          "notes": "Free text."
        }
      ]
    }
  ]
}
```

All paths are relative to the manifest itself. The `altitude_reference`,
`frame` and `closed` fields on a trajectory entry carry the metadata the CSV
cannot; this is the one place where a CSV's altitude reference is recorded for
the shipped examples.

---

## 5. Sweep manifest

Written by the altitude sweep tool alongside a bulk download, describing what
was generated and from what.

```json
{
  "schema_version": 1,
  "generated_by": "uav-mission-toolkit altitude_sweep",
  "generated_utc": "2026-09-15T12:00:00.000Z",
  "source_file": "examples/demo_site/example_trajectory.csv",
  "source_row_count": 18,
  "altitude_reference": "AGL",
  "frame": "local_enu",
  "heading_reference": "true_north",
  "variants": [
    {
      "filename": "example_trajectory_alt20m.csv",
      "altitude_m": 20,
      "row_count": 18,
      "verified": true
    }
  ]
}
```

`verified: true` means the file passed the round-trip check described in
[architecture.md](architecture.md#altitude-sweep-verification): the CSV text was
parsed back and compared row by row against the source, and only the altitude
column differed.

Filenames here are labels. Nothing in the toolkit reads an altitude back out of
a filename.
