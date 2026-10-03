export type PastedImage = {
  n: number
  /** Where Claude Code cached the image; null until its file is found. */
  path: string | null
  /** Its size in pixels, from the PNG header; null when that couldn't be read. */
  size: { width: number; height: number } | null
}

export type PastedText = {
  n: number
  /** The line count the tag announces (`+9 lines`); null when the tag gives none. */
  lines: number | null
  /** The pasted text, read from the clipboard; null when it couldn't be confirmed. */
  text: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'paste-view': {
      images: PastedImage[]
      texts: PastedText[]
      /** The pasted text shown in the pane, by tag number; null while it is closed. */
      viewing: number | null
    }
  }
}
