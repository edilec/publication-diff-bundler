import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS } from '../src/index.mjs'
import { decodeReferences, parseDocument, parseHtml, parseMarkdown } from '../src/parse.mjs'

const LIMITS = DEFAULT_LIMITS

function metadataOf(document) {
  return Object.fromEntries(document.metadata.map((entry) => [entry.key, entry.value]))
}

test('HTML text is split into blocks at block-level boundaries', () => {
  const document = parseHtml('<body><p>One sentence.</p><p>Another sentence.</p></body>', LIMITS)
  assert.deepEqual(document.blocks, ['One sentence.', 'Another sentence.'])
})

test('a line break ends a block instead of becoming a space', () => {
  // If <br> were folded to whitespace, swapping a line break for a space would
  // be invisible under the collapse mode. Structure is not whitespace.
  const withBreak = parseHtml('<p>first<br>second</p>', LIMITS)
  const withSpace = parseHtml('<p>first second</p>', LIMITS)
  assert.deepEqual(withBreak.blocks, ['first', 'second'])
  assert.deepEqual(withSpace.blocks, ['first second'])
})

test('script, style, template and noscript content never becomes prose', () => {
  const document = parseHtml(
    '<p>kept</p><script>var dropped = "<p>x</p>"</script><style>p { color: red }</style>' +
    '<template><p>hidden</p></template><noscript><p>fallback</p></noscript>',
    LIMITS,
  )
  assert.deepEqual(document.blocks, ['kept'])
})

test('comments and doctypes are skipped without leaking their text', () => {
  const document = parseHtml('<!doctype html><!-- a note about <p>markup</p> --><p>kept</p>', LIMITS)
  assert.deepEqual(document.blocks, ['kept'])
})

test('links carry their destination and their anchor text', () => {
  const document = parseHtml('<p>Read the <a href="/guide">installation guide</a> first.</p>', LIMITS)
  assert.deepEqual(document.links, [{ href: '/guide', text: 'installation guide' }])
  assert.deepEqual(document.blocks, ['Read the installation guide first.'])
})

test('an anchor with no href is a target, not a link', () => {
  const document = parseHtml('<p><a id="top"></a><a href="/x">x</a></p>', LIMITS)
  assert.deepEqual(document.links.map((link) => link.href), ['/x'])
})

test('images record their source and distinguish an absent alt from an empty one', () => {
  const document = parseHtml('<img src="/a.png" alt="A tray"><img src="/b.png" alt=""><img src="/c.png">', LIMITS)
  assert.deepEqual(document.images, [
    { src: '/a.png', alt: 'A tray' },
    { src: '/b.png', alt: '' },
    { src: '/c.png', alt: null },
  ])
})

test('metadata covers the title, meta tags, link relations and the document language', () => {
  const document = parseHtml(
    '<html lang="en-GB"><head><title>Field notes</title>' +
    '<meta charset="utf-8">' +
    '<meta name="Description" content="How a tray is sized.">' +
    '<meta property="og:title" content="Field notes">' +
    '<meta http-equiv="content-language" content="en">' +
    '<link rel="canonical" href="https://example.invalid/notes">' +
    '<link rel="alternate" hreflang="FR" href="https://example.invalid/fr/notes">' +
    '</head></html>',
    LIMITS,
  )
  assert.deepEqual(metadataOf(document), {
    'html:lang': 'en-GB',
    title: 'Field notes',
    'meta:name=description': 'How a tray is sized.',
    'meta:property=og:title': 'Field notes',
    'meta:http-equiv=content-language': 'en',
    'link:canonical': 'https://example.invalid/notes',
    'link:alternate:hreflang=fr': 'https://example.invalid/fr/notes',
  })
})

test('a repeated metadata key is kept under a suffix rather than dropped', () => {
  // A second robots directive that silently replaced the first would let a
  // real policy change vanish between two snapshots.
  const document = parseHtml(
    '<meta name="robots" content="index,follow"><meta name="robots" content="noindex">',
    LIMITS,
  )
  assert.deepEqual(metadataOf(document), {
    'meta:name=robots': 'index,follow',
    'meta:name=robots#2': 'noindex',
  })
})

