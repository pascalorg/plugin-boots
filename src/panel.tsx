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
import { useEffect, useState } from 'react'
import { BOOTS_ICON } from './art'
import { type BuildPiece, type PlacedPiece, useBoots } from './store'
import { isForeignPlacedPiece } from './game/builder'
import { applyItems, discardItems } from './game/item-keep'
import { isForeignItemPlacement, type Placement, useItems } from './game/item-place'
import { discardPlaced, keepPlaced } from './game/keep'
import { applyPaint, discardPaint, type PaintedNode, usePaintKeep } from './game/paint-keep'
import { persistPendingChanges } from './game/pending-lanes'
import {
  deleteDestroyed,
  type DestroyedNode,
  discardDemolition,
  useDemolition,
} from './game/save-demolition'
import { beginEntry } from './game/mic-gate'
import { enterGame } from './game/session'
import { releaseMic, setVoiceMode, voiceMode } from './game/voice'
import type { VoiceMode } from './game/voice-policy'
import {
  onRosterChange,
  roster,
  type RosterEntry,
  ROSTER_POLL_MS,
  rosterMessage,
  rosterSignature,
} from './game/roster'
import {
  copyText,
  currentDropInUrl,
  getShareBridge,
  playTogetherIntro,
  publishProject,
  shareMessage,
  shareMessageTone,
  type ShareReach,
  shareReach,
  type ShareState,
  shareVisibility,
  showsPrivateWarning,
} from './game/share-link'

// ── The pending-changes list ────────────────────────────────────────────────
//
// Between Esc and the decision, the rail lists WHAT is pending: one row per
// piece built, per element leveled, per element painted, per catalog item
// (owner call 2026-08-30 — "I want to see all the ramps I placed, all the
// paints I did", not four counts).
//
// It is a VIEW. No per-row toggle, no selection: Save still writes everything
// and Discard still drops everything, one button each. The rows read the boots
// stores that already survive the Esc, plus host node NAMES — a read of the
// scene store, never a write. The four Save bridges stay the only writers.

/** Visible rows per lane before the rest folds into a "+N more" line. The rail
 * is narrow and a long session would push the buttons off the bottom of the
 * sidebar. Never a silent truncation — the remainder is always printed. */
const ROW_CAP = 5

/** What the player calls each build piece. The store's 'stairs' is the
 * walkable tilted plank; in the fort-builder genre — and in the owner's own
 * words for this list — that piece is a RAMP, so that is what its row says. */
const PIECE_LABEL: Record<BuildPiece, string> = {
  wall: 'Wall',
  stairs: 'Ramp',
  floor: 'Floor',
  roof: 'Roof',
}

/** Row order for the Built lane. Grouping by kind is what keeps the cap
 * honest: a session with 30 walls and 3 ramps must still SHOW the ramps, and
 * one chronological cap would have hidden them behind the walls. */
const PIECE_ORDER: readonly BuildPiece[] = ['wall', 'stairs', 'floor', 'roof']

/** One decimal, no trailing zero, no unit noise — these numbers sit in a
 * narrow rail next to a word. */
const meters = (v: number): string => String(Math.round(v * 10) / 10)

/** "x 4.5, z -1.5" — roughly where it stands, in the world coordinates the
 * editor already shows. Elevation only when it is off the ground floor: most
 * sessions build at y 0 and a third number would be noise. */
const spot = (position: readonly [number, number, number]): string =>
  `x ${meters(position[0])}, z ${meters(position[2])}${
    Math.abs(position[1]) >= 0.05 ? `, y ${meters(position[1])}` : ''
  }`

/**
 * A friendly name for a host node — exported for tests.
 *
 * The demolition and paint lanes carry only a `nodeId`, so the label comes
 * from the scene store: the node's own `name` when the owner gave it one,
 * otherwise its type read as words ('roof-segment' → 'Roof segment'). A node
 * that is GONE (deleted between Esc and the click) falls back to the caller's
 * own word for it and reports `missing`, so the row can say plainly that Save
 * has nothing left to do there. A raw node id is never the label.
 */
