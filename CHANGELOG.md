# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface: renaming or removing one is a breaking change and is
recorded here.

## [Unreleased]

### Added

- `bundlePublicationDiff` compares two snapshot roots and derives a review bundle of text, link,
  image and metadata changes, with a `sha256` digest and per-document hash for each snapshot.
- `publication-diff-bundler` command line interface with `--before`, `--after`, `--bundle`,
  `--whitespace`, `--json`, `--help` and the eight documented limit flags.
- Configurable whitespace comparison (`collapse`, `preserve`) that applies to prose only. Link
  destinations, image sources and URL-valued metadata are compared trimmed and never collapsed, and
  a deletion is reported in every mode.
- Thirty-one rules with severities pinned in one frozen table, documented in `docs/diff-rules.md`.
- Stable output: no clock reading, no absolute path, no locale-dependent ordering, and a
  byte-identical bundle for the same pair of snapshots.

### Fixed

- A regular file reachable under a second name inside one snapshot -- a symlink beside the file it
  points at -- is listed, read and compared under each of its names. It was dropped from that
  snapshot's listing by the walk's real-path guard, which turned the other snapshot's copy into a
  false `document-added` or `document-removed` and let a real content change under that name reach
  status `pass`. The guard now applies to directories, where it exists to stop the walk looping.
- Output sanitising covers the C1 range (U+0080-U+009F) and the bidi controls (U+200E, U+200F,
  U+202A-U+202E, U+2066-U+2069) as well as C0, DEL, U+2028 and U+2029. U+0085 (NEL) and U+009B (the
  8-bit CSI) are not ECMAScript whitespace and are not escaped by `JSON.stringify`, so both used to
  reach stdout intact -- from a path or a metadata key as readily as from an excerpt.

No release has been published.
