import { Box3, Line3, Vector3 } from 'three'
import { lotFloorY } from './ground'
import { WALKABLE_NORMAL_Y } from './movement'
import type { ColliderEntry } from './world'

/**
 * Capsule-vs-world resolution — the three-mesh-bvh `characterMovement`
 * pattern, per-mesh in local space (host transforms are rigid). Mutates
 * position (feet) and clips velocity against contact normals so the player
 * slides along walls instead of sticking.
 *
 * CLIMB FEEL additions:
 * - collideCapsule keeps `walkOnly` colliders (FEET SEE THE PLANE — the
 *   smooth merged-box plank of a voxel-clad placed ramp; bullets skip those
 *   entries and hit the voxel grid instead) and can report the ground
 *   contact normal so movement can ride slopes at full speed.
 * - moveCapsule is the integrate + slide + STEP OFFSET + ground-snap move
 *   the player runs: a horizontal block whose top is within STEP_OFFSET
 *   (with headroom) lifts the capsule and continues WITHOUT speed loss, so
 *   real sawtooth stairs climb at run speed instead of grinding on every
 *   riser. Zero per-frame allocations — module temps only.
 *
 * OPEN-DOORWAY PASSAGE RELIEF (owner report 2026-08-29, "door opens but I
 * can't go through"): real scenes author OTHER nodes across a doorway — the
 * repro house has window_living_a's frame rails (5 cm bars at y 0.60 and
 * 1.75) spanning the front door's opening, so the capsule stopped exactly
 * capsule-radius short of them while the door stood visibly open. While a
 * door (or out-swing window) is open, interact.tsx registers its PASSAGE
 * volume — the collider-group AABB at mount pose, thin axis padded — and
 * collideCapsule ignores any NON-GROUND triangle contact whose closest
 * point lies inside a registered passage. Ground contacts (normal.y ≥
 * WALKABLE_NORMAL_Y) always keep resolving — floors and thresholds carry
 * the capsule through the opening — while wall corners crossing the prism
 * (the QA house's wall_e END inside the front doorway, contacts at bottom-
 * sphere height y ≈ 0.33) and the rails stop pinching. Contacts OUTSIDE
 * the prism keep pushing (the jamb walls, the same rails past the frame).
 */

export type CapsuleConfig = { radius: number; height: number }

export const PLAYER_CAPSULE: CapsuleConfig = { radius: 0.34, height: 1.78 }
export const EYE_HEIGHT = 1.58

/** Capsule step-up: a blocking obstruction whose top is within this of the
 * feet gets climbed in-stride (standard character-controller step). Covers
 * code-max 0.27 m host risers with margin, but never a half-wall (0.93 m). */
export const STEP_OFFSET = 0.35

/** A flat slide that kept at least this fraction of its intended horizontal
 * advance was not meaningfully blocked — no step attempt. */
const STEP_BLOCK_RATIO = 0.9
/** The lifted slide must beat the flat slide by at least this (m) to win. */
const STEP_MIN_GAIN = 1e-3
/** Intended horizontal advance (m) under which stepping is pointless. */
const STEP_MIN_INPUT = 1e-4
/** The step's down-settle and the ground snap probe in slices this tall so
 * the push-out always resolves against the surface below, never sideways
 * out of a deep burial. */
const SETTLE_SLICES = 4
/** How far below the feet the ground snap searches when a previously
 * grounded, non-jumping mover loses contact (slope-parallel motion floats
 * off the plane by float noise; descending ramps outrun the contact). */
const GROUND_SNAP = STEP_OFFSET

const _segment = new Line3()
const _localSegment = new Line3()
const _worldBox = new Box3()
const _localBox = new Box3()
const _triPoint = new Vector3()
const _capsulePoint = new Vector3()
const _normal = new Vector3()
const _passagePoint = new Vector3()

// ---------------------------------------------------------------------------
// Open-doorway passage volumes (see the header block)
// ---------------------------------------------------------------------------

/** Live passage volumes, registered BY IDENTITY (interact.tsx keeps one Box3
 * per open passable operable and hands the same instance back to
 * unregister). Usually empty; one entry per door standing open. */
const passages: Box3[] = []

