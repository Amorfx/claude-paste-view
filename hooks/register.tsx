import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PastedImage, PastedText } from '../types'
import { charCount, draftTags, firstLine, lineBreaks, matchesTag } from './tags'
import type { TextTag } from './tags'
import { drawsImages, pngDimensions, thumbnailBoxes } from './thumbnails'
import type { Dimensions } from './thumbnails'

const PANE = 'paste-view'
// A paste raises no prompt.edit, and a collapsed text paste reaches no hook before it is
// sent: the draft is watched on a timer, and a new text tag is matched against the
// clipboard the moment it appears.
const POLL_MS = 200

const images = atom({ plugin: 'paste-view', key: 'images' } as const, [] as PastedImage[])
const texts = atom({ plugin: 'paste-view', key: 'texts' } as const, [] as PastedText[])
const viewing = atom({ plugin: 'paste-view', key: 'viewing' } as const, null as number | null)

// Tried in order on first use; the first that runs is kept.
const CLIPBOARD_COMMANDS: readonly (readonly string[])[] = [
  ['pbpaste'],
  ['wl-paste', '--no-newline'],
  ['xclip', '-selection', 'clipboard', '-o'],
]

let cwd = ''
let hasGraphics = false
let clipboardCommand: readonly string[] | null | undefined
let viewerCommand: string | undefined
let imagesDir: { session: string; path: string } | undefined
const dimensions = new Map<string, Dimensions | null>()
// Pasted texts by tag number, each read once, when its tag first shows up.
const pastes = new Map<number, string | null>()
// What the draft held at the last refresh; undefined forces the next one to redo the work.
let lastSignature: string | undefined
// What was last written to state, so a refresh that finds the same pastes doesn't redraw.
let written: string | undefined
let isRefreshing = false

async function tmpRoot($: EngineInterface): Promise<string> {
  const configured = await $.env.get('CLAUDE_CODE_TMPDIR')
  if (configured !== undefined) return configured
  const { stdout } = await $.process.run(['id', '-u'])
  return `/tmp/claude-${stdout.trim()}`
}

// Claude Code keeps a session's pasted images in <tmp>/<project>/<session>/images/<n>.<ext>,
// <project> being the working directory with every character but letters and digits
// turned into '-'. That folder is tried first; the session id alone finds it otherwise.
async function findImagesDir($: EngineInterface): Promise<string | undefined> {
  const session = await $.session.id()
  if (imagesDir?.session === session) return imagesDir.path
  const root = await tmpRoot($)
  const projects = await $.fs.list(root).catch(() => [])
  const candidates = [
    cwd.replace(/[^a-zA-Z0-9]/g, '-'),
    ...projects.filter(entry => entry.kind === 'dir').map(entry => entry.name),
  ]
  for (const project of candidates) {
    const path = `${root}/${project}/${session}/images`
    if (await $.fs.exists(path)) {
      imagesDir = { session, path }
      return path
    }
  }
  return undefined
}

// An image is cached in the format it was pasted in: <n>.png for a screenshot, but
// <n>.jpg or <n>.webp for others.
async function findImage($: EngineInterface, dir: string, n: number): Promise<string | undefined> {
  const png = `${dir}/${n}.png`
  if (await $.fs.exists(png)) return png
  const entries = await $.fs.list(dir).catch(() => [])
  const other = entries.find(entry => entry.kind === 'file' && entry.name.startsWith(`${n}.`))
  return other === undefined ? undefined : `${dir}/${other.name}`
}

const isPng = (path: string) => path.endsWith('.png')

async function describeImage($: EngineInterface, dir: string | undefined, n: number): Promise<PastedImage> {
  const path = dir === undefined ? undefined : await findImage($, dir, n)
  if (path === undefined) return { n, path: null, size: null }
  if (!isPng(path)) return { n, path, size: null }
  if (!dimensions.has(path)) {
    // A file past the read cap is still drawn, in a default shape.
    const head = await $.fs.read(path, { as: 'bytes' }).catch(() => undefined)
    dimensions.set(path, head === undefined ? null : pngDimensions(head.base64))
  }
  return { n, path, size: dimensions.get(path) ?? null }
}

