/**
 * Turning one snapshot document into the four things this tool compares:
 * semantic text blocks, links, images and metadata.
 *
 * The HTML reader is a deliberately small scanner, not a conforming parser. It
 * is written to be predictable and bounded rather than clever, and everything
 * it cannot do is written down in docs/diff-rules.md. What matters for the
 * result is that the same bytes always produce the same extraction: there is
 * no clock, no locale, no network and no filesystem in this module.
 */

import { BOM } from './text.mjs'

export const HTML_EXTENSIONS = Object.freeze(['.htm', '.html'])
export const MARKDOWN_EXTENSIONS = Object.freeze(['.markdown', '.md'])
export const DOCUMENT_EXTENSIONS = Object.freeze([...HTML_EXTENSIONS, ...MARKDOWN_EXTENSIONS])

/**
 * Elements that end the current text block.
 *
 * `br` is in the set on purpose. Treating a line break as a space would let a
 * `<br>` be swapped for whitespace without the swap ever showing up under the
 * `collapse` mode, and this tool refuses to let normalisation eat structure.
 */
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'tr', 'ul',
])

/** Elements whose content is discarded: it is code or styling, not prose. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style'])

/** Elements whose content is text but not markup. */
const RCDATA_ELEMENTS = new Set(['textarea', 'title'])

/** Elements whose subtree is skipped entirely. */
const SKIPPED_SUBTREES = new Set(['noscript', 'template'])

/**
 * The complete set of named character references this scanner decodes.
 *
 * A short, documented list beats a partial imitation of the full HTML table:
 * anything outside it is left exactly as written, which is visible in a
 * reviewer's diff rather than silently half-decoded. Matching is
 * case-sensitive, as HTML requires.
 */
const NAMED_REFERENCES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: String.fromCharCode(0xa0),
  quot: '"',
})

const REFERENCE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g

export function decodeReferences(value) {
  if (!value.includes('&')) return value
  return value.replace(REFERENCE, (whole, body) => {
    if (body.charCodeAt(0) === 0x23) {
      const hexadecimal = body[1] === 'x' || body[1] === 'X'
      const code = hexadecimal ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole
      if (code >= 0xd800 && code <= 0xdfff) return whole
      return String.fromCodePoint(code)
    }
    const replacement = NAMED_REFERENCES[body]
    return replacement === undefined ? whole : replacement
  })
}

/** Tokenise HTML into text, open-tag and close-tag events. */
export function* tokenizeHtml(text) {
  let cursor = 0
  const length = text.length

  while (cursor < length) {
    const open = text.indexOf('<', cursor)
    if (open === -1) {
      yield { type: 'text', value: text.slice(cursor) }
      return
    }
    if (open > cursor) yield { type: 'text', value: text.slice(cursor, open) }

    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4)
      cursor = end === -1 ? length : end + 3
      continue
    }
    if (text.startsWith('<!', open) || text.startsWith('<?', open)) {
      const end = text.indexOf('>', open + 2)
      cursor = end === -1 ? length : end + 1
      continue
    }
    if (text.startsWith('</', open)) {
      const closing = /^<\/([a-zA-Z][^\s>]*)[^>]*>?/.exec(text.slice(open))
      if (closing === null) {
        yield { type: 'text', value: '<' }
        cursor = open + 1
        continue
      }
      yield { type: 'close', name: closing[1].toLowerCase() }
      cursor = open + closing[0].length
      continue
    }

    const opening = /^<([a-zA-Z][^\s/>]*)/.exec(text.slice(open))
    if (opening === null) {
      yield { type: 'text', value: '<' }
      cursor = open + 1
      continue
    }
    const name = opening[1].toLowerCase()
    let index = open + opening[0].length
    const attributes = new Map()
    let selfClosing = false

    while (index < length) {
      while (index < length && /\s/.test(text[index])) index += 1
      if (index >= length) break
      if (text[index] === '>') {
        index += 1
        break
      }
      if (text[index] === '/') {
        selfClosing = true
        index += 1
        continue
      }
      let nameEnd = index
      while (nameEnd < length && !/[\s/>=]/.test(text[nameEnd])) nameEnd += 1
      const attributeName = text.slice(index, nameEnd).toLowerCase()
      index = nameEnd
      while (index < length && /\s/.test(text[index])) index += 1

      let value = ''
      if (text[index] === '=') {
        index += 1
        while (index < length && /\s/.test(text[index])) index += 1
        const quote = text[index]
        if (quote === '"' || quote === "'") {
          const end = text.indexOf(quote, index + 1)
          value = end === -1 ? text.slice(index + 1) : text.slice(index + 1, end)
          index = end === -1 ? length : end + 1
        } else {
          let end = index
          while (end < length && !/[\s>]/.test(text[end])) end += 1
          value = text.slice(index, end)
          index = end
        }
      }
      // First declaration wins, as browsers do; a repeated attribute is a
      // malformed tag, not two values.
      if (attributeName !== '' && !attributes.has(attributeName)) {
        attributes.set(attributeName, decodeReferences(value))
      }
    }

    yield { type: 'open', name, attributes, selfClosing }
    cursor = index

    if (!selfClosing && (RAW_TEXT_ELEMENTS.has(name) || RCDATA_ELEMENTS.has(name))) {
      // `name` is one of a fixed set of literals here, so building a pattern
      // from it cannot inject anything into the expression.
      const closing = new RegExp(`</${name}\\s*>`, 'i').exec(text.slice(cursor))
      const raw = closing === null ? text.slice(cursor) : text.slice(cursor, cursor + closing.index)
      if (RCDATA_ELEMENTS.has(name) && raw !== '') yield { type: 'text', value: decodeReferences(raw) }
      cursor = closing === null ? length : cursor + closing.index + closing[0].length
      yield { type: 'close', name }
    }
  }
}

