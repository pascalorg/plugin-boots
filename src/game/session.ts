import { useScene } from '@pascal-app/core'
import { useEditor } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import type { Object3D, PerspectiveCamera } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { Hud } from './hud'
import { GameInput } from './input'
import { closeItemMenu, isItemMenuOpen } from './inventory'
import { placedItemCount } from './item-keep'
import { capturePaint } from './paint-keep'
import { captureDemolition } from './save-demolition'

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
let sessionSerial = 0

/** Monotonic per-Jump-in counter — GameRoot keys its error boundary on it so
 * a crashed session never poisons the next one. */
export const getSessionSerial = (): number => sessionSerial

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
  // The mask-0 guard: an object maskForGame already game-hid must never be
  // re-hidden via `visible = false` — three.js visibility CASCADES, so that
  // flip would cull hosted-child subtrees (nested door/window roots) that
  // the mask hide deliberately left rendering. The resurrection sweep hits
  // this path every ~0.5 s on voxelized wall meshes.
  if (!current || !object.visible || object.layers.mask === 0) return
  current.hiddenObjects.push({ object, visible: object.visible })
  object.visible = false
}

/**
 * Game-hide an object WITHOUT culling its scene-graph descendants: zero its
 * layers mask (masks don't cascade — children keep rendering) instead of
 * flipping `visible`. Restore rides the session teardown list, which also
 * survives dev-time ActiveGame remounts correctly: remount healing restores
 * only the visibility ledger, a re-voxelize re-masks idempotently (mask
 * already 0 → no duplicate record), and the one teardown entry still puts
 * the original mask back on exit.
 */
export function maskForGame(object: Object3D): void {
  if (!current || object.layers.mask === 0) return
  const mask = object.layers.mask
  object.layers.mask = 0
  current.teardown.push(() => {
    object.layers.mask = mask
  })
}

/** The hide plan for one node subtree that may NEST other live nodes'
 * registered roots (`keep`): branches free of kept roots hide wholesale
 * (`hide` → visible = false), while meshes standing on a path DOWN TO a
 * kept root can only be masked (`mask` → layers 0) so the kept subtree
 * keeps rendering. Kept roots themselves are never entered. Pure —
 * exported for unit tests. */
export function planHideKeepingRoots(
  object: Object3D,
  keep: ReadonlySet<Object3D>,
): { hide: Object3D[]; mask: Object3D[] } {
  const hide: Object3D[] = []
  const mask: Object3D[] = []
  const containsKept = (obj: Object3D): boolean => {
    for (const child of obj.children) {
      if (keep.has(child) || containsKept(child)) return true
    }
    return false
  }
  const walk = (obj: Object3D): void => {
    if (!containsKept(obj)) {
      hide.push(obj)
      return
    }
    if ((obj as { isMesh?: boolean }).isMesh) mask.push(obj)
    for (const child of obj.children) {
      if (!keep.has(child)) walk(child)
    }
  }
  walk(object)
  return { hide, mask }
}

/**
 * Hide one node's render subtree for the session while every registered
 * root in `keep` nested inside it KEEPS RENDERING — the voxelize-time twin
 * of collectWorld's hosted-child mesh fence. The host's WallRenderer mounts
 * hosted doors / windows / wall items INSIDE the wall's render mesh, so the
 * old plain `visible = false` on that mesh culled them along: invisible
 * closed doors that still blocked an apparently-open doorway (QA round-2
 * item 3). Without a keep set (hand-built test worlds) this is exactly
 * hideForGame.
 */
export function hideForGameKeepingRoots(
  object: Object3D,
  keep: ReadonlySet<Object3D> | undefined,
): void {
  if (!keep || keep.size === 0) {
    hideForGame(object)
    return
  }
  const plan = planHideKeepingRoots(object, keep)
  for (const obj of plan.hide) hideForGame(obj)
  for (const obj of plan.mask) maskForGame(obj)
}

/**
 * Whole-building presence: the game world is every storey, stacked. 'solo'
 * hides/shadow-masks other levels and 'exploded' displaces them by 5 m gaps —
 * either one would bake a partial or scattered building into the world
 * snapshot. Force 'stacked' for the session with the same record/restore
 * pattern enterGame uses for viewMode/cameraMode. 'manual' (like 'stacked')
 * keeps storeys at their true elevations, so both are left untouched.
 *
 * Deliberately NO per-level visibility ledger: the host LevelSystem re-asserts
 * visibility + layer masks from levelMode every frame, so the mode restore on
 * teardown IS the whole undo (ledgering objects a host frame-loop owns is the
 * ForeignOverlayHide mistake). Exported for unit tests.
 */
export function forceStackedLevelMode(teardown: Array<() => void>): void {
  const viewer = useViewer.getState() as unknown as {
    levelMode?: string
    setLevelMode?: (mode: string) => void
  }
  const prev = viewer.levelMode
  if (!viewer.setLevelMode || (prev !== 'solo' && prev !== 'exploded')) return
  viewer.setLevelMode('stacked')
  teardown.push(() => {
    ;(useViewer.getState() as unknown as { setLevelMode?: (m: string) => void }).setLevelMode?.(
      prev,
    )
  })
}

