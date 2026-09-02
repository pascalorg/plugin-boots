'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  CanvasTexture,
  type Group,
  Matrix4,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  PlaneGeometry,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import { useBoots } from '../store'
import { EYE_HEIGHT } from './collision'
import { DEPOT_NODE_ID, DEPOT_NODE_TYPE, depotWorldYaw, worldToDepotLocal } from './guntable'
import { aimMirrorCamera, flipPaneUv, MirrorCamera, type MirrorPane, paneInView } from './mirror-view'
import { MOVE } from './movement'
import { playerRig } from './player'
import {
  advanceGait,
  articulate,
  type AvatarArticulation,
  AvatarRig,
  createArticulation,
  createRigRefs,
  localPaletteIndex,
  subscribeLocalPalette,
} from './remote-players'
import { VIEWMODEL_NAME } from './viewmodel'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * THE DEPOT MIRROR — a real one.
 *
 * Owner ask (2026-08-31): "maybe somewhere in the depot with the guns you can
 * have a mirror so people check themselves". The first cut was a glazed
 * cabinet with a 0.62-scale dummy inside and compressed parallax; the owner
 * rejected it and chose this instead (2026-09-01): a full-size local Pascaline
 * the main camera never sees, and the depot rendered from a mirrored camera
 * into a render target mapped on the glass — a genuine planar reflection at
 * 1:1, you, the room, the gun rack behind you, costing one small extra pass
 * only while someone is in front of it.
 *
 * So there is no scale factor, no plinth, no box and no clamp anywhere in this
 * file. A flat full-length mirror hangs flush on the back wall past the rack,
 * and what it shows is the scene, from the reflected eye, clipped at the glass.
 * The optics live in mirror-view.ts (pure, tested — the camera, the off-axis
 * frustum, the UV flip); this file is the wiring:
 *
 * YOU, AT 1:1. A first-person game never renders the local player, so the
 * reflection needs a body to reflect: <AvatarRig/> — the exact body every peer
 * gets, posed by the same advanceGait/articulate rules, wearing the tint the
 * roster deal reserved for our own id, holding what the store says is in our
 * hands — planted at our REAL eye position (feet = eye − EYE_HEIGHT, the way
 * remote-players plants a peer from the wire), at our real yaw, in the depot's
 * frame. It is `visible = false` at every instant except inside the pass, so
 * the main camera (which sits inside its head) never sees it, nothing raycasts
 * it (identifyAim's would-render filter drops invisible surfaces), and no layer
 * bookkeeping is needed.
 *
 * THE PASS runs in this component's frame callback, which is priority 0 and
 * subscribed after Player's and Viewmodel's (GunTable mounts after them in
 * ActiveGame), so it sees this frame's camera and runs before R3F's main render.
 * Show the rig, hide the pane (or it samples its own last frame) and the
 * first-person viewmodel (or a giant gun hangs across the reflection from inside
 * the virtual camera), render the scene through the MirrorCamera into the
 * target, restore everything. The main render then draws the pane with that
 * texture as a plain `map` — no shader of ours anywhere, so it is the same on
 * WebGPU and on the WebGL fallback the QA harness forces. The texture holds
 * linear light (renderers tone-map only the output target), and the pane's
 * material is tone-mapped like everything else on screen, so the reflection
 * matches the room rather than blowing out.
 *
 * GATED. Nobody within MIRROR_RANGE in front of the glass, or the pane not on
 * screen (paneInView): no pass, no cost, and the pane wears a dull steel-grey
 * glass so a stale frozen "you" never hangs in it from across the lot.
 *
 * ARMORED like the rest of the depot: the pane registers as a '__boots-depot' /
 * 'fixture' collider, so bullets spark on the glass and grenades wash over it;
 * the wall behind it does the blocking. Named 'boots-mirror-pane' for QA, which
 * reads its real matrixWorld out of world.colliders instead of re-deriving the
 * depot's placement.
 */

// ── Placement, depot-local (pure, tested) ────────────────────────────────────
// The depot's frame: +x toward the breaker end wall, +z out the opening, y up
// from the ground the container is seated on. Deck plate top y = 0.12; back
// wall inner face z = −1.15; end walls x = ±2.9; the gun rack's rails span
// x ∈ [−1.65, 1.65] — so the one clear panel of back wall is at x ≈ −2.3.

/** Pane centre, depot-local x. */
export const MIRROR_PANE_X = -2.3
/** The glass plane, depot-local z: two centimetres proud of the back wall. */
export const MIRROR_PANE_Z = -1.13
/** Pane [width, height] (m) — full-length: boots to hat with room to spare. */
export const MIRROR_PANE_SIZE: readonly [number, number] = [1.04, 1.95]
/** Bottom edge of the glass (depot-local y), just above the 0.12 deck. */
export const MIRROR_SILL_Y = 0.2
/** Steel frame strip width (m), outside the glass. */
export const MIRROR_FRAME = 0.04
/** Nothing runs unless the player is within this distance of the pane (m). */
export const MIRROR_RANGE = 4.5
/** Render target [width, height] — about half resolution at the pane's aspect. */
export const MIRROR_TARGET_SIZE: readonly [number, number] = [512, 960]

/** Wrap to (-π, π]. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2
  let out = a % twoPi
  if (out > Math.PI) out -= twoPi
  if (out <= -Math.PI) out += twoPi
  return out
}

/**
 * Is anyone actually looking? Within MIRROR_RANGE of the pane AND in front of
 * it (a player behind the back wall — outside the container — is looking at
 * corrugated steel, and there is nothing to reflect for them).
 */
export function mirrorEngaged(lx: number, lz: number): boolean {
  if (lz <= MIRROR_PANE_Z) return false
  return Math.hypot(lx - MIRROR_PANE_X, lz - MIRROR_PANE_Z) <= MIRROR_RANGE
}

/**
 * QA handle (see `__boots.mirror()` / `__boots.mirrorPixels()` in game-root):
 * how many passes have run, whether one is running now, and a way to read the
 * live reflection back. Plain counters; the reader copies what it needs.
 */
export const mirrorDebug: {
  passes: number
  engaged: boolean
  size: readonly [number, number]
  /** Which backend the host renderer runs — 'webgpu', 'webgl', or '' before the first frame. */
  backend: string
  /** RGBA of the live target (rows bottom-up on WebGL, top-down on WebGPU); null before any pass. */
  readPixels: (() => Promise<ArrayLike<number> | null>) | null
} = { passes: 0, engaged: false, size: MIRROR_TARGET_SIZE, backend: '', readPixels: null }

// ── Paint (matches the depot's palette) ──────────────────────────────────────
const FRAME = '#6d7076'
/** A mirror loses a little light; a touch of cool tint, otherwise the scene. */
const GLASS_TINT = '#e9f0f2'

/** Reused across frames — the mirror allocates nothing per frame. */
const _artic: AvatarArticulation = createArticulation()
const _eye = new Vector3()
const _local = new Vector3()
const _pane: MirrorPane = {
  center: new Vector3(),
  normal: new Vector3(),
  width: MIRROR_PANE_SIZE[0],
  height: MIRROR_PANE_SIZE[1],
}

/** How often (frames) to look for the viewmodel group while it is not found. */
const VIEWMODEL_RESCAN = 30

/**
 * The glass, its frame, and the body it reflects. Rendered as a CHILD of the
 * depot's root group, so every number above is in the depot's own frame and
 * the whole thing rides the container's placement and yaw for free.
 */
export function DepotMirror({ world }: { world: GameWorld }) {
  const paneRef = useRef<Mesh>(null)
  const selfRef = useRef<Group>(null)
  const colliderRefs = useRef<(Mesh | null)[]>([])
  const glRef = useRef<WebGLRenderer | null>(null)
  const viewmodel = useRef<Object3D | null>(null)
  const viewmodelScan = useRef(0)
  // One stable handle object for the rig's pivots (createRigRefs, not eight
  // useRef calls — the rig's shape is the rig's business).
  const refs = useRef(createRigRefs()).current
  const gaitPhase = useRef(0)
  // The body holds what we hold. A store subscription, so a weapon swap
  // re-renders the rig exactly once, like a peer's does off the wire.
  const weapon = useBoots((s) => s.weapon)
  // And it wears what we wear. Our slot in the deal can MOVE when the roster
  // changes (assignPalette walks collisions forward through the sorted id set),
  // so this has to be a subscription: read once at mount and the glass would
  // keep showing the color the lobby had already reassigned.
  const paletteIndex = useSyncExternalStore(
    subscribeLocalPalette,
    localPaletteIndex,
    localPaletteIndex,
  )
  // The depot's yaw is fixed once the lot loads: the player's heading has to
  // come into this frame before the rig can wear it.
  const yawOffset = useMemo(() => depotWorldYaw(world), [world])

  // GPU-side gear, one set per mount: the target the pass renders into, the
  // pane's geometry with its UVs turned for a render target seen in a mirror,
  // the two faces of the glass (live reflection / idle steel-grey), and the
  // virtual camera.
  const gear = useMemo(() => {
    const [w, h] = MIRROR_TARGET_SIZE
    const target = new WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false })
    const glass = flipPaneUv(new PlaneGeometry(MIRROR_PANE_SIZE[0], MIRROR_PANE_SIZE[1]))
    const live = new MeshBasicMaterial({ color: GLASS_TINT, map: target.texture })
    const idle = new MeshStandardMaterial({ color: '#8b979e', metalness: 0.75, roughness: 0.18 })
    return { camera: new MirrorCamera(), glass, idle, live, target }
  }, [])
  useEffect(
    () => () => {
      gear.target.dispose()
      gear.glass.dispose()
      gear.live.dispose()
      gear.idle.dispose()
    },
    [gear],
  )
  useEffect(() => {
    mirrorDebug.readPixels = async () => {
      const gl = glRef.current as unknown as {
        readRenderTargetPixelsAsync?: (
          target: WebGLRenderTarget,
          x: number,
          y: number,
          width: number,
          height: number,
        ) => Promise<ArrayLike<number>>
      } | null
      if (!gl?.readRenderTargetPixelsAsync || mirrorDebug.passes === 0) return null
      const [w, h] = MIRROR_TARGET_SIZE
      return gl.readRenderTargetPixelsAsync(gear.target, 0, 0, w, h)
    }
    return () => {
      mirrorDebug.readPixels = null
      mirrorDebug.engaged = false
    }
  }, [gear])

  useArmoredColliders(world, colliderRefs)

  useFrame((state, rawDt) => {
    const pane = paneRef.current
    const self = selfRef.current
    const parent = self?.parent
    if (!pane || !self || !parent) return
    if (glRef.current !== state.gl) {
      glRef.current = state.gl
      const backend = (state.gl as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend
      mirrorDebug.backend = backend ? (backend.isWebGPUBackend ? 'webgpu' : 'webgl') : 'webgl'
    }
    const camera = state.camera
    // Player set position/rotation this frame; bring the matrices with them
    // (the renderer would only do it at render time, after us).
    camera.updateMatrixWorld()

    const [lx, lz] = worldToDepotLocal(world, playerRig.position.x, playerRig.position.z)
    const engaged = mirrorEngaged(lx, lz) && paneInView(camera, pane)
    const face = engaged ? gear.live : gear.idle
    if (pane.material !== face) pane.material = face
    mirrorDebug.engaged = engaged
    // Nobody at the glass: one hypot, one frustum test, and out.
    if (!engaged) return

    // ── the body: ours, posed like a peer's ────────────────────────────────
    const dt = Math.min(rawDt, 1 / 30)
    const s = Math.min(1, playerRig.speed / MOVE.runSpeed)
    const staggered = useBoots.getState().staggered
    gaitPhase.current = advanceGait(gaitPhase.current, playerRig.grounded ? s : 0, dt)
    articulate(_artic, gaitPhase.current, s, playerRig.pitch, playerRig.grounded, staggered)
    // playerRig.position is the EYE (feet + EYE_HEIGHT + bob) — exactly what
    // goes out on the wire, so plant the feet exactly as remote-players does.
    _local.copy(playerRig.position)
    parent.worldToLocal(_local)
    self.position.set(_local.x, _local.y - EYE_HEIGHT + _artic.bobY, _local.z)
    self.rotation.y = playerRig.yaw - yawOffset
    if (refs.legL.current) refs.legL.current.rotation.x = _artic.legSwing
    if (refs.legR.current) refs.legR.current.rotation.x = -_artic.legSwing
    if (refs.armL.current) refs.armL.current.rotation.x = _artic.armSwing
    if (refs.armR.current) refs.armR.current.rotation.x = _artic.armAim
    if (refs.torso.current) refs.torso.current.rotation.x = _artic.torsoPitch
    if (refs.head.current) refs.head.current.rotation.x = _artic.headPitch

    // ── the camera: the reflected eye, frustum fitted to the glass ─────────
    camera.getWorldPosition(_eye)
    pane.getWorldPosition(_pane.center)
    // The pane's local +z, in world: the direction the glass faces.
    _pane.normal.setFromMatrixColumn(pane.matrixWorld, 2).normalize()
    if (!aimMirrorCamera(gear.camera, _eye, _pane, (camera as PerspectiveCamera).far ?? 1000)) {
      return
    }
    gear.camera.layers.mask = camera.layers.mask

    // The first-person weapon lives in the scene and copies the camera; find
    // it once by name (rescanning only while it is missing or unmounted).
    let gun = viewmodel.current
    if (!gun || !gun.parent) {
      gun = null
      if (viewmodelScan.current-- <= 0) {
        viewmodelScan.current = VIEWMODEL_RESCAN
        gun = state.scene.getObjectByName(VIEWMODEL_NAME) ?? null
        viewmodel.current = gun
      }
    }

    // ── the pass ───────────────────────────────────────────────────────────
    const gl = state.gl
    const prevTarget = gl.getRenderTarget()
    const prevAutoClear = gl.autoClear
    const gunWasVisible = gun ? gun.visible : false
    pane.visible = false
    if (gun) gun.visible = false
    self.visible = true
    gl.autoClear = true
    gl.setRenderTarget(gear.target)
    gl.render(state.scene, gear.camera)
    gl.setRenderTarget(prevTarget)
    gl.autoClear = prevAutoClear
    self.visible = false
    if (gun) gun.visible = gunWasVisible
    pane.visible = true
    mirrorDebug.passes++
  })

  const [paneW, paneH] = MIRROR_PANE_SIZE
  const paneCenterY = MIRROR_SILL_Y + paneH / 2
  const halfW = paneW / 2
  // The frame sits OUTSIDE the glass, so it stays out of the pane's frustum
  // (a strip inside the rectangle would render as a bar across the reflection)
  // and a centimetre proud of the plane, out of the near-plane clip.
  const frameZ = MIRROR_PANE_Z + 0.01

  // ONE FRAME, THE DEPOT'S. This group is deliberately untranslated, so every
  // number below is a depot-local coordinate, and `self.parent.worldToLocal`
  // is exactly the depot root's inverse transform.
  return (
    <group>
      {/* ── the glass ──────────────────────────────────────────────────── */}
      {/* A COLLIDER (see useArmoredColliders) and the QA anchor: the harness
          finds it in world.colliders and reads its real transform. Its
          material is swapped per frame between the live reflection and idle
          steel-grey glass; `visible` is off only for the instant of the pass. */}
      <mesh
        geometry={gear.glass}
        material={gear.idle}
        name="boots-mirror-pane"
        position={[MIRROR_PANE_X, paneCenterY, MIRROR_PANE_Z]}
        ref={(mesh: Mesh | null) => {
          paneRef.current = mesh
          colliderRefs.current[0] = mesh
        }}
      />
      {/* steel frame around the glass */}
      {[-(halfW + MIRROR_FRAME / 2), halfW + MIRROR_FRAME / 2].map((dx) => (
        <mesh key={dx} position={[MIRROR_PANE_X + dx, paneCenterY, frameZ]}>
          <boxGeometry args={[MIRROR_FRAME, paneH + MIRROR_FRAME * 2, 0.02]} />
          <meshStandardMaterial color={FRAME} metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      {[MIRROR_SILL_Y - MIRROR_FRAME / 2, MIRROR_SILL_Y + paneH + MIRROR_FRAME / 2].map((y) => (
        <mesh key={y} position={[MIRROR_PANE_X, y, frameZ]}>
          <boxGeometry args={[paneW, MIRROR_FRAME, 0.02]} />
          <meshStandardMaterial color={FRAME} metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      {/* Stencil on the wall above the frame. */}
      <MirrorPlaque position={[MIRROR_PANE_X, MIRROR_SILL_Y + paneH + MIRROR_FRAME + 0.14, -1.13]} />

      {/* ── the body in the glass: ours, full size ─────────────────────── */}
      {/* Pure decoration: never a collider, never a target. Invisible at every
          instant except inside the pass, so the main camera — which sits in
          its head — never sees it. */}
      <group name="boots-mirror-self" ref={selfRef} userData={{ __boots: true }} visible={false}>
        <AvatarRig paletteIndex={paletteIndex} refs={refs} weapon={weapon} />
      </group>
    </group>
  )
}

/**
 * The glass, registered as the depot's own armored collider ('__boots-depot' /
 * 'fixture' — the guntable contract: the RENDERED meshes ARE the colliders,
 * they block bullets and never voxelize). The depot's own hook lives with the
 * depot's meshes; this is the same body over the mirror's refs, because the
 * mirror is a child component and cannot reach into the shell's ref array.
 */
function useArmoredColliders(world: GameWorld, refs: { current: (Mesh | null)[] }) {
  useEffect(() => {
    const entries: ColliderEntry[] = []
    for (const mesh of refs.current) {
      if (!mesh) continue
      mesh.updateWorldMatrix(true, false)
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      const entry: ColliderEntry = {
        mesh,
        get bvh() {
          return bvhFor(this.mesh)
        },
        inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
        worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
        root: mesh,
        nodeId: DEPOT_NODE_ID,
        nodeType: DEPOT_NODE_TYPE,
      }
      world.colliders.push(entry)
      entries.push(entry)
    }
    return () => {
      for (const entry of entries) entry.disabled = true
    }
  }, [world, refs])
}

/**
 * The little stencil over the glass. Its own tiny canvas rather than the
 * depot's StencilSign, because that one is a 768 px olive plate sized for
 * marquee text and this is a 9 cm strip.
 */
function MirrorPlaque({ position }: { position: [number, number, number] }) {
  const texture = useMemo(() => {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const g = canvas.getContext('2d')
    if (!g) return null
    g.fillStyle = '#39413a'
    g.fillRect(0, 0, 256, 64)
    g.strokeStyle = '#242a24'
    g.lineWidth = 6
    g.strokeRect(4, 4, 248, 56)
    g.fillStyle = '#dfc95e'
    g.font = 'bold 34px "Courier New", monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('LOOK SHARP', 128, 34)
    return new CanvasTexture(canvas)
  }, [])
  // R3F disposes the JSX material, never an externally created texture.
  useEffect(() => () => texture?.dispose(), [texture])
  return (
    <mesh position={position}>
      <boxGeometry args={[0.6, 0.15, 0.02]} />
      {texture ? (
        <meshStandardMaterial map={texture} roughness={0.8} />
      ) : (
        <meshStandardMaterial color="#39413a" roughness={0.8} />
      )}
    </mesh>
  )
}
