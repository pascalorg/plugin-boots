import { useEffect, useState } from 'react'
import {
  type Bone,
  Group,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  type SkinnedMesh,
  SRGBColorSpace,
  Texture,
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneWithSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { itemModelLoader } from './item-place'

/**
 * PASCALINE, THE MODEL — the mascot from pascalorg/pascaline as a skinned GLB,
 * and the graph surgery that lets the game's ONE articulation rule set drive it.
 *
 * Where it comes from (assets/README.md has the full chain): the mascot's
 * fullbody render → a T-pose redraw by an image model (so the rig binds clean
 * arms) → Rodin image-to-3D → scripts/rig-pascaline.py in Blender (facing from
 * the texture, normalize to the rig height, decimate, our own smooth two-bone
 * weights on a six-pivot skeleton, Draco GLB, measured dims as node extras) →
 * scripts/embed-avatar.mjs → pascaline-glb.ts (base64, loaded on demand).
 * Nothing is fetched from anywhere at runtime: the plugin ships its own body.
 *
 * THE PIVOT TRICK. `articulate` (remote-players.tsx) poses a Pascaline by
 * writing `rotation.x` on six handles — torso, head, armL, armR, legL, legR —
 * exactly as it did on the box rig's groups. Skinned bones carry rest
 * rotations (a bone lying along an arm is not identity), so writing rotation.x
 * on a bone would swing it about some arbitrary axis. Instead each articulated
 * bone is re-parented under an identity-rotated PIVOT placed at the bone's
 * position in its parent's frame (insertPivot). The skeleton's bind matrices
 * are untouched — every bone's world matrix at rest is identical — and the
 * pivot's x axis is its parent's x axis, which for a root/torso pointing up is
 * the body's lateral axis: rotation.x swings the limb forward and back. Bone
 * directions stop mattering, which is what lets a Blender script lay them
 * along limbs for weighting.
 *
 * ARMS DOWN. The model is bound with its arms out (Rodin's A-pose, clean
 * shoulders), but the articulation assumes arms that hang at rest (armAim =
 * π/2 means "level"). Each arm pivot carries a fixed rotation.z — the arm's
 * measured rest angle from vertical, carried in the GLB's dims — and three's
 * Euler order is XYZ, so the matrix is Rx·Ry·Rz: the arm is hung down first
 * (z) and swung about the lateral axis after (x). `articulate` only ever writes
 * rotation.x, so the hang survives every frame.
 *
 * THE ARM FRAME. Under each arm pivot sits a group rotated by the OPPOSITE z
 * (armFrame): inside it, the arm is exactly what the box rig saw — hanging
 * down −y from the shoulder, swinging with rotation.x — so the sleeve band and
 * the elbow use the box rig's literal offsets.
 *
 * ELBOWS AND KNEES. A stick arm cannot hold a gun with two hands and a stick
 * leg cannot lift a knee, so the model has forearm and shin bones, each moved
 * under a joint pivot in the limb's frame (Object3D.attach keeps the bind pose
 * intact). The held weapon mounts in the HAND FRAME under the elbow — hanging
 * −y from the elbow, barrel down the forearm — so bending the elbow raises
 * the gun with the hand.
 */

export const PIVOT_NAMES = ['torso', 'head', 'armL', 'armR', 'legL', 'legR'] as const
export type PivotName = (typeof PIVOT_NAMES)[number]

/** Measured by scripts/rig-pascaline.py and carried in the GLB's extras. */
export type PascalineDims = {
  height: number
  hipZ: number
  neckZ: number
  shoulderZ: number
  shoulderX: number
  legX: number
  /** Shoulder joint → wrist (m), and its two halves plus the hand. */
  armLen: number
  upperArmLen: number
  foreArmLen: number
  handLen: number
  /** Hip → knee and knee → sole (m). */
  thighLen: number
  shinLen: number
  /** Hat band: height above the ground and horizontal radius. */
  hatBandZ: number
  hatRadius: number
  /** Upper-arm sleeve radius (m). */
  armRadius: number
  /** rotation.z on each arm pivot that hangs the arm straight down. */
  armHangL: number
  armHangR: number
}

/** Fallback dims — what assets/pascaline.glb measured when it was built. */
export const DEFAULT_DIMS: PascalineDims = {
  height: 1.85,
  hipZ: 0.848,
  neckZ: 1.591,
  shoulderZ: 1.42,
  shoulderX: 0.198,
  legX: 0.115,
  armLen: 0.431,
  upperArmLen: 0.198,
  foreArmLen: 0.233,
  handLen: 0.13,
  thighLen: 0.385,
  shinLen: 0.444,
  hatBandZ: 1.698,
  hatRadius: 0.137,
  armRadius: 0.081,
  armHangL: 0.756,
  armHangR: -0.768,
}

/** Where the grip sits in the hand: this far past the wrist, as a fraction of the hand. */
export const GRIP_IN_HAND = 0.45

export type PascalineTemplate = { scene: Object3D; dims: PascalineDims }

export const JOINT_NAMES = ['elbowL', 'elbowR', 'kneeL', 'kneeR'] as const
export type JointName = (typeof JOINT_NAMES)[number]

export type PascalineInstance = {
  root: Object3D
  pivots: Record<PivotName, Group>
  /** Elbow and knee pivots — identity frames at the joint, rotation.x bends. */
  joints: Record<JointName, Group>
  /** The box rig's arm frame under each arm pivot (see the header). */
  armFrames: { L: Group; R: Group }
  /** Under each elbow: the forearm hanging −y, where the held weapon mounts. */
  handFrames: { L: Group; R: Group }
  /** The hand bones — collapsed while gripping so a fist can take their place. */
  hands: { L: Object3D | null; R: Object3D | null }
  /** Empty LOD handles — the model has no detail groups to drop, but callers toggle them. */
  detail: { head: Group; body: Group }
  /** The face plate's two mouths (null on a body without a `face` material). */
  face: PascalineFace | null
  dims: PascalineDims
}

// ── The talking mouth ────────────────────────────────────────────────────────

/**
 * THE FACE, TWICE. The forward head polys wear their own opaque material
 * (`face`, the repainted 1024 px plate — scripts/face-plate.py). To show a
 * word being said, the SAME polys are cloned once more per body, bound to the
 * same skeleton, and dressed in ONE module-shared material whose map is the
 * open-mouth repaint (pascaline-face-open.ts, decoded once, lazily). Talking
 * is then a `visible` swap between the two meshes — no per-avatar material
 * clone, no texture rebinding at 8 Hz, nothing renderer-specific: on WebGPU
 * and WebGL alike a hidden mesh simply is not drawn. Both materials are shared
 * across every body on the lot, so a full lobby costs two face programs.
 */
export type PascalineFace = {
  /** The template's own face mesh — the closed mouth. */
  closed: SkinnedMesh
  /** The clone wearing the open-mouth plate; hidden until a word is said. */
  open: SkinnedMesh
  /** Which one is showing right now (the change gate). */
  isOpen: boolean
}

/** Mouth flap half-period (ms): 4 open/close cycles a second while talking. */
export const MOUTH_FLAP_MS = 125

/**
 * Is the mouth open at wall time `now` for a peer whose talk flag is `talking`?
 * A square wave on the wall clock, so every avatar of the same peer on every
 * screen flaps in the same phase and a peer who goes quiet closes at once.
 */
export function mouthOpenAt(talking: boolean, now: number): boolean {
  return talking && (Math.floor(now / MOUTH_FLAP_MS) & 1) === 1
}

/**
 * Show the open or the closed mouth — change-gated, two boolean writes per
 * flip and nothing otherwise. An open mouth is only shown once its plate has
 * decoded; until then (and on a runtime with no image decoder) the face stays
 * closed. Returns whether anything changed.
 */
export function setMouth(face: PascalineFace, open: boolean): boolean {
  const want = open && faceOpenTexture !== null
  if (want === face.isOpen) return false
  face.isOpen = want
  face.closed.visible = !want
  face.open.visible = want
  return true
}

let faceOpenTexture: Texture | null = null
let faceOpenPromise: Promise<Texture> | null = null
let faceOpenFailed: string | null = null
/** The one open-mouth material every body shares — cloned from the first face material seen. */
let faceOpenMaterial: MeshStandardMaterial | null = null

/** Is the open-mouth plate decoded and on its material? (QA/test read.) */
export function faceOpenReady(): boolean {
  return faceOpenTexture !== null
}

/** Sampler parity: the open plate takes the closed plate's wrap, filters,
 * anisotropy, colour space, orientation and UV channel, so the swap changes
 * pixels and nothing else. */
function matchSampler(open: Texture, closed: Texture | null): void {
  if (!closed) return
  open.wrapS = closed.wrapS
  open.wrapT = closed.wrapT
  open.magFilter = closed.magFilter
  open.minFilter = closed.minFilter
  open.anisotropy = closed.anisotropy
  open.generateMipmaps = closed.generateMipmaps
  open.colorSpace = closed.colorSpace
  open.flipY = closed.flipY
  open.channel = closed.channel
  open.needsUpdate = true
}

/**
 * Adopt a decoded open-mouth plate: match its sampler to the closed plate's
 * and put it on the shared open material (one program rebuild, once — the
 * material had the closed map until now). Exported as the test/QA seam the
 * loader itself goes through.
 */
export function adoptFaceOpenTexture(texture: Texture): void {
  faceOpenTexture = texture
  if (faceOpenMaterial) {
    matchSampler(texture, faceOpenMaterial.map)
    faceOpenMaterial.map = texture
    faceOpenMaterial.needsUpdate = true
  }
}

/** Test seam: forget the decoded plate (a fresh module state). */
export function resetFaceOpenTexture(): void {
  faceOpenTexture = null
  faceOpenPromise = null
  faceOpenFailed = null
  faceOpenMaterial = null
}

function openMaterialFor(closed: Material): Material {
  if (!faceOpenMaterial) {
    faceOpenMaterial = (closed as MeshStandardMaterial).clone()
    faceOpenMaterial.name = 'face-open'
    if (faceOpenTexture) {
      matchSampler(faceOpenTexture, faceOpenMaterial.map)
      faceOpenMaterial.map = faceOpenTexture
      faceOpenMaterial.needsUpdate = true
    }
  }
  return faceOpenMaterial
}

/** Can this runtime decode a JPEG into something a Texture can wear? */
function canDecodeImages(): boolean {
  return typeof createImageBitmap === 'function' || typeof Image === 'function'
}

/**
 * Decode the open-mouth plate ONCE for the module: the base64 module is a
 * dynamic import (its own chunk, fetched only when a face is instantiated),
 * decoded the way GLTFLoader decoded the closed plate (createImageBitmap with
 * premultiplyAlpha 'none' where it exists, an <img> otherwise), flipY false and
 * sRGB like every glTF colour texture. Failure is remembered and harmless: the
 * face simply never opens.
 */
export function loadFaceOpenTexture(): Promise<Texture> {
  if (!faceOpenPromise) {
    faceOpenPromise = (async () => {
      const { PASCALINE_FACE_OPEN_JPG_BASE64 } = await import('./pascaline-face-open')
      const bytes = decodeBase64(PASCALINE_FACE_OPEN_JPG_BASE64)
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' })
      let image: ImageBitmap | HTMLImageElement
      if (typeof createImageBitmap === 'function') {
        image = await createImageBitmap(blob, { premultiplyAlpha: 'none' })
      } else {
        const url = URL.createObjectURL(blob)
        try {
          const img = new Image()
          img.src = url
          await img.decode()
          image = img
        } finally {
          URL.revokeObjectURL(url)
        }
      }
      const texture = new Texture(image)
      texture.flipY = false
      texture.colorSpace = SRGBColorSpace
      texture.needsUpdate = true
      adoptFaceOpenTexture(texture)
      return texture
    })().catch((err: unknown) => {
      faceOpenFailed = err instanceof Error ? err.message : String(err)
      throw err
    })
  }
  return faceOpenPromise
}

/** What the mouth loader knows right now — plain copies, for QA. */
export function faceOpenStatus(): { ready: boolean; failed: string | null } {
  return { ready: faceOpenTexture !== null, failed: faceOpenFailed }
}

/**
 * Find the plate on a freshly cloned body and give it its second mouth: the
 * first SkinnedMesh whose (single) material is named `face` is cloned, bound
 * to the same skeleton, dressed in the shared open-mouth material, hidden,
 * and added beside the original. Kicks the one decode on a runtime that can.
 */
function attachFace(root: Object3D): PascalineFace | null {
  const plates: SkinnedMesh[] = []
  root.traverse((o) => {
    const mesh = o as SkinnedMesh
    if (!mesh.isSkinnedMesh) return
    const material = mesh.material
    if (!Array.isArray(material) && material.name === 'face') plates.push(mesh)
  })
  const closedMesh = plates[0]
  const parent = closedMesh?.parent
  if (!closedMesh || !parent) return null
  const open = closedMesh.clone(false) as SkinnedMesh
  open.name = 'face-open'
  open.material = openMaterialFor(closedMesh.material as Material)
  open.frustumCulled = false
  open.visible = false
  parent.add(open)
  if (canDecodeImages()) loadFaceOpenTexture().catch(() => {})
  return { closed: closedMesh, open, isOpen: false }
}

/**
 * Re-parent `bone` under a new identity-rotated pivot at the bone's own
 * position in its parent's frame. World matrices are unchanged afterwards.
 */
export function insertPivot(bone: Object3D, name: string): Group {
  const parent = bone.parent
  if (!parent) throw new Error(`insertPivot: ${bone.name} has no parent`)
  const pivot = new Group()
  pivot.name = name
  pivot.position.copy(bone.position)
  bone.position.set(0, 0, 0)
  parent.add(pivot)
  pivot.add(bone)
  return pivot
}

/**
 * rotation.z that hangs an arm resting at `angleFromDown` radians from
 * vertical, out to the side: the left arm (along −x) needs +angle, the right
 * (along +x) −angle. A T-pose is angle = π/2.
 */
export function armHangZ(side: 'L' | 'R', angleFromDown: number): number {
  return side === 'L' ? angleFromDown : -angleFromDown
}

/** Standard base64 → bytes, no dependencies (atob is on every runtime we ship to). */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function readDims(scene: Object3D): PascalineDims {
  let found: PascalineDims | null = null
  scene.traverse((o) => {
    const raw = (o.userData as { rigDims?: unknown }).rigDims
    if (found || raw === undefined) return
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (parsed && typeof parsed === 'object' && typeof parsed.height === 'number') {
        found = { ...DEFAULT_DIMS, ...(parsed as Partial<PascalineDims>) }
      }
    } catch {
      // Malformed extras: the defaults were measured on the shipped file anyway.
    }
  })
  return found ?? DEFAULT_DIMS
}

