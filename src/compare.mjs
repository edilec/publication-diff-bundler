/**
 * Comparing one document across two snapshots.
 *
 * The rule this module exists to enforce: **whitespace normalisation applies to
 * prose and to nothing else.** A destination -- a link href, an image src, a
 * canonical URL -- is compared trimmed but never collapsed, and a block that is
 * present in one snapshot and absent from the other is a deletion no matter
 * what the mode is. The `collapse` mode may hide a reflow. It may not hide a
 * change to where something points or to whether something is still there.
 *
 * No severity is decided here. Every row carries a rule id, and src/index.mjs
 * takes the severity from the single frozen table.
 */

import { alignSequences } from './align.mjs'
import { byCodeUnit, escapePointerSegment, normalizeText, normalizeUrl, sanitize } from './text.mjs'

const VALUE_LIMIT = 120

/**
 * Metadata keys whose value is a destination.
 *
 * These are compared with `normalizeUrl`, exactly like an href, so the
 * whitespace mode cannot reach them either.
 */
export const URL_VALUED_METADATA = Object.freeze([
  'meta:name=twitter:image',
  'meta:property=og:image',
  'meta:property=og:url',
])

/** Metadata keys whose change carries its own rule, because it redirects readers or crawlers. */
export const METADATA_RULES = Object.freeze({
  'link:canonical': 'canonical-changed',
  'meta:name=robots': 'robots-changed',
})

const DUPLICATE_SUFFIX = /#\d+$/

function baseKey(key) {
  return key.replace(DUPLICATE_SUFFIX, '')
}

export function isUrlValuedMetadata(key) {
  const base = baseKey(key)
  return base.startsWith('link:') || URL_VALUED_METADATA.includes(base)
}

function pointerFor(side, dimension, segment) {
  return `/${side}/${dimension}/${escapePointerSegment(sanitize(String(segment), VALUE_LIMIT))}`
}

function value(raw) {
  return raw === null || raw === undefined ? null : sanitize(raw, VALUE_LIMIT)
}

function createSink() {
  return { changes: [], whitespaceOnly: [], problems: [] }
}

function addChange(sink, row) {
  sink.changes.push({
    ruleId: row.ruleId,
    pointer: row.pointer,
    message: row.message,
    before: value(row.before),
    after: value(row.after),
  })
}

function addWhitespaceOnly(sink, pointer, before, after) {
  sink.whitespaceOnly.push({ pointer, before: value(before), after: value(after) })
}

/**
 * Align one dimension and hand back matched pairs plus classified hunks.
 *
 * When the alignment was refused for being over budget, the caller records the
 * limit and emits nothing else for that dimension. An alignment that was never
 * computed says nothing about what changed, and turning "not computed" into
 * "everything was rewritten" would be a verdict invented out of missing
 * evidence.
 */
function alignDimension(sink, dimension, beforeKeys, afterKeys, maxDiffCells) {
  const alignment = alignSequences(beforeKeys, afterKeys, maxDiffCells)
  if (alignment.truncated) {
    sink.problems.push({ ruleId: 'diff-too-large', dimension, limitName: 'maxDiffCells', limit: maxDiffCells })
    return null
  }
  return alignment
}

/**
 * Split a hunk into replacements, deletions and insertions.
 *
 * Pairing inside a hunk is positional: the first removed item is read as the
 * predecessor of the first added item. A move therefore reads as a deletion
 * plus an insertion, which is documented and is the conservative direction --
 * it shows more, not less.
 */
function classifyHunk(hunk) {
  const shared = Math.min(hunk.removed.length, hunk.added.length)
  return {
    replaced: hunk.removed.slice(0, shared).map((index, position) => [index, hunk.added[position]]),
    removed: hunk.removed.slice(shared),
    added: hunk.added.slice(shared),
  }
}

