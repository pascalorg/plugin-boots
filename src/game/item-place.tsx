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
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { create } from 'zustand'
import { useBoots, type WeaponId } from '../store'
import { sfx } from './audio'
import { EYE_HEIGHT, PLAYER_CAPSULE } from './collision'
import { dropTarget, probeLandingY } from './destruction'
import { type CatalogEntry, closeItemMenu, isItemMenuOpen, openItemMenu } from './inventory'
import { playerRig } from './player'
import { getSession } from './session'
import { bvhFor, type ColliderEntry, type GameWorld, isGlassLikeMesh } from './world'

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
 * MODELS: GLTFLoader (with the host's Draco + meshopt decoder wiring — the
 * system catalog GLBs are Draco-compressed) on the catalog's public GLB
 * URL, one template per catalog id for the whole session (module cache) —
 * ghost and every placement clone it. Host GLB materials are standard
 * three materials (WebGPU-safe, no shaders, no lights added). A failed
 * load (CORS, 404, KTX2-textured — see loadModel) degrades to a labeled
 * proxy box sized from the catalog dimensions; placement and Keep still
 * work.
 *
 * COLLIDERS: each placement registers its REAL sub-meshes (GLB clone, or
 * the proxy box while the load is pending/failed) with nodeType 'item' —
 * the collectWorld convention for saved item nodes, minus the glass-like
 * sub-meshes (never colliders there either; the in-game glass lane is the
 * phase-6 open item). BVHs are LAZY (bvhFor getter), so a placement never
 * builds trees synchronously. 'item' is in shooting.ts's DESTRUCTIBLE set
 * and the grenade fallback set, so a shot placement voxelizes through the
 * SAME silhouette + per-cell-palette lane as a saved item node
 * (QA P6R1 fix 1: 'fixture' box colliders only sparked — and voxelizing
 * the invisible box would have worn no real colors anyway). Entries swap
 * when the GLB lands (proxy target dropped with them); player, bots,
 * debris and the landing probe treat furniture as solid either way.
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

/** Placement budget — every other lane has one (turbo clad FIFO, debris
 * caps); each placement is a full GLB clone worth of draw calls. The ghost
 * refuses ('occupied') at the cap; Save/Discard resets the count. */
export const MAX_PLACED_ITEMS = 64

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

/**
 * Would this placement wedge the player inside the item? The item's world
 * AABB (footprint at the anchor; yaw is snapped to 90°, so odd quarter
 * turns swap w/d) expanded by the capsule radius must not contain the
 * player's capsule axis — the item colliders are solid, collision.ts
 * pushes an EMBEDDED capsule toward the box center, and there is no
 * in-game item undo. Pure, exported for tests.
 */
