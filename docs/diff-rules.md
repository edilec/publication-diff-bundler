# Rules, limits and determinism

This document is the reference for what `publication-diff-bundler` reads, what each rule means, what
the review bundle contains, and what the tool refuses to claim. Rule ids are stable: renaming one is
a breaking change and is recorded in the changelog.

## What is read

Two snapshot roots are walked: `--before` and `--after`. Files ending in `.html`, `.htm`, `.md` or
`.markdown` are documents; everything else is ignored.

- Entries whose name begins with `.` are skipped, as is any directory named `node_modules`.
- Every entry is resolved to its real path and checked against the **real** snapshot root before it
  is opened. An entry that resolves outside the root is refused and reported as `path-escapes-root`;
  its contents never reach the report or the bundle.
- Both sides of that check are resolved. Comparing a resolved root against an unresolved candidate
  would refuse documents that are genuinely inside a snapshot reached through a symbolic link, and a
  false refusal is a defect in its own right.
- A real path already seen is not visited twice, so a symlinked directory inside a snapshot cannot
  duplicate a document or loop the walk. Entries are visited in UTF-16 code-unit order, so when the
  same file is reachable by two names the first name in that order is the one reported.
- File bytes are decoded with `TextDecoder('utf-8', { fatal: true })`. Whether bytes are UTF-8 is the
  decoder's decision; the decoded text is never inspected to make that judgement. There is no
  configuration file, so this is the only decoding path in the tool: all configuration arrives as
  command-line flags.

**Neither snapshot is ever written to.** There is no auto-fix and no write path into a snapshot. The
bundle goes to `--bundle`, which is refused if it resolves inside either root — including through a
symlinked parent directory.

## Presence, and the difference between absent and unknown

Whether a document was added or removed is decided by the two **directory listings**, never by
whether the document could be read. An entry that could not be resolved, was refused for escaping the
root, or is not a regular file is still *present*: it is listed, reported, and the run is marked
`incomplete`. It is never reported as deleted from the other snapshot, and nothing is claimed about
its content. A pair where either side is unknown is recorded with state `unexamined` and is not
compared.

## Whitespace

`--whitespace` selects how prose is compared.

| Mode | Effect |
| --- | --- |
| `collapse` (default) | Every run of whitespace in prose folds to one space and the ends are trimmed, so a reflowed paragraph compares equal. |
| `preserve` | Prose is compared exactly, so the same reflow is reported as `text-changed`. |

Whitespace here means the ECMAScript `\s` class, which includes the no-break space. Zero-width
characters such as U+200B are **not** whitespace: they are invisible but they are content, and
folding them away would hide an edit nobody could see by reading the page.

The mode applies to prose only. It never reaches:

- a link `href` or an image `src`,
- a metadata value whose key begins with `link:`, or is `meta:property=og:url`,
  `meta:property=og:image` or `meta:name=twitter:image`.

Those are compared after trimming the ends and nothing else. Trimming cannot change which resource is
addressed, because an HTML parser strips the same characters before resolving an attribute. Folding
an interior run would: `/a  b` and `/a b` are two different destinations. A whitespace setting that
made them compare equal would be the tool hiding exactly the kind of change it exists to surface.

A difference that the mode ignored is not discarded. It is counted in `summary.whitespaceOnly` and
listed per document in the bundle's `whitespaceOnly` array, with both values.

## What is extracted

### HTML

The reader is a small, bounded scanner, not a conforming HTML parser.

- **Text blocks** are split at block-level elements. `<br>` ends a block rather than becoming a
  space, so swapping a line break for whitespace stays visible under `collapse`.
- `<script>` and `<style>` content is discarded; `<template>` and `<noscript>` subtrees are skipped.
- **Links** are `<a href>` elements, recorded with their destination and their anchor text. An `<a>`
  with no `href` is a target, not a link, and is not tracked.
- **Images** are `<img>` elements, recorded with `src` and `alt`. An absent `alt` and an empty `alt`
  are different values and are reported as such.
