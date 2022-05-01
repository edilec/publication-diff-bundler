import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'publication-diff-bundler.mjs')
const example = (name) => join('examples', name)

async function run(args, cwd = projectDirectory) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { cwd })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'publication-diff-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'before'), { recursive: true })
  await mkdir(join(root, 'after'), { recursive: true })
  return root
}

test('--help prints usage on stdout and exits 0', async () => {
  const result = await run(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^publication-diff-bundler/)
  for (const flag of ['--before', '--after', '--bundle', '--whitespace', '--json']) {
    assert.equal(result.stdout.includes(flag), true, `${flag} is missing from the help text`)
  }
})

test('the clean example exits 0 and the broken example exits 1', async () => {
  const clean = await run(['--before', example('snapshot-before'), '--after', example('snapshot-after-clean')])
  assert.equal(clean.code, 0)
  assert.match(clean.stdout, /status pass/)

  const broken = await run(['--before', example('snapshot-before'), '--after', example('snapshot-after-broken')])
  assert.equal(broken.code, 1)
  assert.match(broken.stdout, /status fail/)
  assert.match(broken.stdout, /link-destination-changed/)
  assert.match(broken.stdout, /content-removed/)
  assert.match(broken.stdout, /document-removed/)
})

test('--json puts a parseable report on stdout and nothing else', async () => {
  const result = await run([
    '--before', example('snapshot-before'),
    '--after', example('snapshot-after-broken'),
    '--json',
  ])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.tool, 'publication-diff-bundler')
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.status, 'fail')
  assert.ok(report.findings.length > 0)
})

test('an invalid configuration exits 2 with an empty stdout', async () => {
  const cases = [
    ['--before', example('snapshot-before'), '--after', example('snapshot-after-clean'), '--nope'],
    ['--before', example('snapshot-before')],
    ['--before', example('snapshot-before'), '--before', example('snapshot-after-clean')],
    [
      '--before', example('snapshot-before'),
      '--after', example('snapshot-after-clean'),
      '--whitespace', 'collapse',
      '--whitespace', 'preserve',
    ],
    ['--before', example('snapshot-before'), '--after', example('snapshot-after-clean'), '--json', '--json'],
    ['--before', example('snapshot-before'), '--after', example('snapshot-after-clean'), '--whitespace', 'trim'],
    ['--before', example('snapshot-before'), '--after', example('snapshot-after-clean'), '--max-blocks', '0'],
    ['--before', example('snapshot-before'), '--after', example('snapshot-after-clean'), '--max-blocks', 'many'],
    ['--before', example('snapshot-before'), '--after', 'examples/no-such-snapshot'],
  ]
  for (const argv of cases) {
    const result = await run(argv)
    assert.equal(result.code, 2, `${argv.join(' ')} did not exit 2`)
    assert.equal(result.stdout, '', `${argv.join(' ')} wrote to stdout on a configuration error`)
    assert.notEqual(result.stderr, '')
  }
})

test('an input that could not be read exits 2 with an incomplete report on stdout', async (t) => {
  const root = await workspace(t)
  await writeFile(join(root, 'before', 'index.html'), '<p>original</p>')
  await symlink(join(root, 'after', 'missing.html'), join(root, 'after', 'index.html'))

  const result = await run(['--before', join(root, 'before'), '--after', join(root, 'after'), '--json'])

  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'document-unreadable'), true)
  assert.match(result.stderr, /incomplete/)
})

test('--bundle writes the derived artifact and reports it on stderr only', async (t) => {
  const root = await workspace(t)
  await writeFile(join(root, 'before', 'a.html'), '<p>one</p>')
  await writeFile(join(root, 'after', 'a.html'), '<p>two</p>')
  const destination = join(root, 'out', 'bundle.json')

  const result = await run(['--before', join(root, 'before'), '--after', join(root, 'after'), '--bundle', destination, '--json'])

  assert.equal(result.code, 0)
  JSON.parse(result.stdout)
  assert.match(result.stderr, /bundle written/)
  const bundle = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(bundle.counts.compared, 1)
  assert.equal(bundle.documents[0].changes[0].ruleId, 'text-changed')
})

