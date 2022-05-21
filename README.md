# publication-diff-bundler

Compare two snapshots of an article or a site and derive a **review bundle**: the semantic text,
link, image and metadata changes between them, with a source hash for each snapshot.

It answers one question for an editor or a reviewer — *what actually changed between these two
versions, and can I trust that this list is the whole of it?* — and it answers it the same way every
time. No network, no clock, no dependencies.

- **Repository:** [edilec/publication-diff-bundler](https://github.com/edilec/publication-diff-bundler)
- **Area:** Content & Publishing
- **License:** MIT

## Why it exists

A publishing change is easy to review badly. A reformatted template turns every paragraph into a
diff, the one deleted sentence is buried in the noise, and a link that quietly started pointing
somewhere else looks identical in a rendered preview.

So this tool does three things and refuses to compromise on any of them:

1. **Whitespace normalisation is configurable and cannot hide a real change.** Collapsing whitespace
   is what makes a reflowed article reviewable. It applies to prose and to nothing else: a link
   `href`, an image `src` and a canonical URL are compared trimmed but never collapsed, and a block
   of content that is present in one snapshot and absent from the other is a deletion in every mode.
2. **Neither snapshot is ever written to.** There is no auto-fix and no write path into a snapshot.
   The bundle is a derived artifact, and its destination is refused if it resolves inside either
   snapshot root — including through a symlinked parent directory.
3. **The bundle is stable.** The same two snapshots always produce a byte-identical bundle: no clock
   reading, no absolute path, no host detail, and every ordering by UTF-16 code unit. Each snapshot
   carries a `sha256` digest, so a bundle can be tied to exactly the bytes it was built from.

## Install

Node 22 or newer. No runtime dependencies, no development dependencies.

```
npm install publication-diff-bundler
```

## Use

```
publication-diff-bundler --before ./snapshots/v1 --after ./snapshots/v2 \
                         --bundle ./review/bundle.json
```

```
3 document(s) examined, 2 compared: 6 error, 1 warning, 0 info, status fail.
7 change(s), 0 added, 1 removed, 0 unexamined; 1 whitespace-only difference(s) ignored.
before sha256:7d0ebf5a2b09cf27a3444a23ff9048597b91dd694c035f1d57f71261ab0dc875
after  sha256:ed89c937882190d97843abd7bd7a2548a60ae889edc68a2dcc6ae54c4b702665
ERROR   guide/install.html/before document-removed Document is present in the before snapshot and absent from the after snapshot.
ERROR   index.html/after/links/0 link-destination-changed A link points somewhere else in the after snapshot.
ERROR   index.html/after/metadata/link:canonical canonical-changed Metadata "link:canonical" changed between the two snapshots.
ERROR   index.html/before/blocks/4 content-removed A text block present in the before snapshot is absent from the after snapshot.
ERROR   index.html/before/images/0 image-removed An image present in the before snapshot is absent from the after snapshot.
WARNING notes.md/after/blocks/2 text-changed A text block was rewritten between the two snapshots.
ERROR   notes.md/after/links/0 link-destination-changed A link points somewhere else in the after snapshot.
```

Add `--json` for the machine-readable report. Run `publication-diff-bundler --help` for the full
option list; every option, limit and rule is documented in [docs/diff-rules.md](./docs/diff-rules.md).

### Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | both snapshots were compared and no error-severity change was found |
| `1` | the comparison found error-severity changes — a deletion, or a changed destination |
| `2` | invalid configuration (stdout is **empty**), or evidence that was missing, undecodable or bounded out (an `incomplete` report on stdout) |

stdout carries the report and nothing else; diagnostics go to stderr.

### Examples

Two runs over the shipped examples:

```
npm run example
node bin/publication-diff-bundler.mjs --before examples/snapshot-before \
                                      --after examples/snapshot-after-broken
```

`examples/snapshot-after-clean` reflows a paragraph, adds one, and adds a `meta` tag: with the
default `collapse` mode the reflow is ignored and the run exits `0`.
`examples/snapshot-after-broken` deletes a paragraph, repoints two links, drops an image, moves the
canonical URL and removes a whole page — every one of which stays visible with the same whitespace
setting, and the run exits `1`.

## As a library

```js
import { bundlePublicationDiff, writeBundleFile } from 'publication-diff-bundler'

const { report, bundle } = await bundlePublicationDiff({
  before: './snapshots/v1',
  after: './snapshots/v2',
  whitespace: 'collapse',
})

if (report.status !== 'incomplete') await writeBundleFile('./review/bundle.json', bundle)
```

`bundlePublicationDiff` throws a `TypeError` for an unknown option, an unknown limit name, an unknown
whitespace mode, or a snapshot root that is not a readable directory.

## Limits and non-goals

This tool reports what differs between two directories of files. It cannot tell you any of the
following, and does not pretend to:

- **Whether a change is correct, wanted or approved.** `text-changed` means a block was rewritten,
  not that the rewrite is wrong; a deletion is flagged as an error because deletions are what get
  lost in review, not because deleting is a mistake. Exit `1` means *this needs sign-off*.
- **Whether a link still works.** Nothing is fetched, ever. A destination is compared as a string;
  a link that pointed at a dead URL in both snapshots is reported as unchanged, because it is.
- **Whether a rendered page looks the same.** It reads files, not browsers. CSS, JavaScript,
  client-side rendering, images' pixels and anything a script injects at runtime are outside it.
- **What a change means semantically.** There is no model, no embedding and no similarity score.
  Two blocks either match on their comparison key or they do not.
- **That a moved paragraph moved.** Alignment within a changed run is positional, so a reordering
  reads as deletions plus insertions. That shows more than the truth, never less.
- **Anything about a document it could not read.** A document that is unreadable, undecodable, too
  large, or bounded out is reported as exactly that, the run is `incomplete`, and it exits `2`.
  Presence is decided by the directory listing, so such a document is never reported as deleted from
  the other snapshot. **Unknown evidence is never a pass.**
- **Anything about an entry that escaped the snapshot root.** A symlink resolving outside the real
  root is refused unread and its content never reaches the output.
- **Full HTML or Markdown conformance.** The readers are small, bounded scanners. What they do and
  do not handle — reference-style Markdown links, the six named character references, block-level
  splitting — is listed in [docs/diff-rules.md](./docs/diff-rules.md).
- **A useful answer beyond its limits.** Every limit (documents, bytes, depth, blocks, links, images,
  metadata entries, alignment cells) is enforced and named in a finding when it is reached. Exceeding
  one is an `incomplete` result, never a silently shorter answer.

## Verification

```
npm run check
```

Runs `node --check` over every shipped file, the full `node --test` suite, the example, and
`npm pack --dry-run`.

Each guarantee above has a test that fails when the guarantee is removed: delete an `incomplete`
flag, let whitespace normalisation reach a URL, compare a resolved root against an unresolved
candidate, or drop a key from the finding order, and the suite goes red.

Two of those tests are deliberately not written against the source. Every rule's severity is pinned
by running the tool over a snapshot pair that isolates it and asserting the status, the exit code and
the severity the report prints, so downgrading a rule in the table, the docs and a test expectation
together still goes red. Ordering is pinned the same way, on inputs whose collation order disagrees
with their code-unit order, so swapping in a comparator that is not `localeCompare` does not slip
past a source scan.

## License

MIT. See [LICENSE](./LICENSE).