function compareBlocks(sink, before, after, mode, maxDiffCells) {
  const alignment = alignDimension(
    sink,
    'blocks',
    before.blocks.map((block) => normalizeText(block, mode)),
    after.blocks.map((block) => normalizeText(block, mode)),
    maxDiffCells,
  )
  if (alignment === null) return

  for (const [beforeIndex, afterIndex] of alignment.pairs) {
    const beforeText = before.blocks[beforeIndex]
    const afterText = after.blocks[afterIndex]
    if (beforeText !== afterText) {
      addWhitespaceOnly(sink, pointerFor('after', 'blocks', afterIndex), beforeText, afterText)
    }
  }

  for (const hunk of alignment.hunks) {
    const { replaced, removed, added } = classifyHunk(hunk)
    for (const [beforeIndex, afterIndex] of replaced) {
      addChange(sink, {
        ruleId: 'text-changed',
        pointer: pointerFor('after', 'blocks', afterIndex),
        message: 'A text block was rewritten between the two snapshots.',
        before: before.blocks[beforeIndex],
        after: after.blocks[afterIndex],
      })
    }
    for (const beforeIndex of removed) {
      addChange(sink, {
        ruleId: 'content-removed',
        pointer: pointerFor('before', 'blocks', beforeIndex),
        message: 'A text block present in the before snapshot is absent from the after snapshot.',
        before: before.blocks[beforeIndex],
        after: null,
      })
    }
    for (const afterIndex of added) {
      addChange(sink, {
        ruleId: 'content-added',
        pointer: pointerFor('after', 'blocks', afterIndex),
        message: 'A text block is present only in the after snapshot.',
        before: null,
        after: after.blocks[afterIndex],
      })
    }
  }
}

function compareLinks(sink, before, after, mode, maxDiffCells) {
  const alignment = alignDimension(
    sink,
    'links',
    before.links.map((link) => normalizeUrl(link.href)),
    after.links.map((link) => normalizeUrl(link.href)),
    maxDiffCells,
  )
  if (alignment === null) return

  for (const [beforeIndex, afterIndex] of alignment.pairs) {
    const beforeLink = before.links[beforeIndex]
    const afterLink = after.links[afterIndex]
    if (normalizeText(beforeLink.text, mode) !== normalizeText(afterLink.text, mode)) {
      addChange(sink, {
        ruleId: 'link-text-changed',
        pointer: pointerFor('after', 'links', afterIndex),
        message: `The anchor text of the link to ${sanitize(normalizeUrl(afterLink.href), VALUE_LIMIT)} changed.`,
        before: beforeLink.text,
        after: afterLink.text,
      })
    } else if (beforeLink.text !== afterLink.text) {
      addWhitespaceOnly(sink, pointerFor('after', 'links', afterIndex), beforeLink.text, afterLink.text)
    }
  }

  for (const hunk of alignment.hunks) {
    const { replaced, removed, added } = classifyHunk(hunk)
    for (const [beforeIndex, afterIndex] of replaced) {
      addChange(sink, {
        ruleId: 'link-destination-changed',
        pointer: pointerFor('after', 'links', afterIndex),
        message: 'A link points somewhere else in the after snapshot.',
        before: before.links[beforeIndex].href,
        after: after.links[afterIndex].href,
      })
    }
    for (const beforeIndex of removed) {
      addChange(sink, {
        ruleId: 'link-removed',
        pointer: pointerFor('before', 'links', beforeIndex),
        message: 'A link present in the before snapshot is absent from the after snapshot.',
        before: before.links[beforeIndex].href,
        after: null,
      })
    }
    for (const afterIndex of added) {
      addChange(sink, {
        ruleId: 'link-added',
        pointer: pointerFor('after', 'links', afterIndex),
        message: 'A link is present only in the after snapshot.',
        before: null,
        after: after.links[afterIndex].href,
      })
    }
  }
}