- **Metadata** keys are `title`, `html:lang`, `meta:name=…`, `meta:property=…`,
  `meta:http-equiv=…`, `link:<rel>` and `link:<rel>:hreflang=<code>`. A repeated key is kept under a
  `#2`, `#3` suffix rather than overwritten: a second `<meta name="robots">` that silently replaced
  the first would let a real policy change vanish between two snapshots.
- Only six named character references are decoded — `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` and
  `&nbsp;` — along with decimal and hexadecimal numeric references. Anything else is left exactly as
  written, where a reviewer can still see it, rather than half-decoded.

### Markdown

- Front matter delimited by `---` contributes `front-matter:<key>` metadata for scalar `key: value`
  lines. The first level-one ATX heading contributes `title`.
- Blocks are paragraphs separated by blank lines; a fenced code block is one block, and an ATX
  heading is its own block.
- Links are inline `[text](destination)` and `<scheme:…>` autolinks; images are `![alt](src)`.
  Reference-style links are **not** resolved — they stay inside the block text, where a change to
  one is still visible as a text change.

## Rule catalog

Severity comes from one frozen table in `src/index.mjs`. A finding never carries a severity literal
written at its construction site, and a rule id with no entry in the table throws rather than
defaulting to anything.

The policy the table encodes: **a deletion and a changed destination are errors**, because those are
the two ways a publication change silently loses something. A rewrite is a warning — it needs review,
and the tool cannot tell a good rewrite from a bad one. An addition is information.

| Rule | Severity | Meaning |
| --- | --- | --- |
| `canonical-changed` | error | The `link:canonical` value differs between the snapshots. |
| `content-added` | info | A text block is present only in the after snapshot. |
| `content-removed` | error | A text block present before is absent after. |
| `diff-too-large` | error | Aligning one dimension would have exceeded `maxDiffCells`; that dimension was not compared. |
| `directory-too-deep` | error | Directory nesting exceeded `maxDepth`; its contents were not examined. |
| `document-added` | info | A document is present only in the after snapshot. |
| `document-not-utf8` | error | A document did not decode as UTF-8; it was hashed but not parsed. |
| `document-removed` | error | A document present before is absent after. |
| `document-too-large` | error | A document is larger than `maxDocumentBytes`; it was not read. |
| `document-unreadable` | error | A document could not be resolved or read, or is not a regular file. |
| `image-added` | info | An image is present only in the after snapshot. |
| `image-alt-changed` | warning | An image kept its source but its alternative text changed. |
| `image-removed` | error | An image present before is absent after. |
| `image-source-changed` | error | An image loads from a different source after. |
| `link-added` | info | A link is present only in the after snapshot. |
| `link-destination-changed` | error | A link points somewhere else after. |
| `link-removed` | error | A link present before is absent after. |
| `link-text-changed` | warning | A link kept its destination but its anchor text changed. |
| `metadata-added` | info | A metadata key is present only in the after snapshot. |
| `metadata-changed` | warning | A metadata value changed. |
| `metadata-removed` | error | A metadata key present before is absent after. |
| `no-documents-found` | warning | Neither snapshot held a supported document, so the run compared nothing. |
| `path-escapes-root` | error | An entry resolved outside its snapshot root and was refused unread. |
| `robots-changed` | error | The `meta:name=robots` value differs between the snapshots. |
| `snapshot-unreadable` | error | A directory inside a snapshot could not be read. |
| `text-changed` | warning | A text block was rewritten. |
| `too-many-blocks` | error | A document holds more text blocks than `maxBlocks`; it was not fully examined. |
| `too-many-documents` | error | A snapshot holds more documents than `maxDocuments`; the scan stopped. |
| `too-many-images` | error | A document holds more images than `maxImages`; it was not fully examined. |
| `too-many-links` | error | A document holds more links than `maxLinks`; it was not fully examined. |
| `too-many-metadata` | error | A document holds more metadata entries than `maxMetadata`; it was not fully examined. |

