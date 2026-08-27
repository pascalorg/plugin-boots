'use client'

// Namespace import ON PURPOSE: the bun-test preload mocks @pascal-app/viewer
// wholesale (no resolveCdnUrl) and a named import would be a load-time
// SyntaxError there; resolveUrl below feature-detects it.
import * as viewerPkg from '@pascal-app/viewer'
import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  BoxGeometry,
  CanvasTexture,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SRGBColorSpace,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { create } from 'zustand'
import { useBoots, type WeaponId } from '../store'
import { sfx } from './audio'
import { EYE_HEIGHT } from './collision'
import { probeLandingY } from './destruction'
import { type CatalogEntry, closeItemMenu, isItemMenuOpen, openItemMenu } from './inventory'
import { playerRig } from './player'
import { getSession } from './session'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Item placement — the ghost-and-drop half of the creative catalog
 * (inventory.tsx is the menu, item-keep.ts the save bridge). Picking a
 * catalog item ARMS it: a half-transparent ghost of its GLB rides the aim
 * point on the player's floor plane, R turns it 90°, LMB drops a GAME-ONLY
 * copy (userData.__boots — world collection and the hiders skip it), RMB
 * stows the ghost, I reopens the catalog. Placements live in `useItems`
 * until the sidebar Save converts them into real `item` nodes (or Discard
 * drops them) — the scene store is NEVER written from here.
 *
 * MODELS: plain GLTFLoader on the catalog's public GLB URL, one template
 * per catalog id for the whole session (module cache) — ghost and every
 * placement clone it. Host GLB materials are standard three materials
 * (WebGPU-safe, no shaders, no lights added). A failed load (CORS, 404,
 * unsupported compression — the host's retrying loader isn't exported to
 * plugins) degrades to a labeled proxy box sized from the catalog
 * dimensions; placement and Keep still work.
 *
 * COLLIDERS: each placement registers ONE Box3-shaped collider (BoxGeometry
 * sized from catalog dimensions × scale — 12 triangles, never a BVH over
 * an arbitrary GLB) with nodeType 'fixture': not in shooting.ts's
 * DESTRUCTIBLE set nor the grenade fallback set, so bullets spark and stop
 * (no voxelization of an invisible box) while the player, bots, debris and
 * the landing probe treat furniture as solid.
 *
 * FIRE OWNERSHIP: while a ghost is armed the CLICK belongs to placement —
 * viewmodel.tsx's trigger block must skip weapon fire when
 * `itemGhostActive()` (manager wiring; until it lands a click both places
 * and fires the held gun). Arming records the held weapon; switching
 * weapons auto-stows the ghost, so the block never outlives intent.
 */

export type PlacedItem = {
  id: number
  /** The catalog asset payload, verbatim — Keep hands it to the host's
   * item schema untouched (item-keep.ts). */
  asset: CatalogEntry
  /** Bottom-center anchor on the floor (world == level coords). */
  position: [number, number, number]
  /** Yaw around Y, snapped to 90°. */
  yaw: number
}

type ItemsState = {
  /** Placements this session (or awaiting the panel's Save/Discard). */
  items: PlacedItem[]
  /** Catalog item riding the ghost; null = stowed. */
  armed: CatalogEntry | null
  arm: (asset: CatalogEntry) => void
  disarm: () => void
  addItem: (asset: CatalogEntry, position: [number, number, number], yaw: number) => PlacedItem
  /** Save/Discard resolution — forgets every placement. */
  resolveItems: () => void
}

let itemId = 1

export const useItems = create<ItemsState>((set, get) => ({
  items: [],
  armed: null,
  arm: (armed) => set({ armed }),
  disarm: () => set({ armed: null }),
  addItem: (asset, position, yaw) => {
    const stored: PlacedItem = { id: itemId++, asset, position, yaw }
    set((s) => ({ items: [...s.items, stored] }))
    return stored
  },
  resolveItems: () => set({ items: [] }),
}))

/** True while a placed-item ghost owns the trigger (armed + menu closed) —
 * viewmodel.tsx's fire gate reads this (manager wiring). */
export function itemGhostActive(): boolean {
  return useItems.getState().armed !== null && !isItemMenuOpen()
}

