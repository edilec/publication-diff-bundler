/**
 * publication-diff-bundler
 *
 * Compares two snapshots of an article or a site and writes a review bundle of
 * the semantic text, link, image and metadata changes between them, with a
 * source hash for each snapshot.
 *
 * Three properties are structural rather than incidental:
 *
 * 1. **Neither snapshot is ever written to.** There is no auto-fix and no
 *    write path into a snapshot. The bundle is a derived artifact and its
 *    destination is refused if it resolves inside either snapshot root.
 * 2. **Whitespace normalisation is configurable and cannot hide a real
 *    change.** It applies to prose only. A destination is compared trimmed but
 *    never collapsed, and a deletion is a deletion in every mode.
 * 3. **The bundle is stable.** Same two snapshots, byte-identical bundle. No
 *    clock, no absolute path, no host detail, no locale-dependent ordering,
 *    and a source hash that ties the bundle to exactly what was compared.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

import { compareDocuments } from './compare.mjs'
import { DOCUMENT_EXTENSIONS, parseDocument } from './parse.mjs'
import { WHITESPACE_MODES, byCodeUnit, decodeUtf8, sanitize } from './text.mjs'

export const TOOL_ID = 'publication-diff-bundler'
export const REPORT_SCHEMA_VERSION = '1'
export const BUNDLE_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A snapshot is ordinary untrusted input: it can hold a generated 50 MB page,
 * a directory tree that nests forever, or two documents shaped so that a
 * quadratic alignment never finishes. Every limit below is explicit,
 * overridable from the CLI, and named in the finding when it is reached.
 * Exceeding one produces an `incomplete` report -- never a quietly shorter
 * answer, and never a pass.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxDocuments: 500,
  maxDocumentBytes: 1048576,
  maxDepth: 8,
  maxBlocks: 2000,
  maxLinks: 2000,
  maxImages: 1000,
  maxMetadata: 200,
  maxDiffCells: 250000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Spread across three dozen construction sites as a literal it drifts
 * silently, and flipping one rule down to a warning turns a refusal into a
 * green build with every test still passing. Every finding takes its severity
 * from here, an unknown rule id throws, and `docs/diff-rules.md` is asserted
 * against this table in both directions.
 *
 * The policy this table encodes: a deletion and a changed destination are
 * errors, because they are the two ways a publication change silently loses
 * something. A rewrite is a warning -- it needs review, but the tool cannot
 * tell a good rewrite from a bad one. An addition is information.
 */
export const RULE_SEVERITY = Object.freeze({
  'canonical-changed': 'error',
  'content-added': 'info',
  'content-removed': 'error',
  'diff-too-large': 'error',
  'directory-too-deep': 'error',
  'document-added': 'info',
  'document-not-utf8': 'error',
  'document-removed': 'error',
  'document-too-large': 'error',
  'document-unreadable': 'error',
  'image-added': 'info',
  'image-alt-changed': 'warning',
  'image-removed': 'error',
  'image-source-changed': 'error',
  'link-added': 'info',
  'link-destination-changed': 'error',
  'link-removed': 'error',
  'link-text-changed': 'warning',
  'metadata-added': 'info',
  'metadata-changed': 'warning',
  'metadata-removed': 'error',
  'no-documents-found': 'warning',
  'path-escapes-root': 'error',
  'robots-changed': 'error',
  'snapshot-unreadable': 'error',
  'text-changed': 'warning',
  'too-many-blocks': 'error',
  'too-many-documents': 'error',
  'too-many-images': 'error',
  'too-many-links': 'error',
  'too-many-metadata': 'error',
})

const ALLOWED_OPTIONS = Object.freeze(['after', 'before', 'limits', 'whitespace'])
const SKIPPED_DIRECTORIES = Object.freeze(['node_modules'])
const SIDES = Object.freeze(['before', 'after'])
const ANCESTOR_PROBE_LIMIT = 64
const PATH_LIMIT = 240

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Containment, checked on real paths.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside a snapshot resolves out of the tree without ever spelling a
 * traversal. Both sides of every comparison here have been through `realpath`,
 * which is the other half of the same defect -- comparing a resolved root
 * against an unresolved candidate refuses files that are genuinely inside a
 * snapshot reached through a symlinked directory.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${name}" must be a positive integer`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

