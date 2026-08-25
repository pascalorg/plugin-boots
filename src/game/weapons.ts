/** Arcade arsenal — no reloads, no ammo scarcity, just rate and punch. */

export type WeaponDef = {
  id: 'knife' | 'pistol' | 'rifle'
  /** Shots (or swings) per second. */
  rate: number
  /** Hold-to-fire. Semi-auto requires a trigger release between shots. */
  auto: boolean
  damage: number
  /** Radius of the voxel sphere a hit carves out of a wall. */
  holeRadius: number
  /** Radians of cone jitter. */
  spread: number
  range: number
  melee: boolean
  /** Camera kick per shot (radians of pitch). */
  kick: number
}

export const WEAPONS: Record<WeaponDef['id'], WeaponDef> = {
  knife: {
    id: 'knife',
    rate: 2.1,
    auto: true,
    damage: 45,
    holeRadius: 0.11,
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
    spread: 0.028,
    range: 90,
    melee: false,
    kick: 0.011,
  },
}
