'use client'

// Namespace import ON PURPOSE: the bun-test preload mocks @pascal-app/viewer
// wholesale (no resolveCdnUrl) and a named import would be a load-time
// SyntaxError there; resolveUrl below feature-detects it.
import * as viewerPkg from '@pascal-app/viewer'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  CanvasTexture,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Ray,
  SRGBColorSpace,
  Vector3,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { create } from 'zustand'
import { useBoots, type WeaponId } from '../store'
import { sfx } from './audio'
import { MOVE_ITEM_KEY } from './input'
import { EYE_HEIGHT, PLAYER_CAPSULE } from './collision'
import {
  collectWallOpenings,
  dropTarget,
  probeLandingY,
  raycastVoxelTargets,
  useDestruction,
} from './destruction'
import { groundSurfaceY } from './ground'
import {
  type CatalogEntry,
  closeItemMenu,
  ensureFullCatalog,
  isItemMenuOpen,
  isOpeningEntry,
  type MenuEntry,
  OPENING_ENTRIES,
  type OpeningEntry,
  openItemMenu,
  placeableCatalog,
} from './inventory'
import { perfEvent } from './perf-monitor'
import { playerRig } from './player'
import { getSession } from './session'
import {
  buildSyncOn,
  forgetSharedPlacements,
  isForeignPlacement,
  moveSharedAperture,
  moveSharedItem,
  publishAperture,
  publishItem,
  setBuildAppliers,
} from './shared-build'
import {
  bvhFor,
  type ColliderEntry,
  type GameWorld,
  isGlassLikeMesh,
  type WallNodeLike,
} from './world'

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
 * OPENINGS (the doors/windows tab): picking an OpeningEntry arms the
 * WALL-SNAP ghost instead — the aim ray projects onto the nearest HOST
 * wall's mid-plane (world.walls; game-built walls are v1-excluded — their
 * node ids don't exist until their own Save), slides along the wall's
 * u-axis at APERTURE_STEP, and is valid only where the aperture fits the
 * wall (end/top margins) without overlapping existing host doors/windows
 * (collectWallOpenings) or other pending apertures. Invalid = the build
 * ghost's red tint. LMB stores a PlacedAperture; the visible stand-in is a
 * GAME-SIDE jamb/header/leaf (or glass) mock sitting ON the wall — the
 * wall is never cut during play; the real hole arrives when Save creates
 * the hosted door/window node.
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
  kind: 'item'
  id: number
  /** The catalog asset payload, verbatim — Keep hands it to the host's
   * item schema untouched (item-keep.ts). */
  asset: CatalogEntry
  /** Bottom-center anchor on its supporting floor/counter/object surface. */
  position: [number, number, number]
  /** Yaw around Y, snapped to 90°. */
  yaw: number
}

/**
 * A pending door/window on a HOST wall — the openings tab's placement.
 * Wall-local like the host's hosted-child convention: `u` meters along the
 * wall's start→end axis, `v` the CENTER height above the wall base (doors:
 * height/2 — they sit on the floor; windows: sill + height/2). During play
 * this renders only the game-side framed stand-in ON the wall (the wall is
 * not cut); Save turns it into a real `door`/`window` node hosted by
 * `wallId` (item-keep.ts).
 */
export type PlacedAperture = {
  kind: 'aperture'
  id: number
  def: OpeningEntry
  wallId: string
  u: number
  v: number
  width: number
  height: number
}

/** Everything the I-catalog can leave pending for Save/Discard. */
export type Placement = PlacedItem | PlacedAperture

type ItemsState = {
  /** Placements this session (or awaiting the panel's Save/Discard). */
  items: Placement[]
  /** Menu entry riding a ghost (furniture OR opening); null = stowed. */
  armed: MenuEntry | null
  /** Placement temporarily lifted by L; omitted from items so its previous
   * collider/rectangle cannot obstruct its own constrained preview. */
  moving: Placement | null
  arm: (asset: MenuEntry) => void
  disarm: () => void
  beginMove: (id: number) => Placement | null
  cancelMove: () => void
  finishMove: (position: [number, number, number], yaw: number) => PlacedItem | null
  finishApertureMove: (wallId: string, u: number, v: number) => PlacedAperture | null
  addItem: (asset: CatalogEntry, position: [number, number, number], yaw: number) => PlacedItem
  /** `size` overrides the entry's nominal dimensions — a REMOTE aperture is
   * materialized from its record, not re-derived from the local catalog. */
  addAperture: (
    def: OpeningEntry,
    wallId: string,
    u: number,
    v: number,
    size?: { width: number; height: number },
  ) => PlacedAperture
  /** Drop one placement. Only the shared lane uses it: a placement whose
   * record was tombstoned elsewhere goes away here too. */
  removeItem: (id: number) => void
  /** Save/Discard resolution — forgets every placement. */
  resolveItems: () => void
}

let itemId = 1

export const useItems = create<ItemsState>((set, get) => ({
  items: [],
  armed: null,
  moving: null,
  arm: (armed) => set({ armed, moving: null }),
  disarm: () => set({ armed: null }),
  beginMove: (id) => {
    const moving = get().items.find((item) => item.id === id) ?? null
    if (!moving) return null
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
      armed: moving.kind === 'item' ? moving.asset : moving.def,
      moving,
    }))
    return moving
  },
  cancelMove: () => {
    const moving = get().moving
    if (!moving) {
      set({ armed: null })
      return
    }
    set((state) => ({ items: [...state.items, moving], armed: null, moving: null }))
  },
  finishMove: (position, yaw) => {
    const moving = get().moving
    if (!moving || moving.kind !== 'item') return null
    const placed: PlacedItem = { ...moving, position, yaw }
    set((state) => ({ items: [...state.items, placed], armed: null, moving: null }))
    return placed
  },
  finishApertureMove: (wallId, u, v) => {
    const moving = get().moving
    if (!moving || moving.kind !== 'aperture') return null
    const placed: PlacedAperture = { ...moving, wallId, u, v }
    set((state) => ({ items: [...state.items, placed], armed: null, moving: null }))
    return placed
  },
  addItem: (asset, position, yaw) => {
    const stored: PlacedItem = { kind: 'item', id: itemId++, asset, position, yaw }
    set((s) => ({ items: [...s.items, stored] }))
    return stored
  },
  addAperture: (def, wallId, u, v, size) => {
    const stored: PlacedAperture = {
      kind: 'aperture',
      id: itemId++,
      def,
      wallId,
      u,
      v,
      width: size?.width ?? def.width,
      height: size?.height ?? def.height,
    }
    set((s) => ({ items: [...s.items, stored] }))
    return stored
  },
  removeItem: (id) => set((s) => ({ items: s.items.filter((p) => p.id !== id) })),
  resolveItems: () => set({ items: [], moving: null }),
}))

/** True while a placed-item ghost owns the trigger (armed + menu closed) —
 * viewmodel.tsx's fire gate reads this (manager wiring). */
export function itemGhostActive(): boolean {
  return useItems.getState().armed !== null && !isItemMenuOpen()
}