/** Max anchor distance from the player (matches the builder's edit reach). */
export const ITEM_REACH = 6
/** Level-gaze anchor: this far ahead when the aim never meets the floor. */
const LEVEL_GAZE_AHEAD = ITEM_REACH * 0.6
/** cos(pitch) below this (looking near straight up/down) = no anchor. */
const MIN_HORIZONTAL = 0.2

export type ItemAnchor = { x: number; y: number; z: number; valid: boolean }

/**
 * Aim-anchored floor point — pure, allocation-free (writes `out`), exported
 * for tests. The aim ray (eye origin, yaw/pitch forward — the shooting.ts
 * convention) intersects the player's floor plane y = floorY:
 *  - downward gaze, hit within reach → anchor there, valid;
 *  - downward gaze beyond reach → clamped to reach along the ray's ground
 *    track, INVALID ('too far' on the HUD ghost-status line);
 *  - level/upward gaze → a fixed LEVEL_GAZE_AHEAD anchor straight ahead,
 *    valid (drop-it-in-front-of-me, the creative-catalog feel).
 * Returns false (no anchor at all) only when the gaze is near-vertical.
 */
export function anchorOnFloor(
  out: ItemAnchor,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  yaw: number,
  pitch: number,
  floorY: number,
  reach = ITEM_REACH,
): boolean {
  const cp = Math.cos(pitch)
  if (cp < MIN_HORIZONTAL) return false
  const dx = -Math.sin(yaw) * cp
  const dy = Math.sin(pitch)
  const dz = -Math.cos(yaw) * cp
  out.y = floorY
  if (dy < -0.02) {
    const t = (floorY - eyeY) / dy
    const hx = dx * t
    const hz = dz * t
    const horizontal = Math.hypot(hx, hz)
    if (horizontal <= reach) {
      out.x = eyeX + hx
      out.z = eyeZ + hz
      out.valid = true
    } else {
      const clamp = reach / horizontal
      out.x = eyeX + hx * clamp
      out.z = eyeZ + hz * clamp
      out.valid = false
    }
    return true
  }
  const inv = LEVEL_GAZE_AHEAD / Math.hypot(dx, dz)
  out.x = eyeX + dx * inv
  out.z = eyeZ + dz * inv
  out.valid = true
  return true
}

const HALF_PI = Math.PI / 2
const TWO_PI = Math.PI * 2

/**
 * Ghost yaw — pure, exported for tests: the item's front faces the player
 * (player yaw + π, snapped to the nearest quarter) plus R quarter-turns,
 * wrapped to [−π, π) so repeated turning stays well-conditioned (the
 * builder's rotatedYaw convention).
 */
