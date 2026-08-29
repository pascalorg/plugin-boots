import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useViewer } from '@pascal-app/viewer'
import { useBoots } from '../store'
import { guardSelectionForGame } from './session'

/**
 * No selection during a session: the host's manipulation gizmos (move-arrow
 * rig, group selection box, outline pass) mount from the viewer store's
 * `selection` inside the same canvas the game renders through. enterGame
 * must record the pre-session selection, clear it, keep it clear for the
 * whole session (host re-asserts → we re-clear, event-driven via a store
 * subscription), and restore the EXACT pre-session selection on teardown —
 * the post-exit Keep flows read selection.levelId from the restored value.
 *
 * The viewer here is the test-preload stub; these tests install a
 * functional setSelection (plain merge — the guard always passes all four
 * fields explicitly, so the real store's hierarchy guard reduces to the
 * same merge) so they exercise the read→clear→guard→restore round-trip
 * against real state.
 */

type SelectionPath = {
  buildingId?: string | null
  levelId?: string | null
  zoneId?: string | null
  selectedIds?: readonly string[]
}
type ViewerStub = {
  getState: () => {
    selection?: SelectionPath
    hoveredId?: unknown
    setSelection?: (updates: SelectionPath) => void
  }
  setState: (partial: Record<string, unknown>) => void
}
const viewer = useViewer as unknown as ViewerStub

const PRE_SESSION: SelectionPath = {
  buildingId: 'building-1',
  levelId: 'level-test',
  zoneId: 'zone-1',
  selectedIds: ['item-sofa'],
}

const CLEARED: SelectionPath = {
  buildingId: null,
  levelId: null,
  zoneId: null,
  selectedIds: [],
}

/** Shared per-test teardown list — drained in afterEach so a test that
 * never exits its "session" can't leak a live guard subscription into the
 * next test (the stub store is module-shared). */
let teardown: Array<() => void> = []

beforeEach(() => {
  teardown = []
  viewer.setState({
    selection: { ...PRE_SESSION },
    hoveredId: null,
    setSelection: (updates: SelectionPath) =>
      viewer.setState({ selection: { ...viewer.getState().selection, ...updates } }),
  })
})

afterEach(() => {
  useBoots.getState().setPhase('editor')
  for (const fn of teardown.splice(0)) fn()
  // Put the preload stub back in its shared shape — keep.ts tests read
  // selection.levelId from it.
  viewer.setState({
    selection: { levelId: 'level-test' },
    hoveredId: undefined,
    setSelection: undefined,
  })
})

describe('guardSelectionForGame', () => {
  test('clears the pre-session selection on enter, one teardown entry', () => {
    guardSelectionForGame(teardown)
    expect(viewer.getState().selection).toEqual(CLEARED)
    expect(teardown).toHaveLength(1)
  })

  test('teardown restores the exact pre-session selection (Keep reads levelId from it)', () => {
    guardSelectionForGame(teardown)
    for (const fn of teardown.splice(0)) fn()
    expect(viewer.getState().selection).toEqual(PRE_SESSION)
    expect(viewer.getState().selection?.levelId).toBe('level-test')
  })

  test('a selection appearing while phase=game is immediately cleared', () => {
    guardSelectionForGame(teardown)
    useBoots.getState().setPhase('game')
    // Host leak path: something routes a click into setSelection mid-game.
    viewer.getState().setSelection?.({ selectedIds: ['item-leak'] })
    expect(viewer.getState().selection).toEqual(CLEARED)
    // Partial hierarchy selections are ghosts too.
    viewer.getState().setSelection?.({ levelId: 'level-2' })
    expect(viewer.getState().selection).toEqual(CLEARED)
    for (const fn of teardown.splice(0)) fn()
    expect(viewer.getState().selection).toEqual(PRE_SESSION)
  })

  test('a hover ghost appearing while phase=game is immediately dropped', () => {
    guardSelectionForGame(teardown)
    useBoots.getState().setPhase('game')
    viewer.setState({ hoveredId: 'item-sofa' })
    expect(viewer.getState().hoveredId).toBeNull()
    for (const fn of teardown.splice(0)) fn()
  })

  test('outside phase=game the guard is inert (no re-clear before/after the session)', () => {
    guardSelectionForGame(teardown)
    // Still subscribed but phase is editor (the synchronous enterGame
    // window before setPhase) — writes stand.
    viewer.getState().setSelection?.({ selectedIds: ['mid-enter'] })
    expect(viewer.getState().selection?.selectedIds).toEqual(['mid-enter'])
    for (const fn of teardown.splice(0)) fn()
    // Unsubscribed after teardown — the restored selection then sticks even
    // in game phase (a dead session must never eat the editor's selection).
    useBoots.getState().setPhase('game')
    viewer.getState().setSelection?.({ selectedIds: ['post-exit'] })
    expect(viewer.getState().selection?.selectedIds).toEqual(['post-exit'])
  })

  test('restore lands the pre-session selection even after mid-game re-clears', () => {
    guardSelectionForGame(teardown)
    useBoots.getState().setPhase('game')
    viewer.getState().setSelection?.({ selectedIds: ['a'], zoneId: 'zone-9' })
    viewer.getState().setSelection?.({ buildingId: 'building-9' })
    expect(viewer.getState().selection).toEqual(CLEARED)
    useBoots.getState().setPhase('editor')
    for (const fn of teardown.splice(0)) fn()
    expect(viewer.getState().selection).toEqual(PRE_SESSION)
  })

  test('older host without the selection API is a no-op, never a throw', () => {
    viewer.setState({ setSelection: undefined })
    expect(() => guardSelectionForGame(teardown)).not.toThrow()
    expect(teardown).toHaveLength(0)
    expect(viewer.getState().selection).toEqual(PRE_SESSION)
  })

  test('empty pre-session selection round-trips to empty', () => {
    viewer.getState().setSelection?.({ ...CLEARED })
    guardSelectionForGame(teardown)
    useBoots.getState().setPhase('game')
    viewer.getState().setSelection?.({ selectedIds: ['item-leak'] })
    expect(viewer.getState().selection).toEqual(CLEARED)
    useBoots.getState().setPhase('editor')
    for (const fn of teardown.splice(0)) fn()
    expect(viewer.getState().selection).toEqual(CLEARED)
  })
})