export function validateWhitespace(mode) {
  if (mode === undefined) return 'collapse'
  if (!WHITESPACE_MODES.includes(mode)) {
    throw new TypeError(`Unknown whitespace mode "${mode}"; use one of ${WHITESPACE_MODES.join(', ')}`)
  }
  return mode
}

/**
 * Resolve the bundle destination and refuse anything inside either snapshot.
 *
 * The destination usually does not exist yet, so the nearest existing ancestor
 * is resolved and the remaining segments are appended. That still defeats a
 * symlinked parent directory, which is how a "separate destination" quietly
 * becomes a file written into the snapshot being reviewed.
 */
export async function resolveBundleDestination(roots, destination) {
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new TypeError('Bundle destination must be a non-empty path')
  }
  const absolute = resolve(destination)
  const tail = []
  let probe = absolute
  let realBase = null

  for (let step = 0; step < ANCESTOR_PROBE_LIMIT; step += 1) {
    try {
      realBase = await realpath(probe)
      break
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new TypeError(`Bundle destination could not be resolved: ${error.code ?? 'unknown error'}`)
      }
      const parent = dirname(probe)
      if (parent === probe) throw new TypeError('Bundle destination has no existing ancestor directory')
      tail.unshift(basename(probe))
      probe = parent
    }
  }
  if (realBase === null) throw new TypeError('Bundle destination is nested too deeply to resolve')

  const resolved = tail.length === 0 ? realBase : join(realBase, ...tail)
  // Both sides are resolved before they are compared. Checking a real
  // destination against a root that was never resolved is the same defect in
  // the other direction: on a host where the snapshot sits under a symlinked
  // ancestor, every containment check would silently answer "outside".
  for (const root of roots) {
    let rootReal
    try {
      rootReal = await realpath(root)
    } catch (error) {
      throw new TypeError(`A snapshot root could not be resolved: ${error.code ?? 'unknown error'}`)
    }
    if (isInside(rootReal, resolved)) {
      throw new TypeError(
        'Bundle destination is inside a snapshot root; the bundle is a derived artifact and must be written elsewhere',
      )
    }
  }
  if (tail.length === 0) {
    const info = await stat(resolved)
    if (info.isDirectory()) throw new TypeError('Bundle destination is a directory, not a file')
  }
  return resolved
}

function createCollector() {
  return { rows: [], incomplete: false }
}

function record(collector, row) {
  collector.rows.push({ pointer: '/', ...row, file: sanitize(row.file, PATH_LIMIT) })
}

/**
 * Walk one snapshot root.
 *
 * Directory entries are sorted by UTF-16 code unit before use, so the order
 * documents are visited never depends on the order the filesystem returned
 * them. Every entry is resolved to its real path and re-checked against the
 * real root before anything is read from it, and a real path already visited
 * is not visited twice.
 */