export function itemOverlapsPlayer(
  x: number,
  y: number,
  z: number,
  yaw: number,
  footprint: [number, number, number],
  playerX: number,
  playerFootY: number,
  playerZ: number,
  capsule = PLAYER_CAPSULE,
): boolean {
  const swapped = Math.round(yaw / HALF_PI) & 1
  const halfW = (swapped ? footprint[2] : footprint[0]) / 2 + capsule.radius
  const halfD = (swapped ? footprint[0] : footprint[2]) / 2 + capsule.radius
  if (Math.abs(playerX - x) >= halfW || Math.abs(playerZ - z) >= halfD) return false
  return playerFootY < y + footprint[1] && playerFootY + capsule.height > y
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

/** Lazy session GLTFLoader — exported for tests. Decoder wiring mirrors
 * the host's item renderer (nodes/src/item/renderer.tsx
 * configureItemModelLoader): nearly every system-catalog GLB is
 * Draco-compressed (extensionsRequired KHR_draco_mesh_compression), so a
 * bare GLTFLoader threw "No DRACOLoader instance provided" and EVERY
 * placement degraded to the labeled proxy box. Draco/meshopt decode is
 * CPU/WASM — WebGPU-safe, no shaders. The gstatic decoder path is the one
 * the host already ships to prod. KTX2 (basisu textures) is deliberately
 * NOT wired: no catalog GLB uses it today and it would need renderer
 * access — such items keep the proxy. */
export function itemModelLoader(): GLTFLoader {
  if (!loader) {
    loader = new GLTFLoader()
    const draco = new DRACOLoader(loader.manager)
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.5/')
    loader.setDRACOLoader(draco)
    loader.setMeshoptDecoder(MeshoptDecoder)
  }
  return loader
}

/** Load (or reuse) the item's GLB scene template. Rejections are recorded
 * per catalog id with their failure class — `itemLoadFailures()` reports
 * them and every consumer falls back to the labeled proxy box. */
function loadModel(asset: CatalogEntry): Promise<Group> {
  const cached = modelCache.get(asset.id)
  if (cached?.status === 'ready') return Promise.resolve(cached.template)
  if (cached?.status === 'loading') return cached.promise
  if (cached?.status === 'failed') return Promise.reject(new Error(cached.error))
  const promise = itemModelLoader()
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

/**
 * Session teardown: release every cached template's GPU resources —
 * geometries, materials and their texture maps — plus the proxy label
 * textures, then forget both caches. Without this the module caches are
 * page-lifetime (a catalog browsing spree pins tens of MB of GLB data
 * across Esc). Unmount ordering is safe: holders being torn down in the
 * same commit never render again, and their own cleanups dispose nothing
 * template-owned (disposeItemContent). Re-entry refetches on demand.
 */
export function disposeItemModels(): void {
  for (const slot of modelCache.values()) {
    if (slot.status !== 'ready') continue
    slot.template.traverse((object) => {
      const mesh = object as Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          const texture = value as { isTexture?: boolean; dispose?: () => void }
          if (texture?.isTexture) texture.dispose?.()
        }
        ;(material as MeshStandardMaterial).dispose()
      }
    })
  }
  modelCache.clear()
  for (const texture of labelCache.values()) texture.dispose()
  labelCache.clear()
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
 * template (shared with real placements) stays untouched. `disposeSource`
 * is the proxy path — its pre-clone materials are mount-owned, and the
 * clone orphans them right here. */
function makeGhostly(root: Object3D, disposeSource = false): void {
  root.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    const clone = (material: { clone: () => unknown }) => {
      const m = material.clone() as MeshStandardMaterial
      if (disposeSource) (material as MeshStandardMaterial).dispose()
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
 * Dispose the three resources one holder content OWNS before it drops
 * (exported for tests): a proxy's geometry + materials are built per
 * mount, ghost materials are per-arm clones (makeGhostly). GLB clones
 * share the template's geometry/materials and the proxy label is a cached
 * CanvasTexture — neither is ever disposed here.
 */
export function disposeItemContent(content: Object3D, proxy: boolean, ghost: boolean): void {
  if (!proxy && !ghost) return
  content.traverse((object) => {
    const mesh = object as Mesh
    if (!mesh.isMesh) return
    if (proxy) mesh.geometry.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) (material as MeshStandardMaterial).dispose()
  })
}

/**
 * Build the visual for one asset into `holder` (ghost or placement):
 * proxy immediately, swapped for the GLB clone when the cached load lands.
 * Returns a cleanup fn — a torn-down holder never receives a late swap,
 * and every mount-owned resource is disposed (here AND on each swap;
 * imperative children never reach R3F's auto-dispose). `onContent` fires
 * after every show (proxy AND the GLB swap) — PlacedItemMesh hangs its
 * collider (re)registration off it; the ghost passes nothing.
 */
function mountItemVisual(
  holder: Group,
  asset: CatalogEntry,
  ghost: boolean,
  onContent?: (content: Object3D) => void,
): () => void {
  let dead = false
  let disposeCurrent: (() => void) | null = null
  const show = (content: Object3D, proxy: boolean) => {
    if (ghost) makeGhostly(content, proxy)
    disposeCurrent?.()
    holder.clear()
    holder.add(content)
    disposeCurrent = () => disposeItemContent(content, proxy, ghost)
    onContent?.(content)
  }
  const cached = modelCache.get(asset.id)
  if (cached?.status === 'ready') {
    show(withCorrective(asset, cached.template.clone(true)), false)
  } else {
    show(buildProxy(asset), true)
    loadModel(asset)
      .then((template) => {
        if (dead) return
        show(withCorrective(asset, template.clone(true)), false)
      })
      .catch(() => {
        // Failure class recorded in the cache; the proxy stays.
      })
  }
  return () => {
    dead = true
    disposeCurrent?.()
    disposeCurrent = null
    holder.clear()
  }
}

// --- Components --------------------------------------------------------------

/** Collider nodeId prefix for placed items ('__boots' family: the keep /
 * demolition / paint capture paths all skip it). */
const ITEM_NODE_PREFIX = '__boots-item-'

/** One placed item: the GLB clone (or proxy) whose own solid sub-meshes
 * ARE the colliders (nodeType 'item' — the collectWorld convention, so
 * shooting/grenades voxelize the placement through the same
 * silhouette + material-palette lane as a saved item node; glass-like
 * sub-meshes are skipped exactly like collectWorld skips them). World
 * matrices are computed once per show — items don't move. Entries are
 * appended after the world's build-time colliders, spliced by identity
 * and their voxel target dropped on every swap/unmount, the
 * PlacedPieceMesh convention (ensureVoxelTarget disables the entries
 * itself when a shot voxelizes the item). */
function PlacedItemMesh({ item, world }: { item: PlacedItem; world: GameWorld }) {
  const holderRef = useRef<Group>(null)

  useLayoutEffect(() => {
    const holder = holderRef.current
    if (!holder) return
    const nodeId = `${ITEM_NODE_PREFIX}${item.id}`
    const entries: ColliderEntry[] = []
    const release = () => {
      for (const entry of entries) {
        entry.disabled = true
        const index = world.colliders.indexOf(entry)
        if (index !== -1) world.colliders.splice(index, 1)
      }
      entries.length = 0
      // Drop the voxel replica too (a GLB landing over a shot proxy — or
      // Save/Discard — must not leave carved voxels of the old shape).
      dropTarget(nodeId)
    }
    const cleanupVisual = mountItemVisual(holder, item.asset, false, (content) => {
      release()
      content.updateWorldMatrix(true, true)
      content.traverse((object) => {
        const mesh = object as Mesh
        if (!mesh.isMesh || isGlassLikeMesh(mesh)) return
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
        const entry: ColliderEntry = {
          mesh,
          // LAZY, the collectWorld idiom — never build GLB trees at
          // placement time; bvhFor caches per geometry.
          get bvh() {
            return bvhFor(this.mesh)
          },
          inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
          worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
          root: mesh,
          nodeId,
          nodeType: 'item',
        }
        entries.push(entry)
        world.colliders.push(entry)
      })
    })
    return () => {
      cleanupVisual()
      release()
    }
  }, [world, item])

  return (
    <group position={item.position} rotation={[0, item.yaw, 0]}>
      <group ref={holderRef} />
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
  /** Armed item's footprint, refreshed per arm — the frame loop's player-
   * overlap check stays allocation-free. */
  const armedFootprint = useRef<[number, number, number]>([1, 1, 1])
  /** probeLandingY memo — the probe walks every collider plus every live
   * grid and is documented "never per frame"; re-probe only when the
   * quantized (1 cm) anchor, floor plane or collider census moves, with a
   * 10-frame fallback so destruction under a frozen aim still settles. */
  const probeCache = useRef({ qx: NaN, qz: NaN, qf: NaN, colliders: -1, frame: -1e9, y: 0 })

  // Ghost content tracks the armed asset (proxy first, GLB when cached).
  useEffect(() => {
    if (armed) armedFootprint.current = itemFootprint(armed)
    const holder = ghostHolderRef.current
    if (!holder || !armed) return
    return mountItemVisual(holder, armed, true)
  }, [armed])

  // Session teardown: the menu (if open) dies with the game tree, the
  // ghost stows, and the model/label caches release their GPU resources —
  // placements themselves persist for the panel's decision.
  useEffect(
    () => () => {
      closeItemMenu(false)
      useItems.getState().disarm()
      disposeItemModels()
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
    const probe = probeCache.current
    const qx = Math.round(_anchor.x * 100)
    const qz = Math.round(_anchor.z * 100)
    const qf = Math.round(floorY * 100)
    if (
      probe.qx !== qx ||
      probe.qz !== qz ||
      probe.qf !== qf ||
      probe.colliders !== world.colliders.length ||
      frame.current - probe.frame >= 10
    ) {
      probe.qx = qx
      probe.qz = qz
      probe.qf = qf
      probe.colliders = world.colliders.length
      probe.frame = frame.current
      probe.y = probeLandingY(world, _anchor.x, floorY + 1, _anchor.z)
    }
    const snapped = probe.y
    const y = snapped > _anchor.y ? snapped : _anchor.y
    const yaw = ghostYaw(playerRig.yaw, yawTurns.current)
    ghost.visible = true
    ghost.position.set(_anchor.x, y, _anchor.z)
    ghost.rotation.set(0, yaw, 0)
    // The anchor reaches ~0.32 m from the player axis — a placement whose
    // box would swallow the capsule is refused (the solid item colliders
    // would wedge the player inside, with no in-game item undo to escape).
    // The session budget refuses the same way once the cap is hit.
    const blocked =
      state.items.length >= MAX_PLACED_ITEMS ||
      itemOverlapsPlayer(
        _anchor.x,
        y,
        _anchor.z,
        yaw,
        armedFootprint.current,
        playerRig.position.x,
        floorY,
        playerRig.position.z,
      )
    session.hud.ghostStatus?.(
      _anchor.valid ? (blocked ? 'occupied' : null) : 'out-of-reach',
      'items',
    )

    // LMB edge on a valid, unblocked anchor = drop a copy (viewmodel's fire
    // gate keeps the held gun quiet while itemGhostActive()). Staggered
    // hands can't place — the same gate every other trigger lane has.
    const firing = session.input.state.firing
    if (
      firing &&
      !prevFire.current &&
      _anchor.valid &&
      !blocked &&
      !useBoots.getState().staggered
    ) {
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
