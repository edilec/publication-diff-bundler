import assert from 'node:assert/strict'
import test from 'node:test'

import {
  byCodeUnit,
  decodeUtf8,
  escapePointerSegment,
  normalizeText,
  normalizeUrl,
  sanitize,
} from '../src/text.mjs'

test('ordering is by UTF-16 code unit, not by collation', () => {
  // The catalog case: `S` (0x53) precedes `_` (0x5F) by code point, while a
  // collation table treats the underscore as ignorable punctuation and orders
  // these the other way round. Reversing the comparator flips this assertion.
  assert.equal(byCodeUnit('MAX_DUPLICATE_URLS', 'MAX_DUPLICATE_URL_ENTRIES'), -1)
  assert.equal(byCodeUnit('MAX_DUPLICATE_URL_ENTRIES', 'MAX_DUPLICATE_URLS'), 1)
  assert.equal(byCodeUnit('a', 'a'), 0)

  const sorted = ['_b', 'Sa', 'ab', 'Ab'].sort(byCodeUnit)
  assert.deepEqual(sorted, ['Ab', 'Sa', '_b', 'ab'])
})

test('decoding is strict: undecodable bytes are refused, not repaired', () => {
  const truncated = Uint8Array.from([0x68, 0x69, 0xff, 0xfe])
  const decoded = decodeUtf8(truncated)
  assert.equal(decoded.ok, false)
  assert.equal(decoded.reason, 'not-utf8')
  assert.equal(Object.hasOwn(decoded, 'text'), false)
})

test('a literal replacement character is valid UTF-8 and decodes as content', () => {
  // Inferring "not UTF-8" from a U+FFFD in the decoded text is the defect this
  // asserts against: these bytes are perfectly valid and must decode.
  const bytes = new TextEncoder().encode('caf�')
  const decoded = decodeUtf8(bytes)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.text, 'caf�')
})

test('sanitize strips the characters that forge a line in a report', () => {
  const forged = `first${String.fromCharCode(10)}ERROR   forged line`
  assert.equal(sanitize(forged), 'first ERROR forged line')
  assert.equal(sanitize(forged).includes(String.fromCharCode(10)), false)

  const separators = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c${String.fromCharCode(0)}d`
  assert.equal(sanitize(separators), 'a b c d')
  for (const code of [0, 0x2028, 0x2029, 13, 127]) {
    assert.equal(sanitize(separators + String.fromCharCode(code)).includes(String.fromCharCode(code)), false)
  }
})

test('sanitize bounds its output and marks the truncation', () => {
  const long = 'x'.repeat(500)
  assert.equal(sanitize(long, 10), 'xxxxxxxxxx...')
  assert.equal(sanitize(long).length, 203)
  assert.equal(sanitize('short', 10), 'short')
  assert.throws(() => sanitize('x', 0), TypeError)
})

test('collapse folds whitespace runs in prose; preserve does not', () => {
  const reflowed = 'A tray is sized\n   for the bundle\tit will carry. '
  assert.equal(normalizeText(reflowed, 'collapse'), 'A tray is sized for the bundle it will carry.')
  assert.equal(normalizeText(reflowed, 'preserve'), reflowed)
  assert.notEqual(normalizeText(reflowed, 'preserve'), normalizeText(reflowed, 'collapse'))
  assert.throws(() => normalizeText('x', 'trim'), TypeError)
})

test('collapse does not fold zero-width characters, which are content', () => {
  const withZeroWidth = `side${String.fromCharCode(0x200b)}effect`
  assert.equal(normalizeText(withZeroWidth, 'collapse'), withZeroWidth)
  assert.notEqual(normalizeText(withZeroWidth, 'collapse'), 'sideeffect')
})

test('a destination is trimmed but never collapsed', () => {
  // This is the guarantee that keeps the whitespace mode away from URLs. If
  // normalizeUrl ever folded interior whitespace, `/a  b` and `/a b` would be
  // the same destination and a real change would disappear.
  assert.equal(normalizeUrl('  /guide/install  '), '/guide/install')
  assert.equal(normalizeUrl('/a  b'), '/a  b')
  assert.notEqual(normalizeUrl('/a  b'), normalizeUrl('/a b'))
  assert.equal(normalizeText('/a  b', 'collapse'), '/a b')
})

test('pointer segments are escaped per RFC 6901', () => {
  assert.equal(escapePointerSegment('meta:name=robots'), 'meta:name=robots')
  assert.equal(escapePointerSegment('a/b'), 'a~1b')
  assert.equal(escapePointerSegment('a~b'), 'a~0b')
  assert.equal(escapePointerSegment('~/'), '~0~1')
})