/** Make `box` an active passage: capsule contacts whose closest point lies
 * inside it are ignored. Idempotent per instance. */
export function registerPassage(box: Box3): void {
  if (!passages.includes(box)) {
    passages.push(box)
    _passageGen++
  }
}

/** Retire a passage registered with the SAME Box3 instance. No-op when
 * absent. */
export function unregisterPassage(box: Box3): void {
  const index = passages.indexOf(box)
  if (index !== -1) {
    passages.splice(index, 1)
    _passageGen++
  }
}

/** Drop every passage (session unmount / test isolation). */
export function clearPassages(): void {
  if (passages.length > 0) _passageGen++
  passages.length = 0
}

/**
 * Bumped whenever the passage set CHANGES — the render lane's "should I redraw"
 * gate. Doors open and close a handful of times a session, so a per-frame
 * integer compare (like `wall.revision`) lets every voxel replica idle for free
 * and rebuild its instance matrices only on the frames a doorway actually
 * appeared or vanished.
 */
let _passageGen = 0

export function passageGeneration(): number {
  return _passageGen
}

/** Is THIS Box3 instance an active passage? (identity, like the registry) */
export function isPassageRegistered(box: Box3): boolean {
  return passages.includes(box)
}

/** Live passage count — QA / test introspection. */
export function passageCount(): number {
  return passages.length
}

/** The live passage volumes as PLAIN DATA (never live refs) — the census
 * `__boots.doors.census()` reads to prove a prism is actually registered and
 * where it stands. */
export function passageBoxes(): Array<{
  min: [number, number, number]
  max: [number, number, number]
}> {
  return passages.map((box) => ({
    min: [box.min.x, box.min.y, box.min.z] as [number, number, number],
    max: [box.max.x, box.max.y, box.max.z] as [number, number, number],
  }))
}

/** Colliders no taller than this read as CROSSING BARS (window rails,
 * thresholds, sill overhangs — the repro rails are 5 cm): their contacts
 * test against the prism padded horizontally by PASSAGE_BAR_SLACK. The
 * capsule brushing a bar contacts it across ±radius of its own axis, so an
 * on-the-jamb-line pass otherwise wedges on the bar's tail past the frame
 * (live QA: the front-door walk stopped at z 4.31 with the exact prism —
 * off-axis rail contacts at x < the 4.6 opening edge kept pushing). Jamb
 * walls, posts and mullions are far taller and keep the exact prism. */
const THIN_BAR_MAX_HEIGHT = 0.3
const PASSAGE_BAR_SLACK = 0.45

/** Horizontal boundary tolerance for EVERY collider: jamb-corner contacts
 * resolve exactly ON the prism face (the QA front door's west jamb reported
 * x 4.59 against a 4.60 prism edge) and their diagonal push nudged the
 * walker off line all the way through. Far below capsule radius, so no
 * body can actually enter the jamb through it. */
const PASSAGE_EDGE_EPS = 0.02

/** Is this WORLD-space contact point inside any active passage, with `pad`
 * of horizontal slack (0 for full-height colliders, PASSAGE_BAR_SLACK for
 * crossing bars)? The Y band is never padded — headers keep their height
 * and nothing above the frame is relieved. */
function inPassage(point: Vector3, pad: number): boolean {
  for (const box of passages) {
    if (
      point.y >= box.min.y &&
      point.y <= box.max.y &&
      point.x >= box.min.x - pad &&
      point.x <= box.max.x + pad &&
      point.z >= box.min.z - pad &&
      point.z <= box.max.z + pad
    ) {
      return true
    }
  }
  return false
}

const _passageCell = new Vector3()