function createDocument() {
  return { blocks: [], links: [], images: [], metadata: [], problems: [] }
}

function createLimitRecorder(document) {
  const hit = new Set()
  return (ruleId, limitName, limit) => {
    if (hit.has(ruleId)) return
    hit.add(ruleId)
    document.problems.push({ ruleId, limitName, limit })
  }
}

function createMetadataSink(document, limits, exceeded) {
  const counts = new Map()
  return (key, value) => {
    if (document.metadata.length >= limits.maxMetadata) {
      exceeded('too-many-metadata', 'maxMetadata', limits.maxMetadata)
      return
    }
    // A repeated key is kept under a suffixed name rather than dropped. A
    // second `<meta name="robots">` that silently replaced the first would let
    // a real policy change vanish between two snapshots.
    const seen = (counts.get(key) ?? 0) + 1
    counts.set(key, seen)
    document.metadata.push({ key: seen === 1 ? key : `${key}#${seen}`, value })
  }
}

/** Read an HTML snapshot document. */
export function parseHtml(text, limits) {
  const document = createDocument()
  const exceeded = createLimitRecorder(document)
  const addMetadata = createMetadataSink(document, limits, exceeded)

  let buffer = []
  let skipDepth = 0
  let openLink = null
  let titleDepth = 0

  const pushBlock = () => {
    const raw = buffer.join('')
    buffer = []
    if (raw.trim() === '') return
    if (document.blocks.length >= limits.maxBlocks) {
      exceeded('too-many-blocks', 'maxBlocks', limits.maxBlocks)
      return
    }
    document.blocks.push(raw)
  }

  const closeLink = () => {
    if (openLink === null) return
    if (document.links.length >= limits.maxLinks) {
      exceeded('too-many-links', 'maxLinks', limits.maxLinks)
      openLink = null
      return
    }
    document.links.push({ href: openLink.href, text: openLink.parts.join('') })
    openLink = null
  }

  for (const token of tokenizeHtml(text)) {
    if (token.type === 'text') {
      if (skipDepth > 0) continue
      if (titleDepth > 0) {
        addMetadata('title', token.value)
        continue
      }
      buffer.push(token.value)
      if (openLink !== null) openLink.parts.push(token.value)
      continue
    }

    if (token.type === 'open') {
      if (SKIPPED_SUBTREES.has(token.name)) {
        if (!token.selfClosing) skipDepth += 1
        continue
      }
      if (skipDepth > 0) continue

      if (token.name === 'title') {
        titleDepth += 1
        continue
      }
      if (token.name === 'html' && token.attributes.has('lang')) {
        addMetadata('html:lang', token.attributes.get('lang'))
      }
      if (token.name === 'meta') {
        const content = token.attributes.get('content')
        if (content !== undefined) {
          for (const attribute of ['name', 'property', 'http-equiv']) {
            const label = token.attributes.get(attribute)
            if (label !== undefined && label.trim() !== '') {
              addMetadata(`meta:${attribute}=${label.trim().toLowerCase()}`, content)
              break
            }
          }
        }
      }
      if (token.name === 'link') {
        const relation = (token.attributes.get('rel') ?? '').trim().toLowerCase()
        const href = token.attributes.get('href')
        if (relation !== '' && href !== undefined) {
          const language = (token.attributes.get('hreflang') ?? '').trim().toLowerCase()
          addMetadata(language === '' ? `link:${relation}` : `link:${relation}:hreflang=${language}`, href)
        }
      }
      if (token.name === 'img') {
        if (document.images.length >= limits.maxImages) {
          exceeded('too-many-images', 'maxImages', limits.maxImages)
        } else {
          document.images.push({
            src: token.attributes.get('src') ?? '',
            alt: token.attributes.has('alt') ? token.attributes.get('alt') : null,
          })
        }
      }
      if (token.name === 'a') {
        closeLink()
        const href = token.attributes.get('href')
        // An `<a>` with no href is a target, not a link. It has no destination
        // to change, so it is not tracked as one.
        if (href !== undefined) openLink = { href, parts: [] }
      }
      if (BLOCK_ELEMENTS.has(token.name)) {
        closeLink()
        pushBlock()
      }
      continue
    }

    if (SKIPPED_SUBTREES.has(token.name)) {
      if (skipDepth > 0) skipDepth -= 1
      continue
    }
    if (skipDepth > 0) continue
    if (token.name === 'title') {
      if (titleDepth > 0) titleDepth -= 1
      continue
    }
    if (token.name === 'a') closeLink()
    if (BLOCK_ELEMENTS.has(token.name)) {
      closeLink()
      pushBlock()
    }
  }

  closeLink()
  pushBlock()
  return document
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const ATX_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const FRONT_MATTER_KEY = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/

/**
 * Markdown inline links, images and autolinks, in document order.
 *
 * Reference-style links are not resolved: see docs/diff-rules.md. They are
 * left inside the block text, where a reviewer still sees the change.
 */
const MARKDOWN_INLINE =
  /(!)?\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|<((?:https?|mailto|ftp):[^>\s]+)>/g

function stripCarriageReturn(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function unwrapPointyBrackets(value) {
  return value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value
}

/** Read a Markdown snapshot document. */
export function parseMarkdown(text, limits) {
  const document = createDocument()
  const exceeded = createLimitRecorder(document)
  const addMetadata = createMetadataSink(document, limits, exceeded)

  const lines = (text.startsWith(BOM) ? text.slice(1) : text).split('\n').map(stripCarriageReturn)
  let start = 0

  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end !== -1) {
      for (let index = 1; index < end; index += 1) {
        const line = lines[index]
        if (line.trim() === '' || line.trimStart().startsWith('#')) continue
        const match = FRONT_MATTER_KEY.exec(line)
        if (match === null) continue
        addMetadata(`front-matter:${match[1].toLowerCase()}`, match[2].trim())
      }
      start = end + 1
    }
  }

  const blocks = []
  let current = []
  let fence = null

  const flush = () => {
    if (current.length === 0) return
    const raw = current.join('\n')
    current = []
    if (raw.trim() !== '') blocks.push(raw)
  }

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (fence !== null) {
      current.push(line)
      if (line.trimStart().startsWith(fence)) {
        flush()
        fence = null
      }
      continue
    }
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch !== null) {
      flush()
      fence = fenceMatch[1]
      current.push(line)
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    if (ATX_HEADING.test(line)) {
      flush()
      current.push(line)
      flush()
      continue
    }
    current.push(line)
  }
  flush()

  for (const block of blocks) {
    if (document.blocks.length >= limits.maxBlocks) {
      exceeded('too-many-blocks', 'maxBlocks', limits.maxBlocks)
      break
    }
    document.blocks.push(block)
  }

  const body = lines.slice(start).join('\n')
  const heading = ATX_HEADING.exec(body.split('\n').find((line) => /^\s{0,3}#\s+/.test(line)) ?? '')
  if (heading !== null) addMetadata('title', heading[2].trim())

  MARKDOWN_INLINE.lastIndex = 0
  let match = MARKDOWN_INLINE.exec(body)
  while (match !== null) {
    if (match[1] === '!') {
      if (document.images.length >= limits.maxImages) {
        exceeded('too-many-images', 'maxImages', limits.maxImages)
      } else {
        document.images.push({ src: unwrapPointyBrackets(match[3] ?? ''), alt: match[2] ?? null })
      }
    } else {
      const href = match[4] !== undefined ? match[4] : unwrapPointyBrackets(match[3] ?? '')
      const label = match[4] !== undefined ? match[4] : (match[2] ?? '')
      if (document.links.length >= limits.maxLinks) {
        exceeded('too-many-links', 'maxLinks', limits.maxLinks)
      } else {
        document.links.push({ href, text: label })
      }
    }
    match = MARKDOWN_INLINE.exec(body)
  }

  return document
}

/** Read a snapshot document, choosing the reader from its extension. */
export function parseDocument(extension, text, limits) {
  if (HTML_EXTENSIONS.includes(extension)) return parseHtml(text, limits)
  if (MARKDOWN_EXTENSIONS.includes(extension)) return parseMarkdown(text, limits)
  throw new TypeError(`No reader for extension "${extension}"`)
}