export function ghostYaw(playerYaw: number, quarterTurns: number): number {
  const snapped = Math.round((playerYaw + Math.PI) / HALF_PI) * HALF_PI
  const yaw = snapped + (((quarterTurns % 4) + 4) % 4) * HALF_PI
  return ((((yaw + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI
}

/** Catalog footprint [w, h, d] = dimensions × scale (schema defaults when
 * absent) — pure, exported for tests. Sizes the collider box AND the
 * fallback proxy, so both stay honest to the host's own metadata. */
export function itemFootprint(asset: CatalogEntry): [number, number, number] {
  const dims = asset.dimensions ?? [1, 1, 1]
  const scale = asset.scale ?? [1, 1, 1]
  return [
    Math.max(0.05, dims[0] * scale[0]),
    Math.max(0.05, dims[1] * scale[1]),
    Math.max(0.05, dims[2] * scale[2]),
  ]
}

// --- Model cache (one GLB template per catalog id, session-agnostic) --------

type ModelSlot =
  | { status: 'loading'; promise: Promise<Group> }
  | { status: 'ready'; template: Group }
  | { status: 'failed'; error: string }

const modelCache = new Map<string, ModelSlot>()
let loader: GLTFLoader | null = null

/** viewer's resolveCdnUrl is stubbed away under bun test — pass-through.
 * (It also types nullable in/out; catalog src is always an https string.) */
const resolveUrl = (src: string): string => {
  const resolve = (viewerPkg as { resolveCdnUrl?: (url: string) => string | null }).resolveCdnUrl
  return (typeof resolve === 'function' ? resolve(src) : null) ?? src
}

/** Load (or reuse) the item's GLB scene template. Rejections are recorded
 * per catalog id with their failure class — `itemLoadFailures()` reports
 * them and every consumer falls back to the labeled proxy box. */
function loadModel(asset: CatalogEntry): Promise<Group> {
  const cached = modelCache.get(asset.id)
  if (cached?.status === 'ready') return Promise.resolve(cached.template)
  if (cached?.status === 'loading') return cached.promise
  if (cached?.status === 'failed') return Promise.reject(new Error(cached.error))
  loader ??= new GLTFLoader()
  const promise = loader
    .loadAsync(resolveUrl(asset.src))
    .then((gltf) => {
      const template = gltf.scene as unknown as Group
      modelCache.set(asset.id, { status: 'ready', template })
      return template
    })
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause.message : String(cause)
      modelCache.set(asset.id, { status: 'failed', error })
      throw cause instanceof Error ? cause : new Error(error)
    })
  modelCache.set(asset.id, { status: 'loading', promise })
  return promise
}

/** QA/debug: which catalog ids fell back to proxies, and why. */
export function itemLoadFailures(): Array<{ id: string; error: string }> {
  const failures: Array<{ id: string; error: string }> = []
  for (const [id, slot] of modelCache) {
    if (slot.status === 'failed') failures.push({ id, error: slot.error })
  }
  return failures
}

/** Corrective nesting (the host item renderer's frame): the OUTER group
 * carries the node pose (bottom-center on the floor + yaw); this INNER
 * group applies the asset's own offset/rotation/scale to the clone. */
function withCorrective(asset: CatalogEntry, child: Object3D): Group {
  const inner = new Group()
  const offset = asset.offset ?? [0, 0, 0]
  const rotation = asset.rotation ?? [0, 0, 0]
  const scale = asset.scale ?? [1, 1, 1]
  inner.position.set(offset[0], offset[1], offset[2])
  inner.rotation.set(rotation[0], rotation[1], rotation[2])
  inner.scale.set(scale[0], scale[1], scale[2])
  inner.add(child)
  return inner
}

/** Name-label CanvasTexture for proxy boxes, cached per catalog id. */
const labelCache = new Map<string, CanvasTexture>()

function labelTexture(name: string): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const cached = labelCache.get(name)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const g = canvas.getContext('2d')!
  g.fillStyle = '#78808f'
  g.fillRect(0, 0, 256, 128)
  g.strokeStyle = 'rgba(255,255,255,0.35)'
  g.strokeRect(4, 4, 248, 120)
  g.fillStyle = '#fff'
  g.font = '600 22px system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(name.slice(0, 18), 128, 64)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  labelCache.set(name, texture)
  return texture
}

/** Fallback proxy: a catalog-dimensioned box wearing the item's name —
 * placement (and Keep, which only needs the asset payload) still work. */
function buildProxy(asset: CatalogEntry): Group {
  const [w, h, d] = itemFootprint(asset)
  const group = new Group()
  const material = new MeshStandardMaterial({ color: '#9aa2b0', roughness: 0.8 })
  const map = labelTexture(asset.name)
  if (map) material.map = map
  const mesh = new Mesh(new BoxGeometry(w, h, d), material)
  mesh.position.y = h / 2
  group.add(mesh)
  return group
}

/** Ghost styling: clone every mesh's material at half opacity so the
 * template (shared with real placements) stays untouched. */
function makeGhostly(root: Object3D): void {
  root.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    const clone = (material: { clone: () => unknown }) => {
      const m = material.clone() as MeshStandardMaterial
      m.transparent = true
      m.opacity = 0.5
      m.depthWrite = false
      return m
    }
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(clone)
      : clone(mesh.material)
  })
}

/**
 * Build the visual for one asset into `holder` (ghost or placement):
 * proxy immediately, swapped for the GLB clone when the cached load lands.
 * Returns a cancel fn — a disposed holder never receives a late swap.
 */
