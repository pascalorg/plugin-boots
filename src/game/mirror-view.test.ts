import { describe, expect, test } from 'bun:test'
import {
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Vector3,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
} from 'three'
import {
  aimMirrorCamera,
  flipPaneUv,
  MIRROR_MIN_EYE_DISTANCE,
  MirrorCamera,
  type MirrorPane,
  paneInView,
  paneLocalFromFlippedUv,
  reflectPointAcrossPlane,
} from './mirror-view'

/**
 * THE MIRROR'S OPTICS, checked against the one statement that defines a plane
 * mirror: what you see at a point Q of the glass is whatever stands on the line
 * from the REFLECTED eye through Q. Everything here runs through real three
 * objects — Matrix4.makePerspective, Object3D.lookAt, Vector3.project — so a
 * sign error in the camera basis, the frustum or the UV flip fails a test
 * instead of showing up as a reflection that turns the wrong way.
 *
 * The pane is placed at an arbitrary yaw and height on purpose: the depot is
 * rotated with the lot, and a mirror that only works facing +z is a poster.
 */

const UP = new Vector3(0, 1, 0)
const PANE_W = 1.04
const PANE_H = 1.95

/** A vertical pane at yaw ψ: normal R_y(ψ)·(0,0,1), local +x = up × normal. */
function paneAt(yaw: number, center: Vector3) {
  const normal = new Vector3(Math.sin(yaw), 0, Math.cos(yaw))
  const paneX = new Vector3().crossVectors(UP, normal)
  const pane: MirrorPane = { center, normal, width: PANE_W, height: PANE_H }
  /** A world point from pane-local (x along the wall, y up, t out into the room). */
  const at = (x: number, y: number, t: number) =>
    center.clone().addScaledVector(paneX, x).addScaledVector(UP, y).addScaledVector(normal, t)
  /** Pane-local [x, y] of a world point (its along-wall and vertical offsets). */
  const local = (p: Vector3): [number, number] => {
    const d = p.clone().sub(center)
    return [d.dot(paneX), d.dot(UP)]
  }
  return { pane, paneX, at, local }
}

/** NDC → the texel's (u, v) the way three's node renderer reads a render
 * target: u left to right, v = 0 at the rendered TOP (ndc.y = +1). */
function texelOf(p: Vector3, cam: PerspectiveCamera): { u: number; v: number; z: number } {
  const ndc = p.clone().project(cam)
  return { u: (ndc.x + 1) / 2, v: (1 - ndc.y) / 2, z: ndc.z }
}

const YAWS = [0, 0.7, Math.PI, -2.1, Math.PI / 2]
const CENTER = new Vector3(3.2, 1.175, -7.4)

describe('reflectPointAcrossPlane', () => {
  test('a point one metre in front lands one metre behind, on the same normal line', () => {
    for (const yaw of YAWS) {
      const { pane, at } = paneAt(yaw, CENTER)
      const p = at(0.3, 0.5, 1)
      const r = reflectPointAcrossPlane(p, pane.center, pane.normal)
      expect(r.distanceTo(at(0.3, 0.5, -1))).toBeCloseTo(0, 12)
    }
  })

  test('points on the plane are fixed and reflecting twice is the identity', () => {
    const { pane, at } = paneAt(0.7, CENTER)
    const onPlane = at(-0.4, 0.8, 0)
    expect(reflectPointAcrossPlane(onPlane, pane.center, pane.normal).distanceTo(onPlane)).toBeCloseTo(0, 12)
    const p = at(0.2, -0.3, 2.5)
    const twice = reflectPointAcrossPlane(
      reflectPointAcrossPlane(p, pane.center, pane.normal),
      pane.center,
      pane.normal,
    )
    expect(twice.distanceTo(p)).toBeCloseTo(0, 12)
  })

  test('writes into the caller\'s vector when given one (no per-frame allocation)', () => {
    const { pane, at } = paneAt(0, CENTER)
    const out = new Vector3()
    const returned = reflectPointAcrossPlane(at(0, 0, 1), pane.center, pane.normal, out)
    expect(returned).toBe(out)
  })
})