/**
 * One body from the template: a skeleton-aware clone (bones and skin are
 * duplicated, geometry and materials shared), the six pivots inserted, arms
 * hung, arm frames and LOD handles added, skinned meshes never frustum-culled
 * (their rest bounds lie about a raised arm).
 */
export function instantiatePascaline(template: PascalineTemplate): PascalineInstance {
  const root = cloneWithSkeleton(template.scene)
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh) o.frustumCulled = false
  })
  const pivots = {} as Record<PivotName, Group>
  for (const name of PIVOT_NAMES) {
    const bone = root.getObjectByName(name) as Bone | undefined
    if (!bone) throw new Error(`pascaline: bone '${name}' missing from the model`)
    pivots[name] = insertPivot(bone, `pivot-${name}`)
  }
  const dims = template.dims
  pivots.armL.rotation.z = dims.armHangL
  pivots.armR.rotation.z = dims.armHangR
  const frame = (pivot: Group, hang: number, name: string) => {
    const g = new Group()
    g.name = name
    g.rotation.z = -hang
    pivot.add(g)
    return g
  }
  const armFrames = {
    L: frame(pivots.armL, dims.armHangL, 'arm-frame-L'),
    R: frame(pivots.armR, dims.armHangR, 'arm-frame-R'),
  }
  // Arm pivots turn in YXZ: hang (z) first, then the swing (x), then a yaw (y)
  // about the vertical that brings a forward-pointing arm in toward the body —
  // the free hand reaching across to a gun's foregrip.
  pivots.armL.rotation.order = 'YXZ'
  pivots.armR.rotation.order = 'YXZ'

  // ELBOWS AND KNEES. The joint pivot lives in the limb's box-rig frame (the
  // arm frame / the leg pivot), straight below the parent joint at rest, so
  // rotation.x bends it about the lateral axis. The forearm/shin BONE is then
  // moved under it with its world transform preserved (Object3D.attach): the
  // skeleton's bind pose does not change, the bone simply has a new parent
  // whose rotation it inherits.
  root.updateMatrixWorld(true)
  const joint = (parent: Group, y: number, name: string, boneName: string): Group => {
    const g = new Group()
    g.name = name
    g.position.set(0, -y, 0)
    parent.add(g)
    g.updateMatrixWorld(true)
    const bone = root.getObjectByName(boneName)
    if (!bone) throw new Error(`pascaline: bone '${boneName}' missing from the model`)
    g.attach(bone)
    return g
  }
  const joints = {
    elbowL: joint(armFrames.L, dims.upperArmLen, 'pivot-elbowL', 'foreL'),
    elbowR: joint(armFrames.R, dims.upperArmLen, 'pivot-elbowR', 'foreR'),
    kneeL: joint(pivots.legL, dims.thighLen, 'pivot-kneeL', 'shinL'),
    kneeR: joint(pivots.legR, dims.thighLen, 'pivot-kneeR', 'shinR'),
  }
  const hand = (elbow: Group, name: string) => {
    const g = new Group()
    g.name = name
    elbow.add(g)
    return g
  }
  const handFrames = { L: hand(joints.elbowL, 'hand-frame-L'), R: hand(joints.elbowR, 'hand-frame-R') }
  const hands = { L: root.getObjectByName('handL') ?? null, R: root.getObjectByName('handR') ?? null }

  const detail = { head: new Group(), body: new Group() }
  detail.head.name = 'head-detail'
  detail.body.name = 'body-detail'
  pivots.head.add(detail.head)
  pivots.torso.add(detail.body)
  // The talking mouth: the face plate's polys again, hidden, on the shared
  // open-mouth material (attachFace). Null on a body that has no plate.
  const face = attachFace(root)
  return { root, pivots, joints, armFrames, handFrames, hands, detail, face, dims }
}

