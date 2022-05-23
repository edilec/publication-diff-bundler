import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { bundlePublicationDiff, compareFindingRows } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'publication-diff-bundler.mjs')

/**
 * Ordering, pinned by what the tool emits rather than by how it is spelled.
 *
 * Grepping the source for `.localeCompare(` is not a determinism test: an
 * `Intl.Collator` drops the forbidden literal and collates exactly as badly,
 * so the grep passes while the order of a report starts depending on the ICU
 * data of whichever host ran it. Every fixture below is chosen so that
 * code-unit order and collation order genuinely disagree -- `Ab` `Sa` `_b`,
 * `Z` before `a`, `a-b` before `a_b` -- and each assertion names the exact
 * order the tool must emit. Swap any comparator in this tool for a collator
 * and these go red.
 */

const CODE_UNIT_PATHS = ['Ab.html', 'Sa.html', '_b.html']

async function tree(t, spec) {
  const root = await mkdtemp(join(tmpdir(), 'publication-diff-order-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(spec)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

async function runCli(args) {
  return execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout }))
}

test('paths reach the report and the bundle in code-unit order', async (t) => {
  // A collator orders these `_b.html`, `Ab.html`, `Sa.html`: it sorts the
  // underscore as punctuation before every letter and folds case. Code units
  // put `A` (0x41) before `S` (0x53) before `_` (0x5F).
  const before = await tree(t, Object.fromEntries(CODE_UNIT_PATHS.map((path) => [path, '<p>one</p>'])))
  const after = await tree(t, Object.fromEntries(CODE_UNIT_PATHS.map((path) => [path, '<p>two</p>'])))
  const destination = join(await mkdtemp(join(tmpdir(), 'publication-diff-order-out-')), 'bundle.json')
  t.after(() => rm(dirname(destination), { recursive: true, force: true }))

  const result = await runCli([
    '--before', before,
    '--after', after,
    '--bundle', destination,
    '--bundle-root', dirname(destination),
    '--json',
  ])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  const bundle = JSON.parse(await readFile(destination, 'utf8'))

  assert.deepEqual(report.findings.map((finding) => finding.location.file), CODE_UNIT_PATHS)
  assert.deepEqual(bundle.documents.map((entry) => entry.file), CODE_UNIT_PATHS)
  for (const side of ['before', 'after']) {
    assert.deepEqual(
      bundle.snapshots[side].files.map((entry) => entry.file),
      CODE_UNIT_PATHS,
      `the ${side} listing is not in code-unit order`,
    )
  }
})

test('the library orders the same paths the same way', async (t) => {
  const before = await tree(t, Object.fromEntries(CODE_UNIT_PATHS.map((path) => [path, '<p>one</p>'])))
  const after = await tree(t, Object.fromEntries(CODE_UNIT_PATHS.map((path) => [path, '<p>two</p>'])))

  const { report, bundle } = await bundlePublicationDiff({ before, after })
  assert.deepEqual(report.findings.map((finding) => finding.location.file), CODE_UNIT_PATHS)
  assert.deepEqual(bundle.documents.map((entry) => entry.file), CODE_UNIT_PATHS)
  assert.deepEqual(bundle.snapshots.after.files.map((entry) => entry.file), CODE_UNIT_PATHS)
})

test('directory entries are walked in code-unit order', async (t) => {
  // `Zmirror` is a symlink to the sibling directory `areal`. The subtree is
  // walked once, under whichever name comes first, so the name that reaches
  // the report says which order the listing was walked in: code units put
  // `Z` (0x5A) before `a` (0x61), a collator puts `areal` first.
  const before = await tree(t, { 'index.html': '<p>same</p>' })
  const after = await tree(t, { 'index.html': '<p>same</p>', 'areal/extra.html': '<p>extra</p>' })
  await symlink('areal', join(after, 'Zmirror'))

  const { report } = await bundlePublicationDiff({ before, after })
  assert.deepEqual(
    report.findings.map((finding) => finding.location.file),
    ['Zmirror/extra.html'],
    'the walk visited the sibling directories in an order that is not by code unit',
  )
})

test('metadata changes are produced and reported in code-unit order by key', async (t) => {
  // `a-b` and `a_b` are the pair a collator orders the other way round: it
  // weights the connector `_` (0x5F) below the dash `-` (0x2D), code units do
  // the opposite. The production order in the bundle comes from the metadata
  // key sort; the report order comes from the finding sort's pointer key.
  const page = (content) =>
    `<html><head><meta name="a-b" content="${content}"><meta name="a_b" content="${content}">` +
    '</head><body><p>same</p></body></html>'
  const before = await tree(t, { 'index.html': page('one') })
  const after = await tree(t, { 'index.html': page('two') })

  const { report, bundle } = await bundlePublicationDiff({ before, after })

  assert.deepEqual(
    bundle.documents[0].changes.map((change) => change.pointer),
    ['/after/metadata/meta:name=a-b', '/after/metadata/meta:name=a_b'],
    'metadata keys were not produced in code-unit order',
  )
  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer),
    ['/after/metadata/meta:name=a-b', '/after/metadata/meta:name=a_b'],
    'findings were not ordered by pointer in code-unit order',
  )
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['metadata-changed', 'metadata-changed'])
})

test('every key of the finding order is compared by code unit', () => {
  // One pair per key, each spelled so that a collator disagrees with code
  // units: `a-b` before `a_b` by code unit, the other way round by collation.
  // Substituting a collator for any one of the four comparisons flips exactly
  // one of these assertions.
  const row = (overrides) => ({ file: 'a.html', pointer: '/p', ruleId: 'r', message: 'm', ...overrides })
  const keys = ['file', 'pointer', 'ruleId', 'message']
  for (const key of keys) {
    const dash = row({ [key]: key === 'pointer' ? '/a-b' : 'a-b' })
    const underscore = row({ [key]: key === 'pointer' ? '/a_b' : 'a_b' })
    assert.equal(compareFindingRows(dash, underscore), -1, `${key} is not compared by code unit`)
    assert.equal(compareFindingRows(underscore, dash), 1, `${key} is not compared by code unit`)
    assert.deepEqual(
      [underscore, dash].sort(compareFindingRows).map((entry) => entry[key]),
      key === 'pointer' ? ['/a-b', '/a_b'] : ['a-b', 'a_b'],
    )
  }
  assert.equal(compareFindingRows(row({}), row({})), 0)
})

test('the whole report is byte-identical to the order written down here', async (t) => {
  // The human report is the artifact an editor reads. Pinning it in full
  // catches an ordering change that slipped past every field-by-field
  // assertion above.
  const before = await tree(t, Object.fromEntries(CODE_UNIT_PATHS.map((path) => [path, '<p>one</p>'])))
  const after = await tree(t, Object.fromEntries(CODE_UNIT_PATHS.map((path) => [path, '<p>two</p>'])))

  const result = await runCli(['--before', before, '--after', after])
  assert.equal(result.code, 0)
  assert.deepEqual(
    result.stdout.split(String.fromCharCode(10)).filter((line) => line.startsWith('WARNING')),
    [
      'WARNING Ab.html/after/blocks/0 text-changed A text block was rewritten between the two snapshots.',
      'WARNING Sa.html/after/blocks/0 text-changed A text block was rewritten between the two snapshots.',
      'WARNING _b.html/after/blocks/0 text-changed A text block was rewritten between the two snapshots.',
    ],
  )
})
