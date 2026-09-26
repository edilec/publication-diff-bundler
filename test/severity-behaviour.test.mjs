import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY, bundlePublicationDiff, formatReport } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'publication-diff-bundler.mjs')

/**
 * Severity, pinned by what a run of the tool actually does.
 *
 * `RULE_SEVERITY` is the single source of truth and stays that way. What it
 * cannot do is defend itself: asserting the table against the documented
 * catalog, or against a copy of the same values written out by hand, is three
 * declarations agreeing with each other, and an edit that changes all three
 * agrees with itself and passes.
 *
 * So every rule below is driven through the real entry point on a real
 * snapshot pair, and what is asserted is the outcome: the status, the exit
 * code of the CLI, and the severity word the report actually prints. For the
 * nineteen rules whose severity decides the verdict, a downgrade or an upgrade
 * moves the exit code -- an error that becomes a warning turns `fail`/1 into
 * `pass`/0, and a warning that becomes an error turns `pass`/0 into `fail`/1.
 * No edit to the table, the docs and a test map can satisfy that.
 *
 * The twelve rules that also mark the run incomplete exit 2 whatever their
 * severity, because missing evidence is never a pass regardless. Both halves
 * are asserted for them: the exit code that does not move, and the severity
 * word in the emitted report, which does.
 */

const LIMIT_FLAGS = {
  maxBlocks: '--max-blocks',
  maxDepth: '--max-depth',
  maxDiffCells: '--max-diff-cells',
  maxDocumentBytes: '--max-document-bytes',
  maxDocuments: '--max-documents',
  maxImages: '--max-images',
  maxLinks: '--max-links',
  maxMetadata: '--max-metadata',
}