test('only the documented character references are decoded', () => {
  assert.equal(decodeReferences('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), 'a & b <c> "d" \'e\'')
  assert.equal(decodeReferences('&#65;&#x42;'), 'AB')
  assert.equal(decodeReferences('&nbsp;'), String.fromCharCode(0xa0))
  assert.equal(decodeReferences('&copy; &Amp; &#xZZ;'), '&copy; &Amp; &#xZZ;')
  assert.equal(decodeReferences('&#xD800;'), '&#xD800;')
})

test('attribute values are entity-decoded, and the first declaration wins', () => {
  const document = parseHtml('<a href="/a?x=1&amp;y=2" href="/b">link</a>', LIMITS)
  assert.deepEqual(document.links, [{ href: '/a?x=1&y=2', text: 'link' }])
})

test('an unquoted attribute value and a self-closing tag still parse', () => {
  const document = parseHtml('<img src=/a.png alt=tray /><p>after</p>', LIMITS)
  assert.deepEqual(document.images, [{ src: '/a.png', alt: 'tray' }])
  assert.deepEqual(document.blocks, ['after'])
})

test('Markdown front matter, headings, paragraphs and fenced code become blocks and metadata', () => {
  const document = parseMarkdown(
    ['---', 'title: Working notes', 'status: draft', '---', '', '# Working notes', '', 'A paragraph',
      'wrapped over lines.', '', '```', 'code line', '', 'still code', '```', '', 'Last paragraph.'].join('\n'),
    LIMITS,
  )
  assert.deepEqual(metadataOf(document), {
    'front-matter:title': 'Working notes',
    'front-matter:status': 'draft',
    title: 'Working notes',
  })
  assert.deepEqual(document.blocks, [
    '# Working notes',
    'A paragraph\nwrapped over lines.',
    '```\ncode line\n\nstill code\n```',
    'Last paragraph.',
  ])
})

test('Markdown inline links, images and autolinks are read in document order', () => {
  const document = parseMarkdown(
    'See the [guide](/guide/install "title") and ![a tray](/img/tray.png) and <https://example.invalid/x>.',
    LIMITS,
  )
  assert.deepEqual(document.links, [
    { href: '/guide/install', text: 'guide' },
    { href: 'https://example.invalid/x', text: 'https://example.invalid/x' },
  ])
  assert.deepEqual(document.images, [{ src: '/img/tray.png', alt: 'a tray' }])
})

test('parseDocument dispatches on the extension and refuses an unknown one', () => {
  assert.deepEqual(parseDocument('.html', '<p>x</p>', LIMITS).blocks, ['x'])
  assert.deepEqual(parseDocument('.md', 'x', LIMITS).blocks, ['x'])
  assert.throws(() => parseDocument('.rst', 'x', LIMITS), TypeError)
})

test('every per-document limit is enforced and names itself', () => {
  const cases = [
    {
      ruleId: 'too-many-blocks',
      limitName: 'maxBlocks',
      limits: { ...LIMITS, maxBlocks: 2 },
      html: '<p>a</p><p>b</p><p>c</p>',
      count: (document) => document.blocks.length,
      expected: 2,
    },
    {
      ruleId: 'too-many-links',
      limitName: 'maxLinks',
      limits: { ...LIMITS, maxLinks: 1 },
      html: '<a href="/a">a</a><a href="/b">b</a>',
      count: (document) => document.links.length,
      expected: 1,
    },
    {
      ruleId: 'too-many-images',
      limitName: 'maxImages',
      limits: { ...LIMITS, maxImages: 1 },
      html: '<img src="/a.png"><img src="/b.png">',
      count: (document) => document.images.length,
      expected: 1,
    },
    {
      ruleId: 'too-many-metadata',
      limitName: 'maxMetadata',
      limits: { ...LIMITS, maxMetadata: 1 },
      html: '<meta name="a" content="1"><meta name="b" content="2">',
      count: (document) => document.metadata.length,
      expected: 1,
    },
  ]

  for (const testCase of cases) {
    const document = parseHtml(testCase.html, testCase.limits)
    assert.equal(testCase.count(document), testCase.expected, `${testCase.ruleId} did not stop at its limit`)
    assert.deepEqual(
      document.problems,
      [{ ruleId: testCase.ruleId, limitName: testCase.limitName, limit: testCase.limits[testCase.limitName] }],
      `${testCase.ruleId} was not reported`,
    )
    const withinLimit = parseHtml(testCase.html, LIMITS)
    assert.deepEqual(withinLimit.problems, [], `${testCase.ruleId} fired below its limit`)
    assert.ok(testCase.count(withinLimit) > testCase.expected, `${testCase.ruleId} fixture is too small to bound`)
  }
})

test('Markdown limits are enforced by the same table', () => {
  const document = parseMarkdown('a\n\nb\n\nc', { ...LIMITS, maxBlocks: 2 })
  assert.equal(document.blocks.length, 2)
  assert.deepEqual(document.problems, [{ ruleId: 'too-many-blocks', limitName: 'maxBlocks', limit: 2 }])
})