/** True for the entire placement interaction, including the catalog itself.
 * The builder uses this broader gate for its wall ghost: opening I must not
 * leave a large hammer wall preview behind the catalog, and L-move keeps it
 * hidden until the placement is dropped or cancelled. */
export function itemPlacementActive(): boolean {
  const state = useItems.getState()
  return isItemMenuOpen() || state.armed !== null || state.moving !== null
}

/** Placement budget — every other lane has one (turbo clad FIFO, debris
 * caps); each placement is a full GLB clone worth of draw calls. The ghost
 * refuses ('occupied') at the cap; Save/Discard resets the count. */
export const MAX_PLACED_ITEMS = 64

/**
 * How much of the budget THIS player has spent.
 *
 * The cap is a draw-call budget on placements you are answerable for, and it
 * has to be, because with a shared world the list also holds everyone else's
 * furniture: counting the whole thing would let three other players spend
 * your allowance and leave you unable to put down a chair. Identical to
 * `items.length` when sync is off, which is the single-player path unchanged.
 */
function ownPlacementCount(items: readonly Placement[]): number {
  if (!buildSyncOn()) return items.length
  let n = 0
  for (const p of items) if (!isForeignPlacement(p.id)) n++
  return n
}

/**
 * Is this placement another player's work?
 *
 * item-keep.ts asks THIS instead of shared-build: a Save bridge may import
 * `localWork` from a shared module and nothing else, and
 * shared-invariant.test.ts enforces it. The lane owns the authorship
 * registry, so the bridge asks its own lane. Always false in single-player.
 */
export function isForeignItemPlacement(id: number): boolean {
  return isForeignPlacement(id)
}

/**
 * Save/Discard resolved the placements: unbind ours WITHOUT tombstoning them.
 * Saving turns them into real nodes on this screen; on every other screen they
 * are still the chairs and doors they always were.
 */
export function releaseSharedItemPlacements(): void {
  forgetSharedPlacements()
}

/** Max anchor distance from the player (matches the builder's edit reach). */
export const ITEM_REACH = 6
/** Level-gaze anchor: this far ahead when the aim never meets the floor. */
const LEVEL_GAZE_AHEAD = ITEM_REACH * 0.6
/** cos(pitch) below this (looking near straight up/down) = no anchor. */
const MIN_HORIZONTAL = 0.2
/** How far BELOW the player's own floor plane a probed surface may still take
 * the ghost. Sloped ground within the 6 m reach drops well under this; a
 * storey does not, so aiming into a hole in the floor you are standing on
 * still places the item at your feet instead of on the ground below. */
const ITEM_MAX_STEP_DOWN = 2.2
/** How far ABOVE the floor plane the landing probe may start. Aiming uphill,
 * the ground at the anchor is above the plane and a probe beginning under it
 * reads as "inside the ground"; starting over it fixes that, and the cap
 * keeps a room's ceiling out of the running. */
const ITEM_PROBE_MAX_RISE = 1.8

export type ItemAnchor = {
  x: number
  y: number
  z: number
  valid: boolean
  /** The aim ray met a real non-supporting surface. The live caller must not
   * fall through that wall/front face to a floor point hidden behind it. */
  blocked?: boolean
}

/**
 * Where the landing probe starts for a ghost anchored at (x, z) while the
 * player's feet are at floorY. Pure, exported for tests.
 */
export function itemProbeFromY(floorY: number, x: number, z: number): number {
  return Math.min(
    floorY + ITEM_PROBE_MAX_RISE,
    Math.max(floorY + 1, groundSurfaceY(x, z) + 0.02),
  )
}

/**
 * The ghost's height: the probed surface, unless it is more than a step below
 * the player's own floor plane (then the plane, the upper-storey guard).
 * Pure, exported for tests.
 */
export function itemDropY(anchorY: number, snapped: number): number {
  return snapped >= anchorY - ITEM_MAX_STEP_DOWN ? snapped : anchorY
}

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

/**
 * Prefer the horizontal surface the crosshair is actually pointing at. The
 * old furniture lane projected every aim all the way to the feet plane, so
 * aiming at a microwave-sized patch of countertop put the XZ anchor on the
 * floor *behind* the counter. This top-plane pass makes counters, shelves,
 * placed furniture and build voxels behave like editor surfaces; the floor
 * projection remains the fallback when the ray sees open air or terrain.
 *
 * AABB tops are deliberate here. They are the same conservative surfaces the
 * landing/collision systems use, and unlike triangle normals they keep GLB,
 * primitive and voxel-backed catalog items on one predictable snap lane.
 */
export function anchorOnSupport(
  out: ItemAnchor,
  colliders: readonly ColliderEntry[],
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  yaw: number,
  pitch: number,
  reach = ITEM_REACH,
): boolean {
  const cp = Math.cos(pitch)
  if (cp < MIN_HORIZONTAL) return false
  const dx = -Math.sin(yaw) * cp
  const dy = Math.sin(pitch)
  const dz = -Math.cos(yaw) * cp
  if (dy >= -0.02) return false
  const horizontalRate = Math.hypot(dx, dz)
  let nearest = Number.POSITIVE_INFINITY
  for (const collider of colliders) {
    if (collider.disabled || collider.walkOnly || collider.nodeType === 'site') continue
    const box = collider.worldBox
    const t = (box.max.y - eyeY) / dy
    if (t <= 0.05 || t >= nearest || t * horizontalRate > reach) continue
    const x = eyeX + dx * t
    const z = eyeZ + dz * t
    if (x < box.min.x - 0.02 || x > box.max.x + 0.02) continue
    if (z < box.min.z - 0.02 || z > box.max.z + 0.02) continue
    nearest = t
    out.x = x
    out.y = box.max.y
    out.z = z
    out.valid = true
  }
  return Number.isFinite(nearest)
}

const _supportOrigin = new Vector3()
const _supportDirection = new Vector3()
const _supportRay = new Ray()
const _supportPoint = new Vector3()
const _supportNormal = new Vector3()
const _supportNormalMatrix = new Matrix3()

/**
 * Exact crosshair support hit used by the live placement lane.
 *
 * Unlike the legacy AABB-top helper above, this ray first resolves the
 * nearest visible triangle (so a counter cannot be selected through its
 * front, a wall, or another prop). It also races the active destruction
 * grids against those triangles. That second lane is what makes a pure
 * voxel island remain a usable countertop after its host collider has been
 * disabled: the live cells, not the now-hidden source mesh, own the ray.
 */