async function readClipboard($: EngineInterface): Promise<string | null> {
  if (clipboardCommand === null) return null
  for (const argv of clipboardCommand === undefined ? CLIPBOARD_COMMANDS : [clipboardCommand]) {
    // pbpaste decodes by the locale, which a bare child process may lack.
    const ran = await $.process.run(argv, { env: { LANG: 'en_US.UTF-8' }, timeoutMs: 1000 }).catch(() => undefined)
    if (ran?.exitCode === 0 && !ran.isStdoutTruncated) {
      clipboardCommand = argv
      return ran.stdout
    }
  }
  clipboardCommand ??= null
  return null
}

async function capturePastes($: EngineInterface, tags: readonly TextTag[]) {
  for (const n of pastes.keys()) if (!tags.some(tag => tag.n === n)) pastes.delete(n)
  const fresh = tags.filter(tag => !pastes.has(tag.n))
  if (fresh.length === 0) return
  // One clipboard can only stand for one paste: tags arriving together (a draft brought
  // back from history) are left without a preview rather than guessed.
  const clipboard = fresh.length === 1 ? await readClipboard($) : null
  for (const tag of fresh) pastes.set(tag.n, clipboard !== null && matchesTag(clipboard, tag.lines) ? clipboard : null)
}

async function refresh($: EngineInterface, draft: string) {
  const tags = draftTags(draft)
  await capturePastes($, tags.texts)

  const signature = JSON.stringify([tags.images, tags.texts.map(tag => tag.n)])
  if (signature === lastSignature) return

  const dir = tags.images.length > 0 ? await findImagesDir($) : undefined
  const imageList = await Promise.all(tags.images.map(n => describeImage($, dir, n)))
  // An image whose file hasn't landed yet is looked for again on the next poll.
  lastSignature = imageList.some(image => image.path === null) ? undefined : signature

  const textList = tags.texts.map(tag => ({ ...tag, text: pastes.get(tag.n) ?? null }))
  // Each write redraws the band: an image still missing must not redraw it on every poll.
  const json = JSON.stringify([imageList, textList])
  if (json !== written) {
    await update($, images, () => imageList)
    await update($, texts, () => textList)
    written = json
  }

  const shown = await read($, viewing)
  if (shown !== null && !tags.texts.some(tag => tag.n === shown)) await closePane($)
}

async function poll($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    await refresh($, (await $.prompt.read()).text)
  } finally {
    isRefreshing = false
  }
}

// Without pictures in the terminal, an image opens in the system's own viewer.
async function openImage($: EngineInterface, path: string) {
  viewerCommand ??= (await $.process.run(['uname'])).stdout.trim() === 'Darwin' ? 'open' : 'xdg-open'
  const ran = await $.process.run([viewerCommand, path], { timeoutMs: 5000 }).catch(() => undefined)
  if (ran?.exitCode !== 0) $.ui.toast(`paste-view: couldn't open the image with ${viewerCommand}`)
}

async function openPane($: EngineInterface, paste: PastedText) {
  await update($, viewing, () => paste.n)
  await $.ui.open({ id: PANE, title: `Pasted text #${paste.n}`, focus: true, closeOnEscape: true })
}

async function closePane($: EngineInterface) {
  await update($, viewing, () => null)
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) await $.ui.close({ id: PANE })
}

/** Lines a paste spans on screen, a trailing newline not counted. */
const shownLines = (paste: PastedText) =>
  paste.text === null ? (paste.lines ?? 0) + 1 : lineBreaks(paste.text.trimEnd()) + 1

