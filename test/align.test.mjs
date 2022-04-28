import assert from 'node:assert/strict'
import test from 'node:test'

import { alignSequences } from '../src/align.mjs'

function keys(values) {
  return values.map((value) => String(value))
}

test('identical sequences match every position and produce no hunk', () => {
  const alignment = alignSequences(keys(['a', 'b', 'c']), keys(['a', 'b', 'c']), 100)
  assert.equal(alignment.truncated, false)
  assert.deepEqual(alignment.pairs, [[0, 0], [1, 1], [2, 2]])
  assert.deepEqual(alignment.hunks, [])
})

test('an insertion leaves the surrounding items matched', () => {
  // Pairing by position would report c and d as changed as well. The whole
  // point of aligning is that one insertion produces exactly one hunk.
  const alignment = alignSequences(keys(['a', 'b', 'c']), keys(['a', 'x', 'b', 'c']), 100)
  assert.deepEqual(alignment.pairs, [[0, 0], [1, 2], [2, 3]])
  assert.deepEqual(alignment.hunks, [{ removed: [], added: [1] }])
})

test('a deletion is reported as a removal with nothing added', () => {
  const alignment = alignSequences(keys(['a', 'b', 'c']), keys(['a', 'c']), 100)
  assert.deepEqual(alignment.pairs, [[0, 0], [2, 1]])
  assert.deepEqual(alignment.hunks, [{ removed: [1], added: [] }])
})

test('a replacement pairs the removed item with the added one', () => {
  const alignment = alignSequences(keys(['a', 'b', 'c']), keys(['a', 'B', 'c']), 100)
  assert.deepEqual(alignment.pairs, [[0, 0], [2, 2]])
  assert.deepEqual(alignment.hunks, [{ removed: [1], added: [1] }])
})

test('a move is reported as a deletion and an insertion, never as a match', () => {
  const alignment = alignSequences(keys(['a', 'b', 'c']), keys(['b', 'c', 'a']), 100)
  assert.equal(alignment.truncated, false)
  const matchedBefore = alignment.pairs.map(([left]) => left)
  assert.deepEqual(matchedBefore, [1, 2])
  const removed = alignment.hunks.flatMap((hunk) => hunk.removed)
  const added = alignment.hunks.flatMap((hunk) => hunk.added)
  assert.deepEqual(removed, [0])
  assert.deepEqual(added, [2])
})

test('an empty side turns the whole other side into one hunk', () => {
  const removedAll = alignSequences(keys(['a', 'b']), [], 100)
  assert.deepEqual(removedAll.pairs, [])
  assert.deepEqual(removedAll.hunks, [{ removed: [0, 1], added: [] }])

  const addedAll = alignSequences([], keys(['a', 'b']), 100)
  assert.deepEqual(addedAll.pairs, [])
  assert.deepEqual(addedAll.hunks, [{ removed: [], added: [0, 1] }])

  const bothEmpty = alignSequences([], [], 100)
  assert.deepEqual(bothEmpty.hunks, [])
})

test('the cell budget is enforced, and a refused alignment claims nothing', () => {
  const before = keys(Array.from({ length: 40 }, (_, index) => `b${index}`))
  const after = keys(Array.from({ length: 40 }, (_, index) => `a${index}`))

  const refused = alignSequences(before, after, 100)
  assert.equal(refused.truncated, true)
  // An alignment that was never computed must not be dressed up as a verdict,
  // and must not hand back an empty one either: a caller that read it as "no
  // differences" would be reporting a result nobody obtained.
  assert.equal(Object.hasOwn(refused, 'pairs'), false)
  assert.equal(Object.hasOwn(refused, 'hunks'), false)

  const allowed = alignSequences(before, after, 40 * 40)
  assert.equal(allowed.truncated, false)
  assert.equal(allowed.hunks.length, 1)
})

test('a shared prefix and suffix keep the quadratic table off the budget', () => {
  const shared = Array.from({ length: 60 }, (_, index) => `s${index}`)
  const before = keys([...shared, 'only-before', ...shared])
  const after = keys([...shared, 'only-after', ...shared])

  // 121 x 121 would be 14641 cells; trimming leaves a 1 x 1 table.
  const alignment = alignSequences(before, after, 4)
  assert.equal(alignment.truncated, false)
  assert.deepEqual(alignment.hunks, [{ removed: [60], added: [60] }])
  assert.equal(alignment.pairs.length, 120)
})

test('alignment refuses arguments it cannot honour', () => {
  assert.throws(() => alignSequences('ab', ['a'], 10), TypeError)
  assert.throws(() => alignSequences(['a'], ['a'], 0), TypeError)
  assert.throws(() => alignSequences(['a'], ['a'], 1.5), TypeError)
})
