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
import { stopPresence } from './presence'
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
  /** True while the entry loading veil is up — the input gate below
   * suppresses look/fire until hud's onReveal drops it. */
  loading: boolean
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

/**
 * NO SELECTION DURING A SESSION. The host's manipulation gizmos — the
 * purple move/resize arrow rig (editor NodeArrowHandles), the dashed group
 * selection box, and the selection outline pass — are React components
 * mounted INSIDE the same R3F canvas the game renders through, driven
 * entirely by the viewer store's `selection` (they carry no scene-graph
 * names or registry kinds, so no hide-sweep predicate can catch them; the
 * store is their only switch). A selection alive during play therefore
 * puts uninteractable purple arrows and corner grips in first person (owner
 * screenshot, 2026-08-28) — and worse, a live sole selection ARMS host
 * manipulation paths our capture-phase input interception cannot block,
 * because they were registered on window CAPTURE before our attach and
 * same-phase listeners run in registration order (the editor
 * selection-manager's Cmd+right-drag direct-rotate writes the SCENE store
 * on release). R3F hover raycasts also flow all session: they ride
 * `pointermove`, which input.ts swallows separately.
 *
 * So: record the pre-session selection, clear it, and keep it clear for
 * the whole session with a store subscription (the ForeignOverlayHide
 * philosophy — the host re-asserts, we re-clear; event-driven, no polling).
 * Teardown unsubscribes and restores the EXACT pre-session selection —
 * exitGame runs teardown before the Keep panel appears, so the post-exit
 * Keep flows (keep.ts / item-keep.ts read selection.levelId) see the
 * restored value. collectWorld's mid-game selection.levelId read is
 * telemetry-only (documented there), so the cleared value is fine.
 *
 * The viewer selection is UI state — a zustand store separate from the
 * useScene document, with no temporal/undo middleware and `selection`
 * excluded from its persist partialize — so clearing it writes nothing
 * undoable and never trips the scene-write sentinel below.
 * Exported for unit tests.
 */
export function guardSelectionForGame(teardown: Array<() => void>): void {
  type SelectionPath = {
    buildingId?: string | null
    levelId?: string | null
    zoneId?: string | null
    selectedIds?: readonly string[]
  }
  type SelectionState = {
    selection?: SelectionPath
    hoveredId?: unknown
    setSelection?: (updates: SelectionPath) => void
  }
  const viewer = useViewer as unknown as {
    getState: () => SelectionState
    setState: (partial: Record<string, unknown>) => void
    subscribe: (listener: (state: SelectionState) => void) => () => void
  }
  const state = viewer.getState()
  // Older hosts without the selection API: nothing mounts gizmos, no-op.
  if (!state.setSelection || !state.selection) return
  const prev: SelectionPath = {
    buildingId: state.selection.buildingId ?? null,
    levelId: state.selection.levelId ?? null,
    zoneId: state.selection.zoneId ?? null,
    selectedIds: [...(state.selection.selectedIds ?? [])],
  }
  const hasSelection = (selection?: SelectionPath): boolean =>
    selection != null &&
    (selection.buildingId != null ||
      selection.levelId != null ||
      selection.zoneId != null ||
      (selection.selectedIds?.length ?? 0) > 0)
  // Re-entrancy latch: zustand notifies subscribers SYNCHRONOUSLY, so the
  // guard listener below runs inside clear()'s own setSelection — at which
  // point hoveredId is still set and an unlatched listener would call
  // clear() again, forever (stack overflow, caught by the unit tests).
  let clearing = false
  const clear = () => {
    if (clearing) return
    clearing = true
    try {
      // All four fields explicit — setSelection's hierarchy guard then
      // merges exactly this, no cascade surprises. Also drop any hover
      // ghost: the hover outline is the same in-canvas selection chrome.
      viewer
        .getState()
        .setSelection?.({ buildingId: null, levelId: null, zoneId: null, selectedIds: [] })
      if (viewer.getState().hoveredId != null) viewer.setState({ hoveredId: null })
    } finally {
      clearing = false
    }
  }
  clear()
  const unsub = viewer.subscribe((s) => {
    if (useBoots.getState().phase !== 'game') return
    if (hasSelection(s.selection) || s.hoveredId != null) clear()
  })
  teardown.push(() => {
    unsub()
    viewer.getState().setSelection?.(prev)
  })
}