const imageLabel = (image: PastedImage, path: string) => {
  if (image.size !== null) return `#${image.n} · image ${image.size.width}×${image.size.height}`
  return isPng(path) ? `#${image.n} · image` : `#${image.n} · image · ${path.slice(path.lastIndexOf('.') + 1)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    hasGraphics = drawsImages({
      term: await $.env.get('TERM'),
      termProgram: await $.env.get('TERM_PROGRAM'),
      kittyWindowId: await $.env.get('KITTY_WINDOW_ID'),
      forceImages: await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
      sessionKind: await $.env.get('CLAUDE_CODE_SESSION_KIND'),
      multiplexer: (await $.env.get('TMUX')) ?? (await $.env.get('STY')),
    })
    // A reload keeps the state: the texts already read stay matched to their tags.
    for (const paste of await read($, texts)) pastes.set(paste.n, paste.text)
    $.clock.every(POLL_MS, () => poll($))
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, viewing, () => null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const imageList = await read($, images)
    const textList = await read($, texts)
    if (imageList.length === 0 && textList.length === 0) return next(e)

    const { Box, Button, Image, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    // The Image element draws a PNG file only: any other format is a line that opens it.
    const pictures = hasGraphics ? imageList.filter(image => image.path !== null && isPng(image.path)) : []
    const imageLines = imageList.filter(image => !pictures.includes(image))
    const openable = imageLines.filter(image => image.path !== null)
    // One row per line below the thumbnails, plus the hint; the thumbnails get the rest.
    const lineRows = imageLines.length + textList.length + 1
    const boxes = thumbnailBoxes(pictures.map(image => image.size), e.props.maxRows - lineRows, width)
    // Number keys run down the lines that open something, images first.
    const hotkey = (i: number) => (i >= 0 && i < 9 ? { hotkey: String(i + 1) } : {})
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {pictures.length > 0 && (
          <Box flexDirection="row" columnGap={1} alignItems="flex-end">
            {pictures.map((image, i) => (
              <Box flexDirection="column" alignItems="center">
                <Box borderStyle="round" borderDimColor>
                  <Image
                    key={`picture-${image.n}`}
                    source={{ file: image.path ?? '', format: 'png' }}
                    columns={boxes[i]?.columns ?? 4}
                    rows={boxes[i]?.rows ?? 1}
                    alt={`[Image #${image.n}]`}
                  />
                </Box>
                <Text dimColor>#{image.n}</Text>
              </Box>
            ))}
          </Box>
        )}
        {imageLines.map(image => {
          const path = image.path
          if (path === null) {
            return <Text dimColor wrap="truncate">{`#${image.n} · image · no preview`}</Text>
          }
          return (
            <Button
              key={`image-${image.n}`}
              plain
              {...hotkey(openable.indexOf(image))}
              label={`${imageLabel(image, path)} — open`}
              onPress={() => openImage($, path)}
            />
          )
        })}
        {textList.map((paste, i) => {
          const head = `#${paste.n} · ${shownLines(paste)} lines`
          if (paste.text === null) {
            return <Text dimColor wrap="truncate">{`${head} · no preview (clipboard changed)`}</Text>
          }
          const label = `${head} · ${charCount(paste.text.length)} — `
          // The hotkey prefix (`1: `) takes three cells.
          return (
            <Button
              key={`text-${paste.n}`}
              plain
              {...hotkey(openable.length + i)}
              label={`${label}${firstLine(paste.text, width - label.length - 3)}`}
              onPress={() => openPane($, paste)}
            />
          )
        })}
        {(openable.length > 0 || textList.some(paste => paste.text !== null)) && (
          <Text dimColor wrap="truncate">click a line, or ctrl+x tab then its number, to see it whole</Text>
        )}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const shown = await read($, viewing)
    const paste = (await read($, texts)).find(one => one.n === shown)
    if (paste?.text == null) return <Text dimColor>This paste is no longer in the prompt.</Text>

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">
          {`${shownLines(paste)} lines · ${charCount(paste.text.length)} · ↑↓ scroll · esc close`}
        </Text>
        <Text>{paste.text}</Text>
      </Box>
    )
  })
}
