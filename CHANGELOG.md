# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface: renaming or removing one is a breaking change and is
recorded here.

## [0.1.0] - 2026-10-14

### Added

- `bundlePublicationDiff` compares two snapshot roots and derives a review bundle of text, link,
  image and metadata changes, with a `sha256` digest and per-document hash for each snapshot.
- `publication-diff-bundler` command line interface with `--before`, `--after`, `--bundle`,
  `--bundle-root`, `--whitespace`, `--json`, `--help` and the eight documented limit flags.
- `--bundle-root` declares the tree `--bundle` may be written into; it defaults to the working
  directory and has no meaning without `--bundle`.
- Configurable whitespace comparison (`collapse`, `preserve`) that applies to prose only. Link
  destinations, image sources and URL-valued metadata are compared trimmed and never collapsed, and
  a deletion is reported in every mode.
- Thirty-one rules with severities pinned in one frozen table, documented in `docs/diff-rules.md`.
- Stable output: no clock reading, no absolute path, no locale-dependent ordering, and a
  byte-identical bundle for the same pair of snapshots.

### Fixed

- `--bundle` accepted a destination that destroyed a file the tool was never asked to touch, and
  reported success while doing it. A symbolic link at the destination was *resolved* by the same
  ancestor walk that was there to defeat a symlinked parent, so the bundle was written through the
  link: measured here, a 48-byte file outside both snapshots became a 4554-byte bundle while the run
  exited 0 and printed `bundle written`. A link whose target did not exist yet created the file
  outside the tree instead. A hard link to a snapshot document was refused by nothing at all --
  `realpath` resolves it to its own path and a string comparison calls it a different file -- so
  `--bundle` over one destroyed an 876-byte input, again at exit 0. All three are now refused by
  `assertWritableDestination` before anything is opened, and again with the real paths of every
  document the run read; a refused destination is a configuration error, so stdout stays empty and
  the exit code is 2. `test/destination.test.mjs` has one case per hole and one per allowed shape,
  and every check in the guard has a mutation that reddens the test named for it.

- A regular file reachable under a second name inside one snapshot -- a symlink beside the file it
  points at -- is listed, read and compared under each of its names. It was dropped from that
  snapshot's listing by the walk's real-path guard, which turned the other snapshot's copy into a
  false `document-added` or `document-removed` and let a real content change under that name reach
  status `pass`. The guard now applies to directories, where it exists to stop the walk looping.
- Output sanitising covers the C1 range (U+0080-U+009F) and the bidi controls (U+200E, U+200F,
  U+202A-U+202E, U+2066-U+2069) as well as C0, DEL, U+2028 and U+2029. U+0085 (NEL) and U+009B (the
  8-bit CSI) are not ECMAScript whitespace and are not escaped by `JSON.stringify`, so both used to
  reach stdout intact -- from a path or a metadata key as readily as from an excerpt.

GitHub source release v0.1.0 — 2026-10-14.
