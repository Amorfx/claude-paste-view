import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { charCount, draftTags, firstLine, matchesTag } from '../hooks/tags'
import { drawsImages, pngDimensions, thumbnailBoxes } from '../hooks/thumbnails'

const LOREM = 'Lorem ipsum dolor sit amet,\nconsectetur adipiscing elit,\nsed do eiusmod tempor.'

test('tags come from the draft, each once, in the order they first appear', () => {
  expect(draftTags('a [Image #4] [Pasted text #2 +9 lines] b [Image #1] [Pasted text #3] [Image #4] [Pasted text #2 +9 lines]')).toEqual({
    images: [4, 1],
    texts: [
      { n: 2, lines: 9 },
      { n: 3, lines: null },
    ],
  })
  expect(draftTags('[Image 1] [image #3] [Pasted text 2 +9 lines] [pasted text #4] #5')).toEqual({ images: [], texts: [] })
})

test('a clipboard text matches a tag only when the line count agrees', () => {
  expect(matchesTag(LOREM, 2)).toBe(true)
  expect(matchesTag(`${LOREM}\n`, 2)).toBe(true) // a trailing newline the terminal dropped
  expect(matchesTag(LOREM.replace(/\n/g, '\r\n'), 2)).toBe(true)
  expect(matchesTag(LOREM, 5)).toBe(false)
  expect(matchesTag('one long line', null)).toBe(true)
  expect(matchesTag(LOREM, null)).toBe(false)
  expect(matchesTag('  \n ', 1)).toBe(false)
})

test('the preview line is the first non-blank line, cut to fit', () => {
  expect(firstLine('\n\n  Hello   world  \nnext', 40)).toBe('Hello world')
  expect(firstLine('abcdefghij', 5)).toBe('abcd…')
  expect(firstLine('abc', 0)).toBe('')
})

test('character counts read short', () => {
  expect(charCount(840)).toBe('840 chars')
  expect(charCount(2349)).toBe('2.3k chars')
  expect(charCount(3000)).toBe('3k chars')
  expect(charCount(1_250_000)).toBe('1.3M chars')
})

test('pictures are drawn only where the terminal speaks the kitty graphics protocol', () => {
  expect(drawsImages({ term: 'xterm-kitty' })).toBe(true)
  expect(drawsImages({ term: 'xterm-256color', kittyWindowId: '1' })).toBe(true)
  expect(drawsImages({ term: 'xterm-ghostty', termProgram: 'ghostty' })).toBe(true)
  expect(drawsImages({ term: 'xterm-256color', termProgram: 'Orca' })).toBe(false)
  expect(drawsImages({ term: 'xterm-256color', termProgram: 'Apple_Terminal' })).toBe(false)
  expect(drawsImages({})).toBe(false)
  // Claude Code turns pictures off inside tmux or screen and in background sessions...
  expect(drawsImages({ termProgram: 'ghostty', multiplexer: '/tmp/tmux-501/default,1,0' })).toBe(false)
  expect(drawsImages({ termProgram: 'ghostty', sessionKind: 'bg' })).toBe(false)
  // ...unless told to draw them anyway.
  expect(drawsImages({ termProgram: 'ghostty', multiplexer: '1', forceImages: '1' })).toBe(true)
})

const BAND = {
  plugin: 'paste-view',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const PANE = {
  plugin: 'paste-view',
  component: 'Pane',
  requestId: 'paste-view',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Pasted text #2', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

/** The first bytes of a PNG of the given size, base64-encoded: signature, IHDR length and tag, width, height. */
function pngStart(width: number, height: number): string {
  const be32 = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height)]
  return btoa(String.fromCharCode(...bytes))
}

test('a PNG gives its size from its header; anything else gives none', () => {
  expect(pngDimensions(pngStart(1630, 632))).toEqual({ width: 1630, height: 632 })
  expect(pngDimensions(btoa('GIF89a, not a PNG at all, padded out'))).toBeNull()
  expect(pngDimensions(btoa('short'))).toBeNull()
})

test('thumbnails keep their proportions within the caps', () => {
  const square = { width: 400, height: 400 }
  // Square: six rows, twelve columns (cells are about twice as tall as wide).
  expect(thumbnailBoxes([square], 20, 120)).toEqual([{ columns: 12, rows: 6 }])
  // Panorama: held to 32 columns, with the rows it then needs.
  expect(thumbnailBoxes([{ width: 3000, height: 500 }], 20, 120)).toEqual([{ columns: 32, rows: 3 }])
  // Portrait: never under four columns.
  expect(thumbnailBoxes([{ width: 100, height: 2000 }], 20, 120)).toEqual([{ columns: 4, rows: 6 }])
  // Unknown size: a 3:2 shape.
  expect(thumbnailBoxes([null], 20, 120)).toEqual([{ columns: 18, rows: 6 }])
})

test('a row of thumbnails shrinks to the room it has', () => {
  const square = { width: 400, height: 400 }
  // Little height: the frame and label take three rows.
  expect(thumbnailBoxes([square], 6, 120)).toEqual([{ columns: 6, rows: 3 }])
  // Little width: three squares at six rows need 3 × 14 + 2 = 44 columns; 40 forces five.
  expect(thumbnailBoxes([square, square, square], 20, 40)).toEqual([
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
    { columns: 10, rows: 5 },
  ])
  // Never below one row, whatever the squeeze.
  expect(thumbnailBoxes([square, square, square, square], 2, 10).every(box => box.rows === 1)).toBe(true)
})

const IMAGES_DIR = '/tmp/claude-501/-work/sess-1/images'