function compareImages(sink, before, after, mode, maxDiffCells) {
  const alignment = alignDimension(
    sink,
    'images',
    before.images.map((image) => normalizeUrl(image.src)),
    after.images.map((image) => normalizeUrl(image.src)),
    maxDiffCells,
  )
  if (alignment === null) return

  for (const [beforeIndex, afterIndex] of alignment.pairs) {
    const beforeImage = before.images[beforeIndex]
    const afterImage = after.images[afterIndex]
    const beforeAlt = beforeImage.alt === null ? null : normalizeText(beforeImage.alt, mode)
    const afterAlt = afterImage.alt === null ? null : normalizeText(afterImage.alt, mode)
    if (beforeAlt !== afterAlt) {
      addChange(sink, {
        ruleId: 'image-alt-changed',
        pointer: pointerFor('after', 'images', afterIndex),
        message: `The alternative text of ${sanitize(normalizeUrl(afterImage.src), VALUE_LIMIT)} changed.`,
        before: beforeImage.alt,
        after: afterImage.alt,
      })
    } else if (beforeImage.alt !== afterImage.alt) {
      addWhitespaceOnly(sink, pointerFor('after', 'images', afterIndex), beforeImage.alt, afterImage.alt)
    }
  }

  for (const hunk of alignment.hunks) {
    const { replaced, removed, added } = classifyHunk(hunk)
    for (const [beforeIndex, afterIndex] of replaced) {
      addChange(sink, {
        ruleId: 'image-source-changed',
        pointer: pointerFor('after', 'images', afterIndex),
        message: 'An image loads from somewhere else in the after snapshot.',
        before: before.images[beforeIndex].src,
        after: after.images[afterIndex].src,
      })
    }
    for (const beforeIndex of removed) {
      addChange(sink, {
        ruleId: 'image-removed',
        pointer: pointerFor('before', 'images', beforeIndex),
        message: 'An image present in the before snapshot is absent from the after snapshot.',
        before: before.images[beforeIndex].src,
        after: null,
      })
    }
    for (const afterIndex of added) {
      addChange(sink, {
        ruleId: 'image-added',
        pointer: pointerFor('after', 'images', afterIndex),
        message: 'An image is present only in the after snapshot.',
        before: null,
        after: after.images[afterIndex].src,
      })
    }
  }
}

function metadataMap(entries) {
  const map = new Map()
  for (const entry of entries) map.set(entry.key, entry.value)
  return map
}

function compareMetadata(sink, before, after, mode) {
  const beforeMap = metadataMap(before.metadata)
  const afterMap = metadataMap(after.metadata)
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort(byCodeUnit)

  for (const key of keys) {
    const label = sanitize(key, VALUE_LIMIT)
    if (!afterMap.has(key)) {
      addChange(sink, {
        ruleId: 'metadata-removed',
        pointer: pointerFor('before', 'metadata', key),
        message: `Metadata "${label}" is absent from the after snapshot.`,
        before: beforeMap.get(key),
        after: null,
      })
      continue
    }
    if (!beforeMap.has(key)) {
      addChange(sink, {
        ruleId: 'metadata-added',
        pointer: pointerFor('after', 'metadata', key),
        message: `Metadata "${label}" is present only in the after snapshot.`,
        before: null,
        after: afterMap.get(key),
      })
      continue
    }
    const beforeValue = beforeMap.get(key)
    const afterValue = afterMap.get(key)
    const compare = isUrlValuedMetadata(key)
      ? (raw) => normalizeUrl(raw)
      : (raw) => normalizeText(raw, mode)
    if (compare(beforeValue) === compare(afterValue)) {
      if (beforeValue !== afterValue) {
        addWhitespaceOnly(sink, pointerFor('after', 'metadata', key), beforeValue, afterValue)
      }
      continue
    }
    addChange(sink, {
      ruleId: METADATA_RULES[baseKey(key)] ?? 'metadata-changed',
      pointer: pointerFor('after', 'metadata', key),
      message: `Metadata "${label}" changed between the two snapshots.`,
      before: beforeValue,
      after: afterValue,
    })
  }
}

/**
 * Compare one document across both snapshots.
 *
 * Returns `{ changes, whitespaceOnly, problems }`. `problems` names a limit
 * that stopped a dimension from being compared; the caller turns it into a
 * finding and marks the run incomplete.
 */
export function compareDocuments(before, after, { mode, maxDiffCells }) {
  if (!Array.isArray(before?.blocks) || !Array.isArray(after?.blocks)) {
    throw new TypeError('Comparison needs two parsed documents')
  }
  if (!Number.isInteger(maxDiffCells) || maxDiffCells < 1) {
    throw new TypeError('The alignment cell budget must be a positive integer')
  }
  const sink = createSink()
  compareBlocks(sink, before, after, mode, maxDiffCells)
  compareLinks(sink, before, after, mode, maxDiffCells)
  compareImages(sink, before, after, mode, maxDiffCells)
  compareMetadata(sink, before, after, mode)
  return sink
}
