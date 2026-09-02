'use client'

import { useEffect, useState } from 'react'
import { useBoots } from '../store'
import { FrameBooster } from './game-root'
import { getRemotes, startSpectating, stopSpectating } from './presence'
import { RemotePlayers } from './remote-players'

/**
 * SPECTATOR LAYER — the render side of "people looking at the project can see
 * the players live."
 *
 * BootsSystem mounts this in EDITOR phase. It is mutually exclusive with
 * ActiveGame, which owns RemotePlayers in GAME phase — a viewer who has NOT
 * dropped in still gets everyone's pose frames through a RECEIVE-ONLY presence
 * subscription (startSpectating publishes no avatar of its own), and renders
 * those exact avatars — movement, aim, firing — with the same <RemotePlayers/>
 * the players already see of each other. When a spectator later drops in,
 * startPresence takes over the same live subscription with no reconnect.
 *
 * COST GATE. The editor canvas renders on demand (frameloop="never"), so the
 * avatars would freeze mid-stride. FrameBooster drives continuous frames — but
 * ONLY while there is at least one live player to watch. An idle project with
 * nobody in the game stays on-demand; the instant someone drops in (a
 * network-driven roster, polled off a plain timer that ticks with or without a
 * render) the watch layer + booster mount, and they unmount when the lot
 * empties. So spectating a live fort costs frames; a quiet page costs nothing.
 */

/** Roster poll cadence (ms). A plain timer, not useFrame: until we have someone
 * to show we mount no FrameBooster, so the canvas isn't ticking to poll from. */
const WATCH_POLL_MS = 400

function anyLivePlayer(): boolean {
  for (const remote of getRemotes().values()) if (remote.ph === 'game') return true
  return false
}

export function SpectatorPlayers() {
  const phase = useBoots((s) => s.phase)
  const [watching, setWatching] = useState(false)

  useEffect(() => {
    if (phase !== 'editor') {
      setWatching(false)
      return
    }
    // Feature-detected: no collab bus (host flag off) → inert, nothing mounts.
    if (!startSpectating()) return
    setWatching(anyLivePlayer())
    const timer = setInterval(() => setWatching(anyLivePlayer()), WATCH_POLL_MS)
    return () => {
      clearInterval(timer)
      stopSpectating()
    }
  }, [phase])

  if (phase !== 'editor' || !watching) return null
  return (
    <>
      <FrameBooster />
      <RemotePlayers />
    </>
  )
}
