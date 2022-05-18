import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  DEFAULT_LIMITS,
  bundlePublicationDiff,
  compareFindingRows,
  createFinding,
  formatReport,
  snapshotDigest,
  validateWhitespace,
} from '../src/index.mjs'

const execFileAsync = promisify(execFile)

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const example = (name) => join(projectDirectory, 'examples', name)

async function tree(t, spec) {
  const root = await mkdtemp(join(tmpdir(), 'publication-diff-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(spec)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

async function fingerprint(root) {
  const entries = []
  async function walk(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(directory, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(path, relative)
      else entries.push(`${relative}:${createHash('sha256').update(await readFile(path)).digest('hex')}`)
    }
  }
  await walk(root, '')
  return entries.join('\n')
}

function rulesAt(report, file) {
  return report.findings.filter((finding) => finding.location.file === file).map((finding) => finding.ruleId)
}

function documentFor(bundle, file) {
  return bundle.documents.find((entry) => entry.file === file)
}

test('the shipped example pair passes with the whitespace-only reflow ignored', async () => {
  const { report, bundle } = await bundlePublicationDiff({
    before: example('snapshot-before'),
    after: example('snapshot-after-clean'),
  })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 3)
  assert.equal(report.summary.compared, 3)
  assert.equal(report.summary.errors, 0)
  assert.ok(report.summary.whitespaceOnly > 0, 'the clean example no longer exercises whitespace normalisation')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId).sort(), [
    'content-added',
    'link-text-changed',
    'metadata-added',
    'text-changed',
  ])
  assert.equal(bundle.complete, true)
  assert.equal(bundle.whitespace, 'collapse')
  assert.equal(documentFor(bundle, 'notes.md').state, 'compared')
  assert.deepEqual(documentFor(bundle, 'notes.md').changes, [])
})

test('a pass is never green on nothing: it carries the documents it examined', async () => {
  const { report } = await bundlePublicationDiff({
    before: example('snapshot-before'),
    after: example('snapshot-after-clean'),
  })
  assert.equal(report.status, 'pass')
  assert.ok(report.summary.checked > 0, 'a pass with checked 0 would be green on no evidence')
})

test('the shipped broken pair fails with every deletion and destination change visible', async () => {
  const { report, bundle } = await bundlePublicationDiff({
    before: example('snapshot-before'),
    after: example('snapshot-after-broken'),
  })

  assert.equal(report.status, 'fail')
  assert.deepEqual(rulesAt(report, 'guide/install.html'), ['document-removed'])
  assert.deepEqual(rulesAt(report, 'index.html').sort(), [
    'canonical-changed',
    'content-removed',
    'image-removed',
    'link-destination-changed',
  ])
  assert.deepEqual(rulesAt(report, 'notes.md').sort(), ['link-destination-changed', 'text-changed'])
  assert.equal(documentFor(bundle, 'guide/install.html').state, 'removed')
  assert.equal(documentFor(bundle, 'guide/install.html').after, null)
  assert.notEqual(documentFor(bundle, 'guide/install.html').before.sha256, null)
})

test('preserve turns the ignored reflow into a reported change', async () => {
  const collapsed = await bundlePublicationDiff({
    before: example('snapshot-before'),
    after: example('snapshot-after-clean'),
  })
  const preserved = await bundlePublicationDiff({
    before: example('snapshot-before'),
    after: example('snapshot-after-clean'),
    whitespace: 'preserve',
  })

  assert.equal(preserved.bundle.whitespace, 'preserve')
  assert.equal(preserved.report.summary.whitespaceOnly, 0)
  assert.ok(
    preserved.report.summary.warnings > collapsed.report.summary.warnings,
    'preserve reported no more than collapse did',
  )
  assert.equal(preserved.report.status, 'pass')
  assert.equal(rulesAt(preserved.report, 'index.html').includes('text-changed'), true)
  assert.equal(rulesAt(collapsed.report, 'index.html').includes('text-changed'), false)
})

test('neither snapshot is written to', async () => {
  const before = await fingerprint(example('snapshot-before'))
  const after = await fingerprint(example('snapshot-after-broken'))
  await bundlePublicationDiff({ before: example('snapshot-before'), after: example('snapshot-after-broken') })
  assert.equal(await fingerprint(example('snapshot-before')), before)
  assert.equal(await fingerprint(example('snapshot-after-broken')), after)
})

