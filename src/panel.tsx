'use client'

import * as pascalCore from '@pascal-app/core'
import { useScene } from '@pascal-app/core'

/** Newer hosts export runAsSingleSceneHistoryStep (collapses every scene
 * mutation inside `run` into ONE undo step). The plugin's pinned core
 * typings (0.9.1) predate it, so resolve it defensively — an older host
 * just keeps today's multi-step behavior. */
const runAsOneHistoryStep = <T,>(run: () => T): T => {
  const step = (
    pascalCore as { runAsSingleSceneHistoryStep?: (store: unknown, run: () => T) => T }
  ).runAsSingleSceneHistoryStep
  return step ? step(useScene, run) : run()
}
import { useState } from 'react'
import { useBoots } from './store'
import { applyItems, discardItems } from './game/item-keep'
import { useItems } from './game/item-place'
import { discardPlaced, keepPlaced } from './game/keep'
import { applyPaint, discardPaint, usePaintKeep } from './game/paint-keep'
import { deleteDestroyed, discardDemolition, useDemolition } from './game/save-demolition'
import { enterGame } from './game/session'

/**
 * The Boots left-rail panel. One big verb: Jump in — the whole editor
 * becomes a game. After a session where you built pieces, the panel offers
 * to keep them (converted into real wall / roof-segment / slab nodes) or
 * discard everything.
 */
