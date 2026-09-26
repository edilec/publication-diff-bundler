import assert from 'node:assert/strict'
import test from 'node:test'

import { compareDocuments, isUrlValuedMetadata } from '../src/compare.mjs'
import { DEFAULT_LIMITS } from '../src/index.mjs'
import { parseHtml } from '../src/parse.mjs'

const LIMITS = DEFAULT_LIMITS

function diff(beforeHtml, afterHtml, mode = 'collapse', maxDiffCells = LIMITS.maxDiffCells) {
  return compareDocuments(parseHtml(beforeHtml, LIMITS), parseHtml(afterHtml, LIMITS), { mode, maxDiffCells })
}

function rules(result) {
  return result.changes.map((change) => change.ruleId)
}

test('a whitespace-only reflow is a change under preserve and ignored under collapse', () => {
  const before = '<p>A tray is sized for the bundle it will carry.</p>'
  const after = '<p>\n  A tray is sized\n  for the bundle it will carry.\n</p>'

  const collapsed = diff(before, after, 'collapse')
  assert.deepEqual(rules(collapsed), [])
  assert.equal(collapsed.whitespaceOnly.length, 1)
  assert.equal(collapsed.whitespaceOnly[0].pointer, '/after/blocks/0')

  const preserved = diff(before, after, 'preserve')
  assert.deepEqual(rules(preserved), ['text-changed'])
  assert.deepEqual(preserved.whitespaceOnly, [])
})

test('a deletion stays visible when the surrounding whitespace was normalised', () => {
  // The acceptance case. The first paragraph was reflowed and the second was
  // deleted; collapse may hide the reflow and may not hide the deletion.
  const before = '<p>Kept paragraph.</p><p>Derating is not optional.</p><p>Closing line.</p>'
  const after = '<p>\n   Kept\n   paragraph.\n</p><p>Closing    line.</p>'

  const result = diff(before, after, 'collapse')
  assert.deepEqual(rules(result), ['content-removed'])
  assert.equal(result.changes[0].before, 'Derating is not optional.')
  assert.equal(result.changes[0].after, null)
  assert.equal(result.changes[0].pointer, '/before/blocks/1')
  assert.equal(result.whitespaceOnly.length, 2)
})

test('a changed link destination stays visible when whitespace was normalised', () => {
  const before = '<p>Read the <a href="/guide/install">installation guide</a> first.</p>'
  const after = '<p>\n  Read the <a href="/guide/installation">installation   guide</a>\n  first.\n</p>'

  // The prose collapsed to the same text, so the only change reported is the
  // one that matters: the link now points somewhere else.
  const result = diff(before, after, 'collapse')
  assert.deepEqual(rules(result), ['link-destination-changed'])
  const destination = result.changes.find((change) => change.ruleId === 'link-destination-changed')
  assert.equal(destination.before, '/guide/install')
  assert.equal(destination.after, '/guide/installation')
})

test('whitespace around a destination is trimmed, but a destination is never collapsed', () => {
  const trimmed = diff('<a href="/guide">g</a>', '<a href="  /guide  ">g</a>', 'collapse')
  assert.deepEqual(rules(trimmed), [])

  // Interior whitespace belongs to the destination. Collapsing it would make
  // two different URLs compare equal, which is the failure this tool refuses.
  const interior = diff('<a href="/a  b">g</a>', '<a href="/a b">g</a>', 'collapse')
  assert.deepEqual(rules(interior), ['link-destination-changed'])
})

test('anchor text changes and link text whitespace are told apart', () => {
  // Anchor text is prose, so a rewrite shows up twice: once as the block that
  // contains it and once as the link whose label changed.
  const changed = diff('<a href="/g">guide</a>', '<a href="/g">the guide</a>', 'collapse')
  assert.deepEqual(rules(changed), ['text-changed', 'link-text-changed'])
  const label = changed.changes.find((change) => change.ruleId === 'link-text-changed')
  assert.equal(label.before, 'guide')
  assert.equal(label.after, 'the guide')

  const reflowed = diff('<a href="/g">guide</a>', '<a href="/g">\n  guide\n</a>', 'collapse')
  assert.deepEqual(rules(reflowed), [])
  assert.deepEqual(reflowed.whitespaceOnly.map((entry) => entry.pointer), ['/after/blocks/0', '/after/links/0'])
})

test('a removed link and a removed image are errors in their own right', () => {
  const result = diff(
    '<p><a href="/a">a</a><a href="/b">b</a></p><img src="/x.png" alt="x">',
    '<p><a href="/a">a</a></p>',
    'collapse',
  )
  assert.deepEqual(rules(result).sort(), ['image-removed', 'link-removed', 'text-changed'])
})

