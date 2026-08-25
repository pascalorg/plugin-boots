/** Arcade arsenal — no reloads, no ammo scarcity, just rate and punch. */

export type WeaponDef = {
  id: 'knife' | 'pistol' | 'rifle' | 'minigun' | 'hammer'
  /** Shots (or swings) per second. */
  rate: number
  /** Hold-to-fire. Semi-auto requires a trigger release between shots. */
  auto: boolean
  damage: number
  /** Radius of the voxel sphere a hit carves out of a non-wall volume. */
  holeRadius: number
  /**
   * Carve radius for kind-'wall' targets only (drywall tears in big sheets,
   * so per-hit holes must read MASSIVE fast — pistol ≈ 0.9 m across).
   * shooting.ts resolves `tearRadius ?? holeRadius`; non-wall destructibles
   * always use holeRadius.
   */
  tearRadius?: number
  /** Radians of cone jitter. */
  spread: number
  range: number
  melee: boolean
  /** Camera kick per shot (radians of pitch). */
  kick: number
  /**
   * Seconds of held trigger before the first shot (rotary guns): barrels
   * accelerate and the whine rises, then fire runs at `rate`. Release spins
   * back down. Undefined = instant trigger like every other gun.
   */
  spinUp?: number
  /**
   * Melee SMASH carve radius (the warhammer): one blow crushes a
   * `smashRadius` sphere out of EVERY voxel target class — walls and plain
   * volumes alike — with the manager's ragged edge nibbles on top (≈ 36+
   * voxels at 0.55). Canonical resolution once shooting routes it:
   * `smashRadius ?? tearRadius ?? holeRadius` for walls,
   * `smashRadius ?? holeRadius` for the rest. Until that routing lands the
   * def mirrors the value into tearRadius (walls smash true) and rides a
   * hair under it in holeRadius (0.52 — the arsenal data invariant keeps
   * tear > drill for every def), so today's carve paths already smash at
   * ~the right size; once shooting reads smashRadius both lanes are exact.
   */
  smashRadius?: number
}

export const WEAPONS: Record<WeaponDef['id'], WeaponDef> = {
  knife: {
    id: 'knife',
    rate: 2.1,
    auto: true,
    damage: 45,
    holeRadius: 0.11,
    tearRadius: 0.3,
    spread: 0,
    range: 2.1,
    melee: true,
    kick: 0,
  },
  pistol: {
    id: 'pistol',
    rate: 5.5,
    auto: false,
    damage: 34,
    holeRadius: 0.16,
    tearRadius: 0.45,
    spread: 0.011,
    range: 90,
    melee: false,
    kick: 0.02,
  },
  rifle: {
    id: 'rifle',
    rate: 10.5,
    auto: true,
    damage: 24,
    holeRadius: 0.19,
    tearRadius: 0.55,
    spread: 0.028,
    range: 90,
    melee: false,
    kick: 0.011,
  },
  // The big one: near-continuous stream that levels a building by sweeping
  // it. Low per-bullet damage and a smaller per-bullet tear than the rifle,
  // but 24/s of them chews through anything; wide spread + tiny constant
  // kick sell the hose feel.
  minigun: {
    id: 'minigun',
    rate: 24,
    auto: true,
    damage: 10,
    holeRadius: 0.15,
    tearRadius: 0.34,
    spread: 0.045,
    range: 90,
    melee: false,
    kick: 0.004,
    spinUp: 0.45,
  },
  // Slot 6: the warhammer. One swing per ~1.1s through a two-phase
  // animation (viewmodel owns the 0.25s wind-up + 0.12s slam; the hit
  // lands at the slam, not on click). Crushes bots outright and smashes a
  // 0.55 m crater into anything voxel; `kick: 0` — the camera punch comes
  // from playerRig.shake at impact instead of a pitch kick.
  hammer: {
    id: 'hammer',
    rate: 0.9,
    auto: true,
    damage: 220,
    holeRadius: 0.52, // rides just under smashRadius (see the field doc)
    tearRadius: 0.55, // mirrors smashRadius (see the field doc)
    spread: 0,
    range: 2.6,
    melee: true,
    kick: 0,
    smashRadius: 0.55,
  },
}
