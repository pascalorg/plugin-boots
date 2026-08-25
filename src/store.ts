import { create } from 'zustand'

export type WeaponId = 'knife' | 'pistol' | 'rifle' | 'builder'
export type BuildPiece = 'wall' | 'floor' | 'ramp'

/** A build-mode placement, in world space. Game-only until Keep converts it
 * into real scene nodes; Discard drops the list. */
export type PlacedPiece = {
  id: number
  piece: BuildPiece
  /** Center of the piece's footprint (y = base elevation). */
  position: [number, number, number]
  /** Yaw around Y, snapped to 90°. */
  yaw: number
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
  setBuildPiece: (piece: BuildPiece) => void
  addPlaced: (piece: Omit<PlacedPiece, 'id'>) => void
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
  setBuildPiece: (buildPiece) => set({ buildPiece }),
  addPlaced: (piece) => set((s) => ({ placed: [...s.placed, { ...piece, id: placedId++ }] })),
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
      buildPiece: 'wall',
    }),
}))
