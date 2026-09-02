import {
  type BufferGeometry,
  type Camera,
  Frustum,
  Matrix4,
  type Object3D,
  PerspectiveCamera,
  Vector3,
} from 'three'

/**
 * THE MIRROR'S OPTICS (pure, tested).
 *
 * A plane mirror shows, at every point Q of the glass, exactly what a camera
 * standing at the REFLECTED eye E' would see through Q: E, Q and the mirror
 * image of any R are collinear iff E', Q and R are, because Q lies on the plane
 * and reflection is an isometry that fixes it. So the depot mirror is one extra
 * render of the real room from E' into a texture that is then mapped 1:1 onto
 * the pane. Nothing is scaled, clamped or compressed — you, the room and the
 * gun rack behind you land where a real mirror would put them.
 *
 * NOT a reflection matrix on the camera: its determinant is −1, which flips
 * every triangle's winding and with it every back-face cull. A proper camera at
 * E' instead, looking straight along the pane's normal, with an OFF-AXIS frustum
 * whose near rectangle IS the pane. Two facts make that exact and cheap:
 *
 *  - The camera looks along n with up = world up, so a vertical pane is
 *    axis-aligned in camera space: its rectangle maps straight onto the four
 *    frustum bounds (left/right/top/bottom at the near plane).
 *  - The near plane sits ON the glass (near = the eye's distance to the pane).
 *    Everything behind the mirror — the container's own back wall two
 *    centimetres behind the glass, the yard beyond it — is clipped before it
 *    can occlude the room. Without this the reflection is a picture of the
 *    inside of a steel wall.
 *
 * THE FLIPS — both in the pane's geometry (flipPaneUv), renderer-agnostic, and
 * pinned by tests that project real points through real three matrices rather
 * than by trusting this paragraph:
 *
 *  - u → 1 − u, for the mirror. A camera looking along +n with up +y has
 *    right = up × (−n), the pane's local −x, while PlaneGeometry puts u = 1 at
 *    local +x. Mapped as-is the image is mirrored the wrong way round.
 *  - v → 1 − v, for the renderer. three's node renderer reads a render
 *    target's texture with v = 0 at the TOP of the rendered image on both
 *    backends (WebGPU natively; the GLSL builder flips render-target lookups
 *    to match — "follow webgpu standards"). Its own post-processing QuadMesh
 *    carries a top-down UV layout for exactly this reason. PlaneGeometry has
 *    v = 1 at the top, so a `map` of a render target on a plain plane hangs
 *    upside down — the QA harness photographed it. The QA readback side of the
 *    same fact: readRenderTargetPixelsAsync returns rows bottom-up on WebGL and
 *    top-down on WebGPU.
 *
 * WHY A CAMERA SUBCLASS. Both backends, on the first frame they meet a camera,
 * stamp their coordinate system (and reversed-depth flag) onto it and call
 * `updateProjectionMatrix()` — which on a stock PerspectiveCamera rebuilds a
 * symmetric frustum from fov/aspect and silently throws the off-axis matrix
 * away. MirrorCamera owns that method: it rebuilds the pane frustum in whatever
 * depth convention the renderer just asked for.
 */

export type MirrorPane = {
  /** Pane centre, world. */
  center: Vector3
  /** Unit normal pointing OUT of the glass, into the room (world). */
  normal: Vector3
  /** Pane extents (m). The pane is assumed vertical (its edges run along world up). */
  width: number
  height: number
}

/** Off-axis frustum bounds at the near plane — makePerspective's arguments. */
export type PaneFrustum = {
  left: number
  right: number
  top: number
  bottom: number
  near: number
  far: number
}

/** An eye closer to the glass than this (m), or behind it, gets no pass. */
export const MIRROR_MIN_EYE_DISTANCE = 0.02

/**
 * p' = p − 2·((p − P)·n)·n — the mirror image of `p` across the plane through
 * `planePoint` with unit normal `n`. Points on the plane are fixed; applying it
 * twice is the identity.
 */
export function reflectPointAcrossPlane(
  p: Vector3,
  planePoint: Vector3,
  n: Vector3,
  out: Vector3 = new Vector3(),
): Vector3 {
  const d = (p.x - planePoint.x) * n.x + (p.y - planePoint.y) * n.y + (p.z - planePoint.z) * n.z
  return out.set(p.x - 2 * d * n.x, p.y - 2 * d * n.y, p.z - 2 * d * n.z)
}

