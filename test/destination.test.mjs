/**
 * The output destination, one test per hole and one per allowed shape.
 *
 * Every refusal below was a real, measured data loss in this tool before the
 * guard went in, driven through the real CLI: a 48-byte file outside both
 * snapshots became a 4554-byte bundle, and an 876-byte snapshot document
 * became a 2272-byte bundle, both while the run exited 0 and printed
 * "bundle written".
 *
 * The allowed cases are not decoration. A guard that refuses everything passes
 * every data-loss test while making the tool useless, so the shapes that must
 * still work are pinned in the same file as the shapes that must not.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'publication-diff-bundler.mjs')

const OUTSIDE_CONTENT = 'a file this tool was never asked to touch\n'

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'publication-diff-destination-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'before'), { recursive: true })
  await mkdir(join(root, 'after'), { recursive: true })
  await mkdir(join(root, 'dest'), { recursive: true })
  await mkdir(join(root, 'outside'), { recursive: true })
  await writeFile(join(root, 'before', 'index.html'), '<p>original</p>')
  await writeFile(join(root, 'after', 'index.html'), '<p>rewritten</p>')
  await writeFile(join(root, 'outside', 'precious.txt'), OUTSIDE_CONTENT)
  return root
}

async function runBundle(root, destination, extra = []) {
  const args = [
    cli,
    '--before', join(root, 'before'),
    '--after', join(root, 'after'),
    '--bundle', destination,
    '--bundle-root', join(root, 'dest'),
    ...extra,
  ]
  return execFileAsync(process.execPath, args, { cwd: projectDirectory }).then(
    (result) => ({ code: 0, ...result }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )
}

async function exists(path) {
  return stat(path).then(() => true, () => false)
}

// ---------------------------------------------------------------------------
// Hole 1: a symbolic link at the destination.
// ---------------------------------------------------------------------------

test('a symlink at the destination is refused, and the file it points at survives', async (t) => {
  const root = await workspace(t)
  const outside = join(root, 'outside', 'precious.txt')
  await symlink(outside, join(root, 'dest', 'bundle.json'))

  const result = await runBundle(root, join(root, 'dest', 'bundle.json'))

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'a refused destination is a configuration error, so stdout stays empty')
  assert.match(result.stderr, /symbolic link/)
  // The measurement that matters: the bundle is 4554 bytes and this file is 41.
  assert.equal(await readFile(outside, 'utf8'), OUTSIDE_CONTENT)
})

test('a symlink at the destination whose target does not exist yet creates nothing', async (t) => {
  // `realpath` fails on a dangling link, so a tool that resolves the
  // destination concludes "nothing is there" and writes -- which follows the
  // link and creates the file outside the tree the caller named.
  const root = await workspace(t)
  const wouldBeCreated = join(root, 'outside', 'created.json')
  await symlink(wouldBeCreated, join(root, 'dest', 'bundle.json'))

  const result = await runBundle(root, join(root, 'dest', 'bundle.json'))

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /symbolic link/)
  assert.equal(await exists(wouldBeCreated), false, 'the bundle was created outside the root')
})

// ---------------------------------------------------------------------------
// Hole 2: a symlinked parent directory.
// ---------------------------------------------------------------------------

test('a symlinked parent directory cannot carry the bundle out of the root', async (t) => {
  const root = await workspace(t)
  const outside = join(root, 'outside', 'precious.txt')
  // Lexically `dest/link/precious.txt` is inside --bundle-root. It is not.
  await symlink(join(root, 'outside'), join(root, 'dest', 'link'))

  const result = await runBundle(root, join(root, 'dest', 'link', 'precious.txt'))

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /outside the permitted root/)
  assert.equal(await readFile(outside, 'utf8'), OUTSIDE_CONTENT)
})

test('a lexical ".." segment cannot carry the bundle out of the root', async (t) => {
  const root = await workspace(t)
  const outside = join(root, 'outside', 'precious.txt')

  const result = await runBundle(root, join(root, 'dest', '..', 'outside', 'precious.txt'))

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /outside the permitted root/)
  assert.equal(await readFile(outside, 'utf8'), OUTSIDE_CONTENT)
})

// ---------------------------------------------------------------------------
// Hole 3: a hard link to an input.
// ---------------------------------------------------------------------------

test('a hard link to a snapshot document is refused, and the document survives', async (t) => {
  // A hard link has no target to resolve and shares no path with the document,
  // so `realpath` and string comparison both call it a different file. Only
  // device plus inode sees that it is the same file. This one destroyed an
  // 876-byte input here while the run exited 0.
  const root = await workspace(t)
  const document = join(root, 'before', 'index.html')
  await link(document, join(root, 'dest', 'bundle.json'))

  const result = await runBundle(root, join(root, 'dest', 'bundle.json'))

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /same file as an input/)
  assert.equal(await readFile(document, 'utf8'), '<p>original</p>')
})

test('a hard link to a snapshot document is refused even when it is the only name left', async (t) => {
  // The same identity check, reached through the second snapshot, so the test
  // cannot pass because only one side is compared.
  const root = await workspace(t)
  const document = join(root, 'after', 'index.html')
  await link(document, join(root, 'dest', 'bundle.json'))

  const result = await runBundle(root, join(root, 'dest', 'bundle.json'))

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /same file as an input/)
  assert.equal(await readFile(document, 'utf8'), '<p>rewritten</p>')
})

// ---------------------------------------------------------------------------
// Shapes that cannot be written at all.
// ---------------------------------------------------------------------------

test('a destination that is a directory is refused', async (t) => {
  const root = await workspace(t)
  await mkdir(join(root, 'dest', 'folder'))

  const result = await runBundle(root, join(root, 'dest', 'folder'))

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /not a regular file/)
})

test('a destination whose directory does not exist is refused rather than created', async (t) => {
  const root = await workspace(t)

  const result = await runBundle(root, join(root, 'dest', 'absent', 'bundle.json'))

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /directory that does not exist/)
  assert.equal(await exists(join(root, 'dest', 'absent')), false)
})

// ---------------------------------------------------------------------------
// The allowed cases. A guard that refuses these is a guard that broke the tool.
// ---------------------------------------------------------------------------

test('an ordinary destination inside the root is written', async (t) => {
  const root = await workspace(t)
  const destination = join(root, 'dest', 'bundle.json')

  const result = await runBundle(root, destination)

  assert.equal(result.code, 0)
  assert.match(result.stderr, /bundle written/)
  const bundle = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(bundle.tool, 'publication-diff-bundler')
  assert.equal(bundle.counts.compared, 1)
})

test('a destination in a subdirectory of the root is written', async (t) => {
  const root = await workspace(t)
  await mkdir(join(root, 'dest', 'nested'))
  const destination = join(root, 'dest', 'nested', 'bundle.json')

  const result = await runBundle(root, destination)

  assert.equal(result.code, 0)
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).counts.compared, 1)
})

test('an existing ordinary file inside the root is replaced', async (t) => {
  const root = await workspace(t)
  const destination = join(root, 'dest', 'bundle.json')
  await writeFile(destination, 'a stale bundle from the last run\n')

  const result = await runBundle(root, destination)

  assert.equal(result.code, 0)
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).counts.compared, 1)
})

test('a root reached through a symlinked ancestor still accepts its own files', async (t) => {
  // The mirror image of hole 2, and the reason the comparison is real path
  // against real path in both directions. On macOS the system temporary
  // directory is itself reached through a symlink, so a guard that compares a
  // resolved destination with an unresolved root refuses every legitimate
  // destination on the machine it is running on.
  const root = await workspace(t)
  await symlink(join(root, 'dest'), join(root, 'alias'))
  const destination = join(root, 'alias', 'bundle.json')

  const result = await execFileAsync(process.execPath, [
    cli,
    '--before', join(root, 'before'),
    '--after', join(root, 'after'),
    '--bundle', destination,
    '--bundle-root', join(root, 'alias'),
  ], { cwd: projectDirectory }).then(
    (value) => ({ code: 0, ...value }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )

  assert.equal(result.code, 0)
  assert.equal(JSON.parse(await readFile(join(root, 'dest', 'bundle.json'), 'utf8')).counts.compared, 1)
})

test('--bundle-root defaults to the working directory, and a destination outside it is refused', async (t) => {
  const root = await workspace(t)

  const result = await execFileAsync(process.execPath, [
    cli,
    '--before', join(root, 'before'),
    '--after', join(root, 'after'),
    '--bundle', join(root, 'dest', 'bundle.json'),
  ], { cwd: projectDirectory }).then(
    (value) => ({ code: 0, ...value }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /outside the permitted root/)
  assert.equal(await exists(join(root, 'dest', 'bundle.json')), false)
})

test('--bundle-root without --bundle is a usage error', async (t) => {
  const root = await workspace(t)

  const result = await execFileAsync(process.execPath, [
    cli,
    '--before', join(root, 'before'),
    '--after', join(root, 'after'),
    '--bundle-root', root,
  ], { cwd: projectDirectory }).then(
    (value) => ({ code: 0, ...value }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /no meaning without --bundle/)
})
