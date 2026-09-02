import { describe, expect, test } from 'bun:test'
import { Bone, Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three'
import {
  armHangZ,
  DEFAULT_DIMS,
  decodeBase64,
  insertPivot,
  instantiatePascaline,
  JOINT_NAMES,
  PIVOT_NAMES,
} from './pascaline-model'

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

/** The full skeleton the Blender script exports, as plain bones (no skin —
 * the graph surgery is what is under test), in the rig's rest layout. */
function fullSkeleton() {
  const d = DEFAULT_DIMS
  const mk = (name: string, x: number, y: number, z = 0) => {
    const b = new Bone()
    b.name = name
    b.position.set(x, y, z)
    return b
  }
  const scene = new Group()
  const root = mk('root', 0, d.hipZ)
  const torso = mk('torso', 0, 0)
  const head = mk('head', 0, d.neckZ - d.hipZ)
  const armL = mk('armL', -d.shoulderX, d.shoulderZ - d.hipZ)
  const armR = mk('armR', d.shoulderX, d.shoulderZ - d.hipZ)
  // A-pose forearms: out and down along the arm's rest direction.
  const dirL = new Vector3(-Math.sin(d.armHangL), -Math.cos(d.armHangL), 0)
  const dirR = new Vector3(Math.sin(-d.armHangR), -Math.cos(-d.armHangR), 0)
  const foreL = mk('foreL', dirL.x * d.upperArmLen, dirL.y * d.upperArmLen)
  const foreR = mk('foreR', dirR.x * d.upperArmLen, dirR.y * d.upperArmLen)
  const handL = mk('handL', dirL.x * d.foreArmLen, dirL.y * d.foreArmLen)
  const handR = mk('handR', dirR.x * d.foreArmLen, dirR.y * d.foreArmLen)
  const legL = mk('legL', -d.legX, 0)
  const legR = mk('legR', d.legX, 0)
  const shinL = mk('shinL', 0, -d.thighLen)
  const shinR = mk('shinR', 0, -d.thighLen)
  // Bones carry rest rotations (the script lays them along the limbs).
  for (const b of [armL, foreL, legL, shinL]) b.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 0.4)
  scene.add(root)
  root.add(torso, legL, legR)
  torso.add(head, armL, armR)
  armL.add(foreL)
  foreL.add(handL)
  armR.add(foreR)
  foreR.add(handR)
  legL.add(shinL)
  legR.add(shinR)
  scene.updateMatrixWorld(true)
  return { scene, dims: d }
}

describe('instantiatePascaline — joints', () => {
  test('elbows and knees exist, in the limb frames, and add no motion of their own', () => {
    const template = fullSkeleton()
    // Reference: the same skeleton with only the six pivots and the arm hang
    // — what the body looked like before it had joints. The joints must
    // reproduce exactly these world matrices for every bone.
    const ref = template.scene.clone(true)
    for (const name of PIVOT_NAMES) insertPivot(ref.getObjectByName(name)!, `pivot-${name}`)
    ref.getObjectByName('pivot-armL')!.rotation.z = template.dims.armHangL
    ref.getObjectByName('pivot-armR')!.rotation.z = template.dims.armHangR
    ref.updateMatrixWorld(true)
    const refWorld = new Map<string, Matrix4>()
    ref.traverse((o) => {
      if ((o as Bone).isBone) refWorld.set(o.name, o.matrixWorld.clone())
    })
    const body = instantiatePascaline(template)
    body.root.updateMatrixWorld(true)
    for (const name of JOINT_NAMES) expect(body.joints[name]).toBeDefined()
    let compared = 0
    body.root.traverse((o) => {
      if (!(o as Bone).isBone) return
      const before = refWorld.get(o.name)
      expect(before).toBeDefined()
      for (let k = 0; k < 16; k++) expect(o.matrixWorld.elements[k]!).toBeCloseTo(before!.elements[k]!, 9)
      compared++
    })
    expect(compared).toBe(13)
    // The elbow pivot hangs straight below the shoulder in the arm frame, by
    // the upper arm's length; the knee below the hip by the thigh's.
    expect(body.joints.elbowR.parent).toBe(body.armFrames.R)
    expect(body.joints.elbowR.position.y).toBeCloseTo(-template.dims.upperArmLen, 12)
    expect(body.joints.kneeL.parent).toBe(body.pivots.legL)
    expect(body.joints.kneeL.position.y).toBeCloseTo(-template.dims.thighLen, 12)
    // The forearm and shin bones now answer to the joints.
    expect(body.root.getObjectByName('foreR')?.parent).toBe(body.joints.elbowR)
    expect(body.root.getObjectByName('shinL')?.parent).toBe(body.joints.kneeL)
    // The hand frame is the weapon's mount, under the elbow.
    expect(body.handFrames.R.parent).toBe(body.joints.elbowR)
    // Arm pivots turn hang-then-swing-then-yaw.
    expect(body.pivots.armL.rotation.order).toBe('YXZ')
    expect(body.pivots.armR.rotation.order).toBe('YXZ')
  })

  test('bending the elbow raises the hand frame forward; bending the knee tucks the shin back', () => {
    const body = instantiatePascaline(fullSkeleton())
    const probe = new Object3D()
    probe.position.set(0, -0.2, 0)
    body.handFrames.R.add(probe)
    body.root.updateMatrixWorld(true)
    const before = new Vector3().setFromMatrixPosition(probe.matrixWorld)
    body.joints.elbowR.rotation.x = 1.2
    body.root.updateMatrixWorld(true)
    const after = new Vector3().setFromMatrixPosition(probe.matrixWorld)
    expect(after.z).toBeLessThan(before.z) // forward is −Z
    expect(after.y).toBeGreaterThan(before.y)

    const shinProbe = new Object3D()
    shinProbe.position.set(0, -0.3, 0)
    body.joints.kneeL.add(shinProbe)
    body.root.updateMatrixWorld(true)
    const b2 = new Vector3().setFromMatrixPosition(shinProbe.matrixWorld)
    body.joints.kneeL.rotation.x = -0.9 // applyArticulation writes −knee
    body.root.updateMatrixWorld(true)
    const a2 = new Vector3().setFromMatrixPosition(shinProbe.matrixWorld)
    expect(a2.z).toBeGreaterThan(b2.z) // the foot goes back
  })
})