export function anchorOnWorldSupport(
  out: ItemAnchor,
  world: GameWorld,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  yaw: number,
  pitch: number,
  reach = ITEM_REACH,
): boolean {
  out.blocked = false
  const cp = Math.cos(pitch)
  if (cp < MIN_HORIZONTAL) return false
  _supportOrigin.set(eyeX, eyeY, eyeZ)
  _supportDirection.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp)
  const maxDistance = reach / Math.max(1e-4, Math.hypot(_supportDirection.x, _supportDirection.z))

  let nearestDistance = Number.POSITIVE_INFINITY
  let supportDistance = Number.POSITIVE_INFINITY
  let supportX = 0
  let supportY = 0
  let supportZ = 0

  for (const collider of world.colliders) {
    if (collider.disabled || collider.walkOnly || collider.nodeType === 'site') continue
    _supportRay.origin.copy(_supportOrigin).applyMatrix4(collider.inverse)
    _supportRay.direction.copy(_supportDirection).transformDirection(collider.inverse)
    const hit = collider.bvh.raycastFirst(_supportRay, 2)
    if (!hit) continue
    _supportPoint.copy(hit.point).applyMatrix4(collider.mesh.matrixWorld)
    const distance = _supportPoint.distanceTo(_supportOrigin)
    if (distance <= 0.05 || distance > maxDistance || distance >= nearestDistance) continue
    nearestDistance = distance
    if (!hit.face) continue
    _supportNormalMatrix.getNormalMatrix(collider.mesh.matrixWorld)
    _supportNormal.copy(hit.face.normal).applyNormalMatrix(_supportNormalMatrix)
    // A tabletop/floor must genuinely face upward. Vertical cabinet fronts,
    // walls and undersides occlude what is behind them but are not supports.
    if (_supportNormal.y < 0.55) continue
    supportDistance = distance
    supportX = _supportPoint.x
    supportY = _supportPoint.y
    supportZ = _supportPoint.z
  }

  const voxelHit = raycastVoxelTargets(_supportOrigin, _supportDirection, maxDistance)
  if (voxelHit && voxelHit.distance < nearestDistance) {
    nearestDistance = voxelHit.distance
    const target = useDestruction.getState().targets.get(voxelHit.nodeId)
    if (target && target.kind !== 'wall' && _supportDirection.y < -0.02) {
      const cellY = target.grid.cellY
      const probeFrom = voxelHit.point.y + cellY * 1.6 + 0.03
      const top = probeLandingY(world, voxelHit.point.x, probeFrom, voxelHit.point.z)
      // A top-face hit resolves back to essentially the same height. A ray
      // entering low through a voxel's vertical side must not jump the ghost
      // onto a surface the crosshair did not actually point at.
      if (top >= voxelHit.point.y - 0.03 && top - voxelHit.point.y <= cellY * 0.7 + 0.03) {
        supportDistance = voxelHit.distance
        supportX = voxelHit.point.x
        supportY = top
        supportZ = voxelHit.point.z
      }
    }
  }

  if (!Number.isFinite(supportDistance) || supportDistance > nearestDistance + 1e-4) {
    out.blocked = Number.isFinite(nearestDistance)
    return false
  }
  out.x = supportX
  out.y = supportY
  out.z = supportZ
  out.valid = Math.hypot(supportX - eyeX, supportZ - eyeZ) <= reach
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

// --- Wall apertures (the openings tab's wall-snap lane) ----------------------

/** Ghost slide step along the wall's u-axis — 10 cm: fine enough to place
 * a door where you want it, coarse enough to feel snapped (the 3 m build
 * lattice is far too coarse for openings). */
export const APERTURE_STEP = 0.1
/** Wall left clear at each end and above the aperture (jack-stud/header
 * room — mirrors the host's own framing sensibilities). */
export const APERTURE_MARGIN = 0.05
/** Obstacle inflation between pending apertures (the OPENING_PAD value
 * destruction.ts uses for host openings — keeps clearances symmetric). */
export const APERTURE_PAD = 0.02

/**
 * A host wall's placement frame in WORLD space: origin at the wall start
 * on the wall base, unit u-axis start→end in XZ. `yaw` is the three group
 * rotation whose local +X runs along the u-axis.
 *
 * SOURCE OF TRUTH: the wall's registered root IS the wall-local frame —
 * the host positions it at the wall start, local +X toward the end, and
 * mounts hosted door/window children inside it at `position = [u, v, 0]`
 * (measured live: a door at position[0] = 0 sits exactly at the wall's
 * world start). So the frame is read off root.matrixWorld directly —
 * transforming node start/end through it would double-apply the pose.
 * node start/end contribute only the LENGTH (they are level-plan coords).
 */
export type WallFrame = {
  wallId: string
  originX: number
  originY: number
  originZ: number
  ux: number
  uz: number
  length: number
  height: number
  thickness: number
  yaw: number
}

const _wfStart = new Vector3()
const _wfEnd = new Vector3()

/** Build one wall's WallFrame (null = stub wall, the destruction.ts 0.3 m
 * degeneracy floor). Curved walls get their straight chord — the same
 * approximation the stud framing already makes. Height/thickness fall back
 * to the host defaults (2.5 / 0.15). */
export function wallPlacementFrame(wall: {
  node: WallNodeLike
  root: Object3D
}): WallFrame | null {
  const { start, end } = wall.node
  const planLength = Math.hypot(end[0] - start[0], end[1] - start[1])
  if (planLength < 0.3) return null
  // Wall-local (0,0,0) and (length,0,0) through the root — origin and far
  // end in world space (scale-safe: length re-measured after transform).
  _wfStart.set(0, 0, 0).applyMatrix4(wall.root.matrixWorld)
  _wfEnd.set(planLength, 0, 0).applyMatrix4(wall.root.matrixWorld)
  const dx = _wfEnd.x - _wfStart.x
  const dz = _wfEnd.z - _wfStart.z
  const length = Math.hypot(dx, dz)
  if (length < 0.3) return null
  const ux = dx / length
  const uz = dz / length
  return {
    wallId: wall.node.id,
    originX: _wfStart.x,
    originY: _wfStart.y,
    originZ: _wfStart.z,
    ux,
    uz,
    length,
    height: wall.node.height ?? 2.5,
    thickness: wall.node.thickness ?? 0.15,
    yaw: Math.atan2(-uz, ux),
  }
}

export type WallAim = { frame: WallFrame | null; u: number; v: number; dist: number }

/**
 * Aim ray vs the walls' mid-plane rectangles — pure, allocation-free
 * (writes `out`), exported for tests. Same eye/yaw/pitch ray as
 * anchorOnFloor; the nearest wall whose rectangle (0..length × 0..height)
 * the ray crosses within `reach` wins. Returns false when no wall is aimed
 * at (out.frame is nulled either way first).
 */
export function aimWallPoint(
  out: WallAim,
  frames: Iterable<WallFrame>,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  yaw: number,
  pitch: number,
  reach = ITEM_REACH,
): boolean {
  const cp = Math.cos(pitch)
  const dx = -Math.sin(yaw) * cp
  const dy = Math.sin(pitch)
  const dz = -Math.cos(yaw) * cp
  out.frame = null
  out.dist = reach
  for (const frame of frames) {
    // Mid-plane normal = u-axis rotated 90° in XZ.
    const nx = -frame.uz
    const nz = frame.ux
    const denom = dx * nx + dz * nz
    if (Math.abs(denom) < 1e-6) continue // parallel gaze
    const t = ((frame.originX - eyeX) * nx + (frame.originZ - eyeZ) * nz) / denom
    if (t <= 0.05 || t >= out.dist) continue
    const hx = eyeX + dx * t - frame.originX
    const hz = eyeZ + dz * t - frame.originZ
    const u = hx * frame.ux + hz * frame.uz
    if (u < 0 || u > frame.length) continue
    const v = eyeY + dy * t - frame.originY
    if (v < 0 || v > frame.height) continue
    out.frame = frame
    out.u = u
    out.v = v
    out.dist = t
  }
  return out.frame !== null
}