async function collectDocuments(rootReal, side, limits, collector) {
  const files = []
  const visited = new Set([rootReal])
  let stopped = false

  /**
   * Add one candidate, honouring the document budget.
   *
   * A candidate whose `realPath` is null is present in the snapshot but was
   * never examined. It is listed anyway, because presence is what decides
   * whether a document was removed: an entry that could not be resolved, was
   * refused for escaping the root, or is not a regular file is *there*, and
   * reporting it as deleted from the other snapshot would be a verdict built
   * on evidence that was never obtained.
   */
  const addCandidate = (candidate) => {
    if (files.length >= limits.maxDocuments) {
      record(collector, {
        file: candidate.file,
        pointer: `/${side}`,
        ruleId: 'too-many-documents',
        message: `Snapshot holds more than the maxDocuments limit of ${limits.maxDocuments}; the scan stopped here.`,
        suggestion: 'Raise --max-documents or compare a smaller subtree.',
      })
      collector.incomplete = true
      stopped = true
      return false
    }
    files.push(candidate)
    return true
  }

  const unknownCandidate = (childRelative) => ({ file: childRelative, realPath: null, bytes: null })

  const documentShaped = (name) => DOCUMENT_EXTENSIONS.includes(extname(name).toLowerCase())

  async function walk(absolute, relativePath, depth) {
    if (stopped) return
    if (depth > limits.maxDepth) {
      record(collector, {
        file: relativePath === '' ? '.' : relativePath,
        pointer: `/${side}`,
        ruleId: 'directory-too-deep',
        message: `Directory nesting exceeded the maxDepth limit of ${limits.maxDepth}; its contents were not examined.`,
        suggestion: 'Raise --max-depth or flatten the snapshot.',
      })
      collector.incomplete = true
      return
    }

    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      record(collector, {
        file: relativePath === '' ? '.' : relativePath,
        pointer: `/${side}`,
        ruleId: 'snapshot-unreadable',
        message: `Directory could not be read: ${error.code ?? 'unknown error'}.`,
      })
      collector.incomplete = true
      return
    }

    entries.sort((left, right) => byCodeUnit(left.name, right.name))

    for (const entry of entries) {
      if (stopped) return
      if (entry.name.startsWith('.')) continue
      const childRelative = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      const childAbsolute = join(absolute, entry.name)

      let realPath
      let info
      try {
        realPath = await realpath(childAbsolute)
        info = await stat(realPath)
      } catch (error) {
        record(collector, {
          file: childRelative,
          pointer: `/${side}`,
          ruleId: 'document-unreadable',
          message: `Entry could not be resolved: ${error.code ?? 'unknown error'}.`,
        })
        collector.incomplete = true
        if (documentShaped(entry.name) && !addCandidate(unknownCandidate(childRelative))) return
        continue
      }

      // Containment is decided on the real path, before the entry is opened or
      // walked. Neither its content nor its real location leaves this function.
      if (!isInside(rootReal, realPath)) {
        record(collector, {
          file: childRelative,
          pointer: `/${side}`,
          ruleId: 'path-escapes-root',
          message: 'Entry resolves outside the snapshot root and was refused; its content was never read.',
          suggestion: 'Move the document inside the snapshot, or snapshot the other location separately.',
        })
        collector.incomplete = true
        if (documentShaped(entry.name) && !addCandidate(unknownCandidate(childRelative))) return
        continue
      }
      if (visited.has(realPath)) continue
      visited.add(realPath)

      if (info.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(entry.name)) continue
        await walk(realPath, childRelative, depth + 1)
        continue
      }
      if (!documentShaped(entry.name)) continue

      // An entry named like a document that is not a regular file -- a FIFO, a
      // socket, a device node -- cannot be read as one, and reading from it
      // could block forever. It is listed as present and unexamined, reported,
      // and the run is incomplete: dropping it in silence would leave an
      // unexamined document inside a passing run, and dropping it from the
      // listing would make the other snapshot look as though it had deleted a
      // document that is sitting right there.
      if (!info.isFile()) {
        record(collector, {
          file: childRelative,
          pointer: `/${side}`,
          ruleId: 'document-unreadable',
          message: 'Entry is named like a document but is not a regular file, so nothing could be read from it.',
          suggestion: 'Remove the entry, or replace it with a regular file.',
        })
        collector.incomplete = true
        if (!addCandidate(unknownCandidate(childRelative))) return
        continue
      }

      if (!addCandidate({ file: childRelative, realPath, bytes: info.size })) return
    }
  }

  await walk(rootReal, '', 0)
  files.sort((left, right) => byCodeUnit(left.file, right.file))
  return files
}

const LIMIT_SUGGESTIONS = Object.freeze({
  'diff-too-large': 'Raise --max-diff-cells, or split the document before comparing it.',
  'too-many-blocks': 'Raise --max-blocks, or compare a smaller document.',
  'too-many-images': 'Raise --max-images, or compare a smaller document.',
  'too-many-links': 'Raise --max-links, or compare a smaller document.',
  'too-many-metadata': 'Raise --max-metadata, or compare a smaller document.',
})

/**
 * Read, hash and parse one document.
 *
 * The returned entry always carries what is known and never more. A document
 * that was not read has no hash and no parse: `ok` is false, a finding has
 * been recorded and the run is incomplete. Nothing downstream is allowed to
 * turn that absence into a verdict about what changed.
 */