test('--bundle inside a snapshot root is a configuration error', async (t) => {
  const root = await workspace(t)
  await writeFile(join(root, 'before', 'a.html'), '<p>one</p>')
  await writeFile(join(root, 'after', 'a.html'), '<p>one</p>')

  const result = await run([
    '--before', join(root, 'before'),
    '--after', join(root, 'after'),
    '--bundle', join(root, 'after', 'bundle.json'),
  ])

  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /inside a snapshot root/)
})

test('every documented limit flag reaches the engine', async (t) => {
  // A limit the CLI accepts and never wires through is a limit that does not
  // exist. Each flag below must change the outcome of the same run.
  const root = await workspace(t)
  const fixture = (second, third) =>
    `<p>one</p><p>${second}</p><p>${third}</p>` +
    '<a href="/x">x</a><a href="/y">y</a>' +
    '<img src="/a.png"><img src="/b.png">' +
    '<meta name="m" content="1"><meta name="n" content="2">'
  await writeFile(join(root, 'before', 'a.html'), fixture('alpha', 'beta'))
  await writeFile(join(root, 'after', 'a.html'), fixture('ALPHA', 'BETA'))
  for (const side of ['before', 'after']) {
    await mkdir(join(root, side, 'deep', 'deeper'), { recursive: true })
    await writeFile(join(root, side, 'deep', 'deeper', 'b.html'), '<p>b</p>')
  }

  const base = ['--before', join(root, 'before'), '--after', join(root, 'after'), '--json']
  const clean = await run(base)
  assert.equal(clean.code, 0, clean.stderr)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')

  const cases = [
    [['--max-documents', '1'], 'too-many-documents'],
    [['--max-document-bytes', '4'], 'document-too-large'],
    [['--max-depth', '1'], 'directory-too-deep'],
    [['--max-blocks', '1'], 'too-many-blocks'],
    [['--max-links', '1'], 'too-many-links'],
    [['--max-images', '1'], 'too-many-images'],
    [['--max-metadata', '1'], 'too-many-metadata'],
    [['--max-diff-cells', '1'], 'diff-too-large'],
  ]
  for (const [flags, ruleId] of cases) {
    const result = await run([...base, ...flags])
    assert.equal(result.code, 2, `${flags.join(' ')} did not make the run incomplete`)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(
      report.findings.some((finding) => finding.ruleId === ruleId),
      true,
      `${flags.join(' ')} did not produce ${ruleId}`,
    )
  }
})

test('--whitespace reaches the engine and changes what is reported', async (t) => {
  const root = await workspace(t)
  await writeFile(join(root, 'before', 'a.html'), '<p>one two</p>')
  await writeFile(join(root, 'after', 'a.html'), '<p>one\n   two</p>')
  const base = ['--before', join(root, 'before'), '--after', join(root, 'after'), '--json']

  const collapsed = JSON.parse((await run(base)).stdout)
  assert.deepEqual(collapsed.findings, [])
  assert.equal(collapsed.summary.whitespaceOnly, 1)

  const preserved = JSON.parse((await run([...base, '--whitespace', 'preserve'])).stdout)
  assert.deepEqual(preserved.findings.map((finding) => finding.ruleId), ['text-changed'])
  assert.equal(preserved.summary.whitespaceOnly, 0)
})

test('a snapshot path containing a newline cannot forge a line in the human report', async (t) => {
  const root = await workspace(t)
  const forged = `evil${String.fromCharCode(10)}ERROR   forged-rule was never emitted`
  await writeFile(join(root, 'before', `${forged}.html`), '<p>x</p>')
  await writeFile(join(root, 'after', 'kept.html'), '<p>x</p>')

  const result = await run(['--before', join(root, 'before'), '--after', join(root, 'after')])

  assert.equal(result.code, 1)
  const errorLines = result.stdout.split(String.fromCharCode(10)).filter((line) => line.startsWith('ERROR'))
  assert.equal(errorLines.length, 1)
  assert.equal(result.stdout.includes('forged-rule'), true)
  assert.equal(errorLines[0].includes('evil ERROR forged-rule was never emitted'), true)
})
