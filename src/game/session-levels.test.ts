import { beforeEach, describe, expect, test } from 'bun:test'
import { useViewer } from '@pascal-app/viewer'
import { forceStackedLevelMode } from './session'

/**
 * Phase A (whole-building presence): enterGame must force the viewer's
 * levelMode to 'stacked' when the editor sits in 'solo' (partial building —
 * other storeys hidden or shadow-only) or 'exploded' (storeys displaced by
 * 5 m gaps), and the session teardown must restore the EXACT prior mode.
 * 'stacked' and 'manual' already keep every storey at its true elevation, so
 * they are left untouched (no spurious teardown entries).
 *
 * The viewer here is the test-preload stub whose setLevelMode is functional
 * (writes levelMode back through setState), so these tests exercise the same
 * read→force→restore round-trip enterGame runs against the real store.
 */

type ViewerStub = {
  getState: () => { levelMode: string }
  setState: (partial: Record<string, unknown>) => void
}
const viewer = useViewer as unknown as ViewerStub

const setMode = (mode: string) => viewer.setState({ levelMode: mode })

beforeEach(() => setMode('stacked'))

describe('forceStackedLevelMode', () => {
  test.each(['solo', 'exploded'])('%s → forced stacked, teardown restores it', (mode) => {
    setMode(mode)
    const teardown: Array<() => void> = []
    forceStackedLevelMode(teardown)
    expect(viewer.getState().levelMode).toBe('stacked')
    expect(teardown).toHaveLength(1)
    for (const fn of teardown.splice(0)) fn()
    expect(viewer.getState().levelMode).toBe(mode)
  })

  test.each(['stacked', 'manual'])('%s → untouched, no teardown entry', (mode) => {
    setMode(mode)
    const teardown: Array<() => void> = []
    forceStackedLevelMode(teardown)
    expect(viewer.getState().levelMode).toBe(mode)
    expect(teardown).toHaveLength(0)
  })

  test('restore lands the prior mode even if the game changed it again', () => {
    setMode('solo')
    const teardown: Array<() => void> = []
    forceStackedLevelMode(teardown)
    // Something mid-session flips the mode (host UI, another plugin) — the
    // teardown must still restore what the PLAYER had before Jump-in.
    setMode('exploded')
    for (const fn of teardown.splice(0)) fn()
    expect(viewer.getState().levelMode).toBe('solo')
  })

  test('missing setLevelMode on an older host is a no-op, never a throw', () => {
    const state = viewer.getState() as Record<string, unknown>
    const saved = state.setLevelMode
    viewer.setState({ levelMode: 'solo', setLevelMode: undefined })
    const teardown: Array<() => void> = []
    expect(() => forceStackedLevelMode(teardown)).not.toThrow()
    expect(teardown).toHaveLength(0)
    expect(viewer.getState().levelMode).toBe('solo')
    viewer.setState({ setLevelMode: saved })
  })
})