describe('aimMirrorCamera', () => {
  test('refuses an eye on or behind the glass', () => {
    const { pane, at } = paneAt(0.7, CENTER)
    const cam = new MirrorCamera()
    expect(aimMirrorCamera(cam, at(0, 0, -1), pane, 100)).toBe(false)
    expect(aimMirrorCamera(cam, at(0, 0, 0), pane, 100)).toBe(false)
    expect(aimMirrorCamera(cam, at(0, 0, MIRROR_MIN_EYE_DISTANCE / 2), pane, 100)).toBe(false)
    expect(cam.pane).toBeNull()
    expect(aimMirrorCamera(cam, at(0, 0, 0.5), pane, 100)).toBe(true)
  })

  test('the pane\'s four corners are the image\'s four corners, from wherever you stand', () => {
    const stands: [number, number, number][] = [
      [0, 0, 1.4], // square on
      [0.35, 0.2, 1.4], // off to the side, taller
      [-0.9, -0.6, 0.6], // crouched, past the edge, nose to the glass
      [1.8, 0.4, 4.4], // across the container
    ]
    for (const yaw of YAWS) {
      const { pane, at } = paneAt(yaw, CENTER)
      for (const [ex, ey, de] of stands) {
        const cam = new MirrorCamera()
        expect(aimMirrorCamera(cam, at(ex, ey, de), pane, 200)).toBe(true)
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            const corner = at((sx * PANE_W) / 2, (sy * PANE_H) / 2, 0)
            const ndc = corner.clone().project(cam)
            // The corner at pane +x is the IMAGE's left edge (ndc.x = −1): that
            // is the flip, and it is what flipPaneUv undoes on the geometry.
            expect(ndc.x).toBeCloseTo(-sx, 9)
            expect(ndc.y).toBeCloseTo(sy, 9)
          }
        }
      }
    }
  })

  test('the near plane is the glass: a hair behind it is clipped, a hair in front is not', () => {
    for (const yaw of YAWS) {
      const { pane, at } = paneAt(yaw, CENTER)
      const cam = new MirrorCamera()
      aimMirrorCamera(cam, at(0.2, 0.1, 1.3), pane, 200)
      // WebGL NDC: the frustum is z ∈ [−1, 1]; behind the near plane is < −1.
      expect(texelOf(at(0, 0, -0.001), cam).z).toBeLessThan(-1)
      expect(texelOf(at(0, 0, 0.001), cam).z).toBeGreaterThan(-1)
      expect(texelOf(at(0, 0, 3), cam).z).toBeLessThan(1)
    }
  })

  test('THE OPTICS: at pane point Q you see what stands on the line from the reflected eye through Q', () => {
    // For an eye E at depth de and a room point R at depth t (both in front),
    // the mirror image of R appears where E'→R crosses the plane:
    // Q = E' + s·(R − E'), s = de / (t + de). Pure geometry, no three in it —
    // and the camera + flipped UVs have to land on exactly that texel.
    const eyes: [number, number, number][] = [
      [0, 0.525, 1.4],
      [0.35, 0.525, 1.4],
      [-0.5, 0.2, 0.7],
      [1.2, 0.6, 3.5],
    ]
    const points: [number, number, number][] = [
      [0, -0.6, 1.4], // the player's own boots
      [0.35, 0.3, 1.4],
      [-1.5, 0.1, 2.0], // the rack, off to one side
      [2.2, 0.9, 0.3], // the end wall, close to the glass
      [0.1, -0.2, 6.0], // out the opening
    ]
    for (const yaw of YAWS) {
      const { pane, at, local } = paneAt(yaw, CENTER)
      for (const [ex, ey, de] of eyes) {
        const cam = new MirrorCamera()
        expect(aimMirrorCamera(cam, at(ex, ey, de), pane, 200)).toBe(true)
        for (const [rx, ry, t] of points) {
          const s = de / (t + de)
          const qx = ex + s * (rx - ex)
          const qy = ey + s * (ry - ey)
          const { u, v } = texelOf(at(rx, ry, t), cam)
          const [px, py] = paneLocalFromFlippedUv(u, v, PANE_W, PANE_H)
          expect(px).toBeCloseTo(qx, 9)
          expect(py).toBeCloseTo(qy, 9)
          // And the analytic Q really is on the plane where we said.
          const q = at(qx, qy, 0)
          expect(local(q)[0]).toBeCloseTo(qx, 12)
        }
      }
    }
  })

  test('you appear in the glass where you stand: boots, chest and hat share your own x', () => {
    // Everything on the vertical line through your eye (your own body, more or
    // less) has rx = ex, so Q.x = ex for all of it: step half a metre to the
    // right and your whole reflection is half a metre to the right — the
    // property v1's compressed parallax could not have.
    const { pane, at } = paneAt(0.7, CENTER)
    for (const ex of [-0.4, 0, 0.5]) {
      const cam = new MirrorCamera()
      aimMirrorCamera(cam, at(ex, 0.525, 1.4), pane, 200)
      for (const ry of [-0.95, -0.2, 0.3, 0.8]) {
        const { u, v } = texelOf(at(ex, ry, 1.4), cam)
        const [px, py] = paneLocalFromFlippedUv(u, v, PANE_W, PANE_H)
        expect(px).toBeCloseTo(ex, 9)
        // ...and at half the height difference to your eye (the s = ½ case).
        expect(py).toBeCloseTo((0.525 + ry) / 2, 9)
      }
    }
  })

  test('sets near/far on the camera to match the frustum (node materials read them)', () => {
    const { pane, at } = paneAt(0, CENTER)
    const cam = new MirrorCamera()
    aimMirrorCamera(cam, at(0, 0, 1.4), pane, 300)
    expect(cam.near).toBeCloseTo(1.4, 12)
    expect(cam.far).toBe(300)
    // A far shorter than the eye distance is nonsense; keep the frustum valid.
    aimMirrorCamera(cam, at(0, 0, 5), pane, 2)
    expect(cam.far).toBeGreaterThan(cam.near)
  })
})