async function snapshot(t, spec) {
  const root = await mkdtemp(join(tmpdir(), 'publication-diff-severity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(spec)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

const page = (head, body) => `<head>${head}</head><body>${body}</body>`
const KEPT = '<p>kept</p>'

/** A pair that differs only in the fragment under test. */
async function pair(t, beforeSpec, afterSpec) {
  return { before: await snapshot(t, beforeSpec), after: await snapshot(t, afterSpec) }
}

/** Both snapshots hold the same bytes; only a limit makes the run say anything. */
async function same(t, spec, limits) {
  const before = await snapshot(t, spec)
  const after = await snapshot(t, spec)
  return { before, after, limits }
}

const CASES = [
  {
    ruleId: 'canonical-changed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    build: (t) => pair(t,
      { 'index.html': page('<link rel="canonical" href="https://example.invalid/a">', KEPT) },
      { 'index.html': page('<link rel="canonical" href="https://example.invalid/b">', KEPT) }),
  },
  {
    ruleId: 'content-added',
    severity: 'info',
    status: 'pass',
    exit: 0,
    build: (t) => pair(t, { 'index.html': page('', KEPT) }, { 'index.html': page('', `${KEPT}<p>extra</p>`) }),
  },
  {
    ruleId: 'content-removed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    build: (t) => pair(t, { 'index.html': page('', `${KEPT}<p>dropped</p>`) }, { 'index.html': page('', KEPT) }),
  },
  {
    ruleId: 'diff-too-large',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: async (t) => ({
      ...(await pair(t,
        { 'index.html': page('', '<p>one</p><p>two</p>') },
        { 'index.html': page('', '<p>ONE</p><p>TWO</p>') })),
      limits: { maxDiffCells: 1 },
    }),
  },
  {
    ruleId: 'directory-too-deep',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: (t) => same(t, { 'index.html': page('', KEPT), 'deep/deeper/a.html': KEPT }, { maxDepth: 1 }),
  },
  {
    ruleId: 'document-added',
    severity: 'info',
    status: 'pass',
    exit: 0,
    build: (t) => pair(t, { 'index.html': page('', KEPT) }, { 'index.html': page('', KEPT), 'extra.html': KEPT }),
  },
  {
    ruleId: 'document-not-utf8',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: async (t) => ({
      before: await snapshot(t, { 'a.html': KEPT }),
      after: await snapshot(t, { 'a.html': Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe]) }),
    }),
  },
  {
    ruleId: 'document-removed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    build: (t) => pair(t, { 'index.html': page('', KEPT), 'gone.html': KEPT }, { 'index.html': page('', KEPT) }),
  },
  {
    ruleId: 'document-too-large',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: (t) => same(t, { 'index.html': page('', KEPT) }, { maxDocumentBytes: 4 }),
  },
  {
    ruleId: 'document-unreadable',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: async (t) => {
      const before = await snapshot(t, { 'a.html': KEPT, 'keep.html': KEPT })
      const after = await snapshot(t, { 'keep.html': KEPT })
      await symlink(join(after, 'no-such-target.html'), join(after, 'a.html'))
      return { before, after }
    },
  },
  {
    ruleId: 'image-added',
    severity: 'info',
    status: 'pass',
    exit: 0,
    build: (t) => pair(t,
      { 'index.html': page('', `${KEPT}<img src="/a.png">`) },
      { 'index.html': page('', `${KEPT}<img src="/a.png"><img src="/b.png">`) }),
  },
  {
    ruleId: 'image-alt-changed',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    build: (t) => pair(t,
      { 'index.html': page('', `${KEPT}<img src="/a.png" alt="a tray">`) },
      { 'index.html': page('', `${KEPT}<img src="/a.png" alt="a cable tray">`) }),
  },
  {
    ruleId: 'image-removed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    build: (t) => pair(t,
      { 'index.html': page('', `${KEPT}<img src="/a.png">`) },
      { 'index.html': page('', KEPT) }),
  },
  {
    ruleId: 'image-source-changed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    build: (t) => pair(t,
      { 'index.html': page('', `${KEPT}<img src="/a.png">`) },
      { 'index.html': page('', `${KEPT}<img src="/b.png">`) }),
  },
  {
    ruleId: 'link-added',
    severity: 'info',
    status: 'pass',
    exit: 0,
    // The anchors carry no text, so the set of destinations is the only thing
    // that differs: an anchor's text is part of the prose block around it, and
    // a fixture that changed both would not say which rule decided the exit
    // code.
    build: (t) => pair(t,
      { 'index.html': page('', `${KEPT}<p><a href="/a"></a></p>`) },
      { 'index.html': page('', `${KEPT}<p><a href="/a"></a><a href="/b"></a></p>`) }),
  },
  {
    ruleId: 'link-destination-changed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    build: (t) => pair(t,
      { 'index.html': page('', `${KEPT}<a href="/a">a</a>`) },
      { 'index.html': page('', `${KEPT}<a href="/b">a</a>`) }),
  },
  {
    ruleId: 'link-removed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    build: (t) => pair(t,
      { 'index.html': page('', `${KEPT}<p><a href="/a"></a></p>`) },
      { 'index.html': page('', `${KEPT}<p></p>`) }),
  },
  {
    ruleId: 'link-text-changed',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    // An anchor's text is also prose, so rewriting it is a text change too.
    // Both rules are warnings, and the assertions below hold every finding to
    // the expected severity, so either of them turning into an error moves the
    // exit code and fails this case.
    companions: ['text-changed'],
    build: (t) => pair(t,
      { 'index.html': page('', `${KEPT}<a href="/a">read this</a>`) },
      { 'index.html': page('', `${KEPT}<a href="/a">read that</a>`) }),
  },
  {
    ruleId: 'metadata-added',
    severity: 'info',
    status: 'pass',
    exit: 0,
    build: (t) => pair(t,
      { 'index.html': page('', KEPT) },
      { 'index.html': page('<meta name="description" content="new">', KEPT) }),
  },
  {
    ruleId: 'metadata-changed',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    build: (t) => pair(t,
      { 'index.html': page('<meta name="description" content="one">', KEPT) },
      { 'index.html': page('<meta name="description" content="two">', KEPT) }),
  },
  {
    ruleId: 'metadata-removed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    build: (t) => pair(t,
      { 'index.html': page('<meta name="description" content="one">', KEPT) },
      { 'index.html': page('', KEPT) }),
  },
  {
    ruleId: 'no-documents-found',
    severity: 'warning',
    status: 'incomplete',
    exit: 2,
    build: (t) => pair(t, { 'notes.txt': 'not a document' }, { 'notes.txt': 'not a document either' }),
  },
  {
    ruleId: 'path-escapes-root',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: async (t) => {
      const outside = await snapshot(t, { 'secret.html': '<p>outside-the-root</p>' })
      const roots = await pair(t, { 'index.html': page('', KEPT) }, { 'index.html': page('', KEPT) })
      for (const root of [roots.before, roots.after]) {
        await symlink(join(outside, 'secret.html'), join(root, 'leak.html'))
      }
      return roots
    },
  },
  {
    ruleId: 'robots-changed',
    severity: 'error',
    status: 'fail',
    exit: 1,
    build: (t) => pair(t,
      { 'index.html': page('<meta name="robots" content="index,follow">', KEPT) },
      { 'index.html': page('<meta name="robots" content="noindex,nofollow">', KEPT) }),
  },
  {
    ruleId: 'snapshot-unreadable',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: async (t) => {
      // Built without the shared helper so that one cleanup hook restores the
      // modes before it removes the trees; the other way round it cannot.
      const roots = []
      const locked = []
      for (const side of ['before', 'after']) {
        const root = await mkdtemp(join(tmpdir(), `publication-diff-severity-${side}-`))
        const directory = join(root, 'section')
        await mkdir(directory, { recursive: true })
        await writeFile(join(root, 'index.html'), page('', KEPT))
        await writeFile(join(directory, 'a.html'), KEPT)
        roots.push(root)
        locked.push(directory)
      }
      t.after(async () => {
        for (const directory of locked) await chmod(directory, 0o755).catch(() => {})
        for (const root of roots) await rm(root, { recursive: true, force: true })
      })
      for (const directory of locked) await chmod(directory, 0o000)
      // A process that can read the directory anyway -- root, or a filesystem
      // without POSIX modes -- would make the assertions meaningless.
      const enforced = await readdir(locked[0]).then(() => false, () => true)
      if (!enforced) return { skip: 'the filesystem did not enforce the mode change' }
      return { before: roots[0], after: roots[1] }
    },
  },
  {
    ruleId: 'text-changed',
    severity: 'warning',
    status: 'pass',
    exit: 0,
    build: (t) => pair(t, { 'index.html': page('', '<p>one</p>') }, { 'index.html': page('', '<p>two</p>') }),
  },
  {
    ruleId: 'too-many-blocks',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: (t) => same(t, { 'index.html': page('', '<p>one</p><p>two</p>') }, { maxBlocks: 1 }),
  },
  {
    ruleId: 'too-many-documents',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: (t) => same(t, { 'a.html': KEPT, 'b.html': KEPT }, { maxDocuments: 1 }),
  },
  {
    ruleId: 'too-many-images',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: (t) => same(t, { 'index.html': page('', `${KEPT}<img src="/a.png"><img src="/b.png">`) }, { maxImages: 1 }),
  },
  {
    ruleId: 'too-many-links',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: (t) => same(t,
      { 'index.html': page('', `${KEPT}<a href="/a">a</a><a href="/b">b</a>`) },
      { maxLinks: 1 }),
  },
  {
    ruleId: 'too-many-metadata',
    severity: 'error',
    status: 'incomplete',
    exit: 2,
    build: (t) => same(t,
      { 'index.html': page('<meta name="one" content="1"><meta name="two" content="2">', KEPT) },
      { maxMetadata: 1 }),
  },
]