function mountItemVisual(holder: Group, asset: CatalogEntry, ghost: boolean): () => void {
  let dead = false
  const show = (content: Object3D) => {
    if (ghost) makeGhostly(content)
    holder.clear()
    holder.add(content)
  }
  const cached = modelCache.get(asset.id)
  if (cached?.status === 'ready') {
    show(withCorrective(asset, cached.template.clone(true)))
  } else {
    show(buildProxy(asset))
    loadModel(asset)
      .then((template) => {
        if (dead) return
        show(withCorrective(asset, template.clone(true)))
      })
      .catch(() => {
        // Failure class recorded in the cache; the proxy stays.
      })
  }
  return () => {
    dead = true
  }
}

// --- Components --------------------------------------------------------------

/** Collider nodeId prefix for placed items ('__boots' family: the keep /
 * demolition / paint capture paths all skip it). */
const ITEM_NODE_PREFIX = '__boots-item-'

/** One placed item: the GLB clone (or proxy) plus its invisible Box3
 * collider. The collider mesh never renders, so its world matrix is
 * computed once here — items don't move. Entries are appended after the
 * world's build-time colliders and spliced by identity on unmount, the
 * PlacedPieceMesh convention. */
function PlacedItemMesh({ item, world }: { item: PlacedItem; world: GameWorld }) {
  const holderRef = useRef<Group>(null)
  const colliderRef = useRef<Mesh>(null)
  const [w, h, d] = itemFootprint(item.asset)

  useEffect(() => {
    const holder = holderRef.current
    if (!holder) return
    const cancel = mountItemVisual(holder, item.asset, false)
    return () => {
      cancel()
      holder.clear()
    }
  }, [item])

  useLayoutEffect(() => {
    const mesh = colliderRef.current
    if (!mesh) return
    mesh.updateWorldMatrix(true, false)
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const entry: ColliderEntry = {
      mesh,
      bvh: bvhFor(mesh),
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      root: mesh,
      nodeId: `${ITEM_NODE_PREFIX}${item.id}`,
      nodeType: 'fixture',
    }
    world.colliders.push(entry)
    return () => {
      const index = world.colliders.indexOf(entry)
      if (index !== -1) world.colliders.splice(index, 1)
    }
  }, [world, item])

  return (
    <group position={item.position} rotation={[0, item.yaw, 0]}>
      <group ref={holderRef} />
      <mesh position={[0, h / 2, 0]} ref={colliderRef} visible={false}>
        <boxGeometry args={[w, h, d]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  )
}

const _anchor: ItemAnchor = { x: 0, y: 0, z: 0, valid: false }

/**
 * The in-canvas orchestrator: ghost pose + the item lane's input, at
 * priority -1 (the Interact convention — negative keeps auto-render) so
 * its one-shot key strips land BEFORE the viewmodel drains the queue.
 * Owns per frame, zero allocations:
 *  - 'KeyI' (stripped): toggle the catalog menu;
 *  - while armed: 'KeyR' (stripped) quarter-turns the ghost, RMB edge
 *    stows it, weapon switch stows it, LMB edge on a valid anchor places;
 *  - ghost follow: floor-plane anchor + probeLandingY snap (items stack
 *    onto slabs/tabletops the probe already knows about);
 *  - HUD: ghost-status 'too far' while clamped, prompt line while armed.
 */
export function GameItems({ world }: { world: GameWorld }) {
  const items = useItems((s) => s.items)
  const armed = useItems((s) => s.armed)
  const ghostRef = useRef<Group>(null)
  const ghostHolderRef = useRef<Group>(null)
  const prevFire = useRef(false)
  const prevAlt = useRef(false)
  const yawTurns = useRef(0)
  const armedWeapon = useRef<WeaponId | null>(null)
  const promptShown = useRef(false)
  const frame = useRef(0)

  // Ghost content tracks the armed asset (proxy first, GLB when cached).
  useEffect(() => {
    const holder = ghostHolderRef.current
    if (!holder || !armed) return
    const cancel = mountItemVisual(holder, armed, true)
    return () => {
      cancel()
      holder.clear()
    }
  }, [armed])

  // Session teardown: the menu (if open) dies with the game tree, and the
  // ghost stows — placements themselves persist for the panel's decision.
  useEffect(
    () => () => {
      closeItemMenu(false)
      useItems.getState().disarm()
    },
    [],
  )

  useFrame(() => {
    const session = getSession()
    const ghost = ghostRef.current
    if (!session || !ghost) return
    frame.current++
    const state = useItems.getState()

    // One-shot strips: 'KeyI' always ours; 'KeyR' ours while armed (the
    // builder reads R from the held-keys set, so stripping the queue only
    // silences the paint tool's color cycle — while a ghost is up, R turns
    // furniture). In-place compaction, the Interact idiom.
    const actions = session.input.state.actions
    let toggleMenu = false
    let rotate = false
    const armedNow = state.armed !== null && !isItemMenuOpen()
    let write = 0
    for (let read = 0; read < actions.length; read++) {
      const action = actions[read]!
      if (action === 'KeyI') {
        toggleMenu = true
      } else if (action === 'KeyR' && armedNow) {
        rotate = true
      } else {
        if (write !== read) actions[write] = action
        write++
      }
    }
    actions.length = write

    if (toggleMenu) {
      if (!closeItemMenu()) {
        openItemMenu(session, (item) => {
          useItems.getState().arm(item)
          armedWeapon.current = useBoots.getState().weapon
          yawTurns.current = 0
        })
      }
    }

    if (isItemMenuOpen() || !state.armed) {
      ghost.visible = false
      prevFire.current = session.input.state.firing
      prevAlt.current = session.input.state.altFiring
      if (promptShown.current) {
        promptShown.current = false
        session.hud.prompt(null, 'items')
        session.hud.ghostStatus?.(null, 'items')
      }
      return
    }

    // Weapon switch stows the ghost — the fire gate must never outlive the
    // tool the player armed it with.
    const weapon = useBoots.getState().weapon
    if (armedWeapon.current !== null && weapon !== armedWeapon.current) {
      state.disarm()
      ghost.visible = false
      return
    }

    if (rotate) yawTurns.current = (yawTurns.current + 1) % 4

    // RMB edge = stow.
    const alt = session.input.state.altFiring
    if (alt && !prevAlt.current) {
      prevAlt.current = alt
      state.disarm()
      ghost.visible = false
      sfx.weaponSwitch()
      return
    }
    prevAlt.current = alt

    // Prompt line (owner-keyed; re-asserted at ~2 Hz so a door prompt that
    // borrowed the line hands it back).
    if (!promptShown.current || frame.current % 30 === 0) {
      promptShown.current = true
      session.hud.prompt('LMB place · R rotate · RMB stow · I catalog', 'items')
    }

    // Anchor on the player's floor plane, then snap onto whatever the
    // landing probe finds under the aim point (slabs, placed floors…).
    const floorY = playerRig.position.y - EYE_HEIGHT
    const found = anchorOnFloor(
      _anchor,
      playerRig.position.x,
      playerRig.position.y,
      playerRig.position.z,
      playerRig.yaw,
      playerRig.pitch,
      floorY,
    )
    if (!found) {
      ghost.visible = false
      session.hud.ghostStatus?.(null, 'items')
      prevFire.current = session.input.state.firing
      return
    }
    const snapped = probeLandingY(world, _anchor.x, floorY + 1, _anchor.z)
    const y = snapped > _anchor.y ? snapped : _anchor.y
    const yaw = ghostYaw(playerRig.yaw, yawTurns.current)
    ghost.visible = true
    ghost.position.set(_anchor.x, y, _anchor.z)
    ghost.rotation.set(0, yaw, 0)
    session.hud.ghostStatus?.(_anchor.valid ? null : 'out-of-reach', 'items')

    // LMB edge on a valid anchor = drop a copy (viewmodel's fire gate keeps
    // the held gun quiet while itemGhostActive()).
    const firing = session.input.state.firing
    if (firing && !prevFire.current && _anchor.valid) {
      useItems.getState().addItem(state.armed, [_anchor.x, y, _anchor.z], yaw)
      sfx.place()
    }
    prevFire.current = firing
  }, -1)

  return (
    <group userData={{ __boots: true }}>
      <group ref={ghostRef} visible={false}>
        <group ref={ghostHolderRef} />
      </group>
      {items.map((item) => (
        <PlacedItemMesh item={item} key={item.id} world={world} />
      ))}
    </group>
  )
}
