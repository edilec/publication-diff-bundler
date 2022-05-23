import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { bundlePublicationDiff } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'publication-diff-bundler.mjs')

const BEFORE = {
  'index.html': '<html lang="en"><head><title>Notes</title>' +
    '<meta name="description" content="How a tray is sized.">' +
    '<link rel="canonical" href="https://example.invalid/notes"></head>' +
    '<body><p>First paragraph.</p><p>Second paragraph.</p>' +
    '<a href="/guide">guide</a><img src="/a.png" alt="a"></body></html>',
  'deep/nested.md': '---\ntitle: Nested\n---\n\n# Nested\n\nA [link](/one) and ![an image](/b.png).\n',
}

const AFTER = {
  'index.html': '<html lang="en"><head><title>Notes</title>' +
    '<meta name="description" content="How a tray is sized.">' +
    '<link rel="canonical" href="https://example.invalid/articles/notes"></head>' +
    '<body><p>First\n   paragraph.</p>' +
    '<a href="/guide/install">guide</a><img src="/a.png" alt="a cable tray"></body></html>',
  'deep/nested.md': '---\ntitle: Nested\n---\n\n# Nested\n\nA [link](/two) and ![an image](/b.png).\n',
}

async function build(t, spec, order = Object.keys(spec)) {
  const root = await mkdtemp(join(tmpdir(), 'publication-diff-stable-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of order) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, spec[path])
  }
  return root
}

async function runJson(before, after, cwd) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, '--before', before, '--after', after, '--json'],
    { cwd },
  ).catch((error) => ({ stdout: error.stdout }))
  return stdout
}

test('two runs over the same pair produce byte-identical output', async (t) => {
  const before = await build(t, BEFORE)
  const after = await build(t, AFTER)

  const first = await runJson(before, after, projectDirectory)
  const second = await runJson(before, after, projectDirectory)
  assert.equal(first, second)
  assert.ok(first.length > 500, 'the fixture produced too little output to be worth comparing')
  assert.equal(JSON.parse(first).status, 'fail')
})

test('the bundle is byte-identical for the same content in a different location', async (t) => {
  // No absolute path, no host detail and no clock reading may reach the
  // bundle, so the same two snapshots in two different temporary directories
  // must serialise to the same bytes.
  const firstPair = [await build(t, BEFORE), await build(t, AFTER)]
  const secondPair = [await build(t, BEFORE), await build(t, AFTER)]

  const first = await bundlePublicationDiff({ before: firstPair[0], after: firstPair[1] })
  const second = await bundlePublicationDiff({ before: secondPair[0], after: secondPair[1] })

  assert.equal(JSON.stringify(first.bundle, null, 2), JSON.stringify(second.bundle, null, 2))
  assert.equal(first.bundle.snapshots.before.digest, second.bundle.snapshots.before.digest)
  assert.notEqual(first.bundle.snapshots.before.digest, first.bundle.snapshots.after.digest)

  // The premise the comparison above rests on. Asserting that the two
  // mkdtemp roots differ cannot fail -- mkdtemp always returns a fresh
  // directory -- so it defends nothing. What can fail is this comparison
  // going vacuous: two bundles that examined less than the fixture holds,
  // or nothing at all, are byte-identical for the wrong reason.
  assert.equal(first.bundle.documents.length, 2, 'the fixture no longer reaches both documents')
  assert.equal(first.bundle.counts.compared, 2)
  assert.equal(first.bundle.counts.changes, 6)
  assert.deepEqual(first.bundle.documents.map((entry) => entry.file), ['deep/nested.md', 'index.html'])
})

test('the output carries no absolute path, host detail or clock reading', async (t) => {
  const before = await build(t, BEFORE)
  const after = await build(t, AFTER)
  const { report, bundle } = await bundlePublicationDiff({ before, after })
  const serialized = `${JSON.stringify(report)}\n${JSON.stringify(bundle)}`

  assert.equal(serialized.includes(before), false)
  assert.equal(serialized.includes(after), false)
  assert.equal(serialized.includes(tmpdir()), false)
  assert.equal(serialized.includes(projectDirectory), false)
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(serialized), false, 'the output carries a timestamp')
  assert.equal(/"(generatedAt|timestamp|createdAt|date)"/.test(serialized), false)
  for (const finding of report.findings) {
    assert.equal(finding.location.file.startsWith('/'), false)
  }
})

test('output does not depend on the working directory it was run from', async (t) => {
  const before = await build(t, BEFORE)
  const after = await build(t, AFTER)

  const fromProject = await runJson(before, after, projectDirectory)
  const fromElsewhere = await runJson(before, after, tmpdir())
  assert.equal(fromProject, fromElsewhere)
})

test('output does not depend on the order the files were created in', async (t) => {
  const reversed = Object.keys(BEFORE).slice().reverse()
  const first = await bundlePublicationDiff({
    before: await build(t, BEFORE),
    after: await build(t, AFTER),
  })
  const second = await bundlePublicationDiff({
    before: await build(t, BEFORE, reversed),
    after: await build(t, AFTER, reversed),
  })

  assert.deepEqual(first.bundle, second.bundle)
  assert.deepEqual(
    first.report.findings.map((finding) => finding.location.file),
    ['deep/nested.md', 'deep/nested.md', 'index.html', 'index.html', 'index.html', 'index.html'],
  )
})

test('the example bundle regenerates byte for byte', async (t) => {
  const destination = await mkdtemp(join(tmpdir(), 'publication-diff-out-'))
  t.after(() => rm(destination, { recursive: true, force: true }))

  const runs = []
  for (const name of ['first.json', 'second.json']) {
    await execFileAsync(process.execPath, [
      cli,
      '--before', join(projectDirectory, 'examples', 'snapshot-before'),
      '--after', join(projectDirectory, 'examples', 'snapshot-after-broken'),
      '--bundle', join(destination, name),
      '--bundle-root', destination,
      '--json',
    ], { cwd: projectDirectory }).catch((error) => error)
    runs.push(await readFile(join(destination, name), 'utf8'))
  }

  assert.equal(runs[0], runs[1])
  assert.ok(runs[0].endsWith('\n'), 'the bundle file does not end with a newline')
  assert.equal(JSON.parse(runs[0]).counts.changes, 7)
})
