import { beforeEach, describe, expect, test } from 'bun:test'
import { useBoots } from '../store'
import {
  ALERT_SECONDS,
  armWaves,
  bots,
  resetBots,
  tickWaveDirector,
  waveState,
} from './enemies-state'

/**
 * THE OPT-IN INVARIANT: combat starts at the industrial breaker switch
 * (guntable.tsx → armWaves) and NOWHERE else. tickWaveDirector's signature
 * has no weapon-ownership input at all — the store is loaded up in the
 * grace test anyway to pin that a fully-armed player still never wakes the
 * horde. The theatre layer (sfx/labels/spawns in enemies.tsx) consumes the
 * step events asserted here.
 */

const DT = 1 / 60

beforeEach(() => {
  resetBots()
  useBoots.getState().resetSession()
})

describe('wave director — switch-armed grace/alert', () => {
  test('owning the whole arsenal for 60 s spawns NOTHING — grace holds', () => {
    const s = useBoots.getState()
    s.giveWeapon('pistol')
    s.giveWeapon('rifle')
    s.giveWeapon('minigun')
    s.setWeapon('rifle')
    let events = 0
    for (let t = 0; t < 60; t += DT) {
      const step = tickWaveDirector(DT, bots.length)
      if (step.alertStarted || step.assaultStarted || step.waveDue) events++
    }
    expect(events).toBe(0)
    expect(waveState.alerted).toBe(false)
    expect(waveState.countdownActive).toBe(false)
    expect(bots.length).toBe(0)
  })

  test('the switch throw starts the theatre, then exactly one assault', () => {
    armWaves()
    const first = tickWaveDirector(DT, 0)
    expect(first.alertStarted).toBe(true)
    expect(waveState.alerted).toBe(true)
    expect(waveState.countdownActive).toBe(true)
    expect(waveState.countdown).toBe(ALERT_SECONDS)
    // The countdown runs its full window and fires assaultStarted once.
    let assaults = 0
    let ticks = 0
    while (waveState.countdown > 0 && ticks < 100000) {
      if (tickWaveDirector(DT, 0).assaultStarted) assaults++
      ticks++
    }
    expect(assaults).toBe(1)
    expect(waveState.countdownActive).toBe(false)
    // ~the whole ALERT_SECONDS window, not an instant skip.
    expect(ticks * DT).toBeGreaterThan(ALERT_SECONDS - 0.1)
  })

  test('armWaves is idempotent — re-throws mid-assault change nothing', () => {
    armWaves()
    tickWaveDirector(DT, 0)
    armWaves()
    const step = tickWaveDirector(DT, 0)
    expect(step.alertStarted).toBe(false)
    expect(waveState.countdown).toBeLessThan(ALERT_SECONDS)
  })

  test('intermission only runs while the lot is clear', () => {
    armWaves()
    tickWaveDirector(DT, 0)
    while (waveState.countdown > 0) tickWaveDirector(DT, 0)
    waveState.intermission = 1
    // Alive bots freeze the next-wave clock…
    for (let t = 0; t < 2; t += DT) {
      expect(tickWaveDirector(DT, 3).waveDue).toBe(false)
    }
    expect(waveState.intermission).toBe(1)
    // …a clear lot runs it down to exactly one waveDue.
    let due = 0
    for (let t = 0; t < 1.5; t += DT) {
      if (tickWaveDirector(DT, 0).waveDue) {
        due++
        waveState.intermission = 5 // what spawnWave() does in the theatre
      }
    }
    expect(due).toBe(1)
  })

  test('resetBots resets the switch — the handle comes back UP, grace restored', () => {
    armWaves()
    tickWaveDirector(DT, 0)
    resetBots()
    expect(waveState.armed).toBe(false)
    expect(waveState.alerted).toBe(false)
    expect(waveState.countdownActive).toBe(false)
    let events = 0
    for (let t = 0; t < 10; t += DT) {
      const step = tickWaveDirector(DT, 0)
      if (step.alertStarted || step.assaultStarted || step.waveDue) events++
    }
    expect(events).toBe(0)
  })
})