test('a document present on both sides but unreadable on one is unknown, never removed', async (t) => {
  const beforeRoot = await tree(t, { 'index.html': '<p>original</p>' })
  const afterRoot = await tree(t, { 'keep.html': '<p>keep</p>' })
  await symlink(join(afterRoot, 'no-such-target.html'), join(afterRoot, 'index.html'))

  const { report, bundle } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesAt(report, 'index.html'), ['document-unreadable'])
  // The defect this guards: reporting evidence that was never obtained as a
  // result. The document is sitting in the after snapshot; it was not deleted.
  assert.equal(rulesAt(report, 'index.html').includes('document-removed'), false)
  assert.equal(documentFor(bundle, 'index.html').state, 'unexamined')
  assert.equal(documentFor(bundle, 'index.html').after.sha256, null)
  assert.deepEqual(documentFor(bundle, 'index.html').changes, [])
  assert.equal(report.summary.unexamined, 1)
})

test('a non-UTF-8 document is hashed but never parsed, and never compared', async (t) => {
  const beforeRoot = await tree(t, { 'a.html': '<p>original</p>' })
  const afterRoot = await mkdtemp(join(tmpdir(), 'publication-diff-'))
  t.after(() => rm(afterRoot, { recursive: true, force: true }))
  await writeFile(join(afterRoot, 'a.html'), Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]))

  const { report, bundle } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesAt(report, 'a.html'), ['document-not-utf8'])
  assert.equal(documentFor(bundle, 'a.html').state, 'unexamined')
  assert.notEqual(documentFor(bundle, 'a.html').after.sha256, null)
  assert.deepEqual(documentFor(bundle, 'a.html').changes, [])
})

test('an empty pair of snapshots is incomplete, never a pass', async (t) => {
  const beforeRoot = await tree(t, { 'notes.txt': 'not a supported extension' })
  const afterRoot = await tree(t, { 'notes.txt': 'not a supported extension either' })

  const { report, bundle } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })

  // The finding is a warning, so the incomplete flag is the only thing
  // standing between this run and a green build. Deleting it turns this
  // assertion from "incomplete" into "pass".
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.errors, 0)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['no-documents-found'])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(bundle.complete, false)
})

test('every snapshot-level limit is enforced and makes the run incomplete', async (t) => {
  const spec = { 'a.html': '<p>a</p>', 'b.html': '<p>b</p>', 'deep/deeper/c.html': '<p>c</p>' }
  const beforeRoot = await tree(t, spec)
  const afterRoot = await tree(t, spec)

  const cases = [
    { ruleId: 'too-many-documents', limits: { maxDocuments: 1 } },
    { ruleId: 'document-too-large', limits: { maxDocumentBytes: 5 } },
    { ruleId: 'directory-too-deep', limits: { maxDepth: 1 } },
  ]

  for (const testCase of cases) {
    const { report } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot, limits: testCase.limits })
    assert.equal(report.status, 'incomplete', `${testCase.ruleId} did not make the run incomplete`)
    assert.equal(
      report.findings.some((finding) => finding.ruleId === testCase.ruleId),
      true,
      `${testCase.ruleId} was not reported`,
    )
  }

  const unbounded = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })
  assert.equal(unbounded.report.status, 'pass', 'the fixture fails for reasons other than the limits')
  assert.equal(unbounded.report.summary.checked, 3)
})

test('a per-document parse limit leaves the pair unexamined and the run incomplete', async (t) => {
  const spec = { 'a.html': '<p>one</p><p>two</p><p>three</p>' }
  const beforeRoot = await tree(t, spec)
  const afterRoot = await tree(t, spec)

  const { report, bundle } = await bundlePublicationDiff({
    before: beforeRoot,
    after: afterRoot,
    limits: { maxBlocks: 2 },
  })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesAt(report, 'a.html'), ['too-many-blocks', 'too-many-blocks'])
  assert.equal(documentFor(bundle, 'a.html').state, 'unexamined')
})

