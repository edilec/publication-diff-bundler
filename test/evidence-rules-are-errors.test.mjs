import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { bundlePublicationDiff, formatReport } from '../src/index.mjs'

/**
 * The eleven rules whose severity no exit code can defend.
 *
 * `test/severity-behaviour.test.mjs` drives every rule through the real entry
 * point, which is the right shape. For the rules that also mark the run
 * incomplete it cannot use the exit code as the observable, because missing
 * evidence exits 2 whatever the severity says. It falls back to comparing the
 * emitted severity against `CASES[i].severity` -- and that is a value in the
 * same map an attacker editing the table and the docs would edit too. Three
 * declarations agreeing with each other, one level deeper.
 *
 * This file exists to break that symmetry. It shares no map, no table import
 * and no parameterised expectation with any other test: each assertion states
 * the literal outcome inline. Downgrading one of these rules has to be
 * discovered here, because there is nothing here to coordinate with.
 *
 * Why these eleven must stay errors: every one reports that the tool did not
 * obtain evidence it was asked for -- a document it could not read or decode, a
 * snapshot it could not open, a bound that truncated the comparison. Reported
 * as a warning, a run that compared almost nothing still prints "0 error" and
 * reads as a clean diff to anyone scanning the summary line.
 */

async function snapshot(t, spec) {
  const root = await mkdtemp(join(tmpdir(), 'publication-diff-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(spec)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

const page = (body) => `<head></head><body>${body}</body>`

async function run(t, spec, limits, afterSpec = undefined) {
  const before = await snapshot(t, spec)
  const after = afterSpec === undefined ? await snapshot(t, spec) : await snapshot(t, afterSpec)
  const { report } = await bundlePublicationDiff({ before, after, ...(limits ? { limits } : {}) })
  return { report, text: formatReport(report) }
}

/**
 * Assert the outcome literally. No shared constant names the severity, so
 * nothing in this file moves when a table entry does.
 */
function assertReportedAsError(report, text, ruleId) {
  const finding = report.findings.find((item) => item.ruleId === ruleId)
  assert.ok(finding, `${ruleId} was not emitted at all`)

  assert.equal(finding.severity, 'error', `${ruleId} must be an error`)
  assert.equal(report.summary.errors >= 1, true, `${ruleId} must raise the error count`)
  assert.equal(report.summary.warnings, 0, `${ruleId} must not be counted as a warning`)

  const line = text.split('\n').find((row) => row.includes(ruleId))
  assert.ok(line, `${ruleId} was not printed in the human report`)
  assert.equal(line.trimStart().startsWith('ERROR'), true, `printed as: ${line.trim()}`)
}

test('a truncated comparison is reported as an error', async (t) => {
  const { report, text } = await run(
    t,
    { 'index.html': page('<p>one</p><p>two</p>') },
    { maxDiffCells: 1 },
    { 'index.html': page('<p>ONE</p><p>TWO</p>') },
  )
  assertReportedAsError(report, text, 'diff-too-large')
})

test('a tree too deep to walk is reported as an error', async (t) => {
  const { report, text } = await run(
    t,
    { 'index.html': page('<p>kept</p>'), 'deep/deeper/a.html': '<p>kept</p>' },
    { maxDepth: 1 },
  )
  assertReportedAsError(report, text, 'directory-too-deep')
})

test('a document that could not be decoded is reported as an error', async (t) => {
  const before = await snapshot(t, { 'index.html': page('<p>kept</p>') })
  const after = await mkdtemp(join(tmpdir(), 'publication-diff-evidence-'))
  t.after(() => rm(after, { recursive: true, force: true }))
  await writeFile(join(after, 'index.html'), Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0x3c, 0x2f, 0x70, 0x3e]))

  const { report } = await bundlePublicationDiff({ before, after })
  assertReportedAsError(report, formatReport(report), 'document-not-utf8')
})

test('a document past the byte bound is reported as an error', async (t) => {
  const { report, text } = await run(
    t,
    { 'index.html': page(`<p>${'x'.repeat(400)}</p>`) },
    { maxDocumentBytes: 64 },
  )
  assertReportedAsError(report, text, 'document-too-large')
})

test('bounds that truncate what was compared are all errors', async (t) => {
  const cases = [
    ['too-many-blocks', { maxBlocks: 1 }, { 'index.html': page('<p>a</p><p>b</p><p>c</p>') }],
    ['too-many-documents', { maxDocuments: 1 }, { 'a.html': page('<p>a</p>'), 'b.html': page('<p>b</p>') }],
    ['too-many-links', { maxLinks: 1 }, { 'index.html': page('<a href="/a">a</a><a href="/b">b</a>') }],
    ['too-many-images', { maxImages: 1 }, { 'index.html': page('<img src="/a.png" alt="a"><img src="/b.png" alt="b">') }],
  ]

  for (const [ruleId, limits, spec] of cases) {
    const { report, text } = await run(t, spec, limits)
    assertReportedAsError(report, text, ruleId)
  }
})

test('a directory the walk cannot enter is reported as an error', async (t) => {
  /*
   * A snapshot root that does not exist at all throws instead: the run never
   * had a subject, which is a configuration error and exits 2 with an empty
   * stdout. This rule covers the other shape -- the root opened, but part of
   * the tree underneath it could not be read, so the comparison silently saw
   * less than it was asked to.
   */
  const before = await snapshot(t, { 'index.html': page('<p>kept</p>') })
  const after = await snapshot(t, { 'index.html': page('<p>kept</p>'), 'locked/x.html': '<p>x</p>' })
  const locked = join(after, 'locked')
  await chmod(locked, 0o000)
  let report
  try {
    // Restore the mode inline rather than in an after hook: the snapshot
    // helper registers its own cleanup first, so its recursive remove would
    // run against a directory it still cannot enter.
    ;({ report } = await bundlePublicationDiff({ before, after }))
  } finally {
    await chmod(locked, 0o755)
  }
  assertReportedAsError(report, formatReport(report), 'snapshot-unreadable')
})

test('a snapshot root that does not exist is a configuration error, not a finding', async (t) => {
  const before = await snapshot(t, { 'index.html': page('<p>kept</p>') })

  await assert.rejects(
    bundlePublicationDiff({ before, after: join(before, 'does-not-exist-at-all') }),
    /after snapshot root could not be read/,
  )
})

test('none of these rules can be satisfied by a run that reports zero errors', async (t) => {
  // The property the eleven share, stated once as an outcome: whenever the tool
  // did not obtain evidence it was asked for, the summary line cannot read
  // "0 error". A downgrade anywhere in the group breaks this.
  const { report } = await run(
    t,
    { 'index.html': page('<p>a</p><p>b</p><p>c</p>') },
    { maxBlocks: 1 },
  )

  assert.equal(report.status, 'incomplete')
  assert.notEqual(report.summary.errors, 0)
})
