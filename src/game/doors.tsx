'use client'

/**
 * Doors grew into the full E-interact system (aim-based doors + windows +
 * cabinets) — the implementation lives in interact.tsx. This module keeps
 * the original mount point and debug handle names so game-root (and the
 * __boots.doors E2E surface) is untouched.
 */
export {
  Interact as Doors,
  interactDebug as doorsDebug,
} from './interact'
