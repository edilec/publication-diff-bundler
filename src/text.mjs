/**
 * Decoding, sanitising and normalisation primitives.
 *
 * Nothing in this module touches the filesystem, the clock, the locale, the
 * environment or the network, so every function here is a pure function of its
 * arguments. That is what makes a bundle reproducible.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` depends on ICU data that differs between Node builds and
 * platforms, and it has already produced a real ordering difference in this
 * catalog. Bundle output is a byte-for-byte contract, so ordering may never
 * depend on a collation table.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then looking for
 * U+FFFD in the result cannot tell undecodable bytes apart from a document
 * that legitimately contains a replacement character, and that confusion has
 * let an unreadable input report a pass. The decoder decides; the decoded text
 * never gets a vote.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * Characters removed before any snapshot-derived string reaches output.
 *
 * Built from code points rather than written literally: a literal U+2028 inside
 * a module is a syntax hazard, and the point of the class is that these
 * characters never reach a report line in the first place. U+2028 and U+2029
 * terminate a line for a JavaScript consumer, and a bare newline forges a line
 * in the human report -- which is why this is applied to identifiers, paths and
 * keys, not only to excerpt text.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${String.fromCharCode(127)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'g',
)

export const BOM = String.fromCharCode(0xfeff)

export const EXCERPT_LIMIT = 200

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every string that came out of a snapshot passes through here on its way to
 * the report or the bundle: block text, link destinations, alt text, metadata
 * keys and values, and relative paths. Sanitising only the evidence field has
 * already let an identifier containing a newline forge extra lines in a human
 * report, so identifiers are sanitised too.
 */
export function sanitize(value, limit = EXCERPT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Excerpt limit must be a positive integer')
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/** The documented whitespace comparison modes. */
export const WHITESPACE_MODES = Object.freeze(['collapse', 'preserve'])

/**
 * Apply the configured whitespace mode to a piece of prose.
 *
 * `collapse` folds every run of ECMAScript `\s` whitespace to one space and
 * trims the ends, so a reflowed paragraph compares equal. `preserve` returns
 * the text untouched, so the same reflow is a change.
 *
 * Zero-width characters (U+200B and friends) are deliberately **not**
 * whitespace here: they are invisible but they are content, and folding them
 * away would hide an edit that nobody could see by reading the page.
 */
export function normalizeText(value, mode) {
  if (mode === 'preserve') return String(value)
  if (mode !== 'collapse') throw new TypeError(`Unknown whitespace mode "${mode}"`)
  return String(value).replace(/\s+/g, ' ').trim()
}

/**
 * Normalise a destination. Trim only -- never collapse.
 *
 * This function exists so that the whitespace mode cannot reach a URL. An HTML
 * parser strips leading and trailing whitespace from an attribute before
 * resolving it, so trimming cannot change which resource is addressed. Folding
 * an interior run would: `"/a  b"` and `"/a b"` are two different destinations,
 * and a configuration option that made them compare equal would be exactly the
 * "whitespace normalisation hid a real change" defect this tool refuses.
 */
export function normalizeUrl(value) {
  return String(value).trim()
}

/** Escape one path segment for a JSON Pointer, per RFC 6901. */
export function escapePointerSegment(segment) {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1')
}
