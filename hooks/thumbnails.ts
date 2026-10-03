export type Dimensions = { width: number; height: number }
export type Box = { columns: number; rows: number }

// A thumbnail is at most this many rows tall and columns wide, and never narrower than MIN.
const MAX_ROWS = 6
const MAX_COLUMNS = 32
const MIN_COLUMNS = 4
// Terminal cells are roughly twice as tall as they are wide.
const CELL_RATIO = 2
// Each thumbnail's frame takes a cell on each side, a border row above and below, plus
// its label row; neighbours sit one column apart.
const FRAME_COLUMNS = 2
const FRAME_ROWS = 3
const GAP = 1
// The shape assumed when an image's size is unknown.
const UNKNOWN: Dimensions = { width: 3, height: 2 }

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]
const IHDR = [0x49, 0x48, 0x44, 0x52]

/**
 * Width and height from the start of a PNG file (base64), read from its IHDR chunk;
 * null when the bytes aren't a PNG.
 */
export function pngDimensions(base64: string): Dimensions | null {
  // Bytes 0-7 are the signature, 12-15 the IHDR tag, 16-23 width and height (big-endian).
  const raw = atob(base64.slice(0, 32))
  if (raw.length < 24) return null
  const byte = (i: number) => raw.charCodeAt(i)
  if (PNG_MAGIC.some((b, i) => byte(i) !== b) || IHDR.some((b, i) => byte(12 + i) !== b)) return null
  const uint32 = (at: number) => ((byte(at) << 24) | (byte(at + 1) << 16) | (byte(at + 2) << 8) | byte(at + 3)) >>> 0
  const width = uint32(16)
  const height = uint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

function boxAt(rows: number, size: Dimensions | null): Box {
  const { width, height } = size ?? UNKNOWN
  const columns = Math.round((rows * CELL_RATIO * width) / height)
  if (columns <= MAX_COLUMNS) return { columns: Math.max(MIN_COLUMNS, columns), rows }
  // Too wide: keep the column cap and give back the rows the picture no longer needs.
  return { columns: MAX_COLUMNS, rows: Math.max(1, Math.round((MAX_COLUMNS * height) / (CELL_RATIO * width))) }
}

const rowWidth = (boxes: readonly Box[]) =>
  boxes.reduce((sum, box) => sum + box.columns + FRAME_COLUMNS, 0) + GAP * Math.max(0, boxes.length - 1)

/**
 * Picture boxes for a single row of thumbnails, each keeping its image's proportions,
 * as tall as `maxRows` allows and scaled down until the row fits in `columns`.
 */
export function thumbnailBoxes(sizes: readonly (Dimensions | null)[], maxRows: number, columns: number): Box[] {
  let rows = Math.min(MAX_ROWS, Math.max(1, maxRows - FRAME_ROWS))
  let boxes = sizes.map(size => boxAt(rows, size))
  while (rows > 1 && rowWidth(boxes) > columns) {
    // Jump straight to the height the overflow suggests, then settle by single rows.
    const scaled = Math.floor((rows * columns) / rowWidth(boxes))
    rows = Math.max(1, Math.min(rows - 1, scaled))
    boxes = sizes.map(size => boxAt(rows, size))
  }
  return boxes
}

/**
 * Whether the terminal draws Claude Code's `Image` element, which needs the kitty
 * graphics protocol (kitty, Ghostty); elsewhere it only draws the `alt` text.
 */
export function drawsImages(env: { term?: string; termProgram?: string; kittyWindowId?: string }): boolean {
  const term = env.term?.toLowerCase() ?? ''
  return (
    env.kittyWindowId !== undefined ||
    env.termProgram?.toLowerCase() === 'ghostty' ||
    term.includes('kitty') ||
    term.includes('ghostty')
  )
}