/**
 * ── Scene-write sentinel ────────────────────────────────────────────────────
 * THE promise: nothing you do in the game is saved. The host autosaves its
 * draft from the live scene store, so the guarantee holds iff the store is
 * NEVER written during play (Keep runs after exit, behind its own button).
 * This sentinel watches the store for the whole session and screams if any
 * code path violates that — a canary, not a fixer.
 *
 * CO-PRESENCE DISCRIMINATOR: with collaboration live, a PEER's edit can
 * land in our scene store mid-session — the host applies remote ops under
 * its remote-op lease, during which `useScene.getState().readOnly === true`.
 * That write is NOT ours and NOT a violation: our game code still never
 * wrote the store, and the session's world snapshot (collectWorld ran at
 * entry) stays frozen — the peer's change appears after Esc, exactly like
 * every host-side restore. Those writes log a calm console.info instead of
 * the INVARIANT VIOLATION scream, so QA keeps a clean signal: any ERROR
 * from this sentinel is still, always, a local bug. Exported for tests.
 */
export function armSceneWriteSentinel(teardown: Array<() => void>): void {
  const nodesAtEnter = useScene.getState().nodes
  const unsub = useScene.subscribe((state) => {
    if (state.nodes !== nodesAtEnter && useBoots.getState().phase === 'game') {
      if ((state as { readOnly?: boolean }).readOnly === true) {
        console.info(
          '[boots] remote collaboration op during play (world snapshot stays frozen)',
        )
      } else {
        console.error(
          '[boots] INVARIANT VIOLATION: the scene store changed during play — nothing in-game may write it. Investigate immediately.',
        )
      }
    }
  })
  teardown.push(unsub)
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
  // No selection during a session: gizmos can't appear in first person.
  // Must run BEFORE setPhase('game') mounts GameRoot, so the pre-session
  // gizmo rig is unmounted before collectWorld snapshots the scene.
  guardSelectionForGame(teardownList)

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
    loading: true,
  }
  current = session

  // ── Entry loading gate (look/fire only) ────────────────────────────────
  // While the veil is up (session.loading), suppress firing and look
  // WITHOUT touching input.ts or player.tsx: every consumer reads
  // `input.state.firing/altFiring` per frame (viewmodel, builder, paint,
  // item-place) and look flows through `input.consumeLook()` (player.tsx
  // only), so wrapping both HERE — where the input is constructed — gates
  // all of them at once. The state proxy answers `false` for the two fire
  // bits while loading and forwards everything else (handlers keep writing
  // the real state through it); consumeLook drains-and-discards deltas so
  // pre-reveal mouse flailing never snaps the camera at reveal. WASD is
  // deliberately NOT gated (harmless under an opaque veil) and the
  // pointer-lock request keeps its original timing: deferring it to the
  // reveal would fire it outside the click's transient activation and
  // browsers would reject it (the exact WrongDocumentError class of bug
  // the fullscreen sequencing above already fights) — the veil hides the
  // early lock anyway. hud.onReveal (below) drops the gate exactly when
  // the veil fades; an Esc mid-load never fires it, and the discarded
  // session's gate dies with the session.
  const realInputState = input.state
  input.state = new Proxy(realInputState, {
    get(target, prop, receiver) {
      if (session.loading && (prop === 'firing' || prop === 'altFiring')) return false
      return Reflect.get(target, prop, receiver)
    },
  })
  const rawConsumeLook = input.consumeLook.bind(input)
  input.consumeLook = () => {
    const look = rawConsumeLook()
    return session.loading ? { dx: 0, dy: 0 } : look
  }
  hud.onReveal = () => {
    if (current === session) session.loading = false
  }

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

  // Scene-write sentinel — see armSceneWriteSentinel below.
  armSceneWriteSentinel(session.teardown)

  useBoots.getState().resetSession()
  useBoots.getState().setPhase('game')
  return true
}

let teardownList: Array<() => void> = []

export function exitGame(): void {
  const session = current
  if (!session) return
  current = null

  // Co-presence goodbye FIRST — one final explicit ph:'editor' frame so
  // peers despawn our avatar instantly, then the adapter tears down. Runs
  // before the session teardown/restore below (feature-detected inside:
  // without a collab bus this is a no-op).
  stopPresence()

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