test('an over-budget alignment makes the run incomplete and names the dimension', async (t) => {
  const beforeRoot = await tree(t, {
    'a.html': Array.from({ length: 30 }, (_, index) => `<p>before ${index}</p>`).join(''),
  })
  const afterRoot = await tree(t, {
    'a.html': Array.from({ length: 30 }, (_, index) => `<p>after ${index}</p>`).join(''),
  })

  const { report, bundle } = await bundlePublicationDiff({
    before: beforeRoot,
    after: afterRoot,
    limits: { maxDiffCells: 100 },
  })

  assert.equal(report.status, 'incomplete')
  const finding = report.findings.find((item) => item.ruleId === 'diff-too-large')
  assert.equal(finding.location.pointer, '/blocks')
  assert.equal(documentFor(bundle, 'a.html').state, 'partial')
  assert.deepEqual(documentFor(bundle, 'a.html').changes, [])

  // Within budget the same pair is fully compared: thirty rewritten blocks,
  // every one of them reported, and the run is complete.
  const allowed = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })
  assert.equal(allowed.report.status, 'pass')
  assert.equal(allowed.bundle.documents[0].state, 'compared')
  assert.equal(allowed.bundle.documents[0].changes.length, 30)
})

test('the source hash ties the bundle to exactly what was compared', async (t) => {
  const first = await tree(t, { 'a.html': '<p>one</p>' })
  const identical = await tree(t, { 'a.html': '<p>one</p>' })
  const changed = await tree(t, { 'a.html': '<p>two</p>' })
  const moved = await tree(t, { 'b.html': '<p>one</p>' })

  const same = await bundlePublicationDiff({ before: first, after: identical })
  assert.equal(same.bundle.snapshots.before.digest, same.bundle.snapshots.after.digest)
  assert.equal(same.report.status, 'pass')
  assert.equal(same.report.summary.changes, 0)

  const differs = await bundlePublicationDiff({ before: first, after: changed })
  assert.notEqual(differs.bundle.snapshots.before.digest, differs.bundle.snapshots.after.digest)

  // The digest covers the path as well as the bytes, so moving a document
  // cannot produce the digest of the snapshot it was moved out of.
  const renamed = await bundlePublicationDiff({ before: first, after: moved })
  assert.notEqual(renamed.bundle.snapshots.before.digest, renamed.bundle.snapshots.after.digest)
  assert.equal(renamed.bundle.snapshots.before.files[0].sha256, renamed.bundle.snapshots.after.files[0].sha256)
  assert.match(same.bundle.snapshots.before.digest, /^sha256:[0-9a-f]{64}$/)
})

test('findings are ordered by file, then pointer, then rule id', async (t) => {
  const beforeRoot = await tree(t, {
    'b.html': '<p>kept</p><p>dropped</p>',
    'a.html': '<a href="/one">one</a>',
  })
  const afterRoot = await tree(t, {
    'b.html': '<p>kept</p>',
    'a.html': '<a href="/two">one</a>',
  })
  await symlink(join(beforeRoot, 'gone-target.html'), join(beforeRoot, 'a-orphan.html'))

  const { report } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })

  assert.deepEqual(
    report.findings.map((finding) => [finding.location.file, finding.location.pointer, finding.ruleId]),
    [
      // Two findings share a file and a pointer here, so the rule id is what
      // separates them; the remaining rows exercise the file and pointer keys.
      ['a-orphan.html', '/before', 'document-removed'],
      ['a-orphan.html', '/before', 'document-unreadable'],
      ['a.html', '/after/links/0', 'link-destination-changed'],
      ['b.html', '/before/blocks/1', 'content-removed'],
    ],
  )
})

