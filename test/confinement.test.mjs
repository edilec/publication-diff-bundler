import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  bundlePublicationDiff,
  isInside,
  resolveBundleDestination,
  writeBundleFile,
} from '../src/index.mjs'

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'publication-diff-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'before'), { recursive: true })
  await mkdir(join(root, 'after'), { recursive: true })
  await writeFile(join(root, 'before', 'index.html'), '<p>original</p>')
  await writeFile(join(root, 'after', 'index.html'), '<p>original</p>')
  return root
}

test('isInside separates a child from a sibling that merely shares a prefix', () => {
  assert.equal(isInside('/a/b', '/a/b/c.html'), true)
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/bc/d.html'), false)
  assert.equal(isInside('/a/b', '/a'), false)
})

test('a symlink that escapes the snapshot root is refused and its content is never read', async (t) => {
  const root = await workspace(t)
  const secret = join(root, 'outside.html')
  await writeFile(secret, '<p>outside-the-root-marker</p>')
  await symlink(secret, join(root, 'after', 'leak.html'))

  const { report, bundle } = await bundlePublicationDiff({
    before: join(root, 'before'),
    after: join(root, 'after'),
  })

  const refusal = report.findings.find((finding) => finding.ruleId === 'path-escapes-root')
  assert.equal(refusal.location.file, 'leak.html')
  assert.equal(refusal.severity, 'error')
  // Refusing to follow the link is only half of it: nothing from the other
  // side of it may appear anywhere in the output.
  const serialized = `${JSON.stringify(report)}${JSON.stringify(bundle)}`
  assert.equal(serialized.includes('outside-the-root-marker'), false)
  assert.equal(serialized.includes(secret), false)
  // The entry is present in the snapshot and was not examined, so the run
  // cannot claim to be complete. Its presence in the after listing is a fact
  // and is reported; nothing about its content is.
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.filter((finding) => finding.location.file === 'leak.html').map((finding) => finding.ruleId),
    ['document-added', 'path-escapes-root'],
  )
  const entry = bundle.documents.find((item) => item.file === 'leak.html')
  assert.equal(entry.after.sha256, null)
  assert.deepEqual(entry.changes, [])
})

test('a legitimate document reached through a symlinked root is compared, not refused', async (t) => {
  // The over-correction of the confinement defect: comparing a realpath-ed
  // root against a raw candidate path refuses files that are genuinely inside
  // the snapshot. A false refusal is a bug too.
  const root = await workspace(t)
  await writeFile(join(root, 'after', 'index.html'), '<p>rewritten</p>')
  await symlink(join(root, 'after'), join(root, 'after-link'))

  const { report } = await bundlePublicationDiff({
    before: join(root, 'before'),
    after: join(root, 'after-link'),
  })

  assert.equal(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'), false)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.compared, 1)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['text-changed'])
})

test('a symlinked directory that stays inside the root is walked normally', async (t) => {
  const root = await workspace(t)
  await mkdir(join(root, 'after', 'real'), { recursive: true })
  await writeFile(join(root, 'after', 'real', 'extra.html'), '<p>extra</p>')
  await symlink(join(root, 'after', 'real'), join(root, 'after', 'mirror'))

  const { report } = await bundlePublicationDiff({
    before: join(root, 'before'),
    after: join(root, 'after'),
  })

  assert.equal(report.findings.some((finding) => finding.ruleId === 'path-escapes-root'), false)
  const added = report.findings.filter((finding) => finding.ruleId === 'document-added')
  // A real path is visited once. Entries are walked in code-unit order, so
  // `mirror` is the path that reaches the report and `real` is recognised as
  // the same file rather than counted twice.
  assert.deepEqual(added.map((finding) => finding.location.file), ['mirror/extra.html'])
})

test('the bundle destination is refused inside either snapshot root', async (t) => {
  const root = await workspace(t)
  const roots = [join(root, 'before'), join(root, 'after')]

  await assert.rejects(
    () => resolveBundleDestination(roots, join(root, 'before', 'bundle.json')),
    /inside a snapshot root/,
  )
  await assert.rejects(
    () => resolveBundleDestination(roots, join(root, 'after', 'nested', 'bundle.json')),
    /inside a snapshot root/,
  )
  const outside = await resolveBundleDestination(roots, join(root, 'bundle.json'))
  assert.equal(outside.endsWith('bundle.json'), true)
})

test('a symlinked parent directory cannot smuggle the bundle into a snapshot', async (t) => {
  const root = await workspace(t)
  const roots = [join(root, 'before'), join(root, 'after')]
  await symlink(join(root, 'before'), join(root, 'reports'))

  // Lexically `reports/bundle.json` is outside both roots. It is not.
  await assert.rejects(
    () => resolveBundleDestination(roots, join(root, 'reports', 'bundle.json')),
    /inside a snapshot root/,
  )
})

test('the bundle destination refuses shapes it cannot write', async (t) => {
  const root = await workspace(t)
  const roots = [join(root, 'before'), join(root, 'after')]

  await assert.rejects(() => resolveBundleDestination(roots, ''), /non-empty path/)
  await assert.rejects(() => resolveBundleDestination(roots, root), /not a file/)
})

test('writing the bundle leaves both snapshots untouched', async (t) => {
  const root = await workspace(t)
  await writeFile(join(root, 'after', 'index.html'), '<p>rewritten</p>')
  const roots = [join(root, 'before'), join(root, 'after')]

  const { bundle } = await bundlePublicationDiff({ before: roots[0], after: roots[1] })
  const destination = await resolveBundleDestination(roots, join(root, 'out', 'bundle.json'))
  await writeBundleFile(destination, bundle)

  assert.equal(await readFile(join(root, 'before', 'index.html'), 'utf8'), '<p>original</p>')
  assert.equal(await readFile(join(root, 'after', 'index.html'), 'utf8'), '<p>rewritten</p>')
  const written = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(written.tool, 'publication-diff-bundler')
  assert.equal(written.counts.compared, 1)
})