`no-documents-found` is a warning, so on its own it would not stop a run from passing. It always
arrives with the `incomplete` flag, which is what actually prevents a green run on no evidence.

## Limits

Every limit is enforced, reported by name when it is reached, and makes the run `incomplete`.
Exceeding one is never a silently shorter answer and never a pass.

| Limit | Flag | Default |
| --- | --- | --- |
| `maxDocuments` | `--max-documents` | 500 |
| `maxDocumentBytes` | `--max-document-bytes` | 1048576 |
| `maxDepth` | `--max-depth` | 8 |
| `maxBlocks` | `--max-blocks` | 2000 |
| `maxLinks` | `--max-links` | 2000 |
| `maxImages` | `--max-images` | 1000 |
| `maxMetadata` | `--max-metadata` | 200 |
| `maxDiffCells` | `--max-diff-cells` | 250000 |

`maxDiffCells` bounds the alignment table for each dimension, after a shared prefix and suffix have
been matched directly. When the budget is exceeded the alignment is **not computed**, and nothing is
reported about that dimension: an alignment that never ran says nothing about what changed, and
turning "not computed" into "everything was rewritten" would be a verdict invented out of missing
evidence.

Unknown configuration is refused rather than ignored: an unknown option, an unknown limit name, an
unknown whitespace mode, and a flag given twice are all configuration errors. A one-character typo
must not turn a real failure into a green run.

## Alignment

Text blocks, links and images are each aligned as an ordered sequence, by longest common
subsequence over a comparison key — the normalised text for blocks, the trimmed destination for
links and images. Pairing by position alone would report everything after an insertion as changed.

Within the unmatched runs, pairing is positional: the first removed item is read as the predecessor
of the first added one, producing a "changed" observation; anything left over is a deletion or an
insertion. A document whose paragraphs were reordered therefore reads as a set of deletions and
insertions rather than as moves. That is the conservative direction — it shows more, not less.

## The bundle

The bundle is a derived artifact written only to `--bundle`.

- `snapshots.<side>.digest` is `sha256:` followed by the hash of one line per candidate document, in
  code-unit order by path, each holding the document hash, its byte length, and its JSON-encoded
  relative path. A document that was not read is recorded as `unread`, so a bundle built on partial
  evidence can never carry the digest of a complete one.
- `snapshots.<side>.files` lists every candidate with its own `sha256` and byte length.
- `documents[].state` is `compared`, `partial` (a dimension was over budget), `unexamined` (one side
  was not obtained), `added` or `removed`.
- `documents[].changes` are in production order: blocks, then links, then images, then metadata.
- `documents[].whitespaceOnly` lists the differences the whitespace mode ignored.

## Determinism

- Findings sort by `(location.file, location.pointer, ruleId, message)`, every comparison by UTF-16
  code unit. `localeCompare` appears nowhere: it depends on ICU data that varies between Node builds
  and has already produced a real ordering difference in this catalog. One consequence is worth
  knowing: `/after/blocks/10` sorts before `/after/blocks/2`, because the sort is over code units and
  not over the numbers inside the pointer.
- No wall-clock reading, locale, environment variable, hash-map iteration order or filesystem
  enumeration order reaches the output.
- No absolute path reaches the output. Every `location.file` and every bundle path is relative to its
  snapshot root.
- Running the tool twice over the same two snapshots — from any directory, on any host — produces
  byte-identical stdout and a byte-identical bundle.

## Output sanitising

Every string that came out of a snapshot is flattened to a single line, stripped of control
characters including U+2028 and U+2029, and bounded, before it reaches the report or the bundle. That
applies to identifiers and paths as well as to excerpts: a document named with an embedded newline
would otherwise forge an extra line in the human report. A metadata key is additionally escaped as a
JSON Pointer segment, so a key containing `/` cannot splice itself into a pointer.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | both snapshots were compared and no error-severity change was found |
| `1` | the comparison found error-severity changes |
| `2` | invalid configuration (stdout empty), or missing evidence (an `incomplete` report on stdout) |