describe('MirrorCamera', () => {
  test('keeps its pane frustum when the renderer re-stamps the depth convention', () => {
    const { pane, at } = paneAt(0.7, CENTER)
    const cam = new MirrorCamera()
    aimMirrorCamera(cam, at(0.35, 0.525, 1.4), pane, 200)
    const r = at(-1.5, 0.1, 2.0)
    const before = texelOf(r, cam)

    // What Renderer._updateCamera does on first sight of a camera.
    cam.coordinateSystem = WebGPUCoordinateSystem
    cam.updateProjectionMatrix()
    const webgpu = texelOf(r, cam)
    expect(webgpu.u).toBeCloseTo(before.u, 12)
    expect(webgpu.v).toBeCloseTo(before.v, 12)
    // WebGPU depth runs 0..1: the glass (near plane) is at z = 0 now.
    expect(texelOf(at(0, 0, 0), cam).z).toBeCloseTo(0, 9)

    ;(cam as unknown as { _reversedDepth: boolean })._reversedDepth = true
    cam.updateProjectionMatrix()
    const reversed = texelOf(r, cam)
    expect(reversed.u).toBeCloseTo(before.u, 12)
    expect(reversed.v).toBeCloseTo(before.v, 12)
    // Reversed depth: the glass is at z = 1.
    expect(texelOf(at(0, 0, 0), cam).z).toBeCloseTo(1, 9)
  })

  test('why it exists: a stock PerspectiveCamera loses a hand-built frustum on that same call', () => {
    const stock = new PerspectiveCamera()
    stock.projectionMatrix.makePerspective(-0.3, 0.7, 1.1, -0.85, 1.4, 200, WebGLCoordinateSystem)
    const handBuilt = stock.projectionMatrix.clone()
    stock.updateProjectionMatrix()
    expect(stock.projectionMatrix.equals(handBuilt)).toBe(false)
  })

  test('unaimed it is an ordinary perspective camera', () => {
    const cam = new MirrorCamera()
    const stock = new PerspectiveCamera()
    expect(cam.pane).toBeNull()
    expect(cam.projectionMatrix.equals(stock.projectionMatrix)).toBe(true)
  })
})