// ── Loading (once per module, on demand) ─────────────────────────────────────

let templatePromise: Promise<PascalineTemplate> | null = null
let templateReady: PascalineTemplate | null = null
let templateFailed: string | null = null
const listeners = new Set<() => void>()

/**
 * Start (or join) the one load. The base64 module is a dynamic import so the
 * body is a separate chunk that only downloads when a game session actually
 * mounts a Pascaline. Parsed with the same Draco-wired loader the item
 * catalog uses.
 */
export function loadPascaline(): Promise<PascalineTemplate> {
  if (!templatePromise) {
    templatePromise = (async () => {
      const { PASCALINE_GLB_BASE64 } = await import('./pascaline-glb')
      const bytes = decodeBase64(PASCALINE_GLB_BASE64)
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      const gltf = await new Promise<GLTF>((resolve, reject) => {
        itemModelLoader().parse(buffer, '', resolve, reject)
      })
      const template = { scene: gltf.scene, dims: readDims(gltf.scene) }
      templateReady = template
      for (const fn of listeners) fn()
      return template
    })().catch((err: unknown) => {
      templateFailed = err instanceof Error ? err.message : String(err)
      for (const fn of listeners) fn()
      throw err
    })
  }
  return templatePromise
}

/** What the loader knows right now — plain copies, for QA. */
export function pascalineStatus(): { ready: boolean; failed: string | null; dims: PascalineDims | null } {
  return { ready: templateReady !== null, failed: templateFailed, dims: templateReady ? { ...templateReady.dims } : null }
}

/**
 * The loaded template, or null until it lands (or forever if it failed — the
 * caller keeps the primitive rig, which is the whole point of the fallback).
 */
export function usePascalineTemplate(): PascalineTemplate | null {
  const [template, setTemplate] = useState<PascalineTemplate | null>(templateReady)
  useEffect(() => {
    if (templateReady) {
      setTemplate(templateReady)
      return
    }
    const fn = () => setTemplate(templateReady)
    listeners.add(fn)
    loadPascaline().catch(() => {})
    return () => {
      listeners.delete(fn)
    }
  }, [])
  return template
}