export function enterGame(): boolean {
  if (current || useBoots.getState().phase === 'game') return false
  if (typeof document === 'undefined') return false
  const canvas = findEditorCanvas()
  const container = canvas?.parentElement
  if (!canvas || !container) return false
  teardownList = []
  sessionSerial++

  // The game drives the 3D PERSPECTIVE camera. Jumping in from the 2D plan
  // view (orthographic camera) leaves the controller writing to a camera the
  // scene isn't rendered through — a frozen top-down frame with every input
  // swallowed (the exact prod symptom). Force both switches; restore on exit.
  const editorState = useEditor.getState() as unknown as {
    viewMode?: string
    setViewMode?: (mode: string) => void
  }
  const viewerState = useViewer.getState() as unknown as {
    cameraMode?: string
    setCameraMode?: (mode: string) => void
  }
  const prevViewMode = editorState.viewMode
  const prevCameraMode = viewerState.cameraMode
  if (editorState.setViewMode && prevViewMode && prevViewMode !== '3d') {
    editorState.setViewMode('3d')
    teardownList.push(() => {
      ;(useEditor.getState() as unknown as { setViewMode?: (m: string) => void }).setViewMode?.(
        prevViewMode,
      )
    })
  }
  if (viewerState.setCameraMode && prevCameraMode && prevCameraMode !== 'perspective') {
    viewerState.setCameraMode('perspective')
    teardownList.push(() => {
      ;(
        useViewer.getState() as unknown as { setCameraMode?: (m: string) => void }
      ).setCameraMode?.(prevCameraMode)
    })
  }
  // Whole-building presence: solo/exploded level modes would snapshot a
  // partial or displaced building — force stacked, restore on exit.
  forceStackedLevelMode(teardownList)

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
  // Sequence the lock AFTER the fullscreen transition settles: firing both
  // back-to-back makes browsers reject the lock with WrongDocumentError
  // mid-churn, leaving a fullscreen-but-unlocked session (mouse degraded —
  // the "can't place a ramp" live report). attach() below fires the first
  // attempt anyway (harmless if it loses the race); these retries land
  // once the document is stable. relock-on-click remains the backstop.
  const fullscreen: Promise<unknown> =
    container.requestFullscreen?.().catch(() => {}) ?? Promise.resolve()
  input.attach(canvas)
  void fullscreen.then(() => {
    input.requestLock()
    window.setTimeout(() => {
      if (current === session && document.pointerLockElement !== canvas) input.requestLock()
    }, 350)
  })
  input.onEscape = () => {
    // Esc with the catalog up closes the menu, not the game (this path only
    // fires with the pointer lock already released — exactly the menu case).
    if (closeItemMenu()) return
    if (current === session) exitGame()
  }
  hud.mount(container)

  // Esc unwinds pointer lock and/or fullscreen — treat either as "exit",
  // but only once it was actually engaged (both engage async after enter).
  let hadLock = false
  const onLockChange = () => {
    if (document.pointerLockElement === canvas) {
      hadLock = true
      hud.prompt(null, 'lock')
      return
    }
    // The item catalog releases the lock deliberately (mouse becomes a
    // cursor over the menu) — that release is not an exit.
    if (hadLock && current === session && !isItemMenuOpen()) exitGame()
  }
  // Never-locked sessions stay playable (input.ts flows buttons/deltas
  // regardless) but the cursor can hit the screen edge — say so instead of
  // leaving the player to wonder. Cleared the moment the lock engages.
  window.setTimeout(() => {
    if (current === session && !hadLock && document.pointerLockElement !== canvas) {
      hud.prompt('click to capture the mouse', 'lock')
    }
  }, 900)
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

  // ── Scene-write sentinel ────────────────────────────────────────────────
  // THE promise: nothing you do in the game is saved. The host autosaves its
  // draft from the live scene store, so the guarantee holds iff the store is
  // NEVER written during play (Keep runs after exit, behind its own button).
  // This sentinel watches the store for the whole session and screams if any
  // code path violates that — a canary, not a fixer.
  {
    const nodesAtEnter = useScene.getState().nodes
    const unsub = useScene.subscribe((state) => {
      if (state.nodes !== nodesAtEnter && useBoots.getState().phase === 'game') {
        console.error(
          '[boots] INVARIANT VIOLATION: the scene store changed during play — nothing in-game may write it. Investigate immediately.',
        )
      }
    })
    session.teardown.push(unsub)
  }

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

  closeItemMenu(false)
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
  // Snapshot leveled scene nodes BEFORE the game tree (and the destruction
  // state with it) unmounts — the panel offers to save the demolition too.
  const leveled = captureDemolition()
  // Same deal for paint: snapshot sprayed coats before the ledger resets.
  const painted = capturePaint()
  useBoots
    .getState()
    .setPendingDecision(placed.length > 0 || leveled > 0 || painted > 0 || placedItemCount() > 0)
}