export function nodeLabel(
  nodes: Readonly<Record<string, unknown>>,
  nodeId: string,
  fallback: string,
): { label: string; missing: boolean } {
  const node = nodes[nodeId] as { name?: string; type?: string } | undefined
  if (!node) return { label: fallback, missing: true }
  const name = node.name?.trim()
  if (name) return { label: name, missing: false }
  const type = node.type?.trim()
  if (!type) return { label: fallback, missing: false }
  const words = type.replace(/[-_]+/g, ' ')
  return { label: `${words.charAt(0).toUpperCase()}${words.slice(1)}`, missing: false }
}

/** One line of the list. `swatch` is a hex (paint lane); `more` marks the
 * "+N more" tail of a capped lane. */
export type PendingRow = {
  key: string
  label: string
  detail?: string
  swatch?: string
  more?: boolean
}

/** One lane: heading, its rows, and the honest caveat about what Save does to
 * them. An empty lane produces no group at all — the caller renders nothing. */
export type PendingGroup = {
  key: 'built' | 'leveled' | 'painted' | 'placed'
  title: string
  count: number
  rows: PendingRow[]
  caveat: string
}

/**
 * The four lanes, as rows — pure, and exported because this is the behavior
 * worth pinning: which rows appear for which store contents, how a node with
 * no name (or no node at all) reads, and where the cap folds.
 *
 * READ-ONLY BY CONSTRUCTION: it takes the stores' contents and a snapshot of
 * the scene nodes and returns strings. Nothing here can write the document.
 */
export function pendingChangeGroups(input: {
  placed: readonly PlacedPiece[]
  destroyed: readonly DestroyedNode[]
  painted: readonly PaintedNode[]
  items: readonly Placement[]
  nodes: Readonly<Record<string, unknown>>
}): PendingGroup[] {
  const { placed, destroyed, painted, items, nodes } = input
  const groups: PendingGroup[] = []

  if (placed.length > 0) {
    const rows: PendingRow[] = []
    for (const kind of PIECE_ORDER) {
      const ofKind = placed.filter((piece) => piece.piece === kind)
      if (ofKind.length === 0) continue
      for (const piece of ofKind.slice(0, ROW_CAP)) {
        rows.push({
          key: `piece-${piece.id}`,
          label: PIECE_LABEL[kind],
          detail: spot(piece.position),
        })
      }
      const hidden = ofKind.length - ROW_CAP
      if (hidden > 0) {
        rows.push({
          key: `more-${kind}`,
          label: `+${hidden} more ${PIECE_LABEL[kind].toLowerCase()}s`,
          more: true,
        })
      }
    }
    // The non-wall caveat is the panel's oldest honest small print, kept
    // verbatim — and now it names ramps too, because they have rows of their
    // own and keep.ts maps them onto the same shed roof segment.
    const others = placed.some((piece) => piece.piece !== 'wall')
    groups.push({
      key: 'built',
      title: 'Built',
      count: placed.length,
      rows,
      caveat: `Saving turns these into real nodes (undoable).${
        others
          ? ' Ramps and roofs try to become real roof segments; floors try to become real slabs (full slabs only for now — 3×3 partial edits are deferred).'
          : ''
      }`,
    })
  }

  if (destroyed.length > 0) {
    const rows: PendingRow[] = destroyed.slice(0, ROW_CAP).map((node) => {
      const fallback = node.kind === 'wall' ? 'Wall' : 'Volume'
      const { label, missing } = nodeLabel(nodes, node.nodeId, fallback)
      return { key: `leveled-${node.nodeId}`, label, detail: missing ? 'already gone' : 'deleted' }
    })
    if (destroyed.length > ROW_CAP) {
      rows.push({
        key: 'more-leveled',
        label: `+${destroyed.length - ROW_CAP} more leveled`,
        more: true,
      })
    }
    groups.push({
      key: 'leveled',
      title: 'Leveled',
      count: destroyed.length,
      rows,
      caveat: `Saving deletes ${
        destroyed.length > 1 ? 'them' : 'it'
      } from the building (undoable). Partially damaged walls always stay intact.`,
    })
  }

  if (painted.length > 0) {
    const rows: PendingRow[] = painted.slice(0, ROW_CAP).map((node) => {
      const { label, missing } = nodeLabel(nodes, node.nodeId, 'Building element')
      return {
        key: `painted-${node.nodeId}`,
        label,
        detail: missing ? 'already gone' : node.colorName,
        swatch: node.color,
      }
    })
    if (painted.length > ROW_CAP) {
      rows.push({
        key: 'more-painted',
        label: `+${painted.length - ROW_CAP} more painted`,
        more: true,
      })
    }
    groups.push({
      key: 'painted',
      title: 'Painted',
      count: painted.length,
      rows,
      caveat: `Saving recolors ${painted.length > 1 ? 'them' : 'it'} to ${
        painted.length > 1 ? 'their' : 'its'
      } dominant coat (undoable) — the splatter art itself stays in the game.`,
    })
  }

  if (items.length > 0) {
    const rows: PendingRow[] = items.slice(0, ROW_CAP).map((item) => {
      if (item.kind === 'item') {
        return {
          key: `item-${item.id}`,
          label: item.asset.name || 'Item',
          detail: spot(item.position),
        }
      }
      // An opening is wall-hosted: WHICH wall is the useful detail, and a wall
      // that got leveled in the session is one Save will skip.
      const { label, missing } = nodeLabel(nodes, item.wallId, 'a wall')
      return {
        key: `item-${item.id}`,
        label: item.def.name,
        detail: missing ? 'wall is gone' : `on ${label}`,
      }
    })
    if (items.length > ROW_CAP) {
      rows.push({ key: 'more-items', label: `+${items.length - ROW_CAP} more items`, more: true })
    }
    groups.push({
      key: 'placed',
      title: 'Placed',
      count: items.length,
      rows,
      caveat: `Saving adds ${
        items.length > 1 ? 'them' : 'it'
      } for real (furniture, doors and windows — undoable).`,
    })
  }

  return groups
}