export default function BootsPanel() {
  const pendingDecision = useBoots((s) => s.pendingDecision)
  const placed = useBoots((s) => s.placed)
  const destroyed = useDemolition((s) => s.destroyed)
  const painted = usePaintKeep((s) => s.painted)
  const placedItems = useItems((s) => s.items)
  const [lastKept, setLastKept] = useState<string | null>(null)

  const wallCount = placed.filter((p) => p.piece === 'wall').length
  const otherCount = placed.length - wallCount

  return (
    <div className="flex flex-col gap-4 p-4 text-sidebar-foreground">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-base">Boots</h2>
          <span className="rounded-full border border-sidebar-border/60 bg-sidebar-accent px-1.5 py-px font-semibold text-[9px] text-sidebar-foreground/70 uppercase tracking-widest">
            Alpha
          </span>
        </div>
        <p className="text-sidebar-foreground/50 text-xs leading-relaxed">
          Just like Bones, it's alpha. Make sure your building can resist robot zombie attacks.
        </p>
      </header>

      <button
        className="flex w-full items-center justify-center gap-2 rounded-md bg-sidebar-accent px-3 py-2 font-semibold text-sm hover:bg-sidebar-accent/80"
        onClick={() => {
          setLastKept(null)
          enterGame()
        }}
        type="button"
      >
        ⏵ Jump in
      </button>

      {pendingDecision &&
        (placed.length > 0 ||
          destroyed.length > 0 ||
          painted.length > 0 ||
          placedItems.length > 0) && (
        <section className="flex flex-col gap-2 rounded-md border border-sidebar-border/60 p-3">
          <p className="text-[11px] text-sidebar-foreground/50 leading-relaxed">
            Nothing was saved while you played — shooting, breaking, all of it stays in the game.
            Only the button below writes anything, and Discard leaves your building exactly as it
            was.
          </p>
          <p className="text-xs leading-relaxed">
            You built <span className="font-semibold">{placed.length}</span> piece
            {placed.length > 1 ? 's' : ''} in-game
            {wallCount > 0 ? ` (${wallCount} wall${wallCount > 1 ? 's' : ''} can become real)` : ''}
            .
          </p>
          {destroyed.length > 0 && (
            <p className="text-xs leading-relaxed">
              You fully leveled <span className="font-semibold">{destroyed.length}</span> building
              element{destroyed.length > 1 ? 's' : ''} — saving deletes {destroyed.length > 1 ? 'them' : 'it'} from
              the building (undoable). Partially damaged walls always stay intact.
            </p>
          )}
          {painted.length > 0 && (
            <p className="text-xs leading-relaxed">
              You painted <span className="font-semibold">{painted.length}</span> building
              element{painted.length > 1 ? 's' : ''} — saving recolors {painted.length > 1 ? 'them' : 'it'} to
              {painted.length > 1 ? ' their' : ' its'} dominant coat (undoable).
            </p>
          )}
          {placedItems.length > 0 && (
            <p className="text-xs leading-relaxed">
              You placed <span className="font-semibold">{placedItems.length}</span> catalog item
              {placedItems.length > 1 ? 's' : ''} — saving adds {placedItems.length > 1 ? 'them' : 'it'} for
              real (furniture, doors and windows — undoable).
            </p>
          )}
          <div className="flex gap-2">
            <button
              className="flex-1 rounded-md bg-sidebar-accent px-2 py-1.5 font-semibold text-xs hover:bg-sidebar-accent/80"
              onClick={() => {
                // ONE history step for the whole save: every bridge write
                // (kept pieces, demolition deletes, paint patches, item
                // creates — several store actions) collapses into a single
                // Cmd+Z in the editor. Without this a saved roof alone was
                // two undo steps (container + segment).
                const { result, removed, repainted, itemsResult } = runAsOneHistoryStep(() => {
                  const result = keepPlaced()
                  const removed = deleteDestroyed()
                  // Paint applies AFTER the demolition delete so nodes
                  // removed just above are skipped instead of patched.
                  const repainted = applyPaint()
                  const itemsResult = applyItems()
                  return { result, removed, repainted, itemsResult }
                })
                // `kept` counts every converted piece; roofs and floors are
                // also tallied separately, so walls = the remainder.
                const walls = result.kept - result.roofs - result.floors
                const extras = [
                  result.roofs > 0 ? `${result.roofs} roof${result.roofs === 1 ? '' : 's'}` : '',
                  result.floors > 0 ? `${result.floors} floor${result.floors === 1 ? '' : 's'}` : '',
                  result.windows > 0 ? `${result.windows} window${result.windows === 1 ? '' : 's'}` : '',
                  result.doors > 0 ? `${result.doors} door${result.doors === 1 ? '' : 's'}` : '',
                ]
                  .filter(Boolean)
                  .join(', ')
                setLastKept(
                  `Kept ${walls} wall${walls === 1 ? '' : 's'}${extras ? ` + ${extras}` : ''}${
                    removed > 0 ? ` · deleted ${removed} leveled element${removed === 1 ? '' : 's'}` : ''
                  }${repainted > 0 ? ` · repainted ${repainted}` : ''}${
                    itemsResult.kept > 0 ? ` · placed ${itemsResult.kept} item(s)` : ''
                  }${
                    result.skipped + itemsResult.skipped > 0
                      ? ` — ${result.skipped + itemsResult.skipped} piece(s) had no node type yet`
                      : ''
                  }`,
                )
              }}
              type="button"
            >
              Save changes
            </button>
            <button
              className="flex-1 rounded-md border border-sidebar-border/60 px-2 py-1.5 text-xs hover:bg-sidebar-accent/60"
              onClick={() => {
                discardPlaced()
                discardDemolition()
                discardPaint()
                discardItems()
                setLastKept('Discarded — your building is exactly as it was')
              }}
              type="button"
            >
              Discard all
            </button>
          </div>
          {otherCount > 0 && (
            <p className="text-[11px] text-sidebar-foreground/40">
              Roofs try to become real roof segments; floors try to become real slabs (full slabs
              only for now — 3×3 partial edits are deferred).
            </p>
          )}
        </section>
      )}
      {lastKept && <p className="text-[11px] text-sidebar-foreground/50">{lastKept}</p>}

      <section className="flex flex-col gap-1 text-[11px] text-sidebar-foreground/50 leading-relaxed">
        <p className="font-semibold text-sidebar-foreground/70 uppercase tracking-wider text-[10px]">
          Controls
        </p>
        <p>WASD move · Space jump · Shift walk</p>
        <p>Mouse shoot · E gear up at the depot (behind you at spawn)</p>
        <p>
          Peaceful for as long as you like — grab guns, build, nothing comes. Face the breaker on
          the depot's end wall from outside and press E: the countdown starts and the machines come
          in waves. E again throws it back up and calls the whole thing off.
        </p>
        <p>1 knife · 2 pistol · 3 rifle · 4/B build · 5 the big one · 6 hammer · 7 paint</p>
        <p>RMB aim (pistol/rifle) · Q or Z/X/C/V pick piece · R cycles paint color · Esc exit</p>
        <p>
          Pieces lock to the grid — look up to build the ceiling above you, R rotates (walls flip
          sides, stairs turn, roofs cycle shapes), run up your stairs while holding click to chain
          them, U undo, G grenade.
        </p>
        <p>
          I opens the item catalog — place couches and appliances in your fort; the openings tab
          snaps doors and windows onto real walls.
        </p>
        <p>
          F edits a placed piece — 3×3 cells on walls and floors (pocket the middle for a window),
          corner heights on roofs (raise or drop corners for slopes, valleys and flat caps).
        </p>
        <p>You can't die — you get staggered. The machines back off; shake it off and keep going.</p>
      </section>
    </div>
  )
}
