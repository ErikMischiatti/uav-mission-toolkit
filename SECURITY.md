# Security policy

## Read this first: what this software is not

**The UAV Mission Toolkit is experimental software for preparing and inspecting
mission data. It is not a flight-safety system.**

Concretely:

- It does not communicate with any vehicle, autopilot or ground control
  station, and it never has.
- It performs no airspace, obstacle, terrain, weather or regulatory checks. The
  "safety area" is a polygon a user drew; nothing validates it against reality.
- Its geodetic conversion is a documented local approximation, not survey-grade
  geodesy. See [docs/coordinate_frames.md](docs/coordinate_frames.md).
- Its validation catches structural and arithmetic mistakes — a mission point
  outside the polygon, an altitude outside the declared band, a duplicate id. It
  cannot tell you whether a mission is *safe* or *legal* to fly.
- It has no automated test coverage in v0.1.

Anything produced by these tools must be independently reviewed by a qualified
person before it informs a real flight, and must comply with the aviation
regulations that apply where you are operating. Use it at your own risk; the
MIT license disclaims all warranties.

## Supported versions

| Version | Supported |
| --- | --- |
| v0.1 (`main`) | Yes — fixes land on `main` |
| Anything earlier | There is nothing earlier |

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue tracker.

1. Use GitHub's private vulnerability reporting on this repository
   (*Security* → *Report a vulnerability*).
2. If that is unavailable to you, open a public issue that says only that you
   have a security report and asks for a private channel — **without** any
   details of the problem — and wait for a reply.

Please include, as far as you can:

- what the problem is and what an attacker could achieve;
- the exact steps or input file that reproduces it;
- the browser and version you saw it in;
- anything you already know about a fix.

This is a personal project maintained in spare time. Expect an acknowledgement
within about a week. There is no bug bounty.

## Scope

The whole toolkit runs client-side, has no backend, no accounts and no stored
credentials, so the attack surface is narrow. Reports that are in scope:

- Anything that lets a loaded file execute script in the page (the DOM helpers
  write text with `textContent` and there is no `innerHTML` path — a way around
  that is a real finding).
- A crafted `site.json`, trajectory JSON or CSV that causes the tools to produce
  *silently wrong* output rather than a visible error. Given what these files are
  used for, a validator that passes a bad file is a security issue, not just a
  bug.
- Anything that causes data to leave the user's machine. Nothing in the toolkit
  uploads anything; a path that does is a finding.
- Problems with the pinned third-party dependency, Leaflet — see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Out of scope:

- The absence of Subresource Integrity on the CDN-loaded Leaflet. It is a known,
  documented limitation with a documented workaround; a pull request is welcome,
  a report is not needed.
- Missing hardening that presumes a server: there is no server.
- The known limitations listed in the [README](README.md#known-limitations).