/**
 * THE VOXEL LANE'S PASSAGE RELIEF (owner report 2026-08-30: "i still cant
 * enter a door because i see voxels when it's open through it and i can open
 * with E but not walk into it").
 *
 * The prism above only relieves HOST BVH TRIANGLES, because `inPassage` is
 * consulted from exactly one place: collideCapsule's `intersectsTriangle`.
 * But the player is resolved against voxel grids in a SECOND, separate pass
 * (destruction.collideVoxelTargets, run from player.tsx right after
 * moveCapsule), and that pass knew nothing about doorways. Every scene
 * authors neighbouring geometry across its openings — the QA house's `wall_e`
 * END stands inside the front doorway, and a wall's voxel grid does not carve
 * the door aperture — so while those grids were DORMANT the host triangles
 * were relieved and the door walked fine, and the instant gunfire WOKE the
 * grid the very same geometry re-solidified as cubes with no relief at all:
 * the door still opened (interact owns the node), the leaf still swung, the
 * prism was still registered, every door collider was still disabled, and the
 * capsule was still stopped dead in the opening. Measured on the flat QA
 * house: front door open-walk advance 20.63 m pristine → 1.61 m once `wall_e`
 * woke, with 22 of its cells standing in the aperture at capsule height.
 *
 * So the voxel lane asks the same question the triangle lane does — with one
 * difference, because a cube has no normal. The triangle lane keeps resolving
 * WALKABLE-NORMAL contacts so floors carry the capsule through the opening;
 * the obvious voxel translation (keep resolving whichever cells push mostly
 * UPWARD) is WRONG, and measurably so: `collideVoxelTargets` clamps the
 * contact to the capsule's core segment, which starts a radius above the feet,
 * so a WALL's bottom row reads as strongly vertical too (measured in the
 * regression rig: feet at y 0.037, cell center y 0.075, dy/dist = 0.715 — well
 * past WALKABLE_NORMAL_Y) and that one row alone kept sealing the doorway.
 *
 * The discriminator is the FEET PLANE, not the push direction. A floor the
 * capsule stands on has its cells BELOW the feet; a wall row that blocks the
 * walk stands AT OR ABOVE them. So a cell inside the prism at or above `feetY`
 * is the blocker the open door promised away and is dropped, while anything
 * below the feet keeps resolving — a voxel floor or threshold still carries the
 * capsule across the opening and nobody falls through a shot-out slab standing
 * in a doorway. (The prism's Y band is a second guard on the same invariant:
 * it starts at the door leaf's sill, so floor cells are usually already out of
 * the band before the feet test ever runs.)
 *
 * `cellHalf` is the HALF-EXTENT of the cell being resolved, and it is not
 * optional in practice — a cell is a CUBE, not the point this test used to
 * compare. Measured on the flat QA house's front door with every refusal
 * recorded and attributed: 1566 refusals, all of them "centre outside the
 * prism", from exactly two owners — `wall_e`'s column at z 3.54 against a
 * prism starting at z 3.587 (cell 0.203, so the cube spans 3.44-3.64 and more
 * than half of it is INSIDE the opening) and the open leaf's own grid at x 5.44
 * against a prism ending at x 5.40 (cell 0.15). Dropping only the cells whose
 * CENTRES fall inside leaves a fringe one cell thick lining the whole aperture,
 * and a 0.8 m door has just 0.06 m of clearance per side for a 0.68 m capsule —
 * so that fringe alone seals it.
 *
 * `cellHalf` is therefore THE RADIUS THIS LANE RESOLVES A CELL WITH, not the
 * cell's true half-extent — and the distinction is deliberate, because those
 * differ. `collideVoxelTargets` treats a cell as a SPHERE of `grid.cell * 0.55`
 * where `grid.cell = max(cellX, cellY, cellZ)`, so on a wall's THICKNESS axis
 * (pinned to extent/layers, 0.03-0.05 m) that sphere is several times fatter
 * than the cube it stands for. The set of capsule positions a cell can block is
 * fixed by that sphere, so the only pad that relieves exactly what this lane
 * can block — no seal left behind, nothing extra freed — is the sphere's own
 * radius. Asking about the true anisotropic box here would UNDER-relieve on the
 * thickness axis and let the fringe seal the door again. (The lanes that are
 * about what you SEE rather than where you can stand get `passageHidesCell`,
 * which is deliberately unpadded — see its header for why the trade-off flips.)
 *
 * It still cannot open a hole in a jamb. On the axis where jamb leakage is even
 * possible — the door's WIDTH, where the prism is unpadded — `grid.cell` IS the
 * in-plane cell size, so the pad equals the true half-extent to within a
 * percent. On the thickness axis, where the pad is oversized, the prism already
 * carries PASSAGE_SLACK (0.35 m) of its own, which dwarfs any cell, so the
 * oversize changes nothing that the slack had not already decided.
 */