async function runCli(fixture) {
  const args = ['--before', fixture.before, '--after', fixture.after]
  for (const [name, value] of Object.entries(fixture.limits ?? {})) {
    args.push(LIMIT_FLAGS[name], String(value))
  }
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout }))
}

for (const testCase of CASES) {
  test(`${testCase.ruleId} is emitted as ${testCase.severity} and the run exits ${testCase.exit}`, async (t) => {
    const fixture = await testCase.build(t)
    if (fixture.skip !== undefined) {
      t.skip(fixture.skip)
      return
    }

    const { report, bundle } = await bundlePublicationDiff({
      before: fixture.before,
      after: fixture.after,
      limits: fixture.limits ?? {},
    })

    // The fixture isolates the rule, so nothing else can be deciding the
    // status or the exit code below.
    assert.deepEqual(
      [...new Set(report.findings.map((finding) => finding.ruleId))].sort(),
      [testCase.ruleId, ...(testCase.companions ?? [])].sort(),
    )
    for (const finding of report.findings) {
      assert.equal(finding.severity, testCase.severity, `${testCase.ruleId} was emitted as ${finding.severity}`)
    }

    // The severity as the human report prints it, and as the summary counts it.
    const printed = formatReport(report, bundle)
      .split(String.fromCharCode(10))
      .filter((line) => line.includes(` ${testCase.ruleId} `))
    assert.ok(printed.length > 0, `${testCase.ruleId} never reached a report line`)
    for (const line of printed) {
      assert.equal(line.startsWith(testCase.severity.toUpperCase()), true, `report line: ${line}`)
    }
    assert.equal(report.summary.errors > 0, testCase.severity === 'error')
    assert.equal(report.summary.warnings > 0, testCase.severity === 'warning')
    assert.equal(report.summary.info > 0, testCase.severity === 'info')

    // The outcome a downgrade or an upgrade moves.
    assert.equal(report.status, testCase.status)
    const result = await runCli(fixture)
    assert.equal(result.code, testCase.exit, `the CLI exited ${result.code}`)
    assert.match(result.stdout, new RegExp(`status ${testCase.status}\\.`))
  })
}

test('every rule in the severity table is pinned by a run of the tool', () => {
  // The table is the source of truth; this is the list of rules that were
  // actually exercised above. A rule added to the table without a run that
  // emits it is a rule whose severity nobody watched happen.
  assert.deepEqual(
    CASES.map((testCase) => testCase.ruleId).sort(),
    Object.keys(RULE_SEVERITY).sort(),
  )
  assert.equal(new Set(CASES.map((testCase) => testCase.ruleId)).size, CASES.length)
})

test('the three severities differ in what they do, not only in what they are called', () => {
  // The whole reason severity is worth pinning: two of these outcomes are a
  // refusal and one is not.
  const outcomes = new Map()
  for (const testCase of CASES) {
    outcomes.set(testCase.severity, [...(outcomes.get(testCase.severity) ?? []), `${testCase.status}/${testCase.exit}`])
  }
  assert.deepEqual([...new Set(outcomes.get('error'))].sort(), ['fail/1', 'incomplete/2'])
  assert.deepEqual([...new Set(outcomes.get('warning'))].sort(), ['incomplete/2', 'pass/0'])
  assert.deepEqual([...new Set(outcomes.get('info'))], ['pass/0'])
})
