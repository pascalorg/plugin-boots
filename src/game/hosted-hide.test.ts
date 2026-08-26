import { describe, expect, test } from 'bun:test'
import { BoxGeometry, Group, Mesh, Object3D } from 'three'
import { planHideKeepingRoots } from './session'

/**
 * Voxelize-time hide vs hosted children (QA round-2 item 3, visible-leaf
 * half): the host's WallRenderer nests hosted door/window/item roots INSIDE
 * the wall's render mesh, so hiding that mesh with `visible = false` culled
 * every live door and window with it — invisible closed doors that still
 * blocked an apparently-open doorway. planHideKeepingRoots is the pure
 * planner behind hideForGameKeepingRoots: branches free of kept roots hide
 * wholesale, meshes on a path down to a kept root get MASKED (layers 0 —
 * masks don't cascade), and kept subtrees are never entered.
 */

function wallWithHostedChildren() {
  // Wall render mesh (the registered wall root), like the host's renderer.
  const wall = new Mesh(new BoxGeometry(4, 2.8, 0.2))
  // Treatments: a cladding mesh child that must hide with the wall.
  const treatments = new Group()
  const cladding = new Mesh(new BoxGeometry(4, 2.8, 0.02))
  treatments.add(cladding)
  wall.add(treatments)
  // Hosted door + window roots, nested directly inside the wall mesh.
  const door = new Group()
  door.add(new Mesh(new BoxGeometry(0.8, 2, 0.04)))
  wall.add(door)
  const window = new Group()
  window.add(new Mesh(new BoxGeometry(1.2, 1.2, 0.05)))
  wall.add(window)
  return { wall, treatments, cladding, door, window }
}

describe('planHideKeepingRoots', () => {
  test('masks the wall mesh, hides fenced-free branches, never enters kept roots', () => {
    const { wall, treatments, door, window } = wallWithHostedChildren()
    const plan = planHideKeepingRoots(wall, new Set<Object3D>([door, window]))
    // The wall mesh sits on the path down to kept roots — masked, not hidden.
    expect(plan.mask).toContain(wall)
    expect(plan.hide).not.toContain(wall)
    // Treatments branch carries no kept root — hidden wholesale (one entry
    // for the branch top; its descendants cull with it).
    expect(plan.hide).toContain(treatments)
    // Kept roots and their subtrees appear in NEITHER list.
    const touched = new Set([...plan.hide, ...plan.mask])
    for (const kept of [door, window]) {
      kept.traverse((obj) => expect(touched.has(obj)).toBe(false))
    }
  })

  test('no kept descendants → the whole subtree hides as one entry', () => {
    const { wall, door, window } = wallWithHostedChildren()
    wall.remove(door)
    wall.remove(window)
    const plan = planHideKeepingRoots(wall, new Set<Object3D>([door, window]))
    expect(plan.hide).toEqual([wall])
    expect(plan.mask).toEqual([])
  })

  test('kept root behind an intermediate wrapper: the path stays, siblings hide', () => {
    const wall = new Mesh(new BoxGeometry(4, 2.8, 0.2))
    const wrapper = new Group()
    const door = new Group()
    door.add(new Mesh(new BoxGeometry(0.8, 2, 0.04)))
    const sibling = new Mesh(new BoxGeometry(0.5, 0.5, 0.05))
    wrapper.add(door)
    wrapper.add(sibling)
    wall.add(wrapper)
    const plan = planHideKeepingRoots(wall, new Set<Object3D>([door]))
    expect(plan.mask).toContain(wall)
    // The wrapper is on the kept path: not hidden (it would cull the door),
    // not masked (plain groups render nothing themselves).
    expect(plan.hide).not.toContain(wrapper)
    expect(plan.mask).not.toContain(wrapper)
    expect(plan.hide).toContain(sibling)
    expect(plan.hide).not.toContain(door)
  })
})