export function passageRelievesCell(
  x: number,
  y: number,
  z: number,
  feetY: number,
  cellHalf = 0,
): boolean {
  _reliefCalls++
  if (passages.length === 0) return false
  // The feet test stays STRICT (unpadded): a voxel floor's cells sit below the
  // feet, and padding this by `cellHalf` would relieve the very slab holding
  // the capsule up in the doorway and drop the player through it.
  if (y < feetY) return false
  _passageCell.set(x, y, z)
  const relieved = inPassage(_passageCell, PASSAGE_EDGE_EPS + Math.max(0, cellHalf))
  if (relieved) _reliefGrants++
  return relieved
}

/** How often the VOXEL lane actually consulted this module, and how often it
 * was told "relieved" — two ints, so QA can tell "the relief said no" from
 * "the relief was never asked" (a second module instance, or a voxel pass that
 * does not route through here) without reading a screenshot. */
let _reliefCalls = 0
let _reliefGrants = 0

export function passageReliefStats(): { calls: number; grants: number; passages: number } {
  return { calls: _reliefCalls, grants: _reliefGrants, passages: passages.length }
}

export function resetPassageReliefStats(): void {
  _reliefCalls = 0
  _reliefGrants = 0
}

/**
 * THE SAME QUESTION WITH NO FEET IN IT — for the lanes that are about what you
 * can SEE THROUGH rather than where you can stand.
 *
 * The owner reported two symptoms, not one: "i SEE voxels when it's open
 * through it AND i can open with E but not walk into it". The walk is
 * `passageRelievesCell`. The other half is drawn geometry: voxel-walls.tsx
 * instances every alive cell regardless of relief, so a wall whose grid crosses
 * a NEIGHBOUR's doorway (a grid never carves someone else's aperture) keeps its
 * cubes on screen right across the opening once it wakes.
 *
 * Two deliberate differences from the walk predicate:
 *
 *  - NO `feetY` TERM. A cube you can see through has nothing to do with where
 *    anyone's feet are; the walk's feet rule exists only to keep a threshold
 *    slab solid underfoot.
 *  - NO PADDING AT ALL — a cell is hidden only when its CENTRE stands inside the
 *    prism. This is the opposite call from the collision lane, and on purpose:
 *    there, under-relieving leaves a one-cell fringe that SEALS the door (the
 *    bug), while over-relieving costs nothing visible. Here the trade-off flips.
 *    Every direction a pad could grow in removes material the player is looking
 *    straight at: outward on the door's WIDTH notches the jambs, DOWN holes the
 *    floor of the doorway, UP opens a slot over the header, and on the THICKNESS
 *    axis the prism already carries PASSAGE_SLACK (0.35 m). Under-hiding, by
 *    contrast, leaves at most half a cell of genuine wall poking into the edge
 *    of the aperture — geometry the collision lane has already relieved, so it
 *    cannot trap anyone, and at 0.02-0.14 m it reads as wall, not as a blockage.
 *    A centre test also hides EXACTLY the census the browser probe counted (43
 *    cells on the sculpted lot, 65 on the QA house's bath door): a cube standing
 *    in an opening is majority-inside it by definition.
 */
export function passageHidesCell(x: number, y: number, z: number): boolean {
  if (passages.length === 0) return false
  _passageCell.set(x, y, z)
  return inPassage(_passageCell, PASSAGE_EDGE_EPS)
}

