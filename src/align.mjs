/**
 * Sequence alignment.
 *
 * Text blocks, links and images are all ordered sequences, and all three are
 * aligned the same way: a longest-common-subsequence match over a comparison
 * key, with the unmatched remainder grouped into hunks. Pairing by position
 * alone would report every item after an insertion as changed, which buries
 * the one change a reviewer actually needs to see.
 *
 * The alignment is bounded. A quadratic table over two long documents is a
 * denial of service, so the cell budget is explicit and exceeding it is
 * reported as missing evidence rather than paid for or guessed at.
 */

/**
 * Align two key sequences.
 *
 * Returns `{ truncated, pairs, hunks }`:
 *
 * - `pairs` are `[beforeIndex, afterIndex]` for items whose keys matched.
 * - `hunks` are the runs between matches, each `{ removed, added }` holding
 *   before-indices and after-indices respectively.
 * - `truncated` is true when the cell budget was exceeded. In that case there
 *   are **no** `pairs` and **no** `hunks` -- not empty ones, none at all. The
 *   alignment was never computed, so nothing is known about which items
 *   changed, and a caller that reached for a result would fail loudly rather
 *   than read "nothing was computed" as "nothing changed". Reporting the whole
 *   document as rewritten would be inventing a verdict out of evidence that
 *   was never obtained.
 */
export function alignSequences(beforeKeys, afterKeys, maxCells) {
  if (!Array.isArray(beforeKeys) || !Array.isArray(afterKeys)) {
    throw new TypeError('Alignment needs two arrays of comparison keys')
  }
  if (!Number.isInteger(maxCells) || maxCells < 1) {
    throw new TypeError('The alignment cell budget must be a positive integer')
  }

  const pairs = []
  const hunks = []

  // Common prefix and suffix are matched directly. A typical publication edit
  // touches a few blocks in a long document, so this keeps the quadratic table
  // small enough that the budget is never reached in ordinary use.
  let prefix = 0
  while (prefix < beforeKeys.length && prefix < afterKeys.length && beforeKeys[prefix] === afterKeys[prefix]) {
    pairs.push([prefix, prefix])
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < beforeKeys.length - prefix &&
    suffix < afterKeys.length - prefix &&
    beforeKeys[beforeKeys.length - 1 - suffix] === afterKeys[afterKeys.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const left = beforeKeys.slice(prefix, beforeKeys.length - suffix)
  const right = afterKeys.slice(prefix, afterKeys.length - suffix)

  if (left.length * right.length > maxCells) return { truncated: true }

  const middlePairs = longestCommonSubsequence(left, right)

  let beforeCursor = 0
  let afterCursor = 0
  for (const [i, j] of middlePairs) {
    if (i > beforeCursor || j > afterCursor) {
      hunks.push({
        removed: range(prefix + beforeCursor, prefix + i),
        added: range(prefix + afterCursor, prefix + j),
      })
    }
    pairs.push([prefix + i, prefix + j])
    beforeCursor = i + 1
    afterCursor = j + 1
  }
  if (beforeCursor < left.length || afterCursor < right.length) {
    hunks.push({
      removed: range(prefix + beforeCursor, prefix + left.length),
      added: range(prefix + afterCursor, prefix + right.length),
    })
  }

  for (let index = 0; index < suffix; index += 1) {
    pairs.push([beforeKeys.length - suffix + index, afterKeys.length - suffix + index])
  }

  return { truncated: false, pairs, hunks }
}

function range(start, end) {
  const values = []
  for (let value = start; value < end; value += 1) values.push(value)
  return values
}

/**
 * The classic dynamic-programming LCS, walked forward so ties resolve toward
 * the earliest match. Deterministic for any pair of inputs, which is the only
 * property the bundle depends on.
 */
function longestCommonSubsequence(left, right) {
  const rows = left.length
  const columns = right.length
  if (rows === 0 || columns === 0) return []

  const width = columns + 1
  const table = new Uint32Array((rows + 1) * width)
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i * width + j] = left[i] === right[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }

  const pairs = []
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (left[i] === right[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1
    else j += 1
  }
  return pairs
}
