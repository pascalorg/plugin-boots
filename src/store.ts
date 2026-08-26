import { create } from 'zustand'

export type WeaponId = 'knife' | 'pistol' | 'rifle' | 'minigun' | 'hammer' | 'builder'
export type BuildPiece = 'wall' | 'floor' | 'roof'

/** All nine cells of a piece's 3×3 grid alive (see PlacedPiece.mask). */
export const FULL_MASK = 0b111111111

/** A build-mode placement, in world space. Game-only until Keep converts it
 * into real scene nodes; Discard drops the list. */
export type PlacedPiece = {
  id: number
  piece: BuildPiece
  /** Center of the piece's footprint (y = base elevation). */
  position: [number, number, number]
  /** Yaw around Y, snapped to 90°. */
  yaw: number
  /** 9-bit build-battle cell mask — bit (col + row·3) set = cell alive.
   * Columns run along the piece's local +X (col 0 at −X); wall rows climb
   * (row 0 = bottom), floor/roof rows run along local +Z (row 0 at −Z —
   * a roof's LOW edge). 511 (FULL_MASK) = intact piece. Edited in-game
   * with the builder's F edit mode; Keep reads it to trim walls and
   * pocket windows/doors. */
  mask: number
}

export type BootsPhase = 'editor' | 'game'

type BootsState = {
  phase: BootsPhase
  /** Weapons picked up this session — knife is always owned. */
  owned: WeaponId[]
  weapon: WeaponId
  /** Rounds left in the clip, by weapon. */
  clip: Record<string, number>
  reloading: boolean
  health: number
  /** True while the player is in the 2.5s "downed but not dead" stagger
   * (health hit 0). Player movement halves, viewmodel droops, firing is
   * blocked. Set/cleared by player.tsx's stagger loop. */
  staggered: boolean
  buildPiece: BuildPiece
  /** Pieces placed in build mode this session (or awaiting Keep/Discard). */
  placed: PlacedPiece[]
  /** True right after a session that placed pieces — the panel offers Keep/Discard. */
  pendingDecision: boolean

  setPhase: (phase: BootsPhase) => void
  giveWeapon: (weapon: WeaponId) => void
  setWeapon: (weapon: WeaponId) => void
  setClip: (weapon: WeaponId, rounds: number) => void
  setReloading: (reloading: boolean) => void
  setHealth: (health: number) => void
  setStaggered: (staggered: boolean) => void
  setBuildPiece: (piece: BuildPiece) => void
  addPlaced: (piece: Omit<PlacedPiece, 'id' | 'mask'> & { mask?: number }) => void
  /** Replace one placed piece's 9-bit cell mask (builder F edit mode).
   * The piece object is swapped, so its mesh + collider re-register. */
  setPlacedMask: (id: number, mask: number) => void
  /** Rebuild one placed piece AS another piece type (edit-exit transform,
   * e.g. a stair-silhouette wall mask folding into a ramp). Position, id
   * and list order are preserved; the mask resets to FULL_MASK. The piece
   * object is swapped, so its mesh + collider + voxel replica re-register.
   * Callers guard the target pose with isOccupied first. */
  transformPlaced: (id: number, piece: BuildPiece, yaw: number) => void
  removeLastPlaced: () => PlacedPiece | undefined
  resolvePlaced: () => void
  setPendingDecision: (pending: boolean) => void
  resetSession: () => void
}

let placedId = 1

export const useBoots = create<BootsState>((set, get) => ({
  phase: 'editor',
  owned: ['knife'],
  weapon: 'knife',
  clip: {},
  reloading: false,
  health: 100,
  staggered: false,
  buildPiece: 'wall',
  placed: [],
  pendingDecision: false,

  setPhase: (phase) => set({ phase }),
  giveWeapon: (weapon) =>
    set((s) => (s.owned.includes(weapon) ? s : { owned: [...s.owned, weapon] })),
  setWeapon: (weapon) => set({ weapon }),
  setClip: (weapon, rounds) => set((s) => ({ clip: { ...s.clip, [weapon]: rounds } })),
  setReloading: (reloading) => set({ reloading }),
  setHealth: (health) => set({ health }),
  setStaggered: (staggered) => set({ staggered }),
  setBuildPiece: (buildPiece) => set({ buildPiece }),
  addPlaced: (piece) =>
    set((s) => ({
      placed: [...s.placed, { mask: FULL_MASK, ...piece, id: placedId++ }],
    })),
  setPlacedMask: (id, mask) =>
    set((s) => ({
      placed: s.placed.map((p) => (p.id === id ? { ...p, mask: mask & FULL_MASK } : p)),
    })),
  transformPlaced: (id, piece, yaw) =>
    set((s) => ({
      placed: s.placed.map((p) => (p.id === id ? { ...p, piece, yaw, mask: FULL_MASK } : p)),
    })),
  removeLastPlaced: () => {
    const s = get()
    const last = s.placed[s.placed.length - 1]
    if (last) set({ placed: s.placed.slice(0, -1) })
    return last
  },
  resolvePlaced: () => set({ placed: [], pendingDecision: false }),
  setPendingDecision: (pendingDecision) => set({ pendingDecision }),
  resetSession: () =>
    set({
      owned: ['knife'],
      weapon: 'knife',
      clip: {},
      reloading: false,
      health: 100,
      staggered: false,
      buildPiece: 'wall',
    }),
}))
