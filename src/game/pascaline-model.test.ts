import { describe, expect, test } from 'bun:test'
import { Bone, Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three'
import { armHangZ, decodeBase64, insertPivot, PIVOT_NAMES } from './pascaline-model'

/**
 * The graph surgery that lets `articulate` drive a skinned body the way it
 * drove the box rig: pivots that change nothing at rest, arms that hang from
 * whatever pose the generator chose, and an arm frame in which the box rig's
 * own offsets put a weapon in the same hand.
 */

/** A little skeleton in the shape the Blender script exports: root → torso →
 * head / arms(+hands); root → legs. Bones carry non-identity rest rotations
 * on purpose — the point of the pivots is that those stop mattering. */
function skeleton() {
  const root = new Bone()
  root.name = 'root'
  root.position.set(0, 0.85, 0)
  const torso = new Bone()
  torso.name = 'torso'
  const head = new Bone()
  head.name = 'head'
  head.position.set(0, 0.74, 0)
  head.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.3)
  const armR = new Bone()
  armR.name = 'armR'
  armR.position.set(0.2, 0.57, 0)
  armR.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2)
  const handR = new Bone()
  handR.name = 'handR'
  handR.position.set(0, 0.43, 0)
  const legL = new Bone()
  legL.name = 'legL'
  legL.position.set(-0.115, 0, 0)
  legL.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI)
  root.add(torso)
  torso.add(head)
  torso.add(armR)
  armR.add(handR)
  root.add(legL)
  const scene = new Group()
  scene.add(root)
  scene.updateMatrixWorld(true)
  return { scene, root, torso, head, armR, handR, legL }
}

function worldOf(o: Object3D): Matrix4 {
  o.updateWorldMatrix(true, false)
  return o.matrixWorld.clone()
}

describe('insertPivot', () => {
  test("changes no world matrix at rest — the skin's bind pose is untouched", () => {
    const s = skeleton()
    const before = [s.torso, s.head, s.armR, s.handR, s.legL].map(worldOf)
    insertPivot(s.head, 'pivot-head')
    insertPivot(s.armR, 'pivot-armR')
    insertPivot(s.legL, 'pivot-legL')
    s.scene.updateMatrixWorld(true)
    const after = [s.torso, s.head, s.armR, s.handR, s.legL].map(worldOf)
    for (let i = 0; i < before.length; i++) {
      for (let k = 0; k < 16; k++) expect(after[i]!.elements[k]!).toBeCloseTo(before[i]!.elements[k]!, 12)
    }
  })

  test("sits at the bone's place in the parent frame, identity-rotated, and owns the bone", () => {
    const s = skeleton()
    const pivot = insertPivot(s.armR, 'pivot-armR')
    expect(pivot.parent).toBe(s.torso)
    expect(s.armR.parent).toBe(pivot)
    expect(pivot.position.toArray()).toEqual([0.2, 0.57, 0])
    expect(pivot.quaternion.equals(new Quaternion())).toBe(true)
    expect(s.armR.position.length()).toBe(0)
    // The bone keeps its own rest rotation; the pivot does not care.
    const rest = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2)
    expect(s.armR.quaternion.angleTo(rest)).toBeCloseTo(0, 12)
  })

  test("rotation.x on the pivot swings the limb about the body's lateral axis, whatever the bone's rest", () => {
    const s = skeleton()
    const pivot = insertPivot(s.legL, 'pivot-legL')
    // A point at the foot: 0.85 m below the hip pivot, in world space.
    const foot = new Object3D()
    foot.position.set(0, -0.85, 0)
    pivot.add(foot)
    pivot.rotation.x = 0.5
    s.scene.updateMatrixWorld(true)
    const p = new Vector3().setFromMatrixPosition(foot.matrixWorld)
    // Swings forward (the rig faces −Z), stays on its own x.
    expect(p.x).toBeCloseTo(-0.115, 12)
    expect(p.z).toBeCloseTo(-0.85 * Math.sin(0.5), 12)
    expect(p.y).toBeCloseTo(0.85 - 0.85 * Math.cos(0.5), 12)
  })

  test('refuses a parentless bone', () => {
    expect(() => insertPivot(new Bone(), 'x')).toThrow()
  })

  test('the six pivots are exactly the handles articulate writes', () => {
    expect([...PIVOT_NAMES].sort()).toEqual(['armL', 'armR', 'head', 'legL', 'legR', 'torso'])
  })
})

describe('armHangZ', () => {
  test('hangs an arm resting at any angle straight down, on either side', () => {
    for (const angle of [0.2, 0.756, 0.768, Math.PI / 2]) {
      for (const [side, sign] of [
        ['L', -1],
        ['R', 1],
      ] as const) {
        // The arm at rest: `angle` from vertical, out to its own side.
        const rest = new Vector3(sign * Math.sin(angle), -Math.cos(angle), 0)
        const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), armHangZ(side, angle))
        const hung = rest.clone().applyQuaternion(q)
        expect(hung.x).toBeCloseTo(0, 12)
        expect(hung.y).toBeCloseTo(-1, 12)
        expect(hung.z).toBeCloseTo(0, 12)
      }
    }
  })

  test('with rotation.x written after (XYZ order), the hung arm swings forward to level at π/2', () => {
    const pivot = new Group()
    pivot.rotation.z = armHangZ('R', 0.768)
    pivot.rotation.x = Math.PI / 2 // articulate's armAim at zero pitch
    pivot.updateMatrixWorld(true)
    const rest = new Vector3(Math.sin(0.768), -Math.cos(0.768), 0)
    const hand = rest.applyMatrix4(pivot.matrixWorld)
    expect(hand.y).toBeCloseTo(0, 12)
    expect(hand.z).toBeCloseTo(-1, 12) // forward is −Z
  })
})

describe('the arm frame', () => {
  test('under the hung pivot, the box rig\'s own offsets land the weapon where the box rig held it', () => {
    // Box rig: arm pivot (identity at rest) → weapon at (0, −0.52, 0.02), Rx(−π/2).
    const boxPivot = new Group()
    const boxWeapon = new Group()
    boxWeapon.position.set(0, -0.52, 0.02)
    boxWeapon.rotation.set(-Math.PI / 2, 0, 0)
    boxPivot.add(boxWeapon)

    for (const hang of [-0.768, -Math.PI / 2, -0.2]) {
      const pivot = new Group()
      pivot.rotation.z = hang
      const frame = new Group()
      frame.rotation.z = -hang
      pivot.add(frame)
      const weapon = new Group()
      weapon.position.set(0, -0.52, 0.02)
      weapon.rotation.set(-Math.PI / 2, 0, 0)
      frame.add(weapon)

      for (const aim of [0, Math.PI / 2, Math.PI / 2 + 0.4, 1.9]) {
        boxPivot.rotation.x = aim
        pivot.rotation.x = aim
        boxPivot.updateMatrixWorld(true)
        pivot.updateMatrixWorld(true)
        const a = boxWeapon.matrixWorld.elements
        const b = weapon.matrixWorld.elements
        for (let k = 0; k < 16; k++) expect(b[k]!).toBeCloseTo(a[k]!, 10)
      }
    }
  })
})

describe('decodeBase64', () => {
  test('round-trips bytes', () => {
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 1, 2, 250, 255])
    const b64 = btoa(String.fromCharCode(...bytes))
    expect(Array.from(decodeBase64(b64))).toEqual(Array.from(bytes))
  })
})