function harness(on: On, env: Record<string, string> = {}) {
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CODE_TMPDIR: '/tmp/claude-501', TERM: 'xterm-256color', ...env })
  const state = {
    draft: '',
    clipboard: '',
    /** Names of the files in the session's image cache. */
    images: ['1.png'],
    writes: 0,
    opened: [] as string[],
    closed: [] as string[],
    ran: [] as string[][],
  }
  const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', ($, e) => ({
    value: e.path === IMAGES_DIR ? state.images.map(name => entry(name, 'file')) : [entry('-work', 'dir')],
  }))
  on('fs.exists', ($, e) => ({ value: e.path === IMAGES_DIR || state.images.some(name => e.path === `${IMAGES_DIR}/${name}`) }))
  on('fs.read', () => ({ value: { base64: pngStart(800, 400) } }))
  on('state.set', ($, e, next) => (state.writes++, next(e)))
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.read', () => ({ value: { text: state.draft, cursor: state.draft.length } }))
  on('process.run', ($, e) => {
    state.ran.push([...e.argv])
    const [command] = e.argv
    const stdout = command === 'pbpaste' ? state.clipboard : command === 'uname' ? 'Darwin\n' : ''
    const exitCode = command === 'pbpaste' || command === 'uname' || command === 'open' ? 0 : 1
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', ($, e) => (state.opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: state.opened.map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  on('ui.close', ($, e) => (state.closed.push(e.id), (state.opened = state.opened.filter(id => id !== e.id)), { value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  return { clock, state }
}

test('a pasted text shows a preview, opens whole in a pane, and clears on send', async ($, on) => {
  const { clock, state } = harness(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  state.clipboard = LOREM
  state.draft = 'explain [Pasted text #2 +2 lines]'
  await clock.advance(200)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button', key: 'text-2', text: '#2 · 3 lines · 79 chars — Lorem ipsum dolor sit amet,' })).toBeDefined()
  await $.ui.press({ plugin: 'paste-view', key: 'text-2' })
  await band.unmount()
  expect(state.opened).toEqual(['paste-view'])

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'sed do eiusmod tempor.' })).toBeDefined()
  await pane.unmount()

  // Sending the prompt empties the box: the row goes and the pane closes.
  state.draft = ''
  await clock.advance(200)
  expect(state.closed).toEqual(['paste-view'])
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.find({ type: 'Button' })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: 'engine band' })).toBeDefined()
})

test('a paste whose clipboard no longer matches says so instead of guessing', async ($, on) => {
  const { clock, state } = harness(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  state.clipboard = 'something copied since'
  state.draft = '[Pasted text #1 +9 lines]'
  await clock.advance(200)
  // The clipboard catching up later doesn't change a verdict already made.
  state.clipboard = LOREM
  await clock.advance(200)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: '#1 · 10 lines · no preview (clipboard changed)' })).toBeDefined()
})

test('several tags appearing at once are not guessed from one clipboard', async ($, on) => {
  const { clock, state } = harness(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  state.clipboard = LOREM
  state.draft = '[Pasted text #1 +2 lines] [Pasted text #2 +2 lines]'
  await clock.advance(200)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button' })).toBeUndefined()
})

for (const [terminal, env, hasPicture] of [
  ['Ghostty', { TERM_PROGRAM: 'ghostty' }, true],
  ['Orca', { TERM_PROGRAM: 'Orca' }, false],
] as const) {
  test(`a pasted image in ${terminal} shows as ${hasPicture ? 'a thumbnail' : 'a line that opens it'}`, async ($, on) => {
    const { clock, state } = harness(on, env)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    state.draft = 'see [Image #1]'
    await clock.advance(200)

    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const image = await band.find({ type: 'Image' })
    const line = await band.find({ type: 'Button', key: 'image-1', text: '#1 · image 800×400 — open' })
    if (hasPicture) {
      expect(image?.props).toMatchObject({ source: { file: `${IMAGES_DIR}/1.png`, format: 'png' } })
      expect(line).toBeUndefined()
    } else {
      expect(image).toBeUndefined()
      expect(line).toBeDefined()
      // Pressing it opens the cached file in the system's viewer.
      await $.ui.press({ plugin: 'paste-view', key: 'image-1' })
      expect(state.ran).toContainEqual(['open', `${IMAGES_DIR}/1.png`])
    }
  })
}

for (const [terminal, env] of [
  ['Ghostty', { TERM_PROGRAM: 'ghostty' }],
  ['Orca', { TERM_PROGRAM: 'Orca' }],
] as const) {
  test(`a pasted JPEG in ${terminal} shows as a line that opens it`, async ($, on) => {
    const { clock, state } = harness(on, env)
    state.images = ['1.jpg', '12.png']
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    state.draft = 'see [Image #1]'
    await clock.advance(200)

    // The Image element only draws a PNG file, so no thumbnail, even where pictures show.
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Image' })).toBeUndefined()
    expect(await band.find({ type: 'Button', key: 'image-1', text: '#1 · image · jpg — open' })).toBeDefined()
    await $.ui.press({ plugin: 'paste-view', key: 'image-1' })
    expect(state.ran).toContainEqual(['open', `${IMAGES_DIR}/1.jpg`])
  })
}

test('an image whose file is still missing does not redraw the band on every poll', async ($, on) => {
  const { clock, state } = harness(on, { TERM_PROGRAM: 'ghostty' })
  state.images = []
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  state.draft = 'see [Image #1]'
  await clock.advance(200)
  const afterFirst = state.writes
  await clock.advance(200)
  await clock.advance(200)
  expect(state.writes).toBe(afterFirst)

  // Once its file lands, the next poll finds it and draws it.
  state.images = ['1.png']
  await clock.advance(200)
  expect(state.writes).toBeGreaterThan(afterFirst)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Image' }))?.props).toMatchObject({ source: { file: `${IMAGES_DIR}/1.png` } })
})