/** One pending change. `swatch` is a hex — the paint lane's colour has to be
 * SEEN, and an inline background is the only way to paint an arbitrary hex
 * (no new styling approach, no UI library). */
function Row({ label, detail, swatch }: { label: string; detail?: string; swatch?: string }) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-[11px] leading-snug">
      <span className="flex min-w-0 items-baseline gap-1.5">
        {swatch && (
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-sm border border-sidebar-border/60"
            style={{ backgroundColor: swatch }}
          />
        )}
        <span className="truncate">{label}</span>
      </span>
      {detail && <span className="shrink-0 text-sidebar-foreground/40">{detail}</span>}
    </li>
  )
}

/** The tail of a capped lane. Says the number out loud — a list that hid rows
 * silently would be exactly the thing this whole section replaces. */
function MoreRow({ text }: { text: string }) {
  return <li className="text-[11px] text-sidebar-foreground/40 leading-snug">{text}</li>
}

/** A lane's heading — the section's own uppercase idiom, plus the count. */
function GroupHeading({ title, count }: { title: string; count: number }) {
  return (
    <p className="font-semibold text-[10px] text-sidebar-foreground/70 uppercase tracking-wider">{`${title} · ${count}`}</p>
  )
}

/** The list itself: pure presentation over pendingChangeGroups. Split from the
 * panel so it can be rendered — and read — without a store behind it. */
export function PendingChanges({ groups }: { groups: readonly PendingGroup[] }) {
  return (
    <>
      {groups.map((group) => (
        <div className="flex flex-col gap-1" key={group.key}>
          <GroupHeading count={group.count} title={group.title} />
          <ul className="flex flex-col gap-px">
            {group.rows.map((row) =>
              row.more ? (
                <MoreRow key={row.key} text={row.label} />
              ) : (
                <Row detail={row.detail} key={row.key} label={row.label} swatch={row.swatch} />
              ),
            )}
          </ul>
          <p className="text-[11px] text-sidebar-foreground/40 leading-relaxed">{group.caveat}</p>
        </div>
      ))}
    </>
  )
}