/**
 * THE SAME QUESTION FOR A STICK, NOT A CUBE — the member lanes' passage test
 * (framing segments, joists, rafters, drywall sheets: everything voxel-walls.tsx
 * draws as a MemberLayer rather than a grid cell).
 *
 * `passageHidesCell` asks whether a CENTRE stands inside the opening, and for a
 * cell that is the whole question: a cube 0.15 m on a side in a 0.8 m doorway is
 * majority-inside the moment its centre is, so centre-in and stands-in are the
 * same predicate to within half a cell. A framing member is not that shape. A
 * stud line splits into sticks up to ~0.9 m long and a plate into ~1.2 m runs
 * (destruction.ts buildSegments), so a stick can cross the full width of a 0.8 m
 * doorway with its CENTRE comfortably outside the prism — the centre test would
 * leave exactly the bar across the opening this lane exists to remove, and it
 * would leave it on the worst members, the long ones.
 *
 * So a member is tested as its CENTRE LINE: the segment through its centre along
 * its longest local axis, rotated into world space by the same composition the
 * matrix writer uses (voxel-walls.tsx beginMemberRotation — one composition, two
 * readers, so the axis we test is the axis we draw). Hidden when that line enters
 * the prism.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, on both sides:
 *
 *  - NO PRISM PAD — like `passageHidesCell` and for exactly its reason (every
 *    direction a pad could grow in removes geometry the player is looking
 *    straight at), and one step stricter: not even that lane's PASSAGE_EDGE_EPS,
 *    for the reason spelled out at the loop below. Here the stakes are higher
 *    than on the skin, because the
 *    door's OWN framing is parked a mere OPENING_PAD (0.02 m, destruction.ts)
 *    clear of its aperture: the trimmer studs flanking the opening and the
 *    header plate over it are the geometry a pad reaches FIRST. Pad this by a
 *    fifth of a metre and an open door loses its jambs and its header — a
 *    conspicuously worse artefact than the bar it was removing.
 *  - NO CROSS-SECTION. The two minor axes are ignored, so a stick that only
 *    grazes the prism with a corner keeps drawing. That under-relieves by at
 *    most half the member's cross-section — 0.019 m on a 2×4's width, 0.045 m on
 *    its depth, 0.118 m on a 2×10 joist — all at or below the half-cell the skin
 *    lane already accepts, and all of it lumber inside a wall cavity rather than
 *    in open air. Erring this way is also what keeps the 0.02 m jamb clearance
 *    meaningful: an OBB test would spend most of that clearance on the stick's
 *    own half-width.
 *
 * The under-relief bound is the member's cross-section, NOT its length, which is
 * why testing the line rather than the point matters: length is the dimension
 * that varies from 0.09 m to 1.2 m across the layer, and it is now exact.
 *
 * (A wide SHEET member — `boards`, the drywall-plate layer voxel-walls.tsx can
 * render but destruction.ts does not populate today — would need its medial
 * RECTANGLE rather than a single line, since a plate can cross a doorway off
 * both of its own axes. Pinned by test so the day boards land, they land loud.)
 */
