'use client'

import { useState } from 'react'
import { useBoots } from './store'
import { discardPlaced, keepPlaced } from './game/keep'
import { enterGame } from './game/session'

/**
 * The Boots left-rail panel. One big verb: Jump in — the whole editor
 * becomes a game. After a session where you built pieces, the panel offers
 * to keep them (converted into real walls) or discard everything.
 */
export default function BootsPanel() {
  const pendingDecision = useBoots((s) => s.pendingDecision)
  const placed = useBoots((s) => s.placed)
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

      {pendingDecision && placed.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border border-sidebar-border/60 p-3">
          <p className="text-xs leading-relaxed">
            You built <span className="font-semibold">{placed.length}</span> piece
            {placed.length > 1 ? 's' : ''} in-game
            {wallCount > 0 ? ` (${wallCount} wall${wallCount > 1 ? 's' : ''} can become real)` : ''}
            .
          </p>
          <div className="flex gap-2">
            <button
              className="flex-1 rounded-md bg-sidebar-accent px-2 py-1.5 font-semibold text-xs hover:bg-sidebar-accent/80"
              onClick={() => {
                const result = keepPlaced()
                setLastKept(
                  `Kept ${result.kept} wall${result.kept === 1 ? '' : 's'}${
                    result.skipped > 0 ? ` — ${result.skipped} piece(s) had no node type yet` : ''
                  }`,
                )
              }}
              type="button"
            >
              Keep{wallCount > 0 ? ` ${wallCount} wall${wallCount > 1 ? 's' : ''}` : ''}
            </button>
            <button
              className="flex-1 rounded-md border border-sidebar-border/60 px-2 py-1.5 text-xs hover:bg-sidebar-accent/60"
              onClick={() => {
                discardPlaced()
                setLastKept('Discarded')
              }}
              type="button"
            >
              Discard
            </button>
          </div>
          {otherCount > 0 && (
            <p className="text-[11px] text-sidebar-foreground/40">
              Floors & ramps stay game-only for now.
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
        <p>Mouse shoot · E gear up at the table</p>
        <p>Peaceful until you grab a gun — then a five-second countdown, and the machines come in waves.</p>
        <p>1 knife · 2 pistol · 3 rifle · 4/B build</p>
        <p>Q cycle piece · hold click to place a run · G undo · Esc exit</p>
        <p>Pieces snap to what you've placed — look up to stack walls.</p>
        <p>You can't die — you get staggered. The machines back off; shake it off and keep going.</p>
      </section>
    </div>
  )
}
