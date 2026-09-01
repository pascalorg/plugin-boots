import bootsIcon from './assets/boots-icon.webp'
import bootsLoader from './assets/boots-loader.webp'

/**
 * BOOTS BRAND. The name stayed; every pixel of the art is new, and all of it is
 * Pascaline — the editor's official mascot, hard hat with the Pascal logotype,
 * tool belt, tan work boots (which is why the name still fits). Frames come
 * straight from the official render pack via docs/brand/build-brand-assets.py,
 * so the plugin can never drift off-model.
 *
 * Next static image imports are `{ src, width, height }`; hosts and raw DOM
 * both want the URL string, so that is what these export.
 */

/** The square badge: the rail entry (20×20 in the host) and the panel header.
 * The FILENAME is load-bearing — docs/qa/qa-boots-roster.mjs finds the rail
 * entry by `img[src*="boots-icon"]`, the only thing in that DOM naming Boots. */
export const BOOTS_ICON: string = bootsIcon.src

/** The loading hero — an ANIMATED WebP (24 frames, 1.92 s, loop-exact) that
 * sits above the loading bar in both loading surfaces: the in-game card
 * (game/hud.ts) and the share-link veil (game/drop-gate.tsx). */
export const BOOTS_LOADER: string = bootsLoader.src