async function loadDocument(collector, limits, side, entry) {
  // A candidate with no real path was listed as present and unexamined by the
  // walker, which has already reported why. It carries no hash and no parse.
  if (entry.realPath === null) return { ok: false, sha256: null, bytes: null }

  if (entry.bytes > limits.maxDocumentBytes) {
    record(collector, {
      file: entry.file,
      pointer: `/${side}`,
      ruleId: 'document-too-large',
      message: `Document is ${entry.bytes} bytes, above the maxDocumentBytes limit of ${limits.maxDocumentBytes}; it was not read.`,
      suggestion: 'Raise --max-document-bytes or compare a smaller document.',
    })
    collector.incomplete = true
    return { ok: false, sha256: null, bytes: null }
  }

  let bytes
  try {
    bytes = await readFile(entry.realPath)
  } catch (error) {
    record(collector, {
      file: entry.file,
      pointer: `/${side}`,
      ruleId: 'document-unreadable',
      message: `Document could not be read: ${error.code ?? 'unknown error'}.`,
    })
    collector.incomplete = true
    return { ok: false, sha256: null, bytes: null }
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    record(collector, {
      file: entry.file,
      pointer: `/${side}`,
      ruleId: 'document-not-utf8',
      message: 'Document is not valid UTF-8; it was hashed but not parsed, so nothing was compared from it.',
      suggestion: 'Re-encode the snapshot document as UTF-8.',
    })
    collector.incomplete = true
    return { ok: false, sha256, bytes: bytes.length }
  }

  const parsed = parseDocument(extname(entry.file).toLowerCase(), decoded.text, limits)
  for (const problem of parsed.problems) {
    record(collector, {
      file: entry.file,
      pointer: `/${side}`,
      ruleId: problem.ruleId,
      message: `Document exceeded the ${problem.limitName} limit of ${problem.limit}; it was not fully examined.`,
      suggestion: LIMIT_SUGGESTIONS[problem.ruleId],
    })
    collector.incomplete = true
  }

  return {
    ok: parsed.problems.length === 0,
    sha256,
    bytes: bytes.length,
    document: parsed,
  }
}

/**
 * The source hash of one snapshot.
 *
 * One line per candidate document, in code-unit order by path, holding the
 * document hash, its byte length and its JSON-encoded relative path. The path
 * is JSON-encoded so that a name containing a separator or a newline cannot
 * make two different listings produce the same digest. A document that was not
 * read is recorded as `unread`, so a bundle built from partial evidence can
 * never carry the digest of a complete one.
 */
export function snapshotDigest(entries) {
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(`${entry.sha256 ?? 'unread'} ${entry.bytes ?? '-'} ${JSON.stringify(entry.rawFile)}\n`, 'utf8')
  }
  return `sha256:${hash.digest('hex')}`
}

/**
 * The documented finding order: file, then pointer, then rule id, then
 * message. Every comparison is by UTF-16 code unit.
 *
 * Exported so each key can be exercised on its own. Two findings can share a
 * file and a pointer -- a document that is both over the byte limit and absent
 * from the other snapshot reports twice in the same place -- and there the rule
 * id is the only thing deciding the order. The message is the final tiebreak,
 * which makes the order total for any pair of rows.
 */
export function compareFindingRows(left, right) {
  return byCodeUnit(left.file, right.file) ||
    byCodeUnit(left.pointer, right.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message)
}

