# Coordinate frames and conventions

This document defines every convention the toolkit uses. If code and this
document disagree, that is a bug in one of them; both should be fixed together.

All code implementing the conversions lives in a single module,
[`shared/js/geo.js`](../shared/js/geo.js).

## 1. Global frame: WGS84 geodetic

A site origin is given as WGS84 geodetic coordinates:

| Field | Unit | Range |
| --- | --- | --- |
| `latitude_deg` | degrees | −90 … 90 |
| `longitude_deg` | degrees | −180 … 180 |
| `altitude_amsl_m` | metres | above mean sea level |

Two points about `altitude_amsl_m`:

- It is **above mean sea level**, not height above the WGS84 ellipsoid. The
  toolkit does not apply a geoid model, so whatever the source of the number
  used as "mean sea level" is what you get. For v0.1 this value is carried as
  metadata only: no calculation in the toolkit consumes it.
- There is no default. A site without an origin altitude fails validation.

## 2. Local frame: ENU

Everything except the origin is expressed in a local **East-North-Up** frame
whose origin is the site origin:

| Axis | Field | Direction |
| --- | --- | --- |
| X | `east_m` | geodetic east |
| Y | `north_m` | geodetic north (true, not magnetic, not grid) |
| Z | altitude | up |

Units are metres. The frame is right-handed.

The vertical axis is handled separately from the horizontal ones throughout the
codebase: `geodeticToEnu()` and `enuToGeodetic()` return and accept only
`east_m` / `north_m`. This is deliberate. An altitude number is meaningless
without its reference (see section 4), and mixing the two in one conversion
function is how a value ends up silently reinterpreted.

## 3. The local approximation, and what it is not

The conversion is a **local tangent plane (flat earth) approximation**. The
WGS84 radii of curvature are evaluated once, at the origin latitude, and then
used as constant metres-per-degree scale factors:

```
M(φ) = a(1 − e²) / (1 − e² sin²φ)^(3/2)      meridional radius
N(φ) = a / (1 − e² sin²φ)^(1/2)              prime vertical radius

north_m = (lat − lat₀) · M(lat₀) · π/180
east_m  = (lon − lon₀) · N(lat₀) · cos(lat₀) · π/180
```

with `a = 6378137.0 m` and `f = 1/298.257223563`.

**This is not high-precision geodesy.** It does not use geodesics, it does not
account for the height of the site above the ellipsoid, and its scale factors
are frozen at the origin.

### Error sources, in rough order of importance

1. **Frozen east scale factor.** The metres-per-degree of longitude shrinks with
   `cos(latitude)`. Displacing north by Δn changes the true scale by roughly
   `tan(φ) · Δn / R`. At latitude 48° and Δn = 1 km that is about 1.7 × 10⁻⁴,
   so a point 1 km east *and* 1 km north of the origin is off by roughly
   0.2 m in the east component.
2. **Height above the ellipsoid.** The local scale should really be `(R + h)/R`.
   A site 500 m above the ellipsoid is off by about 8 × 10⁻⁵, i.e. roughly
   0.08 m per kilometre.
3. **Planar geometry.** Treating the tangent plane as flat costs about
   `d³ / (24 R²)`, which is well under a millimetre at 5 km. This term is
   irrelevant compared to the two above.

These are order-of-magnitude estimates derived from the formulas above, not
measurements against a reference implementation.

### Practical limit

`LOCAL_FRAME_RECOMMENDED_RADIUS_M` in `shared/js/geo.js` is **5000 m**. Beyond
that distance from the origin, the site validator emits a warning. The number is
a judgement call: it is roughly where the decimetre-level errors above start to
approach a metre, which is the point at which the approximation stops being
obviously good enough for the kind of planning these tools do.

If you need better, replace the two functions `geodeticToEnu()` and
`enuToGeodetic()` with a call into a real geodesy library (GeographicLib,
proj4js). They are the only two places in the codebase that convert between the
frames; nothing else needs to change.

### Antimeridian and poles

