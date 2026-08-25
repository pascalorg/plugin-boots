import type { Object3D, PerspectiveCamera } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { Hud } from './hud'
import { GameInput } from './input'

/**
 * The out-of-React session singleton: DOM concerns (canvas, fullscreen,
 * pointer-lock/fullscreen exit watching), input, HUD, and the restore
 * ledger. The in-canvas GameRoot reads it to wire the 3D side.
 *
 * Invariant: entering and leaving MUST round-trip the editor untouched —
 * every visibility flip and camera pose is recorded here and restored in
 * `exitGame`, and the game never writes the scene store.
 */
export type GameSession = {
  input: GameInput
  hud: Hud
  canvas: HTMLCanvasElement
  container: HTMLElement
  /** Set by GameRoot on mount; used to restore the editor camera. */
  camera: PerspectiveCamera | null
  savedCamera: {
    position: [number, number, number]
    quaternion: [number, number, number, number]
    fov: number
  } | null
  /** Host objects the game hid (damaged walls, shattered panes). */
  hiddenObjects: Array<{ object: Object3D; visible: boolean }>
  teardown: Array<() => void>
}

let current: GameSession | null = null

export const getSession = (): GameSession | null => current

function findEditorCanvas(): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null
  let bestArea = 0
  for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
    const area = canvas.clientWidth * canvas.clientHeight
    if (area > bestArea) {
      bestArea = area
      best = canvas
    }
  }
  return best
}

export function hideForGame(object: Object3D): void {
  if (!current || !object.visible) return
  current.hiddenObjects.push({ object, visible: object.visible })
  object.visible = false
}

export function enterGame(): boolean {
  if (current || useBoots.getState().phase === 'game') return false
  if (typeof document === 'undefined') return false
  const canvas = findEditorCanvas()
  const container = canvas?.parentElement
  if (!canvas || !container) return false
  teardownList = []

  // Position context for the HUD overlay.
  if (getComputedStyle(container).position === 'static') {
    const prev = container.style.position
    container.style.position = 'relative'
    teardownList.push(() => {
      container.style.position = prev
    })
  }

  const input = new GameInput()
  const hud = new Hud()
  const session: GameSession = {
    input,
    hud,
    canvas,
    container,
    camera: null,
    savedCamera: null,
    hiddenObjects: [],
    teardown: teardownList,
  }
  current = session

  sfx.resume()
  void container.requestFullscreen?.().catch(() => {})
  input.attach(canvas)
  hud.mount(container)

  // Esc unwinds pointer lock and/or fullscreen — treat either as "exit",
  // but only once it was actually engaged (both engage async after enter).
  let hadLock = false
  const onLockChange = () => {
    if (document.pointerLockElement === canvas) {
      hadLock = true
      return
    }
    if (hadLock && current === session) exitGame()
  }
  let hadFullscreen = false
  const onFullscreenChange = () => {
    if (document.fullscreenElement) {
      hadFullscreen = true
      return
    }
    if (hadFullscreen && current === session) exitGame()
  }
  document.addEventListener('pointerlockchange', onLockChange)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  session.teardown.push(() => {
    document.removeEventListener('pointerlockchange', onLockChange)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
  })

  useBoots.getState().resetSession()
  useBoots.getState().setPhase('game')
  return true
}

let teardownList: Array<() => void> = []

export function exitGame(): void {
  const session = current
  if (!session) return
  current = null

  useBoots.getState().setPhase('editor')

  session.input.detach()
  session.hud.unmount()
  for (const { object, visible } of session.hiddenObjects) object.visible = visible
  session.hiddenObjects = []
  for (const fn of session.teardown.splice(0)) fn()
  teardownList = []

  const camera = session.camera
  const saved = session.savedCamera
  if (camera && saved) {
    camera.position.set(...saved.position)
    camera.quaternion.set(...saved.quaternion)
    camera.fov = saved.fov
    camera.updateProjectionMatrix()
  }

  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  if (document.pointerLockElement) document.exitPointerLock()

  const placed = useBoots.getState().placed
  useBoots.getState().setPendingDecision(placed.length > 0)
}