/**
 * Build one finding, taking its severity from the single table.
 *
 * Exported so a test can prove the refusal below actually throws: a rule that
 * can be emitted without a table entry is a rule whose severity nobody pinned.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(`Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/diff-rules.md.`)
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: row.message,
    location: { file: row.file, pointer: row.pointer },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = row.evidence
  if (row.suggestion !== undefined) finding.suggestion = row.suggestion
  return finding
}

function evidenceFor(change) {
  if (change.before === null && change.after === null) return undefined
  if (change.before === null) return `added: ${change.after}`
  if (change.after === null) return `removed: ${change.before}`
  return `${change.before} => ${change.after}`
}

async function readSnapshot(collector, rootReal, side, limits) {
  const files = await collectDocuments(rootReal, side, limits, collector)
  const entries = []
  for (const entry of files) {
    const loaded = await loadDocument(collector, limits, side, entry)
    entries.push({
      rawFile: entry.file,
      file: sanitize(entry.file, PATH_LIMIT),
      sha256: loaded.sha256,
      bytes: loaded.bytes,
      ok: loaded.ok,
      document: loaded.document,
    })
  }
  return entries
}

/**
 * Compare two snapshots and derive a review bundle.
 *
 * Nothing here reads the network, the clock, the locale or the environment,
 * and no absolute path reaches the result, so two runs over the same bytes --
 * from any directory, on any host -- produce byte-identical output. Both
 * snapshots are opened read-only.
 */
export async function bundlePublicationDiff(options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  for (const side of SIDES) {
    if (typeof options[side] !== 'string' || options[side].trim() === '') {
      throw new TypeError(`A ${side} snapshot root is required`)
    }
  }
  const limits = validateLimits(options.limits ?? {})
  const mode = validateWhitespace(options.whitespace)

  const roots = {}
  for (const side of SIDES) {
    let rootReal
    try {
      rootReal = await realpath(resolve(options[side]))
    } catch (error) {
      throw new TypeError(`The ${side} snapshot root could not be read: ${error.code ?? 'unknown error'}`)
    }
    const info = await stat(rootReal)
    if (!info.isDirectory()) throw new TypeError(`The ${side} snapshot root must be a directory`)
    roots[side] = rootReal
  }

  const collector = createCollector()
  const snapshots = {}
  for (const side of SIDES) snapshots[side] = await readSnapshot(collector, roots[side], side, limits)

  const byPath = {}
  for (const side of SIDES) byPath[side] = new Map(snapshots[side].map((entry) => [entry.rawFile, entry]))
  const paths = [...new Set([...byPath.before.keys(), ...byPath.after.keys()])].sort(byCodeUnit)

  const documents = []
  let compared = 0
  let added = 0
  let removed = 0
  let unexamined = 0
  let changeCount = 0
  let whitespaceOnlyCount = 0

  for (const path of paths) {
    const before = byPath.before.get(path)
    const after = byPath.after.get(path)
    // Findings pass the raw relative path: `record` is the one place that
    // sanitises an identifier on its way into the report. The bundle keeps its
    // own sanitised copy of the same path.
    const bundleFile = sanitize(path, PATH_LIMIT)
    const sides = {
      before: before === undefined ? null : { bytes: before.bytes, sha256: before.sha256 },
      after: after === undefined ? null : { bytes: after.bytes, sha256: after.sha256 },
    }

    if (before !== undefined && after !== undefined) {
      // Presence is decided by the two listings, which were both obtained. A
      // document that is present on both sides but could not be read on one is
      // unknown -- never "removed", never "unchanged". Reporting evidence that
      // was never obtained as a result is exactly the defect this branch
      // exists to refuse.
      if (!before.ok || !after.ok) {
        unexamined += 1
        documents.push({ file: bundleFile, state: 'unexamined', ...sides, changes: [], whitespaceOnly: [] })
        continue
      }
      const result = compareDocuments(before.document, after.document, { mode, maxDiffCells: limits.maxDiffCells })
      for (const problem of result.problems) {
        record(collector, {
          file: path,
          pointer: `/${problem.dimension}`,
          ruleId: problem.ruleId,
          message: `Aligning ${problem.dimension} would have exceeded the ${problem.limitName} budget of ${problem.limit}; this dimension was not compared.`,
          suggestion: LIMIT_SUGGESTIONS[problem.ruleId],
        })
        collector.incomplete = true
      }
      for (const change of result.changes) {
        record(collector, {
          file: path,
          pointer: change.pointer,
          ruleId: change.ruleId,
          message: change.message,
          evidence: evidenceFor(change),
        })
      }
      compared += 1
      changeCount += result.changes.length
      whitespaceOnlyCount += result.whitespaceOnly.length
      documents.push({
        file: bundleFile,
        state: result.problems.length === 0 ? 'compared' : 'partial',
        ...sides,
        changes: result.changes,
        whitespaceOnly: result.whitespaceOnly,
      })
      continue
    }

    if (before !== undefined) {
      removed += 1
      changeCount += 1
      record(collector, {
        file: path,
        pointer: '/before',
        ruleId: 'document-removed',
        message: 'Document is present in the before snapshot and absent from the after snapshot.',
        evidence: before.sha256 === null ? undefined : `before sha256:${before.sha256}`,
      })
      documents.push({ file: bundleFile, state: 'removed', ...sides, changes: [], whitespaceOnly: [] })
      continue
    }

    added += 1
    changeCount += 1
    record(collector, {
      file: path,
      pointer: '/after',
      ruleId: 'document-added',
      message: 'Document is present only in the after snapshot.',
      evidence: after.sha256 === null ? undefined : `after sha256:${after.sha256}`,
    })
    documents.push({ file: bundleFile, state: 'added', ...sides, changes: [], whitespaceOnly: [] })
  }

  /**
   * Green on no evidence is a defect, not a clean bill of health. When neither
   * snapshot held a single document the run obtained nothing to compare, so it
   * says so and is incomplete -- it can never be a pass. The finding alone
   * would not prevent one: it is a warning, so this flag is the only thing
   * standing between an empty run and a green build.
   */
  if (paths.length === 0) {
    record(collector, {
      file: '.',
      pointer: '/',
      ruleId: 'no-documents-found',
      message: 'Neither snapshot holds a document with a supported extension, so this run compared nothing.',
      suggestion: `Point --before and --after at directories holding ${DOCUMENT_EXTENSIONS.join(', ')} files.`,
    })
    collector.incomplete = true
  }

  collector.rows.sort(compareFindingRows)

  const findings = collector.rows.map(createFinding)
  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  const counts = {
    documents: paths.length,
    compared,
    added,
    removed,
    unexamined,
    changes: changeCount,
    whitespaceOnly: whitespaceOnlyCount,
  }

  const bundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    complete: status !== 'incomplete',
    whitespace: mode,
    snapshots: {
      before: describeSnapshot(snapshots.before),
      after: describeSnapshot(snapshots.after),
    },
    counts,
    documents,
  }

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: paths.length,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      ...counts,
    },
    findings,
  }

  return { report, bundle }
}

