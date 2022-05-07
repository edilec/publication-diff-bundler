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

No release has been published.