/** Snap the aimed u to the ghost grid, clamped so the aperture keeps its
 * end margins — null when the wall is too short for it at all. */
export function snapApertureU(
  u: number,
  width: number,
  length: number,
  step = APERTURE_STEP,
  margin = APERTURE_MARGIN,
): number | null {
  const min = margin + width / 2
  const max = length - margin - width / 2
  if (min > max) return null
  return Math.min(max, Math.max(min, Math.round(u / step) * step))
}

/** Wall-space aperture rect from a center-u / bottom-v0 pose. Structurally
 * compatible with destruction.ts's WallOpening rects. */
export type ApertureRect = { u0: number; u1: number; v0: number; v1: number }

export function apertureRect(
  u: number,
  v0: number,
  width: number,
  height: number,
): ApertureRect {
  return { u0: u - width / 2, u1: u + width / 2, v0, v1: v0 + height }
}

/** Strict 2D interval overlap — touching edges do NOT overlap. */
export function rectsOverlap(a: ApertureRect, b: ApertureRect): boolean {
  return a.u0 < b.u1 && a.u1 > b.u0 && a.v0 < b.v1 && a.v1 > b.v0
}

/**
 * Would this aperture cut cleanly? Inside the wall span (end margins),
 * under the top margin, and clear of every obstacle rect (host openings
 * arrive pre-inflated from collectWallOpenings; pending ones through
 * pendingApertureRects). Pure, exported for tests.
 */
export function apertureFits(
  rect: ApertureRect,
  wallLength: number,
  wallHeight: number,
  obstacles: readonly ApertureRect[],
  margin = APERTURE_MARGIN,
): boolean {
  const eps = 1e-6
  if (rect.u0 < margin - eps || rect.u1 > wallLength - margin + eps) return false
  if (rect.v0 < -eps || rect.v1 > wallHeight - margin + eps) return false
  for (const o of obstacles) if (rectsOverlap(rect, o)) return false
  return true
}

/** The pending apertures already on `wallId`, as obstacle rects inflated
 * by APERTURE_PAD (the same clearance host openings get). */
export function pendingApertureRects(
  items: readonly Placement[],
  wallId: string,
  pad = APERTURE_PAD,
): ApertureRect[] {
  const rects: ApertureRect[] = []
  for (const placed of items) {
    if (placed.kind !== 'aperture' || placed.wallId !== wallId) continue
    rects.push({
      u0: placed.u - placed.width / 2 - pad,
      u1: placed.u + placed.width / 2 + pad,
      v0: placed.v - placed.height / 2 - pad,
      v1: placed.v + placed.height / 2 + pad,
    })
  }
  return rects
}

// --- Model cache (one GLB template per catalog id, session-agnostic) --------

type ModelSlot =
  | { status: 'loading'; promise: Promise<Group> }
  | { status: 'ready'; template: Group }
  | { status: 'failed'; error: string }

const modelCache = new Map<string, ModelSlot>()
let loader: GLTFLoader | null = null
let ktx2Loader: KTX2Loader | null = null
const ktx2Renderers = new WeakSet<object>()

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
 * CPU/WASM — WebGPU-safe, no shaders. The API catalog also contains
 * KHR_texture_basisu models, so GameItems configures the shared loader with
 * the live renderer before a selection can start loading. */
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