/**
 * The Save bridges + the history-step wrapper, injectable ONLY so a test can
 * pin the call ORDER (paint must apply after the demolition delete, so removed
 * nodes are skipped instead of patched) and that all four sit inside the one
 * history step. Nothing in the product ever passes an argument.
 */
export type SaveBridges = {
  keepPlaced: typeof keepPlaced
  deleteDestroyed: typeof deleteDestroyed
  applyPaint: typeof applyPaint
  applyItems: typeof applyItems
  runStep: <T>(run: () => T) => T
  /** Re-writes the durable pending window — which, the lanes now being empty,
   * DELETES it. Part of the bridge set rather than the click handler on
   * purpose: a Save that wrote real nodes and left the stored window behind
   * would resurrect the whole decision on the next load, on top of the nodes
   * it just created. It has to be impossible to forget. */
  persist: typeof persistPendingChanges
  /** Can the document be written at all? Required, not optional: every bridge
   * below no-ops on a read-only store and then clears its captures anyway, so
   * a bridge set that forgot to answer this would print a receipt for a save
   * that never happened. */
  writable: () => boolean
}

const LIVE_SAVE: SaveBridges = {
  keepPlaced,
  deleteDestroyed,
  applyPaint,
  applyItems,
  persist: persistPendingChanges,
  runStep: runAsOneHistoryStep,
  writable: () => !(useScene.getState() as unknown as { readOnly?: boolean }).readOnly,
}

/**
 * Save: write everything the list promised and return the receipt line the
 * panel prints under the buttons.
 *
 * ONE history step for the whole save: every bridge write (kept pieces,
 * demolition deletes, paint patches, item creates — several store actions)
 * collapses into a single Cmd+Z in the editor. Without this a saved roof alone
 * was two undo steps (container + segment).
 */