Longitude differences are wrapped into [−180, 180), so a site straddling the
antimeridian does not produce a 40 000 km offset. Near the poles the east scale
factor collapses towards zero; `enuToGeodetic()` refuses to divide by it and
raises instead of returning nonsense.

## 4. Altitude references

There is exactly one rule: **an altitude never travels without its reference.**

| Value | Meaning |
| --- | --- |
| `AGL` | above ground level, at the point in question |
| `AMSL` | above mean sea level |
| `ATO` | above the take-off point, i.e. above the site origin altitude |

Consequences that are enforced in code:

- `altitude_reference` is a required field wherever an altitude appears in a
  document. A missing or unrecognised value is a validation error, never a
  default.
- The toolkit **does not convert** between references. Converting AGL to AMSL
  requires terrain data the toolkit does not have; converting ATO to AMSL
  requires trusting the origin altitude. Instead, mixing references inside one
  site is reported as an error, and the user is asked to make them consistent.
- The trajectory CSV cannot carry a reference (it is five numeric columns), so
  any tool reading one must be told the reference explicitly. The altitude sweep
  tool asks for it and refuses to generate variants until it is set.

## 5. Heading

One convention, used everywhere:

> **Heading is in degrees clockwise from true north, in the range [0, 360).**

So 0° = north, 90° = east, 180° = south, 270° = west. In local ENU terms:

```
heading_deg = atan2(east_m, north_m) · 180/π,   normalised into [0, 360)
```

Note the argument order: `atan2(east, north)`, not the `atan2(y, x)` of the
usual mathematical convention. That is what makes the angle clockwise from
north instead of counter-clockwise from east.

This is **true** north. The toolkit has no magnetic declination model and does
not produce magnetic headings. `local_frame.heading_reference` records this
explicitly as `"true_north"` so that a future version could add another value
without ambiguity about old files.

An unspecified heading is written as `null` (or omitted), and is reported as
such. It is not silently turned into 0°, which would mean "point north".

## 6. Units

SI throughout, in both files and code:

| Quantity | Unit | Suffix |
| --- | --- | --- |
| Distance, altitude | metre | `_m` |
| Area | square metre | — |
| Speed | metre per second | `_mps` |
| Angle | degree | `_deg` |
| Time | second | `_s` |

Field names carry their unit as a suffix so that a mis-read is a typo rather
than a silent unit error. There are no kilometres, knots, feet or km/h anywhere
in the data model. The trajectory validator warns when a speed exceeds 60 m/s,
which is the most likely sign that someone entered km/h.


## Which site is a trajectory in?

A trajectory carries no origin. Its numbers are metres in *some* site's local
ENU frame, and the same list of points means a different place on the ground in
a different frame. Two things keep that from being ambiguous:

- A site may declare an explicit **`site_id`**, separate from its human-readable
  name.
- A trajectory may record a **`site_context`** block naming that id, the site
  name, the origin and the frame. See
  [file_formats.md](file_formats.md#site_context).

Both are optional, and neither is a path or a filename. Nothing in this project
reads meaning out of a filename, so a trajectory is never bound to a file on
somebody's disk — it records an id, and whoever loads it still has to supply the
site. The id is only there so a mismatch can be *noticed*: loading a trajectory
against a site whose id disagrees is reported as a warning.

A trajectory with no `site_context` is still valid. It simply does not claim a
frame it cannot back up, and whoever loads it has to know which site it belongs
to by other means.

## Importing latitude and longitude

Geographic coordinates entering the toolkit (currently via GeoJSON) are
converted into the local frame by `geodeticToEnu()`, against the site origin and
nothing else. Two rules apply:

- **The origin is never invented.** Without one there is no local frame, so the
  conversion is refused with a message rather than anchored somewhere plausible.
- **Elevations are not imported.** GeoJSON positions may carry a third value,
  but the format does not say what it is measured against. An altitude without
  its reference is meaningless here, so the value is dropped and the fact is
  reported.

GeoJSON orders positions `[longitude, latitude]` — the opposite of how they are
usually spoken. That conversion happens in exactly one function,
`readPosition()` in `shared/js/geojson.js`, which validates both ranges.
