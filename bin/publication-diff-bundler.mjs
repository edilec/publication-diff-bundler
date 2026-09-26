#!/usr/bin/env node

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  bundlePublicationDiff,
  formatReport,
  resolveBundleDestination,
  writeBundleFile,
} from '../src/index.mjs'

const HELP = `publication-diff-bundler

Compare two snapshots of an article or a site and derive a review bundle of the
text, link, image and metadata changes between them, with a source hash for
each snapshot. Nothing is fetched, and neither snapshot is ever written to.

Usage:
  publication-diff-bundler --before DIR --after DIR [--bundle FILE] [--json]
                           [--whitespace collapse|preserve] [limits]

Options:
  --before DIR             Snapshot taken before the change (required)
  --after DIR              Snapshot taken after the change (required)
  --bundle FILE            Write the review bundle here; must be outside both roots
  --bundle-root DIR        Tree --bundle must resolve inside (default: the
                           working directory)
  --whitespace MODE        collapse (default) ignores reflowed whitespace in prose;
                           preserve reports it as a change
  --json                   Emit the machine-readable report on stdout
  --max-documents N        Maximum documents per snapshot (default 500)
  --max-document-bytes N   Maximum bytes per document (default 1048576)
  --max-depth N            Maximum directory depth below a root (default 8)
  --max-blocks N           Maximum text blocks per document (default 2000)
  --max-links N            Maximum links per document (default 2000)
  --max-images N           Maximum images per document (default 1000)
  --max-metadata N         Maximum metadata entries per document (default 200)
  --max-diff-cells N       Alignment table budget per dimension (default 250000)
  -h, --help               Show this help

Every option is accepted once: a repeated flag is a configuration error, not a
silent last-wins. An unknown option is refused rather than ignored.

--bundle is checked before either snapshot is read and again before the write.
A symbolic link at the destination, a symlinked directory on the way to it, a
path that leaves --bundle-root and a hard link to a snapshot document are each
refused: every one of them writes over a file this tool was never asked to
touch, and every one of them did so here while the run exited 0.

--whitespace collapse folds runs of whitespace in prose only. It never reaches a
destination: a link whose href changed, an image whose src changed and a
canonical URL that moved are reported in every mode, and a block that is present
in one snapshot and absent from the other is a deletion in every mode.

The bundle is a derived artifact. It carries no clock reading and no absolute
path, so the same two snapshots always produce a byte-identical bundle.

Exit codes:
  0  both snapshots were compared and no error-severity change was found
  1  the comparison found error-severity changes: a deletion or a changed destination
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-documents', 'maxDocuments'],
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-depth', 'maxDepth'],
  ['--max-blocks', 'maxBlocks'],
  ['--max-links', 'maxLinks'],
  ['--max-images', 'maxImages'],
  ['--max-metadata', 'maxMetadata'],
  ['--max-diff-cells', 'maxDiffCells'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { before: null, after: null, bundle: null, bundleRoot: null, whitespace: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--whitespace preserve --whitespace collapse` runs a mode nobody asked for
   * and `--before a --before b` compares a snapshot nobody named. That is the
   * same defect as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--before') {
      once('--before')
      options.before = takeValue('--before')
    } else if (argument === '--after') {
      once('--after')
      options.after = takeValue('--after')
    } else if (argument === '--bundle') {
      once('--bundle')
      options.bundle = takeValue('--bundle')
    } else if (argument === '--bundle-root') {
      once('--bundle-root')
      options.bundleRoot = takeValue('--bundle-root')
    } else if (argument === '--whitespace') {
      once('--whitespace')
      options.whitespace = takeValue('--whitespace')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  for (const name of ['before', 'after']) {
    if (options[name] === null) throw new Error(`--${name} is required`)
  }
  if (options.bundleRoot !== null && options.bundle === null) {
    throw new Error('--bundle-root has no meaning without --bundle')
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  // Configuration is settled before a single byte of either snapshot is read,
  // so a bad root or a destination inside a snapshot fails with no report
  // rather than after half a run.
  const roots = []
  for (const side of ['before', 'after']) {
    try {
      roots.push(await realpath(resolve(options[side])))
    } catch (error) {
      process.stderr.write(`--${side} could not be read: ${error.code ?? error.message}\n`)
      return 2
    }
  }

  /*
   * The destination is settled before a single byte of either snapshot is
   * read, and checked again below with the documents this run actually opened.
   * The first pass cannot see a hard link to a document it has not listed yet;
   * the second cannot fail early enough to keep a bad configuration from
   * costing a whole run. Both are cheap, so both happen.
   *
   * A refused destination is a configuration error, so stdout stays empty.
   */
  const bundleRoot = options.bundle === null ? null : options.bundleRoot ?? process.cwd()
  let destination = null
  if (options.bundle !== null) {
    try {
      destination = await resolveBundleDestination(roots, options.bundle, { root: bundleRoot })
    } catch (error) {
      process.stderr.write(`--bundle is not usable: ${error.message}\n`)
      return 2
    }
  }

  let report
  let bundle
  let inputs
  try {
    const result = await bundlePublicationDiff({
      before: options.before,
      after: options.after,
      limits: options.limits,
      ...(options.whitespace === null ? {} : { whitespace: options.whitespace }),
    })
    report = result.report
    bundle = result.bundle
    inputs = result.inputs
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  if (destination !== null) {
    // Re-checked with the real paths of every document that was opened. A hard
    // link to one of them has no target to resolve and shares no path with it,
    // so `realpath` and string comparison both call it a different file; only
    // device and inode see that it is the same one. Re-checking also closes
    // the window between the first check and the write.
    try {
      destination = await resolveBundleDestination(roots, options.bundle, { root: bundleRoot, inputs })
    } catch (error) {
      process.stderr.write(`--bundle is not usable: ${error.message}\n`)
      return 2
    }
    try {
      await writeBundleFile(destination, bundle)
      process.stderr.write(
        `bundle written: ${bundle.counts.documents} document(s), ${bundle.counts.changes} change(s), complete=${bundle.complete}\n`,
      )
    } catch (error) {
      process.stderr.write(`bundle could not be written: ${error.code ?? error.message}\n`)
      return 2
    }
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, bundle))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.unexamined} document pair(s) were not compared out of ${report.summary.checked} examined.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
