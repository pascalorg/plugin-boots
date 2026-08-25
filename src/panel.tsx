'use client'

import { useEditor } from '@pascal-app/editor'
import { flushSync } from 'react-dom'

/** Fixed bottom-center hint mounted straight on <body> — the sidebar (and this
 * panel with it) can unmount while first-person mode is up, so the hint can't
 * live in this React tree. Removed by the store subscription on exit. */
const HINT_ID = 'boots-esc-hint'

function mountEscHint() {
  if (document.getElementById(HINT_ID)) return
  const hint = document.createElement('div')
  hint.id = HINT_ID
  hint.textContent = 'Esc to exit'
  hint.style.cssText = [
    'position:fixed',
    'bottom:28px',
    'left:50%',
    'transform:translateX(-50%)',
    'padding:8px 16px',
    'border-radius:999px',
    'background:rgba(0,0,0,0.55)',
    'color:#fff',
    'font:600 13px/1 system-ui,sans-serif',
    'letter-spacing:0.04em',
    'z-index:2147483647',
    'pointer-events:none',
    'user-select:none',
  ].join(';')
  document.body.appendChild(hint)
}

function unmountEscHint() {
  document.getElementById(HINT_ID)?.remove()
}

type EditorFirstPerson = {
  isFirstPersonMode?: boolean
  setFirstPersonMode?: (value: boolean) => void
}

/**
 * Jump in: fullscreen + the host's first-person mode, in one click.
 *
 * Both `requestFullscreen` and the pointer lock the host's
 * FirstPersonControls requests on mount need the SAME user activation, so
 * fullscreen fires first (fire-and-forget) and the mode flips inside
 * `flushSync` — mirroring the host's own overlay button — so the controls
 * mount synchronously while the click gesture is still live.
 * `setFirstPersonMode` is duck-typed: it ships in current hosts but not in
 * the published editor types this package compiles against.
 */
function jumpIn() {
  const editor = useEditor.getState() as unknown as EditorFirstPerson
  if (!editor.setFirstPersonMode) return

  void document.documentElement.requestFullscreen?.().catch(() => {})
  flushSync(() => editor.setFirstPersonMode?.(true))
  mountEscHint()

  // Esc releases the pointer lock, which makes the host exit first-person
  // mode — follow it: drop the hint and leave fullscreen.
  const unsubscribe = (
    useEditor as unknown as {
      subscribe: (listener: (state: EditorFirstPerson) => void) => () => void
    }
  ).subscribe((state) => {
    if (state.isFirstPersonMode) return
    unsubscribe()
    unmountEscHint()
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  })
}

/** The Boots left-rail panel — one button. Put your boots on. */
export default function BootsPanel() {
  return (
    <div className="flex flex-col gap-4 p-4 text-sidebar-foreground">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-base">Boots</h2>
          <span className="rounded-full border border-sidebar-border/60 bg-sidebar-accent px-1.5 py-px font-semibold text-[9px] text-sidebar-foreground/70 uppercase tracking-widest">
            Beta
          </span>
        </div>
        <p className="text-sidebar-foreground/50 text-xs leading-relaxed">
          Walk the building you're editing, first person, full screen.
        </p>
      </header>

      <button
        className="flex w-full items-center justify-center gap-2 rounded-md bg-sidebar-accent px-3 py-2 font-semibold text-sm hover:bg-sidebar-accent/80"
        onClick={jumpIn}
        type="button"
      >
        ⏵ Jump in
      </button>
    </div>
  )
}