function describeSnapshot(entries) {
  return {
    documents: entries.length,
    digest: snapshotDigest(entries),
    files: entries.map((entry) => ({ file: entry.file, bytes: entry.bytes, sha256: entry.sha256 })),
  }
}

/** Serialise the derived bundle to its own destination. Neither snapshot is touched. */
export async function writeBundleFile(destination, bundle) {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
  return destination
}

const SEVERITY_WIDTH = 7

export function formatReport(report, bundle) {
  const { summary } = report
  const lines = [
    `${summary.checked} document(s) examined, ${summary.compared} compared: ${summary.errors} error, ${summary.warnings} warning, ${summary.info} info, status ${report.status}.`,
    `${summary.changes} change(s), ${summary.added} added, ${summary.removed} removed, ${summary.unexamined} unexamined; ${summary.whitespaceOnly} whitespace-only difference(s) ignored.`,
  ]
  if (bundle !== undefined) {
    lines.push(`before ${bundle.snapshots.before.digest}`)
    lines.push(`after  ${bundle.snapshots.after.digest}`)
  }
  for (const finding of report.findings) {
    const place = `${finding.location.file}${finding.location.pointer}`
    lines.push(`${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${place} ${finding.ruleId} ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}

export {
  DOCUMENT_EXTENSIONS,
  HTML_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  decodeReferences,
  parseDocument,
  parseHtml,
  parseMarkdown,
} from './parse.mjs'
export { WHITESPACE_MODES, byCodeUnit, decodeUtf8, normalizeText, normalizeUrl, sanitize } from './text.mjs'
export { alignSequences } from './align.mjs'
export { METADATA_RULES, URL_VALUED_METADATA, compareDocuments, isUrlValuedMetadata } from './compare.mjs'