export function saveSessionChanges(bridges: SaveBridges = LIVE_SAVE): string {
  // NOTHING IS ATTEMPTED ON A DOCUMENT THAT REFUSES WRITES. Every bridge
  // no-ops on `readOnly` — the host's node actions guard internally — and then
  // clears its own captures, so running them here would print a full receipt
  // ("Kept 4 walls · repainted 7") for a scene that changed in no way, and the
  // session's work would be gone with the captures. Refuse instead and keep
  // everything pending: the read-only lease is not always permanent, so the
  // same button works once it is released.
  if (!bridges.writable()) {
    return 'Nothing saved — this project is read-only right now. Your changes are still pending.'
  }
  const { result, removed, repainted, itemsResult } = bridges.runStep(() => {
    const result = bridges.keepPlaced()
    const removed = bridges.deleteDestroyed()
    // Paint applies AFTER the demolition delete so nodes removed just above
    // are skipped instead of patched.
    const repainted = bridges.applyPaint()
    const itemsResult = bridges.applyItems()
    return { result, removed, repainted, itemsResult }
  })
  // Outside the history step: browser storage is not part of the document and
  // has no business inside an undo batch.
  bridges.persist()
  // `kept` counts every converted piece; roofs and floors are also tallied
  // separately, so walls = the remainder.
  const walls = result.kept - result.roofs - result.floors
  const extras = [
    result.roofs > 0 ? `${result.roofs} roof${result.roofs === 1 ? '' : 's'}` : '',
    result.floors > 0 ? `${result.floors} floor${result.floors === 1 ? '' : 's'}` : '',
    result.windows > 0 ? `${result.windows} window${result.windows === 1 ? '' : 's'}` : '',
    result.doors > 0 ? `${result.doors} door${result.doors === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  return `Kept ${walls} wall${walls === 1 ? '' : 's'}${extras ? ` + ${extras}` : ''}${
    removed > 0 ? ` · deleted ${removed} leveled element${removed === 1 ? '' : 's'}` : ''
  }${repainted > 0 ? ` · repainted ${repainted}` : ''}${
    itemsResult.kept > 0 ? ` · placed ${itemsResult.kept} item(s)` : ''
  }${
    result.skipped + itemsResult.skipped > 0
      ? ` — ${result.skipped + itemsResult.skipped} piece(s) had no node type yet`
      : ''
  }`
}

export type DiscardBridges = {
  discardPlaced: typeof discardPlaced
  discardDemolition: typeof discardDemolition
  discardPaint: typeof discardPaint
  discardItems: typeof discardItems
  /** Same reason as the Save side: the stored window has to go too, or the
   * next load offers a decision the player already made. */
  persist: typeof persistPendingChanges
}

const LIVE_DISCARD: DiscardBridges = {
  discardPlaced,
  discardDemolition,
  discardPaint,
  discardItems,
  persist: persistPendingChanges,
}

/** Discard: drop all four lanes and touch nothing in the document. Same
 * injectable-for-tests shape as Save; the product never passes an argument. */
export function discardSessionChanges(bridges: DiscardBridges = LIVE_DISCARD): string {
  bridges.discardPlaced()
  bridges.discardDemolition()
  bridges.discardPaint()
  bridges.discardItems()
  bridges.persist()
  return 'Discarded — your building is exactly as it was'
}

// ── Share link ──────────────────────────────────────────────────────────────
//
// One link, and a friend is standing next to you (owner call 2026-08-31). The
// button copies the drop-in URL for THIS page; all of the thinking lives in
// game/share-link.ts, pure and tested, so this is only the markup plus three
// handlers.
//
// It appears twice in the rail — once under Jump in, once under the Controls —
// because that is where he asked for it. Two instances, two independent bits
// of local state: whichever one you click is the one that answers you, and a
// stale "copied" from the other end of the sidebar never sits there implying
// something happened just now.

/** Shared button skin with Jump in, one weight down. */
const SHARE_BUTTON =
  'flex w-full items-center justify-center gap-2 rounded-md border border-sidebar-border/60 px-3 py-2 font-semibold text-xs hover:bg-sidebar-accent/60'

export function ShareLink() {
  const [state, setState] = useState<ShareState>({ kind: 'idle' })

  // The owner can also flip visibility from the host's own navbar while our
  // warning is on screen. When that happens the warning is simply wrong, so
  // re-read the bridge instead of leaving it up until the next click.
  useEffect(() => {
    const bridge = getShareBridge()
    if (!bridge) return
    return bridge.subscribe(() => {
      setState((prev) => {
        if (prev.kind !== 'copied' && prev.kind !== 'manual') return prev
        const live = getShareBridge()
        const visibility = shareVisibility(live)
        const reach = shareReach(live)
        if (visibility === prev.visibility && reach === prev.reach) return prev
        return { ...prev, reach, visibility }
      })
    })
  }, [])

  const copy = async () => {
    const url = currentDropInUrl()
    if (!url) {
      setState({ kind: 'no-link' })
      return
    }
    // Snapshot the visibility BEFORE the await: the warning has to describe
    // the project the link points at, not whatever the host reports a tick
    // later.
    const bridge = getShareBridge()
    const visibility = shareVisibility(bridge)
    const reach = shareReach(bridge)
    const copied = await copyText(url)
    setState({ kind: copied ? 'copied' : 'manual', reach, url, visibility })
  }

  const publish = async (url: string) => {
    setState({ kind: 'publishing', url })
    setState(await publishProject(getShareBridge(), url))
  }

  const message = shareMessage(state)

  return (
    <div className="flex flex-col gap-2">
      <button className={SHARE_BUTTON} onClick={copy} type="button">
        🔗 Share link
      </button>

      {showsPrivateWarning(state) && 'url' in state && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
          {/* His words, kept as-is: the sentence has to say who CAN'T get in. */}
          <p className="font-medium text-[11px] text-amber-200/90 leading-relaxed">
            Project is private, only you can join.
          </p>
          <button
            className="rounded-md bg-amber-500/20 px-2 py-1.5 font-semibold text-[11px] text-amber-100 hover:bg-amber-500/30"
            onClick={() => publish(state.url)}
            type="button"
          >
            Make it public
          </button>
        </div>
      )}

      {state.kind === 'manual' && (
        // Clipboard refused (an http:// dev host over a LAN address does that).
        // The link still exists, so show it rather than pretending it copied.
        <input
          className="w-full rounded border border-sidebar-border/60 bg-sidebar-accent/40 px-2 py-1 font-mono text-[10px] text-sidebar-foreground/80"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={state.url}
        />
      )}

      {message && (
        <p
          className={
            shareMessageTone(state) === 'warn'
              ? 'text-[11px] text-amber-300/80 leading-relaxed'
              : 'text-[11px] text-sidebar-foreground/50 leading-relaxed'
          }
        >
          {message}
        </p>
      )}
    </div>
  )
}

// ── Voice ───────────────────────────────────────────────────────────────────
//
// The sidebar's whole job here is to say that voice EXISTS. Everything about the
// call is automatic once two people are in the same session — the one thing a
// player has to know is that M turns their microphone on, and there is nowhere
// in a first-person game to write that down.
//
// The mode picker is the only real setting, and it is a preference that outlives
// the page (voice.ts persists it), so it belongs out here in the editor rather
// than behind a key nobody would find mid-firefight.

/** What each mode promises, in the words a player would use. */
export const VOICE_MODES: ReadonlyArray<{ mode: VoiceMode; label: string; detail: string }> = [
  {
    detail: 'Everyone hears everyone, wherever they are in the building.',
    label: 'Squad',
    mode: 'squad',
  },
  {
    detail: 'Voices fade with distance — walk over to talk. Flat on iPhone.',
    label: 'Nearby',
    mode: 'proximity',
  },
]

export function VoiceSettings() {
  // Module state, not a store: voice.ts owns the mode (it also has to survive a
  // reload, which the game stores deliberately do not). Mirrored into React on
  // mount so the buttons show what is actually set.
  const [mode, setMode] = useState<VoiceMode>(() => voiceMode())

  const pick = (next: VoiceMode) => {
    setVoiceMode(next)
    setMode(next)
  }

  return (
    <section className="flex flex-col gap-2">
      <p className="font-semibold text-[10px] text-sidebar-foreground/70 uppercase tracking-wider">
        Voice chat
      </p>
      <p className="text-[11px] text-sidebar-foreground/50 leading-relaxed">
        Your mic is on by default — Jump in asks your browser once, and the MIC ON/OFF switch on the
        way in is remembered. <span className="font-semibold text-sidebar-foreground/80">M</span> mutes
        and unmutes in the game (the MIC button on a phone). You hear everyone whether or not you
        ever speak — so does anyone watching from the editor — and leaving the game switches the mic
        off.
      </p>
      <div className="flex gap-1.5">
        {VOICE_MODES.map((option) => (
          <button
            aria-pressed={mode === option.mode}
            className={
              mode === option.mode
                ? 'flex-1 rounded-md bg-sidebar-accent px-2 py-1.5 font-semibold text-xs'
                : 'flex-1 rounded-md border border-sidebar-border/60 px-2 py-1.5 text-xs hover:bg-sidebar-accent/60'
            }
            key={option.mode}
            onClick={() => pick(option.mode)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-sidebar-foreground/50 leading-relaxed">
        {VOICE_MODES.find((option) => option.mode === mode)?.detail}
      </p>
    </section>
  )
}

// ── Who's here ──────────────────────────────────────────────────────────────
//
// The bug report was "so nothing really like joining a game together": two
// people, one link, and neither screen said whether the other had arrived. That
// one silence hides several different failures, and this line separates them —
// "Just you in here right now" means the LINK failed, a name means it worked and
// whatever is wrong is downstream. See roster.ts for why it reads the host bus
// directly instead of net.ts's game-lifetime copy.

/** Live read of the room, resilient to a bus installed after we mounted. */
function useRoster(): RosterEntry[] | null {
  const [entries, setEntries] = useState<RosterEntry[] | null>(() => roster())

  useEffect(() => {
    // Compared by signature, not by identity: `roster()` builds a fresh array
    // every call, so setting state unconditionally would re-render the sidebar
    // every ROSTER_POLL_MS for the life of the session.
    let signature = rosterSignature(entries)
    const read = () => {
      const next = roster()
      const nextSignature = rosterSignature(next)
      if (nextSignature === signature) return
      signature = nextSignature
      setEntries(next)
    }
    read()
    const stopListening = onRosterChange(read)
    const timer = setInterval(read, ROSTER_POLL_MS)
    return () => {
      stopListening()
      clearInterval(timer)
    }
    // Mount-only on purpose (hence no `entries` dep): it is read once to seed
    // the signature, and re-running this on every roster change would tear down
    // the subscription it just installed.
  }, [])

  return entries
}

export function WhosHere() {
  const entries = useRoster()
  const somebody = entries !== null && entries.length > 0

  return (
    <p
      className={
        somebody
          ? 'flex items-center gap-1.5 font-semibold text-[11px] text-sidebar-foreground/80 leading-relaxed'
          : 'flex items-center gap-1.5 text-[11px] text-sidebar-foreground/50 leading-relaxed'
      }
      data-boots-roster={entries === null ? 'no-bus' : String(entries.length)}
    >
      <span
        aria-hidden="true"
        className={
          somebody
            ? 'size-1.5 shrink-0 rounded-full bg-emerald-400'
            : 'size-1.5 shrink-0 rounded-full bg-sidebar-foreground/25'
        }
      />
      {rosterMessage(entries)}
    </p>
  )
}

/**
 * Play together — the link, who is on the other end of it, and the voice call.
 *
 * Grouped because they are one question ("can we play this together right
 * now?") with three answers that have to agree. The intro is reach-aware for
 * the same reason the click message is: two sentences about the same link, one
 * of them promising a drop-in the host will not perform, is how the owner ends
 * up sharing a link he believes works.
 */
export function PlayTogether() {
  // Snapshotted at render and refreshed by the bridge's own subscription — the
  // owner can flip visibility from the host navbar while this panel is open,
  // and reach can change under us when the host swaps the bridge.
  const [reach, setReach] = useState<ShareReach>(() => shareReach(getShareBridge()))

  useEffect(() => {
    const bridge = getShareBridge()
    if (!bridge) return
    setReach(shareReach(getShareBridge()))
    return bridge.subscribe(() => setReach(shareReach(getShareBridge())))
  }, [])

  return (
    <section className="flex flex-col gap-2">
      <p className="font-semibold text-[10px] text-sidebar-foreground/70 uppercase tracking-wider">
        Play together
      </p>
      <WhosHere />
      <p className="text-[11px] text-sidebar-foreground/50 leading-relaxed">
        {playTogetherIntro(reach)}
      </p>
      <ShareLink />
      <VoiceSettings />
    </section>
  )
}

/** The Jump in button's resting label (mic-gate relabels it while it asks). */
const JUMP_LABEL = '⏵ Jump in'

/**
 * The Boots left-rail panel. One big verb: Jump in — the whole editor
 * becomes a game. After a session where you built pieces, the panel offers
 * to keep them (converted into real wall / roof-segment / slab nodes) or
 * discard everything.
 */
export default function BootsPanel() {
  // The phase is the gate the decision UI needs, and the ONLY one. It used to
  // be a `pendingDecision` flag set at Esc and cleared on re-entry, which made
  // the offer a moment rather than a state: reload the editor, or come back
  // tomorrow, and a fort you never decided about was simply gone from the
  // sidebar. The lanes are durable now (pending-store.ts), so the honest gate
  // is "you are in the editor and something is pending" — offered for as long
  // as it is true. What the flag actually protected is still protected: during
  // play `phase === 'game'`, so no Save click can reach the scene store.
  const phase = useBoots((s) => s.phase)
  const allPlaced = useBoots((s) => s.placed)
  const destroyed = useDemolition((s) => s.destroyed)
  const painted = usePaintKeep((s) => s.painted)
  const allPlacedItems = useItems((s) => s.items)
  // A READ of the host document — the only one in this file, and the only
  // place the plugin needs it outside the Save bridges: the demolition and
  // paint lanes know a nodeId, and the rows have to show a NAME.
  const sceneNodes = useScene((s) => s.nodes)
  const [lastKept, setLastKept] = useState<string | null>(null)
  // The Jump in button runs through the mic gate like every other entry surface
  // (mic-gate.ts): when the browser has to ask for the microphone, the FIRST
  // click becomes the prompt and the button says so ("ALLOW THE MIC ↑", busy),
  // the second enters. Calling enterGame() straight from here put the permission
  // bubble inside the fullscreen/pointer-lock sequence, which exits the game.
  const [entry, setEntry] = useState<{ label: string; busy: boolean }>({ label: JUMP_LABEL, busy: false })

  // "You built N pieces" has to mean what it says. In a shared world the
  // stores also hold what other players built, and Save writes only this
  // player's work (keep.ts / item-keep.ts filter the same way), so counting
  // the whole list would promise to keep walls that are not ours and offer a
  // decision to a player who built nothing. Both are the full list in
  // single-player.
  const placed = allPlaced.filter((p) => !isForeignPlacedPiece(p.id))
  const placedItems = allPlacedItems.filter((p) => !isForeignItemPlacement(p.id))

  const groups = pendingChangeGroups({
    placed,
    destroyed,
    painted,
    items: placedItems,
    nodes: sceneNodes,
  })

  return (
    <div className="flex flex-col gap-4 p-4 text-sidebar-foreground">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {/* The badge, same asset the rail entry uses (art.ts) — Pascaline in
              her hard hat. Square and self-framed, so it needs no border here;
              rounded to the sidebar's radius and fixed at 24px so a long
              sidebar never reflows around it. */}
          <img
            alt=""
            className="size-6 shrink-0 rounded-[5px] object-cover"
            draggable={false}
            src={BOOTS_ICON}
          />
          <h2 className="font-semibold text-base">Boots</h2>
          <span className="rounded-full border border-sidebar-border/60 bg-sidebar-accent px-1.5 py-px font-semibold text-[9px] text-sidebar-foreground/70 uppercase tracking-widest">
            Alpha
          </span>
        </div>
        <p className="text-sidebar-foreground/50 text-xs leading-relaxed">
          Just like Bones, it's alpha. Pascaline laced up her work boots — make sure your building
          can resist robot zombie attacks.
        </p>
      </header>

      <button
        className="flex w-full items-center justify-center gap-2 rounded-md bg-sidebar-accent px-3 py-2 font-semibold text-sm hover:bg-sidebar-accent/80 disabled:opacity-60"
        disabled={entry.busy}
        onClick={() => {
          setLastKept(null)
          beginEntry({
            setLabel: (label, busy) => setEntry({ label, busy }),
            enter: () => {
              setEntry({ label: JUMP_LABEL, busy: false })
              // Nothing entered (no canvas yet): nothing may keep the mic.
              if (!enterGame()) releaseMic()
            },
          })
        }}
        type="button"
      >
        {entry.label}
      </button>

      <ShareLink />

      {phase === 'editor' && groups.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border border-sidebar-border/60 p-3">
          <p className="font-semibold text-[10px] text-sidebar-foreground/70 uppercase tracking-wider">
            Pending changes
          </p>
          <p className="text-[11px] text-sidebar-foreground/50 leading-relaxed">
            Nothing was saved while you played — shooting, breaking, all of it stays in the game.
            This list waits here until you decide, reloads included: only the buttons below write
            anything, and Discard leaves your building exactly as it was.
          </p>
          {/* One group per non-empty lane, so the decision is about things he
              can see. `groups.length > 0` is also the section's own gate: it is
              empty exactly when all four lanes are — and in a shared world the
              pieces in the store can all be other players' (excluded above), so
              a player who built nothing is never asked to decide. */}
          <PendingChanges groups={groups} />
          <div className="flex gap-2">
            <button
              className="flex-1 rounded-md bg-sidebar-accent px-2 py-1.5 font-semibold text-xs hover:bg-sidebar-accent/80"
              onClick={() => setLastKept(saveSessionChanges())}
              type="button"
            >
              Save changes
            </button>
            <button
              className="flex-1 rounded-md border border-sidebar-border/60 px-2 py-1.5 text-xs hover:bg-sidebar-accent/60"
              onClick={() => setLastKept(discardSessionChanges())}
              type="button"
            >
              Discard all
            </button>
          </div>
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

      <PlayTogether />
    </div>
  )
}