test('each key of the documented finding order carries its own weight', () => {
  // One row per key. Drop any single comparison from compareFindingRows and
  // this expectation changes: the message ordering deliberately disagrees with
  // the rule id ordering, and the pointer ordering with the rule id ordering.
  const rows = [
    { file: 'b.html', pointer: '/a', ruleId: 'a-rule', message: 'm' },
    { file: 'a.html', pointer: '/b', ruleId: 'a-rule', message: 'm' },
    { file: 'a.html', pointer: '/a', ruleId: 'b-rule', message: 'm' },
    { file: 'a.html', pointer: '/a', ruleId: 'a-rule', message: 'zz' },
    { file: 'a.html', pointer: '/a', ruleId: 'a-rule', message: 'aa' },
  ]
  assert.deepEqual(
    rows.slice().sort(compareFindingRows).map((row) => `${row.file}${row.pointer} ${row.ruleId} ${row.message}`),
    [
      'a.html/a a-rule aa',
      'a.html/a a-rule zz',
      'a.html/a b-rule m',
      'a.html/b a-rule m',
      'b.html/a a-rule m',
    ],
  )
})

test('the rule id breaks a tie the message would order the other way', async (t) => {
  // A document that is over the byte limit and absent from the after snapshot
  // reports twice at the same file and pointer. Sorted by rule id,
  // `document-removed` comes first; sorted by message, `document-too-large`
  // would, because "Document is 25 bytes" precedes "Document is present".
  const beforeRoot = await tree(t, { 'big.html': '<p>a paragraph over the limit</p>' })
  const afterRoot = await tree(t, { 'other.html': '<p>x</p>' })

  const { report } = await bundlePublicationDiff({
    before: beforeRoot,
    after: afterRoot,
    limits: { maxDocumentBytes: 10 },
  })

  const atBig = report.findings.filter((finding) => finding.location.file === 'big.html')
  assert.deepEqual(atBig.map((finding) => finding.location.pointer), ['/before', '/before'])
  assert.deepEqual(atBig.map((finding) => finding.ruleId), ['document-removed', 'document-too-large'])
  assert.ok(
    atBig[1].message < atBig[0].message,
    'the fixture no longer makes the message order disagree with the rule id order',
  )
})

test('an identifier containing a newline cannot forge a line in the human report', async (t) => {
  const forged = `evil${String.fromCharCode(10)}ERROR   forged/injected.html/ forged-rule injected.html`
  const beforeRoot = await tree(t, { [`${forged}.html`]: '<p>original</p>' })
  const afterRoot = await tree(t, { 'other.html': '<p>other</p>' })

  const { report, bundle } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })
  const text = formatReport(report, bundle)

  assert.equal(report.findings.some((finding) => finding.location.file.includes(String.fromCharCode(10))), false)
  assert.equal(
    text.split(String.fromCharCode(10)).filter((line) => line.startsWith('ERROR')).length,
    1,
    'a sanitised identifier still produced two error lines',
  )
  assert.equal(bundle.documents.some((entry) => entry.file.includes(String.fromCharCode(10))), false)
  assert.equal(bundle.snapshots.before.files.some((entry) => entry.file.includes(String.fromCharCode(10))), false)
})

test('a control or bidi character reaching output through an identifier is stripped', async (t) => {
  // Three different routes into the output, and the first two are identifiers
  // rather than excerpts: a relative path, a metadata key, and a block of
  // prose. U+0085 (NEL) starts a new line on a terminal exactly as a newline
  // does, U+009B is the 8-bit CSI, U+202E reverses everything displayed after
  // it, and U+2066 hides what it wraps. None of them is ECMAScript whitespace
  // and none is escaped by JSON.stringify, so a class that stops at C0 and the
  // two separators lets every one of them through to stdout intact.
  const NEL = String.fromCharCode(0x85)
  const CSI = String.fromCharCode(0x9b)
  const RLO = String.fromCharCode(0x202e)
  const SEPARATOR = String.fromCharCode(0x2028)
  const ISOLATE = String.fromCharCode(0x2066)
  const forbidden = [NEL, CSI, RLO, SEPARATOR, ISOLATE, String.fromCharCode(0x7f), String.fromCharCode(0)]

  const beforeRoot = await tree(t, { 'index.html': '<html><head></head><body><p>kept</p></body></html>' })
  const afterRoot = await tree(t, {
    [`evil${NEL}ERROR   forged-rule was never emitted.html`]: '<p>added</p>',
    'index.html':
      `<html><head><meta name="key${RLO}reversed" content="value${CSI}m"></head>` +
      `<body><p>kept${SEPARATOR}${ISOLATE}rewritten</p></body></html>`,
  })

  const { report, bundle } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })
  const emitted = `${formatReport(report, bundle)}${JSON.stringify(report)}${JSON.stringify(bundle)}`

  for (const character of forbidden) {
    assert.equal(
      emitted.includes(character),
      false,
      `U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} reached the output`,
    )
  }
  // Each route really was exercised: the path and the key arrived as
  // identifiers, the prose as an excerpt.
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file).sort(),
    ['evil ERROR forged-rule was never emitted.html', 'index.html', 'index.html'],
  )
  assert.equal(
    report.findings.some((finding) => finding.location.pointer === '/after/metadata/meta:name=key reversed'),
    true,
    'the metadata key never reached a pointer, so this fixture proves nothing about identifiers',
  )
  assert.equal(
    report.findings.some((finding) => finding.evidence !== undefined && finding.evidence.includes('rewritten')),
    true,
    'no excerpt reached the evidence field, so this fixture proves nothing about excerpts',
  )
  // The forged line is flattened into the line it was smuggled into.
  const lines = formatReport(report, bundle).split(String.fromCharCode(10))
  assert.equal(lines.filter((line) => line.startsWith('ERROR')).length, 0)
  assert.equal(lines.filter((line) => line.includes('forged-rule was never emitted')).length, 1)
})

