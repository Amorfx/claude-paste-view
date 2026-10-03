export type TextTag = { n: number; lines: number | null }
export type DraftTags = { images: number[]; texts: TextTag[] }

// `[Image #3]`, `[Pasted text #2 +9 lines]`, or `[Pasted text #2]` for one long line.
const TAG = /\[(?:Image #(\d+)|Pasted text #(\d+)(?: \+(\d+) lines?)?)\]/g

/** The image and pasted-text tags a draft holds, each once, in the order they first appear. */
export function draftTags(draft: string): DraftTags {
  const images: number[] = []
  const texts: TextTag[] = []
  for (const [, image, text, lines] of draft.matchAll(TAG)) {
    if (image !== undefined && !images.includes(Number(image))) images.push(Number(image))
    if (text !== undefined && !texts.some(tag => tag.n === Number(text))) {
      texts.push({ n: Number(text), lines: lines === undefined ? null : Number(lines) })
    }
  }
  return { images, texts }
}

/** Line breaks in a text, counted the way Claude Code counts them for a paste's tag. */
export function lineBreaks(text: string): number {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0
}

/**
 * Whether a clipboard text is the paste a tag stands for: same line count as the tag
 * announces, allowing for a trailing newline the terminal may have dropped.
 */
export function matchesTag(text: string, lines: number | null): boolean {
  if (text.trim() === '') return false
  const expected = lines ?? 0
  return lineBreaks(text) === expected || lineBreaks(text.trimEnd()) === expected
}

/** The first non-blank line, whitespace collapsed, cut to `width` with an ellipsis. */
export function firstLine(text: string, width: number): string {
  const line = text.split(/\r\n|\r|\n/).find(l => l.trim() !== '')?.replace(/\s+/g, ' ').trim() ?? ''
  if (width < 1) return ''
  return line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`
}

/** A short character count: `840 chars`, `2.3k chars`, `1.2M chars`. */
export function charCount(length: number): string {
  if (length < 1000) return `${length} chars`
  if (length < 1_000_000) return `${(length / 1000).toFixed(1).replace(/\.0$/, '')}k chars`
  return `${(length / 1_000_000).toFixed(1).replace(/\.0$/, '')}M chars`
}