/** Attach Basis/KTX2 decoding to the imperative catalog loader. */
export function configureItemModelLoader(renderer: object): boolean {
  if (ktx2Renderers.has(renderer)) return true
  try {
    if (!ktx2Loader) {
      ktx2Loader = new KTX2Loader()
      ktx2Loader.setTranscoderPath('https://cdn.jsdelivr.net/gh/pmndrs/drei-assets@master/basis/')
    }
    ktx2Loader.detectSupport(renderer as never)
    itemModelLoader().setKTX2Loader(ktx2Loader)
    ktx2Renderers.add(renderer)
    return true
  } catch (error) {
    console.warn('[boots/items] KTX2 support unavailable; textured GLBs may use a proxy', error)
    return false
  }
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
      perfEvent('item-load')
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
export function mountItemVisual(
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
const _itemRay = new Ray()
const _itemRayDirection = new Vector3()
const _itemRayHit = new Vector3()

/** Nearest solid under the crosshair, but only returns a game-placed item.
 * A wall or another prop in front wins the ray and prevents through-wall L. */
export function aimedPlacedItemId(
  colliders: readonly ColliderEntry[],
  eye: { x: number; y: number; z: number },
  yaw: number,
  pitch: number,
  reach = ITEM_REACH,
): number | null {
  const cp = Math.cos(pitch)
  _itemRay.origin.set(eye.x, eye.y, eye.z)
  _itemRayDirection.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp)
  _itemRay.direction.copy(_itemRayDirection)
  let nearest = reach
  let target: number | null = null
  for (const collider of colliders) {
    if (collider.disabled || collider.nodeType === 'site') continue
    if (_itemRay.intersectBox(collider.worldBox, _itemRayHit) === null) continue
    const distance = _itemRayHit.distanceTo(_itemRay.origin)
    if (distance >= nearest) continue
    nearest = distance
    target = collider.nodeId.startsWith(ITEM_NODE_PREFIX)
      ? Number.parseInt(collider.nodeId.slice(ITEM_NODE_PREFIX.length), 10)
      : null
  }
  return target !== null && Number.isFinite(target) ? target : null
}

const _aperturePickAim: WallAim = { frame: null, u: 0, v: 0, dist: 0 }

/** Select a Boots-placed door/window from the exact wall point under the
 * crosshair. The nearest wall plane wins first, so an opening can never be
 * grabbed through a nearer wall. */
export function aimedPlacedApertureId(
  items: readonly Placement[],
  frames: Iterable<WallFrame>,
  eye: { x: number; y: number; z: number },
  yaw: number,
  pitch: number,
  reach = ITEM_REACH,
): number | null {
  if (!aimWallPoint(_aperturePickAim, frames, eye.x, eye.y, eye.z, yaw, pitch, reach)) return null
  const frame = _aperturePickAim.frame
  if (!frame) return null
  for (let i = items.length - 1; i >= 0; i--) {
    const placed = items[i]!
    if (placed.kind !== 'aperture' || placed.wallId !== frame.wallId) continue
    const rect = apertureRect(
      placed.u,
      placed.v - placed.height / 2,
      placed.width,
      placed.height,
    )
    if (
      _aperturePickAim.u >= rect.u0 &&
      _aperturePickAim.u <= rect.u1 &&
      _aperturePickAim.v >= rect.v0 &&
      _aperturePickAim.v <= rect.v1
    ) return placed.id
  }
  return null
}

/** Candidate-volume + line-of-sight guard for both fresh placement and L.
 * The surface whose top supports the item is ignored, but walls, furniture
 * and every raised blocking surface refuse the drop. */
export function itemBlockedByWorld(
  colliders: readonly ColliderEntry[],
  x: number,
  y: number,
  z: number,
  yaw: number,
  footprint: [number, number, number],
  eye: { x: number; y: number; z: number },
): boolean {
  const swapped = Math.round(yaw / HALF_PI) & 1
  const width = swapped ? footprint[2] : footprint[0]
  const depth = swapped ? footprint[0] : footprint[2]
  const halfW = width / 2
  const halfD = depth / 2
  const top = y + footprint[1]

  for (const collider of colliders) {
    if (collider.disabled || collider.nodeType === 'site') continue
    const box = collider.worldBox
    // Contact with the supporting floor/table top is valid, as is anything
    // entirely above the item. Remaining strict overlap blocks the volume.
    if (box.max.y <= y + 0.025 || box.min.y >= top - 0.025) continue
    if (
      box.max.x > x - halfW &&
      box.min.x < x + halfW &&
      box.max.z > z - halfD &&
      box.min.z < z + halfD
    ) return true
  }

  const centerY = y + footprint[1] / 2
  _itemRay.origin.set(eye.x, eye.y, eye.z)
  _itemRayDirection.set(x - eye.x, centerY - eye.y, z - eye.z)
  const targetDistance = _itemRayDirection.length()
  if (targetDistance <= 0.05) return false
  _itemRay.direction.copy(_itemRayDirection).multiplyScalar(1 / targetDistance)
  const nearRadius = Math.max(0.05, Math.min(halfW, halfD))
  for (const collider of colliders) {
    if (collider.disabled || collider.nodeType === 'site') continue
    const box = collider.worldBox
    if (box.max.y <= y + 0.025) continue
    if (_itemRay.intersectBox(box, _itemRayHit) === null) continue
    if (_itemRayHit.distanceTo(_itemRay.origin) < targetDistance - nearRadius) return true
  }
  return false
}

// --- Aperture stand-in (jambs + header + leaf/glass primitive mock) ----------

const JAMB = 0.06
const APERTURE_FRAME_COLOR = '#7a5a3a'
const APERTURE_LEAF_COLOR = '#8a6844'
const APERTURE_GLASS_COLOR = '#9fc7d9'
/** The build ghost's invalid red (builder.tsx's ghost tint). */
const APERTURE_INVALID_COLOR = '#ff5a4d'

/** One material for the stand-in — JSX-created per mesh (R3F auto-dispose
 * owns it). `userData.baseColor` is the ghost tint's restore point. */
function StandInMaterial({ color, ghost, glass }: { color: string; ghost: boolean; glass: boolean }) {
  return (
    <meshStandardMaterial
      color={color}
      depthWrite={!ghost && !glass}
      opacity={glass ? (ghost ? 0.25 : 0.35) : ghost ? 0.55 : 1}
      roughness={glass ? 0.15 : 0.75}
      transparent={ghost || glass}
      userData={{ baseColor: color }}
    />
  )
}

/**
 * The game-side visual for a pending door/window — a framed mock the
 * guntable/weapon-models primitive idiom builds from boxes: two jambs, a
 * header, and a leaf (doors; sliding doors get a glazed leaf, doubles two
 * leaves) or a glass plate + sill (windows). Local frame: origin at the
 * aperture's bottom-center on the wall mid-plane, +X along the wall
 * u-axis, +Z across the thickness. The stand-in sits ON the wall (poking
 * `depth` through both faces) — the wall itself is only cut at Save.
 */
export function ApertureStandIn({
  def,
  depth,
  ghost = false,
}: {
  def: OpeningEntry
  depth: number
  ghost?: boolean
}) {
  const w = def.width
  const h = def.height
  const innerW = w - 2 * JAMB
  const innerH = h - JAMB
  const leaves: Array<{ x: number; w: number }> =
    def.doorType === 'double'
      ? [
          { x: -innerW / 4 - 0.004, w: innerW / 2 - 0.008 },
          { x: innerW / 4 + 0.004, w: innerW / 2 - 0.008 },
        ]
      : [{ x: 0, w: innerW }]
  const glazedLeaf = def.doorType === 'sliding'
  return (
    <group>
      {/* Jambs + header */}
      <mesh position={[-(w - JAMB) / 2, innerH / 2, 0]}>
        <boxGeometry args={[JAMB, innerH, depth]} />
        <StandInMaterial color={APERTURE_FRAME_COLOR} ghost={ghost} glass={false} />
      </mesh>
      <mesh position={[(w - JAMB) / 2, innerH / 2, 0]}>
        <boxGeometry args={[JAMB, innerH, depth]} />
        <StandInMaterial color={APERTURE_FRAME_COLOR} ghost={ghost} glass={false} />
      </mesh>
      <mesh position={[0, h - JAMB / 2, 0]}>
        <boxGeometry args={[w, JAMB, depth]} />
        <StandInMaterial color={APERTURE_FRAME_COLOR} ghost={ghost} glass={false} />
      </mesh>
      {def.node === 'door' ? (
        leaves.map((leaf) => (
          <mesh key={leaf.x} position={[leaf.x, (innerH - 0.02) / 2 + 0.005, 0]}>
            {/* Leaf pokes 1 cm proud of both wall faces (depth − 0.02 vs
             * the jambs' depth) — flush inside the wall it was invisible. */}
            <boxGeometry args={[leaf.w, innerH - 0.02, Math.max(0.04, depth - 0.02)]} />
            <StandInMaterial
              color={glazedLeaf ? APERTURE_GLASS_COLOR : APERTURE_LEAF_COLOR}
              ghost={ghost}
              glass={glazedLeaf}
            />
          </mesh>
        ))
      ) : (
        <>
          {/* Glass plate + sill; sliding sashes get a center mullion. */}
          <mesh position={[0, h / 2 - JAMB / 2, 0]}>
            <boxGeometry args={[innerW, h - 2 * JAMB, Math.max(0.02, depth - 0.03)]} />
            <StandInMaterial color={APERTURE_GLASS_COLOR} ghost={ghost} glass />
          </mesh>
          {def.windowType === 'sliding' && (
            <mesh position={[0, h / 2 - JAMB / 2, 0]}>
              <boxGeometry args={[0.03, h - 2 * JAMB, Math.max(0.035, depth - 0.01)]} />
              <StandInMaterial color={APERTURE_FRAME_COLOR} ghost={ghost} glass={false} />
            </mesh>
          )}
          <mesh position={[0, -0.015, 0]}>
            <boxGeometry args={[w + 0.08, 0.03, depth + 0.06]} />
            <StandInMaterial color={APERTURE_FRAME_COLOR} ghost={ghost} glass={false} />
          </mesh>
        </>
      )}
    </group>
  )
}

/** One pending aperture, posed on its host wall. NO colliders: the wall
 * stays solid during play (the hole only exists after Save) — the mock is
 * pure decoration. A wall missing from the snapshot renders nothing. */
function PlacedApertureMesh({ placed, world }: { placed: PlacedAperture; world: GameWorld }) {
  const frame = useMemo(() => {
    const wall = world.walls.get(placed.wallId)
    return wall ? wallPlacementFrame(wall) : null
  }, [world, placed.wallId])
  if (!frame) return null
  const bottom = placed.v - placed.height / 2
  return (
    <group
      position={[
        frame.originX + frame.ux * placed.u,
        frame.originY + bottom,
        frame.originZ + frame.uz * placed.u,
      ]}
      rotation={[0, frame.yaw, 0]}
    >
      <ApertureStandIn def={placed.def} depth={frame.thickness + 0.04} />
    </group>
  )
}

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
const _wallAim: WallAim = { frame: null, u: 0, v: 0, dist: 0 }

/**
 * The in-canvas orchestrator: ghost pose + the item lane's input, at
 * priority -1 (the Interact convention — negative keeps auto-render) so
 * its one-shot key strips land BEFORE the viewmodel drains the queue.
 * Owns per frame, zero allocations:
 *  - 'KeyI' (stripped): toggle the catalog menu;
 *  - 'KeyL' (stripped): lift/drop aimed furniture (`M` belongs to voice);
 *  - while armed: 'KeyR' (stripped) quarter-turns the ghost, RMB edge
 *    stows it, weapon switch stows it, LMB edge on a valid anchor places;
 *  - ghost follow: floor-plane anchor + probeLandingY snap (items stack
 *    onto slabs/tabletops the probe already knows about);
 *  - openings instead ride the WALL-SNAP ghost: aim ray → nearest host
 *    wall mid-plane (aimWallPoint over session-cached WallFrames), u
 *    snapped to APERTURE_STEP, validity = apertureFits against host
 *    openings + pending apertures, red tint while invalid;
 *  - HUD: ghost-status 'too far' while clamped, prompt line while armed.
 */
export function GameItems({ world }: { world: GameWorld }) {
  const renderer = useThree((state) => state.gl)
  // Configure before children render: a placement carried across re-entry
  // mounts its loader in a layout effect, before this component's effects.
  // The WeakSet makes render retries/StrictMode idempotent.
  configureItemModelLoader(renderer)
  const items = useItems((s) => s.items)
  const armed = useItems((s) => s.armed)
  const ghostRef = useRef<Group>(null)
  const ghostHolderRef = useRef<Group>(null)
  const apGhostRef = useRef<Group>(null)
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
  const probeCache = useRef({
    qx: NaN,
    qz: NaN,
    qf: NaN,
    qyaw: NaN,
    surface: false,
    colliders: -1,
    frame: -1e9,
    y: 0,
    supported: true,
  })
  /** Session-lifetime wall frames (host walls never move during play);
   * built lazily on the first aperture aim, dropped on world swap. */
  const wallFramesRef = useRef<Map<string, WallFrame> | null>(null)
  /** Aimed wall's obstacle rects (host openings + pending apertures) —
   * collectWallOpenings allocates, so re-collect only when the aimed wall
   * or the placement census changes. */
  const apObstacles = useRef<{ wallId: string | null; count: number; rects: ApertureRect[] }>({
    wallId: null,
    count: -1,
    rects: [],
  })
  /** Last aperture-ghost validity — tint traversal runs on edges only. */
  const apInvalid = useRef(false)

  useEffect(() => {
    wallFramesRef.current = null
  }, [world])

  // Begin the shared published-catalog fetch before I is opened or a peer
  // publishes a placement. The bundled list remains the instant fallback.
  useEffect(() => {
    void ensureFullCatalog()
  }, [])

  // REMOTE PLACEMENTS. The catalog lane keeps its store module-private, so it
  // hands shared-build the three functions that can reach it rather than
  // letting shared-build import this file (which would close an import cycle
  // through inventory + destruction). Installed for the session; a mounted
  // applier with no world attached is never called.
  useEffect(() => {
    setBuildAppliers({
      spawnItem: (rec) => {
        // The catalog is the same on every peer, but a row can still be
        // missing (a host that ships a different bundle). Refusing the spawn
        // leaves the record alive and untombstoned — nobody else loses the
        // chair because this client cannot draw it.
        const asset = placeableCatalog().find((entry) => entry.id === rec.catalogId)
        if (!asset) return null
        return useItems.getState().addItem(asset, [rec.x, rec.y, rec.z], rec.yaw).id
      },
      spawnAperture: (rec) => {
        const def = OPENING_ENTRIES.find((entry) => entry.id === rec.catalogId)
        if (!def) return null
        // Size comes from the RECORD, not from the local entry: the outcome
        // travelled, and a stand-in that quietly resized itself would leave
        // two players disagreeing about whether the next door fits beside it.
        // A wall this client does not have renders nothing (PlacedApertureMesh
        // returns null) while the record stays converged.
        return useItems
          .getState()
          .addAperture(def, rec.host, rec.u, rec.v, { width: rec.width, height: rec.height }).id
      },
      removePlacement: (runtimeId) => {
        useItems.getState().removeItem(runtimeId)
      },
    })
    return () => {
      setBuildAppliers({
        spawnItem: undefined,
        spawnAperture: undefined,
        removePlacement: undefined,
      })
    }
  }, [])

  // Dev/QA handle (the __boots / __bootsBuilder idiom): the catalog lane's
  // live state + an on-demand wall-aim probe — headless QA sees exactly
  // what the aperture ghost sees. Plain data, never live refs.
  useEffect(() => {
    ;(globalThis as Record<string, unknown>).__bootsItems = {
      state: () => {
        const s = useItems.getState()
        return {
          armed: s.armed ? { id: s.armed.id, opening: isOpeningEntry(s.armed) } : null,
          items: s.items.map((p) =>
            p.kind === 'aperture'
              ? {
                  kind: p.kind,
                  id: p.id,
                  def: p.def.id,
                  wallId: p.wallId,
                  u: p.u,
                  v: p.v,
                  width: p.width,
                  height: p.height,
                }
              : {
                  kind: p.kind,
                  id: p.id,
                  asset: p.asset.id,
                  position: [...p.position],
                  yaw: p.yaw,
                },
          ),
        }
      },
      pose: () => ({
        x: playerRig.position.x,
        y: playerRig.position.y,
        z: playerRig.position.z,
        yaw: playerRig.yaw,
        pitch: playerRig.pitch,
      }),
      wallFrames: () => {
        const frames = wallFramesRef.current
        return frames ? Array.from(frames.values()).map((f) => ({ ...f })) : []
      },
      aimWall: () => {
        const frames = wallFramesRef.current
        if (!frames) return { frames: 0, hit: false }
        const out: WallAim = { frame: null, u: 0, v: 0, dist: 0 }
        const hit = aimWallPoint(
          out,
          frames.values(),
          playerRig.position.x,
          playerRig.position.y,
          playerRig.position.z,
          playerRig.yaw,
          playerRig.pitch,
        )
        return {
          frames: frames.size,
          hit,
          wallId: out.frame?.wallId ?? null,
          u: out.u,
          v: out.v,
          dist: out.dist,
        }
      },
    }
    return () => {
      delete (globalThis as Record<string, unknown>).__bootsItems
    }
  }, [])

  // Ghost content tracks the armed asset (proxy first, GLB when cached).
  // Openings mount nothing here — their ghost is the declarative
  // ApertureStandIn under apGhostRef, keyed on the armed entry.
  useEffect(() => {
    apInvalid.current = false
    if (!armed || isOpeningEntry(armed)) return
    armedFootprint.current = itemFootprint(armed)
    const holder = ghostHolderRef.current
    if (!holder) return
    return mountItemVisual(holder, armed, true)
  }, [armed])

  // Session teardown: the menu (if open) dies with the game tree, the
  // ghost stows, and the model/label caches release their GPU resources —
  // placements themselves persist for the panel's decision.
  useEffect(
    () => () => {
      closeItemMenu(false)
      useItems.getState().cancelMove()
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
    let move = false
    const armedNow = state.armed !== null && !isItemMenuOpen()
    let write = 0
    for (let read = 0; read < actions.length; read++) {
      const action = actions[read]!
      if (action === 'KeyI') {
        toggleMenu = true
      } else if (action === MOVE_ITEM_KEY) {
        move = true
      } else if (action === 'KeyR' && armedNow) {
        rotate = true
      } else {
        if (write !== read) actions[write] = action
        write++
      }
    }
    actions.length = write

    if (move && !isItemMenuOpen()) {
      if (state.moving) {
        state.cancelMove()
        ghost.visible = false
        sfx.weaponSwitch()
        return
      }
      if (!state.armed) {
        const itemId = aimedPlacedItemId(
          world.colliders,
          playerRig.position,
          playerRig.yaw,
          playerRig.pitch,
        )
        let frames = wallFramesRef.current
        if (!frames) {
          frames = new Map()
          for (const [id, wall] of world.walls) {
            const wallFrame = wallPlacementFrame(wall)
            if (wallFrame) frames.set(id, wallFrame)
          }
          wallFramesRef.current = frames
        }
        const apertureId = itemId === null
          ? aimedPlacedApertureId(
              state.items,
              frames.values(),
              playerRig.position,
              playerRig.yaw,
              playerRig.pitch,
            )
          : null
        const id = itemId ?? apertureId
        const picked = id === null ? null : state.beginMove(id)
        if (picked) {
          armedWeapon.current = useBoots.getState().weapon
          yawTurns.current = 0
          sfx.weaponSwitch()
        } else {
          session.hud.prompt('Aim at placed furniture, door, or window, then press L', 'items')
        }
        return
      }
    }

    if (toggleMenu) {
      if (state.moving) state.cancelMove()
      if (!closeItemMenu()) {
        openItemMenu(session, (item) => {
          useItems.getState().arm(item)
          armedWeapon.current = useBoots.getState().weapon
          yawTurns.current = 0
        })
      }
    }

    const apGhost = apGhostRef.current

    if (isItemMenuOpen() || !state.armed) {
      ghost.visible = false
      if (apGhost) apGhost.visible = false
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
      if (state.moving) state.cancelMove()
      else state.disarm()
      ghost.visible = false
      if (apGhost) apGhost.visible = false
      return
    }

    const openingArmed = isOpeningEntry(state.armed)
    if (rotate && !openingArmed) yawTurns.current = (yawTurns.current + 1) % 4

    // RMB edge = stow.
    const alt = session.input.state.altFiring
    if (alt && !prevAlt.current) {
      prevAlt.current = alt
      if (state.moving) state.cancelMove()
      else state.disarm()
      ghost.visible = false
      if (apGhost) apGhost.visible = false
      sfx.weaponSwitch()
      return
    }
    prevAlt.current = alt

    // Prompt line (owner-keyed; re-asserted at ~2 Hz so a door prompt that
    // borrowed the line hands it back).
    if (!promptShown.current || frame.current % 30 === 0) {
      promptShown.current = true
      session.hud.prompt(
        openingArmed
          ? state.moving
            ? 'LMB drop along this wall · RMB cancel move'
            : 'LMB place on a wall · RMB stow · I catalog · L move aimed opening'
          : state.moving
            ? 'LMB drop · R rotate · RMB cancel move'
            : 'LMB place · R rotate · RMB stow · I catalog · L move aimed item',
        'items',
      )
    }

    // --- Openings: the wall-snap ghost lane -------------------------------
    if (openingArmed) {
      ghost.visible = false
      const def = state.armed as OpeningEntry
      let frames = wallFramesRef.current
      if (!frames) {
        frames = new Map()
        for (const [id, wall] of world.walls) {
          const wallFrame = wallPlacementFrame(wall)
          if (wallFrame) frames.set(id, wallFrame)
        }
        wallFramesRef.current = frames
      }
      const movingAperture = state.moving?.kind === 'aperture' ? state.moving : null
      const eligibleFrames = movingAperture
        ? (() => {
            const original = frames.get(movingAperture.wallId)
            return original ? [original] : []
          })()
        : frames.values()
      const aimed = aimWallPoint(
        _wallAim,
        eligibleFrames,
        playerRig.position.x,
        playerRig.position.y,
        playerRig.position.z,
        playerRig.yaw,
        playerRig.pitch,
      )
      if (!aimed || !_wallAim.frame) {
        if (apGhost) apGhost.visible = false
        session.hud.ghostStatus?.(null, 'items')
        prevFire.current = session.input.state.firing
        return
      }
      const wall = _wallAim.frame
      const width = movingAperture?.width ?? def.width
      const height = movingAperture?.height ?? def.height
      const sill = movingAperture ? movingAperture.v - movingAperture.height / 2 : def.sill
      // Snap along the u-axis; a wall too short for the aperture still
      // shows the ghost (clamped to its center) — just blocked.
      const snappedU = snapApertureU(_wallAim.u, width, wall.length)
      const u = snappedU ?? wall.length / 2
      const rect = apertureRect(u, sill, width, height)
      const obstacles = apObstacles.current
      if (obstacles.wallId !== wall.wallId || obstacles.count !== state.items.length) {
        obstacles.wallId = wall.wallId
        obstacles.count = state.items.length
        obstacles.rects = [
          ...collectWallOpenings(world, wall.wallId),
          ...pendingApertureRects(state.items, wall.wallId),
        ]
      }
      const blocked =
        ownPlacementCount(state.items) >= MAX_PLACED_ITEMS ||
        snappedU === null ||
        !apertureFits(rect, wall.length, wall.height, obstacles.rects)
      if (apGhost) {
        apGhost.visible = true
        apGhost.position.set(
          wall.originX + wall.ux * u,
          wall.originY + sill,
          wall.originZ + wall.uz * u,
        )
        apGhost.rotation.set(0, wall.yaw, 0)
        // Red tint on validity EDGES only (per-frame traversal is waste).
        if (apInvalid.current !== blocked) {
          apInvalid.current = blocked
          apGhost.traverse((object) => {
            const mesh = object as Mesh
            if (!mesh.isMesh) return
            const material = mesh.material as MeshStandardMaterial
            material.color.set(
              blocked
                ? APERTURE_INVALID_COLOR
                : ((material.userData.baseColor as string) ?? APERTURE_FRAME_COLOR),
            )
          })
        }
      }
      session.hud.ghostStatus?.(blocked ? 'occupied' : null, 'items')
      const apFiring = session.input.state.firing
      if (apFiring && !prevFire.current && !blocked && !useBoots.getState().staggered) {
        const stored = movingAperture
          ? useItems.getState().finishApertureMove(wall.wallId, u, sill + height / 2)
          : useItems.getState().addAperture(def, wall.wallId, u, sill + height / 2)
        // Wall-RELATIVE on the wire (host id + u,v + size), so it lands on the
        // same wall for a peer whose build grid is a different frame entirely
        // — an opening belongs to its wall, not to the lot.
        if (stored) {
          if (movingAperture) {
            moveSharedAperture(
              stored.id,
              def.id,
              wall.wallId,
              stored.u,
              stored.v,
              stored.width,
              stored.height,
            )
          } else {
            publishAperture(
              stored.id,
              def.id,
              wall.wallId,
              stored.u,
              stored.v,
              stored.width,
              stored.height,
            )
          }
        }
        sfx.place()
      }
      prevFire.current = apFiring
      return
    }
    if (apGhost) apGhost.visible = false

    // Prefer the horizontal surface under the crosshair (countertops,
    // shelves, placed furniture and build voxels), then fall back to the
    // player's floor plane when the aim sees open air or terrain.
    const floorY = playerRig.position.y - EYE_HEIGHT
    const supportAimed = anchorOnWorldSupport(
      _anchor,
      world,
      playerRig.position.x,
      playerRig.position.y,
      playerRig.position.z,
      playerRig.yaw,
      playerRig.pitch,
    )
    const found =
      supportAimed ||
      (!_anchor.blocked && anchorOnFloor(
        _anchor,
        playerRig.position.x,
        playerRig.position.y,
        playerRig.position.z,
        playerRig.yaw,
        playerRig.pitch,
        floorY,
      ))
    if (!found) {
      ghost.visible = false
      session.hud.ghostStatus?.(null, 'items')
      prevFire.current = session.input.state.firing
      return
    }
    const probe = probeCache.current
    // Probe origin: over the player's feet, and over the ground at the anchor
    // when the aim points uphill (see ITEM_PROBE_MAX_RISE).
    const probeFrom = supportAimed
      ? Math.max(itemProbeFromY(floorY, _anchor.x, _anchor.z), _anchor.y + 0.08)
      : itemProbeFromY(floorY, _anchor.x, _anchor.z)
    const qx = Math.round(_anchor.x * 100)
    const qz = Math.round(_anchor.z * 100)
    const qf = Math.round(probeFrom * 100)
    // A moved item keeps its old orientation until R is pressed. New catalog
    // items continue to face the player on first appearance.
    const movingItem = state.moving?.kind === 'item' ? state.moving : null
    const yaw = movingItem
      ? ghostYaw(movingItem.yaw - Math.PI, yawTurns.current)
      : ghostYaw(playerRig.yaw, yawTurns.current)
    const qyaw = Math.round(yaw / HALF_PI)
    if (
      probe.qx !== qx ||
      probe.qz !== qz ||
      probe.qf !== qf ||
      probe.qyaw !== qyaw ||
      probe.surface !== supportAimed ||
      probe.colliders !== world.colliders.length ||
      frame.current - probe.frame >= 10
    ) {
      probe.qx = qx
      probe.qz = qz
      probe.qf = qf
      probe.qyaw = qyaw
      probe.surface = supportAimed
      probe.colliders = world.colliders.length
      probe.frame = frame.current
      probe.y = probeLandingY(world, _anchor.x, probeFrom, _anchor.z)
      probe.supported = true
      // Elevated placements need a real patch of support, not one lucky
      // center pixel. Probe just inside the rotated footprint's four corners;
      // every corner must meet the same top within 6 cm. Ground placement
      // keeps its slope-friendly center probe unchanged.
      if (supportAimed && probe.y > floorY + 0.06) {
        const fp = armedFootprint.current
        const swapped = Math.round(yaw / HALF_PI) & 1
        const halfW = (swapped ? fp[2] : fp[0]) / 2
        const halfD = (swapped ? fp[0] : fp[2]) / 2
        const sx = Math.max(0, halfW - Math.min(0.05, halfW * 0.2))
        const sz = Math.max(0, halfD - Math.min(0.05, halfD * 0.2))
        for (const ox of [-sx, sx]) {
          for (const oz of [-sz, sz]) {
            const corner = probeLandingY(world, _anchor.x + ox, probeFrom, _anchor.z + oz)
            if (Math.abs(corner - probe.y) > 0.06) probe.supported = false
          }
        }
      }
    }
    const snapped = probe.y
    // Downhill, the probed surface is BELOW the player's own floor plane —
    // and that is exactly where the item belongs. The old max() pinned it to
    // the plane, so anything dropped on a slope hung in the air. The plane
    // still wins past ITEM_MAX_STEP_DOWN, which is the upper-storey guard:
    // aiming into a hole in the floor you stand on must not place the item on
    // the ground a storey below.
    const y = itemDropY(_anchor.y, snapped)
    ghost.visible = true
    ghost.position.set(_anchor.x, y, _anchor.z)
    ghost.rotation.set(0, yaw, 0)
    // The anchor reaches ~0.32 m from the player axis — a placement whose
    // box would swallow the capsule is refused (the solid item colliders
    // would wedge the player inside, with no in-game item undo to escape).
    // The session budget refuses the same way once the cap is hit.
    const blocked =
      ownPlacementCount(state.items) >= MAX_PLACED_ITEMS ||
      !probe.supported ||
      itemOverlapsPlayer(
        _anchor.x,
        y,
        _anchor.z,
        yaw,
        armedFootprint.current,
        playerRig.position.x,
        floorY,
        playerRig.position.z,
      ) ||
      itemBlockedByWorld(
        world.colliders,
        _anchor.x,
        y,
        _anchor.z,
        yaw,
        armedFootprint.current,
        playerRig.position,
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
      const asset = state.armed as CatalogEntry
      // Capture the rendered preview itself. This is deliberately not a
      // second ghostYaw calculation: the placed mesh, shared record and Save
      // bridge all inherit the exact orientation the player clicked.
      const previewYaw = ghost.rotation.y
      const destination: [number, number, number] = [_anchor.x, y, _anchor.z]
      const stored = movingItem
        ? useItems.getState().finishMove(destination, previewYaw)
        : useItems.getState().addItem(asset, destination, previewYaw)
      if (stored) {
        // The wire carries the catalog id, not the asset: every peer runs the
        // same published API catalog, and a row is ~1 KB against 5 numbers.
        if (movingItem) moveSharedItem(stored.id, asset.id, stored.position, stored.yaw)
        else publishItem(stored.id, asset.id, stored.position, stored.yaw)
      }
      sfx.place()
    }
    prevFire.current = firing
  }, -1)

  return (
    <group userData={{ __boots: true }}>
      <group ref={ghostRef} visible={false}>
        <group ref={ghostHolderRef} />
      </group>
      <group ref={apGhostRef} visible={false}>
        {armed && isOpeningEntry(armed) && (
          <ApertureStandIn def={armed} depth={0.2} ghost key={armed.id} />
        )}
      </group>
      {items.map((item) =>
        item.kind === 'aperture' ? (
          <PlacedApertureMesh key={item.id} placed={item} world={world} />
        ) : (
          <PlacedItemMesh item={item} key={item.id} world={world} />
        ),
      )}
    </group>
  )
}