test('options, limits and the whitespace mode are validated rather than guessed at', async () => {
  const before = example('snapshot-before')
  const after = example('snapshot-after-clean')

  await assert.rejects(() => bundlePublicationDiff({ before, after, whitespac: 'collapse' }), TypeError)
  await assert.rejects(() => bundlePublicationDiff({ before, after, whitespace: 'trim' }), TypeError)
  await assert.rejects(() => bundlePublicationDiff({ before, after, limits: { maxDocument: 5 } }), TypeError)
  await assert.rejects(() => bundlePublicationDiff({ before, after, limits: { maxDocuments: 0 } }), TypeError)
  await assert.rejects(() => bundlePublicationDiff({ before }), TypeError)
  await assert.rejects(() => bundlePublicationDiff({ before, after: join(before, 'index.html') }), TypeError)
  await assert.rejects(() => bundlePublicationDiff({ before, after: join(before, 'missing') }), TypeError)
  await assert.rejects(() => bundlePublicationDiff('not an object'), TypeError)
})

test('every limit the CLI documents exists in the shipped defaults', () => {
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), [
    'maxBlocks',
    'maxDepth',
    'maxDiffCells',
    'maxDocumentBytes',
    'maxDocuments',
    'maxImages',
    'maxLinks',
    'maxMetadata',
  ])
})

test('a directory that cannot be listed is reported and makes the run incomplete', async (t) => {
  // Cleanup is registered before the mode is changed, so the tree is always
  // readable again by the time it is removed.
  const beforeRoot = await tree(t, { 'section/a.html': '<p>a</p>' })
  const afterRoot = await mkdtemp(join(tmpdir(), 'publication-diff-'))
  const locked = join(afterRoot, 'section')
  t.after(async () => {
    await chmod(locked, 0o755).catch(() => {})
    await rm(afterRoot, { recursive: true, force: true })
  })
  await mkdir(locked, { recursive: true })
  await writeFile(join(locked, 'a.html'), '<p>a</p>')
  await chmod(locked, 0o000)

  // A process that can read the directory anyway -- root, or a filesystem
  // without POSIX modes -- would make the assertion below meaningless.
  const enforced = await readdir(locked).then(() => false, () => true)
  if (!enforced) {
    t.skip('the filesystem did not enforce the mode change')
    return
  }

  const { report } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesAt(report, 'section'), ['snapshot-unreadable'])
})

test('a document that cannot be opened is reported and makes the run incomplete', async (t) => {
  const beforeRoot = await tree(t, { 'a.html': '<p>a</p>' })
  const afterRoot = await mkdtemp(join(tmpdir(), 'publication-diff-'))
  const locked = join(afterRoot, 'a.html')
  t.after(async () => {
    await chmod(locked, 0o644).catch(() => {})
    await rm(afterRoot, { recursive: true, force: true })
  })
  await writeFile(locked, '<p>a</p>')
  await chmod(locked, 0o000)

  const enforced = await readFile(locked).then(() => false, () => true)
  if (!enforced) {
    t.skip('the filesystem did not enforce the mode change')
    return
  }

  const { report, bundle } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesAt(report, 'a.html'), ['document-unreadable'])
  assert.equal(documentFor(bundle, 'a.html').state, 'unexamined')
})

