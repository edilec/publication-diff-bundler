import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { METADATA_RULES } from '../src/compare.mjs'
import { DEFAULT_LIMITS, RULE_SEVERITY, WHITESPACE_MODES } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_FILES = ['src/index.mjs', 'src/text.mjs', 'src/align.mjs', 'src/parse.mjs', 'src/compare.mjs']

/**
 * Severity decides whether a run fails or passes, so it is the one thing in
 * this tool most worth pinning. Three dozen construction sites each carrying
 * their own literal is exactly the shape that drifts silently; these tests
 * assert that the single table, the documented catalog and the shipped source
 * all agree, in both directions.
 */

async function readProjectFile(relativePath) {
  return readFile(resolve(projectDirectory, relativePath), 'utf8')
}

async function documentedSeverities() {
  const text = await readProjectFile('docs/diff-rules.md')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented rule catalog matches the severity table exactly', async () => {
  const documented = await documentedSeverities()

  assert.equal(Object.keys(documented).length, 31)
  assert.deepEqual(
    Object.keys(documented).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/diff-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('every rule the source emits is defined in the severity table', async () => {
  const sources = await Promise.all(SOURCE_FILES.map((path) => readProjectFile(path)))
  const emitted = new Set([...sources.join('\n').matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]))
  // The per-document limits are raised through a helper rather than a literal
  // property, so they are scanned for separately.
  for (const match of (await readProjectFile('src/parse.mjs')).matchAll(/exceeded\('([a-z0-9-]+)'/g)) {
    emitted.add(match[1])
  }

  assert.ok(emitted.size > 20, 'the rule scan found suspiciously few construction sites')
  for (const ruleId of emitted) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but missing from RULE_SEVERITY`)
  }
})

test('the key-specific metadata rules are pinned like every other rule', () => {
  assert.deepEqual(METADATA_RULES, {
    'link:canonical': 'canonical-changed',
    'meta:name=robots': 'robots-changed',
  })
  for (const ruleId of Object.values(METADATA_RULES)) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is reachable but missing from RULE_SEVERITY`)
    assert.equal(RULE_SEVERITY[ruleId], 'error')
  }
})

test('no severity literal is written at a finding construction site', async () => {
  // A `severity:` beside a `ruleId:` is the defect this table exists to
  // prevent: it lets one rule be downgraded without the table, the docs or a
  // test noticing.
  for (const path of SOURCE_FILES) {
    const source = await readProjectFile(path)
    assert.equal(
      /severity:\s*'(error|warning|info)'/.test(source),
      false,
      `${path} writes a severity literal instead of reading RULE_SEVERITY`,
    )
  }
})

test('every rule severity is pinned here, rule by rule', () => {
  // The table and the documented catalog are asserted against each other, so a
  // coordinated edit to both agrees with itself and passes. This is the third
  // copy, written out by hand: a downgrade has to walk past an expectation that
  // shares no source with either of them. Downgrading any `error` below turns a
  // refusal into a green build -- a deleted paragraph, a link that now points
  // somewhere else, a document that vanished, or evidence that was never read
  // would all reach status pass.
  assert.deepEqual({ ...RULE_SEVERITY }, {
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
})

test('every table entry uses a severity the report contract defines', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(['error', 'warning', 'info'].includes(severity), `${ruleId} has severity ${severity}`)
  }
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
})

test('the documented limits are the shipped limits, and the CLI offers every flag', async () => {
  const text = await readProjectFile('docs/diff-rules.md')
  const rows = [...text.matchAll(/\|\s*`(max[A-Za-z]+)`\s*\|\s*`(--[a-z-]+)`\s*\|\s*(\d+)\s*\|/g)]
  const documented = Object.fromEntries(rows.map((row) => [row[1], Number(row[3])]))

  assert.deepEqual(documented, { ...DEFAULT_LIMITS })

  const help = await readProjectFile('bin/publication-diff-bundler.mjs')
  for (const row of rows) {
    assert.equal(help.includes(row[2]), true, `${row[2]} is documented but not offered by the CLI`)
  }
  assert.equal(Object.isFrozen(DEFAULT_LIMITS), true)
})

test('the documented whitespace modes are the shipped whitespace modes', async () => {
  const text = await readProjectFile('docs/diff-rules.md')
  assert.deepEqual([...WHITESPACE_MODES], ['collapse', 'preserve'])
  for (const mode of WHITESPACE_MODES) {
    assert.equal(text.includes(`\`${mode}\``), true, `${mode} is accepted but not documented`)
  }
  assert.equal(text.includes('`normalize`'), false, 'the docs name a mode the tool does not accept')
})

test('directory listings are ordered before they are used', async () => {
  // This one is asserted against the source rather than against behaviour, and
  // the reason is worth writing down: the filesystems these tests run on
  // already hand back entries in code-unit order, so removing the sort changes
  // nothing observable *here*. It changes everything on a filesystem that does
  // not -- the walk order, and with it which of two links to the same file is
  // reported. A behavioural test that cannot fail on this host would be a
  // tautology; this assertion at least fails when the sort is deleted.
  const source = await readProjectFile('src/index.mjs')
  assert.equal(
    source.includes('entries.sort((left, right) => byCodeUnit(left.name, right.name))'),
    true,
    'directory entries are used in whatever order the filesystem returned them',
  )
})

test('the source never reaches for a locale-dependent comparison', async () => {
  for (const path of [...SOURCE_FILES, 'bin/publication-diff-bundler.mjs']) {
    const source = await readProjectFile(path)
    assert.equal(/\.localeCompare\s*\(/.test(source), false, `${path} sorts with localeCompare`)
    assert.equal(/\.sort\(\)\s*;?\n/.test(source), false, `${path} sorts without an explicit comparator`)
  }
})