describe('flipPaneUv', () => {
  test('u = 0 moves to the pane\'s +x edge, v = 0 to its top edge', () => {
    const geometry = flipPaneUv(new PlaneGeometry(PANE_W, PANE_H))
    const pos = geometry.getAttribute('position')
    const uv = geometry.getAttribute('uv')
    expect(uv.count).toBe(4)
    for (let i = 0; i < uv.count; i++) {
      const x = pos.getX(i)
      const y = pos.getY(i)
      expect(uv.getX(i)).toBeCloseTo(x > 0 ? 0 : 1, 12)
      // Render-target convention: v = 0 is the rendered top, so the top edge
      // of the glass reads the top of the picture.
      expect(uv.getY(i)).toBeCloseTo(y > 0 ? 0 : 1, 12)
    }
  })

  test('is an involution and returns the same geometry', () => {
    const geometry = new PlaneGeometry(2, 1)
    const original = Array.from(geometry.getAttribute('uv').array)
    const returned = flipPaneUv(flipPaneUv(geometry))
    expect(returned).toBe(geometry)
    expect(Array.from(geometry.getAttribute('uv').array)).toEqual(original)
  })
})

describe('paneLocalFromFlippedUv', () => {
  test('reads the turned convention: u = 0 is +x, u = 1 is −x, v = 0 is the top', () => {
    expect(paneLocalFromFlippedUv(0, 0.5, PANE_W, PANE_H)[0]).toBeCloseTo(PANE_W / 2, 12)
    expect(paneLocalFromFlippedUv(1, 0.5, PANE_W, PANE_H)[0]).toBeCloseTo(-PANE_W / 2, 12)
    expect(paneLocalFromFlippedUv(0.5, 0, PANE_W, PANE_H)[1]).toBeCloseTo(PANE_H / 2, 12)
    expect(paneLocalFromFlippedUv(0.5, 1, PANE_W, PANE_H)[1]).toBeCloseTo(-PANE_H / 2, 12)
    // Consistent with flipPaneUv on a real PlaneGeometry: each vertex's uv
    // maps back onto its own position.
    const geometry = flipPaneUv(new PlaneGeometry(PANE_W, PANE_H))
    const pos = geometry.getAttribute('position')
    const uv = geometry.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) {
      const [x, y] = paneLocalFromFlippedUv(uv.getX(i), uv.getY(i), PANE_W, PANE_H)
      // Positions are float32; 6 places is the attribute's own precision.
      expect(x).toBeCloseTo(pos.getX(i), 6)
      expect(y).toBeCloseTo(pos.getY(i), 6)
    }
  })
})

describe('paneInView', () => {
  const pane = new Mesh(new PlaneGeometry(PANE_W, PANE_H))
  pane.position.set(0, 1.2, -3)
  pane.updateMatrixWorld(true)

  test('on screen when the camera faces it, off when it turns its back', () => {
    const cam = new PerspectiveCamera(92, 16 / 9, 0.1, 100)
    cam.position.set(0.3, 1.7, 0)
    cam.lookAt(pane.position)
    cam.updateMatrixWorld(true)
    expect(paneInView(cam, pane)).toBe(true)

    cam.rotateY(Math.PI)
    cam.updateMatrixWorld(true)
    expect(paneInView(cam, pane)).toBe(false)
  })

  test('still on screen when it sits at the edge of the view', () => {
    const cam = new PerspectiveCamera(92, 16 / 9, 0.1, 100)
    cam.position.set(0.3, 1.7, 0)
    cam.lookAt(pane.position)
    cam.rotateY(0.7) // ~40° off, inside a 92° fov's half-width
    cam.updateMatrixWorld(true)
    expect(paneInView(cam, pane)).toBe(true)
  })
})