test('an entry named like a document that is not a regular file is never read from', async (t) => {
  const beforeRoot = await tree(t, { 'keep.html': '<p>keep</p>' })
  const afterRoot = await tree(t, { 'keep.html': '<p>keep</p>' })
  const fifo = join(afterRoot, 'pipe.html')
  const made = await execFileAsync('mkfifo', [fifo]).then(() => true, () => false)
  if (!made) {
    t.skip('mkfifo is not available on this host')
    return
  }

  // Reading a FIFO can block forever, so it is listed as present, reported,
  // and never opened.
  const { report, bundle } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(rulesAt(report, 'pipe.html'), ['document-added', 'document-unreadable'])
  assert.equal(documentFor(bundle, 'pipe.html').after.sha256, null)
})

test('the snapshot digest follows the documented line format exactly', async (t) => {
  const small = '<p>small</p>'
  const big = `<p>${'x'.repeat(200)}</p>`
  const beforeRoot = await tree(t, { 'small.html': small, 'big.html': big })
  const afterRoot = await tree(t, { 'small.html': small, 'big.html': big })

  const { bundle } = await bundlePublicationDiff({
    before: beforeRoot,
    after: afterRoot,
    limits: { maxDocumentBytes: 100 },
  })

  // Recomputed here from the format written down in docs/diff-rules.md, so a
  // change to the format -- including how an unread document is marked -- has
  // to walk past this expectation.
  const smallHash = createHash('sha256').update(Buffer.from(small)).digest('hex')
  const expected = `sha256:${createHash('sha256')
    .update(`unread - ${JSON.stringify('big.html')}\n`, 'utf8')
    .update(`${smallHash} ${Buffer.byteLength(small)} ${JSON.stringify('small.html')}\n`, 'utf8')
    .digest('hex')}`

  assert.equal(bundle.snapshots.before.digest, expected)
  assert.equal(bundle.snapshots.after.digest, expected)
  assert.deepEqual(bundle.snapshots.before.files.map((entry) => entry.sha256), [null, smallHash])
  assert.equal(snapshotDigest([]), `sha256:${createHash('sha256').digest('hex')}`)
})

test('an unknown whitespace mode is refused up front, naming the modes that exist', () => {
  assert.equal(validateWhitespace(undefined), 'collapse')
  assert.equal(validateWhitespace('preserve'), 'preserve')
  assert.throws(() => validateWhitespace('trim'), /use one of collapse, preserve/)
})

test('a document listed under a directory sorts after a sibling file of the same stem', async (t) => {
  // Discovery order is depth-first, so `b/x.html` is found before `b.html`.
  // Code-unit order is the other way round, because `.` precedes `/`. Without
  // the explicit sort over relative paths the report comes out backwards.
  const beforeRoot = await tree(t, { 'b.html': '<p>one</p>', 'b/x.html': '<p>two</p>' })
  const afterRoot = await tree(t, { 'b.html': '<p>ONE</p>', 'b/x.html': '<p>TWO</p>' })

  const { report, bundle } = await bundlePublicationDiff({ before: beforeRoot, after: afterRoot })
  assert.deepEqual(report.findings.map((finding) => finding.location.file), ['b.html', 'b/x.html'])
  assert.deepEqual(bundle.snapshots.before.files.map((entry) => entry.file), ['b.html', 'b/x.html'])
})

test('createFinding refuses a rule with no pinned severity', () => {
  assert.throws(
    () => createFinding({ ruleId: 'invented-rule', message: 'x', file: 'a.html', pointer: '/' }),
    /not in RULE_SEVERITY/,
  )
  const finding = createFinding({ ruleId: 'content-removed', message: 'x', file: 'a.html', pointer: '/' })
  assert.equal(finding.severity, 'error')
  assert.equal(Object.hasOwn(finding, 'evidence'), false)
})