/**
 * A PerspectiveCamera whose projection is a pane frustum, and stays one. See
 * the header: the renderer's own `updateProjectionMatrix()` call would rebuild
 * a stock camera's symmetric frustum over our off-axis one.
 */
export class MirrorCamera extends PerspectiveCamera {
  /** The pane frustum once aimed; null until then (stock projection). */
  pane: PaneFrustum | null = null

  override updateProjectionMatrix(): void {
    const f = this.pane
    if (!f) {
      super.updateProjectionMatrix()
      return
    }
    this.projectionMatrix.makePerspective(
      f.left,
      f.right,
      f.top,
      f.bottom,
      f.near,
      f.far,
      this.coordinateSystem,
      this.reversedDepth,
    )
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert()
  }
}

const _eyeR = new Vector3()
const _v = new Vector3()
const _right = new Vector3()
const _up = new Vector3()

/**
 * Stand the virtual camera at the reflected eye and fit its frustum to the
 * pane. Returns false — camera untouched — when the eye is on or behind the
 * glass (nothing to reflect; the wall is corrugated steel from out there).
 *
 * `far` is the main camera's: the reflection sees as far as you do.
 */
export function aimMirrorCamera(
  cam: MirrorCamera,
  eye: Vector3,
  pane: MirrorPane,
  far: number,
): boolean {
  const n = pane.normal
  // How far in front of the glass the real eye stands.
  const dist = _v.copy(eye).sub(pane.center).dot(n)
  if (!(dist > MIRROR_MIN_EYE_DISTANCE)) return false

  reflectPointAcrossPlane(eye, pane.center, n, _eyeR)
  cam.position.copy(_eyeR)
  cam.up.set(0, 1, 0)
  cam.lookAt(_v.copy(_eyeR).add(n))
  cam.updateMatrixWorld(true)

  // The pane centre in camera axes. It is `dist` along the view axis by
  // construction ((centre − E')·n = dist), so the near plane at `dist` IS the
  // glass, and the rectangle's bounds are plain offsets from the centre.
  _right.setFromMatrixColumn(cam.matrixWorld, 0)
  _up.setFromMatrixColumn(cam.matrixWorld, 1)
  _v.copy(pane.center).sub(_eyeR)
  const cx = _v.dot(_right)
  const cy = _v.dot(_up)
  const hw = pane.width / 2
  const hh = pane.height / 2
  const safeFar = far > dist + 1 ? far : dist + 1

  const f = cam.pane ?? { left: 0, right: 0, top: 0, bottom: 0, near: 0, far: 0 }
  f.left = cx - hw
  f.right = cx + hw
  f.top = cy + hh
  f.bottom = cy - hh
  f.near = dist
  f.far = safeFar
  cam.pane = f
  cam.near = dist
  cam.far = safeFar
  cam.updateProjectionMatrix()
  return true
}

const _frustum = new Frustum()
const _projScreen = new Matrix4()

/**
 * Is the pane on screen at all? The pass only runs while someone is in front
 * of the glass AND looking its way: standing at the mirror facing the rack
 * costs nothing. Uses the camera's current matrices — one frame stale at
 * worst, which for a gate is nothing.
 */
export function paneInView(camera: Camera, pane: Object3D): boolean {
  _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  _frustum.setFromProjectionMatrix(_projScreen, camera.coordinateSystem, camera.reversedDepth)
  return _frustum.intersectsObject(pane)
}

/**
 * Turn a geometry's UVs for the pane, in place: u → 1 − u (the mirror's
 * handedness — the virtual camera's right is the pane's local −x) and
 * v → 1 − v (render-target textures read top-down in three's node renderer).
 * See THE FLIPS in the header.
 */
export function flipPaneUv<G extends BufferGeometry>(geometry: G): G {
  const uv = geometry.getAttribute('uv')
  if (!uv) return geometry
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 1 - uv.getX(i), 1 - uv.getY(i))
  uv.needsUpdate = true
  return geometry
}

/**
 * Where on the pane a render-target texel lands once the geometry's UVs are
 * turned by flipPaneUv: pane-local [x, y] from the pane's centre, in metres.
 * u = 0 is the pane's +x edge, u = 1 its −x edge; v = 0 is the top of the
 * glass, v = 1 its sill (render-target convention).
 */
export function paneLocalFromFlippedUv(
  u: number,
  v: number,
  width: number,
  height: number,
): [number, number] {
  return [(0.5 - u) * width, (0.5 - v) * height]
}