export function passageHidesSegment(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  if (passages.length === 0) return false
  for (const box of passages) {
    // THE EXACT PRISM — not even PASSAGE_EDGE_EPS, which the cell lanes carry.
    // That eps is a COLLISION tolerance (jamb-corner contacts resolving exactly
    // on a prism face pushed the walker off line), and on the skin it is free:
    // 0.02 m against a half-cell of 0.075 m is noise. Against framing it is not
    // noise, it is most of the budget. Measured on the harness wall — a 4 m wall
    // with a 0.9 m hosted door, the shape stud-openings.test.ts pins — the
    // clipped bottom plate stops 0.026 m short of the prism (OPENING_PAD 0.02
    // plus the segment's own 0.006 end shrink). An 0.02 m eps would spend 77 %
    // of that on nothing, leaving 6 mm between "correct" and hiding the plate
    // the doorway stands on. The eps has no job here — a stick whose centre line
    // lands exactly on the prism face is arbitrary either way, and there is no
    // resolution loop for it to destabilise.
    if (
      segmentTouchesBox(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        box.min.x,
        box.min.y,
        box.min.z,
        box.max.x,
        box.max.y,
        box.max.z,
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * Does segment A→B intersect the axis-aligned box? Slab clipping on the
 * parameter t ∈ [0, 1] — allocation-free, and it answers for the whole stick at
 * once instead of sampling it.
 *
 * A degenerate axis (the segment is flat in x, y or z — the common case, since
 * most framing runs parallel to a world axis) is handled by an inside test
 * rather than a division: with dx exactly 0 the two slab roots are ±Infinity,
 * which clips correctly, but `0/0` on a segment that also STARTS on the slab
 * plane is NaN and every comparison against it is false, so the clip would fail
 * open. Testing the coordinate instead is both exact and cheaper.
 */
function segmentTouchesBox(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  let t0 = 0
  let t1 = 1
  // x
  const dx = bx - ax
  if (dx === 0) {
    if (ax < minX || ax > maxX) return false
  } else {
    let ta = (minX - ax) / dx
    let tb = (maxX - ax) / dx
    if (ta > tb) {
      const swap = ta
      ta = tb
      tb = swap
    }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return false
  }
  // y
  const dy = by - ay
  if (dy === 0) {
    if (ay < minY || ay > maxY) return false
  } else {
    let ta = (minY - ay) / dy
    let tb = (maxY - ay) / dy
    if (ta > tb) {
      const swap = ta
      ta = tb
      tb = swap
    }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return false
  }
  // z
  const dz = bz - az
  if (dz === 0) {
    if (az < minZ || az > maxZ) return false
  } else {
    let ta = (minZ - az) / dz
    let tb = (maxZ - az) / dz
    if (ta > tb) {
      const swap = ta
      ta = tb
      tb = swap
    }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return false
  }
  return true
}

/**
 * Could any open doorway possibly touch this sphere? The render lane's cheap
 * bail-out: a voxel replica whose whole grid is nowhere near a doorway must not
 * walk its cells just because a door opened on the far side of the lot.
 */
export function passagesTouchSphere(cx: number, cy: number, cz: number, r: number): boolean {
  for (const box of passages) {
    const dx = Math.max(box.min.x - cx, 0, cx - box.max.x)
    const dy = Math.max(box.min.y - cy, 0, cy - box.max.y)
    const dz = Math.max(box.min.z - cz, 0, cz - box.max.z)
    if (dx * dx + dy * dy + dz * dz <= r * r) return true
  }
  return false
}

function refreshSegments(pos: Vector3, cfg: CapsuleConfig, collider: ColliderEntry): void {
  _segment.start.set(pos.x, pos.y + cfg.radius, pos.z)
  _segment.end.set(pos.x, pos.y + cfg.height - cfg.radius, pos.z)
  _localSegment.copy(_segment).applyMatrix4(collider.inverse)
}

/** Steepest ground contact of the CURRENT collideCapsule call (min normal.y
 * above the grounded threshold) — module state so the resolve loop stays
 * allocation-free. */
let _groundNy = Number.POSITIVE_INFINITY

/** Resolve the capsule out of every collider. Returns whether any contact
 * counted as ground (normal.y > 0.55) this pass. `walkOnly` colliders stay
 * solid here on purpose — movement sees the smooth plane, bullets see the
 * voxels. When `groundNormalOut` is given it receives the STEEPEST ground
 * contact normal of this pass (slope riding wants the ramp, not the seam's
 * flat neighbor), or (0, 1, 0) when only the lot plane grounds the capsule. */
export function collideCapsule(
  pos: Vector3,
  vel: Vector3,
  colliders: ColliderEntry[],
  cfg: CapsuleConfig = PLAYER_CAPSULE,
  groundNormalOut?: Vector3,
): boolean {
  let grounded = false
  _groundNy = Number.POSITIVE_INFINITY
  if (groundNormalOut) groundNormalOut.set(0, 1, 0)

  for (let iteration = 0; iteration < 3; iteration++) {
    let corrected = false
    _worldBox.min.set(pos.x - cfg.radius, pos.y, pos.z - cfg.radius)
    _worldBox.max.set(pos.x + cfg.radius, pos.y + cfg.height, pos.z + cfg.radius)

    for (const collider of colliders) {
      if (collider.disabled) continue
      if (!collider.worldBox.intersectsBox(_worldBox)) continue
      // Passage relief pad for this collider (see THIN_BAR_MAX_HEIGHT).
      const passagePad =
        passages.length > 0 &&
        collider.worldBox.max.y - collider.worldBox.min.y <= THIN_BAR_MAX_HEIGHT
          ? PASSAGE_BAR_SLACK
          : PASSAGE_EDGE_EPS
      refreshSegments(pos, cfg, collider)
      _localBox.makeEmpty()
      _localBox.expandByPoint(_localSegment.start)
      _localBox.expandByPoint(_localSegment.end)
      _localBox.min.addScalar(-cfg.radius)
      _localBox.max.addScalar(cfg.radius)

      collider.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(_localBox),
        intersectsTriangle: (tri) => {
          const distance = tri.closestPointToSegment(_localSegment, _triPoint, _capsulePoint)
          if (distance >= cfg.radius) return false
          const depth = cfg.radius - distance
          _normal.subVectors(_capsulePoint, _triPoint)
          if (_normal.lengthSq() < 1e-12) return false
          _normal.normalize().transformDirection(collider.mesh.matrixWorld)
          // Passage relief: a NON-GROUND contact standing inside an open
          // doorway's registered prism is a phantom blocker (overlapping
          // window rail, a perpendicular wall's end corner) — the open door
          // promised passage. Ground-normal contacts always resolve (the
          // floor carries the capsule through; the height-band variant
          // failed live: wall-corner contacts report at bottom-sphere
          // height y ≈ radius and wedged under any floor band). World-space
          // test on the TRIANGLE-side contact point; anything outside the
          // prism (jamb wall faces, the rail beyond the frame) still pushes.
          if (passages.length > 0 && _normal.y < WALKABLE_NORMAL_Y) {
            _passagePoint.copy(_triPoint).applyMatrix4(collider.mesh.matrixWorld)
            if (inPassage(_passagePoint, passagePad)) return false
          }
          if (_normal.y >= WALKABLE_NORMAL_Y) {
            // WALKABLE GROUND: resolve the embed VERTICALLY (depth / n.y) —
            // the classic character-controller ground resolve. Push-out
            // along the tilted normal cancels horizontal advance: on a
            // smooth 43° plank the ride alternated full frames with
            // one-fifth frames (QA 2026-08-28 — uphill ratio 0.75 while
            // VELOCITY stayed at full run speed) because the step retry's
            // down-settle lands GRAZING (distance == radius, never
            // penetrating → not grounded) and aborts. Vertical resolve
            // keeps the capsule ON the plane at full horizontal speed;
            // walls, ceilings and too-steep faces keep the normal push.
            pos.y += depth / _normal.y
          } else {
            pos.addScaledVector(_normal, depth)
          }
          if (_normal.y > 0.55) {
            grounded = true
            if (groundNormalOut && _normal.y < _groundNy) {
              _groundNy = _normal.y
              groundNormalOut.copy(_normal)
            }
          }
          const into = vel.dot(_normal)
          if (into < 0) vel.addScaledVector(_normal, -into)
          corrected = true
          refreshSegments(pos, cfg, collider)
          return false
        },
      })
    }
    if (!corrected) break
  }

  // The lot itself: an infinite ground plane at the LOT FLOOR — y = 0 on a
  // flat or void scene (exactly the old behaviour), and just under the site's
  // lowest point when the scene carries sculpted terrain. It stays a single
  // scalar rather than a per-XZ terrain height on purpose: the heightfield is
  // already a solid collider resolved above, so it does the real holding-up,
  // while a per-XZ plane would shove anything inside a basement or a
  // below-grade room up through its own floor. This is the last-resort
  // backstop, not the ground.
  const floor = lotFloorY()
  if (pos.y < floor) {
    pos.y = floor
    if (vel.y < 0) vel.y = 0
    grounded = true
  } else if (pos.y < floor + 0.02 && vel.y <= 0.01) {
    grounded = true
  }

  return grounded
}

/**
 * Pure step-up decision (exported for tests): lift only when the flat slide
 * was truly blocked (kept under STEP_BLOCK_RATIO of its intended advance)
 * and the lifted slide actually got farther. All three are horizontal
 * distances in meters for one tick.
 */
export function stepUpWins(desired: number, flat: number, lifted: number): boolean {
  if (desired < STEP_MIN_INPUT) return false
  if (flat >= desired * STEP_BLOCK_RATIO) return false
  return lifted > flat + STEP_MIN_GAIN
}

const _moveStartPos = new Vector3()
const _moveStartVel = new Vector3()
const _stepPos = new Vector3()
const _stepVel = new Vector3()
const _snapPos = new Vector3()
const _snapVel = new Vector3()
const _flatNormal = new Vector3()

/**
 * One movement tick: integrate `pos` by `vel · dt`, resolve against the
 * colliders, and layer the two grounded-movement fixes on top:
 *
 * STEP OFFSET — when the slide was blocked horizontally while grounded, retry
 * from STEP_OFFSET higher and settle back down; if the lifted slide got
 * farther AND lands grounded (obstruction top within the offset, headroom
 * above — a ceiling that pushes the lifted probe back down aborts), commit it
 * and RESTORE the pre-move horizontal velocity: the step costs no speed.
 *
 * GROUND SNAP — a previously grounded, non-jumping mover that lost contact
 * (running down a ramp, float noise on slope-parallel motion) probes up to
 * GROUND_SNAP below and re-attaches; past a real edge the probe finds
 * nothing and the mover goes airborne exactly as before.
 *
 * Returns grounded. Extra resolve passes only run on blocked/detached
 * frames; the plain path costs exactly one collideCapsule, and everything
 * uses module temps (zero per-frame allocations).
 */
export function moveCapsule(
  pos: Vector3,
  vel: Vector3,
  dt: number,
  colliders: ColliderEntry[],
  wasGrounded: boolean,
  jumped: boolean,
  cfg: CapsuleConfig = PLAYER_CAPSULE,
  groundNormalOut?: Vector3,
): boolean {
  _moveStartPos.copy(pos)
  _moveStartVel.copy(vel)
  const desired = Math.hypot(vel.x, vel.z) * dt

  pos.addScaledVector(vel, dt)
  let grounded = collideCapsule(pos, vel, colliders, cfg, groundNormalOut)

  // STEP OFFSET: only for grounded movers with real horizontal intent.
  if (wasGrounded && !jumped && desired >= STEP_MIN_INPUT) {
    const flat = Math.hypot(pos.x - _moveStartPos.x, pos.z - _moveStartPos.z)
    if (flat < desired * STEP_BLOCK_RATIO) {
      if (groundNormalOut) _flatNormal.copy(groundNormalOut)
      _stepPos.copy(_moveStartPos)
      _stepPos.y += STEP_OFFSET
      _stepPos.addScaledVector(_moveStartVel, dt)
      _stepVel.copy(_moveStartVel)
      const liftedY = _stepPos.y
      collideCapsule(_stepPos, _stepVel, colliders, cfg)
      // Headroom: a ceiling that pushed the lifted probe back down means the
      // capsule can't stand on the step — abort before the settle.
      if (_stepPos.y >= liftedY - 1e-3) {
        // Settle back down in slices so the push-out resolves against the
        // step's TOP, not sideways out of a deep burial.
        let steppedGrounded = false
        for (let i = 0; i < SETTLE_SLICES && !steppedGrounded; i++) {
          _stepPos.y -= STEP_OFFSET / SETTLE_SLICES
          steppedGrounded = collideCapsule(_stepPos, _stepVel, colliders, cfg, groundNormalOut)
        }
        const lifted = Math.hypot(_stepPos.x - _moveStartPos.x, _stepPos.z - _moveStartPos.z)
        if (steppedGrounded && stepUpWins(desired, flat, lifted)) {
          pos.copy(_stepPos)
          // Lift-and-continue WITHOUT speed loss: the step never eats the
          // horizontal momentum the riser's face clipped away.
          vel.x = _moveStartVel.x
          vel.z = _moveStartVel.z
          vel.y = 0
          return true
        }
      }
      if (groundNormalOut) groundNormalOut.copy(_flatNormal)
    }
  }

  // GROUND SNAP: re-attach a grounded mover that only lost contact to
  // slope-parallel drift — never after a jump, never past a real drop.
  if (!grounded && wasGrounded && !jumped) {
    _snapPos.copy(pos)
    _snapVel.copy(vel)
    let snapped = false
    for (let i = 0; i < SETTLE_SLICES && !snapped; i++) {
      _snapPos.y -= GROUND_SNAP / SETTLE_SLICES
      snapped = collideCapsule(_snapPos, _snapVel, colliders, cfg, groundNormalOut)
    }
    if (snapped && _snapPos.y <= pos.y + 1e-4) {
      pos.copy(_snapPos)
      vel.copy(_snapVel)
      grounded = true
    } else if (groundNormalOut) {
      groundNormalOut.set(0, 1, 0)
    }
  }

  return grounded
}
