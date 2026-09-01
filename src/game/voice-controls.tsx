import { useFrame } from '@react-three/fiber'
import { useEffect } from 'react'
import { takeAction } from './input'
import { getRemotes } from './presence'
import { getSession } from './session'
import { type MicState, micState, selfTalking, talkingPeers, toggleMic, voiceActive } from './voice'

/**
 * The player-facing half of voice: one key and one chip.
 *
 * M toggles the microphone. It is a ONE-SHOT taken off the input action queue
 * rather than read off the held-keys set, because a tap whose keydown and keyup
 * both land inside a single frame is invisible to per-frame key sampling — the
 * same reason interact.tsx takes 'KeyE' from the queue. We run at priority -1 so
 * the strip happens before the viewmodel's consumeActions() drains it.
 *
 * THE FIRST PRESS IS THE PERMISSION PROMPT, and that is deliberate. A keystroke
 * is a user gesture, which is exactly what a browser requires before it will even
 * show the microphone dialog; asking on session entry instead would put that
 * dialog in front of somebody who just dropped into a firefight, and a dialog
 * answered by reflex is denied for good. Entry only re-enables a mic this browser
 * has ALREADY granted (game-root's enableMicIfAlreadyPermitted), so from the
 * second session onward there is nothing to press.
 */

/** Feature-detected HUD surface — same defensive idiom as driveChip's. */
type VoiceHud = {
  voiceChip?: (args: {
    mic: MicState
    talking: boolean
    talkers: number
    peers: number
  }) => void
}

/**
 * Peers in the game, for the chip's "is there anybody to talk to" decision.
 *
 * Counted from PRESENCE, not from the voice mesh: past the mesh cap somebody can
 * be standing in the lot with you and outside the call, and a chip claiming you
 * are alone while another builder walks past is worse than no chip.
 */
function gamePeerCount(): number {
  let count = 0
  for (const remote of getRemotes().values()) {
    if (remote.ph === 'game') count++
  }
  return count
}

export function VoiceControls() {
  useFrame(() => {
    const session = getSession()
    if (!session) return

    if (takeAction(session.input.state.actions, 'KeyM')) {
      // Fire-and-forget: the first press awaits a permission dialog that can sit
      // open for as long as the player takes to read it, and the frame loop must
      // not be holding anything while that happens.
      void toggleMic()
    }

    // The chip is change-gated on its rendered text inside the HUD, so driving it
    // every frame costs one small object and no DOM write.
    const hud = session.hud as unknown as VoiceHud | undefined
    hud?.voiceChip?.({
      mic: micState(),
      peers: gamePeerCount(),
      talkers: voiceActive() ? talkingPeers().length : 0,
      talking: selfTalking(),
    })
  }, -1)

  useEffect(
    () => () => {
      // Session over: blank the chip. A live session's next frame re-drives it.
      const hud = getSession()?.hud as unknown as VoiceHud | undefined
      hud?.voiceChip?.({ mic: 'off', peers: 0, talkers: 0, talking: false })
    },
    [],
  )

  return null
}