test('an image source change and an alt change are separate observations', () => {
  const source = diff('<img src="/a.png" alt="tray">', '<img src="/b.png" alt="tray">')
  assert.deepEqual(rules(source), ['image-source-changed'])

  const alt = diff('<img src="/a.png" alt="tray">', '<img src="/a.png" alt="a cable tray">')
  assert.deepEqual(rules(alt), ['image-alt-changed'])
  assert.equal(alt.changes[0].before, 'tray')

  const removedAlt = diff('<img src="/a.png" alt="tray">', '<img src="/a.png">')
  assert.deepEqual(rules(removedAlt), ['image-alt-changed'])
  assert.equal(removedAlt.changes[0].after, null)
})

test('canonical and robots changes carry their own rules', () => {
  const canonical = diff(
    '<link rel="canonical" href="https://example.invalid/a">',
    '<link rel="canonical" href="https://example.invalid/b">',
  )
  assert.deepEqual(rules(canonical), ['canonical-changed'])

  const robots = diff('<meta name="robots" content="index">', '<meta name="robots" content="noindex">')
  assert.deepEqual(rules(robots), ['robots-changed'])

  const description = diff('<meta name="description" content="a">', '<meta name="description" content="b">')
  assert.deepEqual(rules(description), ['metadata-changed'])
})

test('a canonical URL is never whitespace-collapsed, unlike a description', () => {
  assert.equal(isUrlValuedMetadata('link:canonical'), true)
  assert.equal(isUrlValuedMetadata('link:canonical#2'), true)
  assert.equal(isUrlValuedMetadata('meta:property=og:url'), true)
  assert.equal(isUrlValuedMetadata('meta:name=description'), false)

  const canonical = diff(
    '<link rel="canonical" href="https://example.invalid/a  b">',
    '<link rel="canonical" href="https://example.invalid/a b">',
  )
  assert.deepEqual(rules(canonical), ['canonical-changed'])

  const description = diff(
    '<meta name="description" content="one  two">',
    '<meta name="description" content="one two">',
  )
  assert.deepEqual(rules(description), [])
  assert.equal(description.whitespaceOnly.length, 1)
})

test('added and removed metadata are reported separately from a changed value', () => {
  const result = diff(
    '<meta name="description" content="a"><meta name="robots" content="index">',
    '<meta name="description" content="a"><meta name="author" content="team">',
  )
  assert.deepEqual(rules(result).sort(), ['metadata-added', 'metadata-removed'])
  const removed = result.changes.find((change) => change.ruleId === 'metadata-removed')
  assert.equal(removed.pointer, '/before/metadata/meta:name=robots')
})

test('an over-budget alignment reports the limit and claims nothing about the dimension', () => {
  const before = `<body>${Array.from({ length: 40 }, (_, index) => `<p>before ${index}</p>`).join('')}</body>`
  const after = `<body>${Array.from({ length: 40 }, (_, index) => `<p>after ${index}</p>`).join('')}</body>`

  const refused = diff(before, after, 'collapse', 100)
  assert.deepEqual(refused.problems, [
    { ruleId: 'diff-too-large', dimension: 'blocks', limitName: 'maxDiffCells', limit: 100 },
  ])
  // Nothing is asserted about the blocks, because nothing was computed.
  assert.deepEqual(rules(refused), [])

  const allowed = diff(before, after, 'collapse', 40 * 40)
  assert.deepEqual(allowed.problems, [])
  assert.equal(rules(allowed).length, 40)
})

test('untrusted content reaching a change row is sanitised and bounded', () => {
  const forged = `<p>line one${String.fromCharCode(10)}ERROR   forged</p>`
  const result = diff('<p>original</p>', forged)
  assert.equal(result.changes[0].after, 'line one ERROR forged')
  assert.equal(result.changes[0].after.includes(String.fromCharCode(10)), false)

  const long = `<p>${'x'.repeat(400)}</p>`
  const bounded = diff('<p>original</p>', long)
  assert.equal(bounded.changes[0].after.length, 123)
})

test('a metadata key containing a pointer character is escaped, not spliced', () => {
  const result = diff('<meta name="a/b" content="1">', '<meta name="a/b" content="2">')
  assert.equal(result.changes[0].pointer, '/after/metadata/meta:name=a~1b')
})

test('comparison refuses arguments it cannot honour', () => {
  assert.throws(() => compareDocuments(null, parseHtml('', LIMITS), { mode: 'collapse', maxDiffCells: 10 }), TypeError)
  assert.throws(() => compareDocuments(parseHtml('', LIMITS), parseHtml('', LIMITS), { mode: 'collapse', maxDiffCells: 0 }), TypeError)
  assert.throws(() => diff('<p>a</p>', '<p>b</p>', 'squash'), TypeError)
})
