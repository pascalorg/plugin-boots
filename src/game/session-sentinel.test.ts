import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { useScene } from '@pascal-app/core'
import { useBoots } from '../store'
import { armSceneWriteSentinel, classifySceneWrite } from './session'

/**
 * Scene-write sentinel discriminator: the sentinel's ERROR must stay a clean
 * local-bug signal. A scene-store write during play is
 *  - an INVARIANT VIOLATION scream (console.error) when it is an INCREMENTAL
 *    write under normal access — some in-game code path wrote the store
 *    (createNode/updateNodes/deleteNodes all spread the previous map and
 *    leave `dirtyNodes` alone, which is exactly what the classifier keys on);
 *  - a calm console.info when the store was under the host's remote-op lease
 *    (useScene.getState().readOnly === true): a PEER's collaboration edit;
 *  - a calm console.info when the host REHYDRATED the whole graph — the
 *    dev-host Fast Refresh re-running the Editor load effect (`unloadScene()`
 *    + `setScene(...)`, the captured 2026-08-29 warner-2 signature) or a
 *    remote SSE scene sync applying through the same `setScene` path. Only
 *    those host lifecycle APIs swap a fresh `dirtyNodes` Set in the write
 *    that replaces `nodes`, with zero node identities surviving.
 */

type SceneStore = {
  getState: () => {
    setScene: (nodes: Record<string, unknown>, roots: string[]) => void
    createNode: (node: Record<string, unknown>, parentId?: string) => void
    unloadScene: () => void
    setReadOnly?: (readOnly: boolean) => void
    readOnly?: boolean
    nodes: Record<string, unknown>
  }
}
const scene = useScene as unknown as SceneStore

function arm(): Array<() => void> {
  const teardown: Array<() => void> = []
  armSceneWriteSentinel(teardown)
  return teardown
}

function release(teardown: Array<() => void>): void {
  for (const fn of teardown.splice(0)) fn()
}

function spies() {
  return {
    error: spyOn(console, 'error').mockImplementation(() => {}),
    info: spyOn(console, 'info').mockImplementation(() => {}),
  }
}

afterEach(() => {
  useBoots.getState().setPhase('editor')
  scene.getState().setReadOnly?.(false)
  scene.getState().setScene({}, [])
})

describe('scene-write sentinel — local writes still scream', () => {
  test('an incremental store write during play (no lease) is an INVARIANT VIOLATION error', () => {
    const { error, info } = spies()
    scene.getState().setScene({ 'node-1': { id: 'node-1' } }, ['node-1'])
    useBoots.getState().setPhase('game')
    const teardown = arm()
    // The rogue-write shape: createNode spreads the previous nodes map
    // (identities shared) and never swaps dirtyNodes — same store surface
    // the four Save bridges use, but during play.
    scene.getState().createNode({ id: 'rogue-1' })
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls[0]?.[0])).toContain('INVARIANT VIOLATION')
    expect(info).not.toHaveBeenCalled()
    release(teardown)
    error.mockRestore()
    info.mockRestore()
  })

  test('nothing fires outside game phase (editor writes are normal life)', () => {
    const { error, info } = spies()
    useBoots.getState().setPhase('editor')
    const teardown = arm()
    scene.getState().setScene({ 'node-2': { id: 'node-2' } }, ['node-2'])
    scene.getState().createNode({ id: 'node-2b' })
    expect(error).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    release(teardown)
    error.mockRestore()
    info.mockRestore()
  })
})

describe('scene-write sentinel — the remote-op lease discriminator', () => {
  test('a write under readOnly === true logs info, never the violation error', () => {
    const setReadOnly = scene.getState().setReadOnly
    expect(typeof setReadOnly).toBe('function') // host store carries the lease flag
    const { error, info } = spies()
    useBoots.getState().setPhase('game')
    const teardown = arm()
    setReadOnly?.(true) // the host's remote-op lease
    scene.getState().setScene({ 'node-3': { id: 'node-3' } }, ['node-3'])
    expect(error).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalled()
    expect(String(info.mock.calls[0]?.[0])).toContain(
      'remote collaboration op during play (world snapshot stays frozen)',
    )
    setReadOnly?.(false)
    release(teardown)
    error.mockRestore()
    info.mockRestore()
  })

  test('lease released → later local writes scream again (no sticky calm)', () => {
    const { error, info } = spies()
    useBoots.getState().setPhase('game')
    const teardown = arm()
    scene.getState().setReadOnly?.(true)
    scene.getState().setScene({ 'node-4': { id: 'node-4' } }, ['node-4'])
    scene.getState().setReadOnly?.(false)
    error.mockClear()
    scene.getState().createNode({ id: 'rogue-4' })
    expect(error).toHaveBeenCalled()
    release(teardown)
    error.mockRestore()
    info.mockRestore()
  })

  test('teardown disarms the sentinel', () => {
    const { error, info } = spies()
    useBoots.getState().setPhase('game')
    const teardown = arm()
    release(teardown)
    scene.getState().createNode({ id: 'node-6' })
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
    info.mockRestore()
  })
})

describe('scene-write sentinel — host rehydration is tolerated, named, and calm', () => {
  test('a mid-game setScene rehydration (dev hot-reload / remote SSE sync) logs info, never the error', () => {
    scene.getState().setScene({ 'node-a': { id: 'node-a' } }, ['node-a'])
    const { error, info } = spies()
    useBoots.getState().setPhase('game')
    const teardown = arm()
    scene.getState().setScene({ 'node-b': { id: 'node-b' } }, ['node-b'])
    expect(error).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalled()
    expect(String(info.mock.calls[0]?.[0])).toContain('host scene rehydration during play')
    release(teardown)
    error.mockRestore()
    info.mockRestore()
  })

  test('the captured Fast Refresh signature — unloadScene() then setScene() — logs infos, zero errors', () => {
    scene.getState().setScene({ 'node-a': { id: 'node-a' } }, ['node-a'])
    const { error, info } = spies()
    useBoots.getState().setPhase('game')
    const teardown = arm()
    // The exact pair the Editor load effect runs when HMR re-triggers it.
    scene.getState().unloadScene()
    scene.getState().setScene({ 'node-a': { id: 'node-a' } }, ['node-a'])
    expect(error).not.toHaveBeenCalled()
    expect(info.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of info.mock.calls) {
      expect(String(call[0])).toContain('host scene rehydration during play')
    }
    release(teardown)
    error.mockRestore()
    info.mockRestore()
  })

  test('the baseline rolls forward: an in-game write AFTER a tolerated rehydration still screams', () => {
    scene.getState().setScene({ 'node-a': { id: 'node-a' } }, ['node-a'])
    const { error, info } = spies()
    useBoots.getState().setPhase('game')
    const teardown = arm()
    scene.getState().setScene({ 'node-b': { id: 'node-b' } }, ['node-b'])
    expect(error).not.toHaveBeenCalled()
    scene.getState().createNode({ id: 'rogue-b' })
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls[0]?.[0])).toContain('INVARIANT VIOLATION')
    release(teardown)
    error.mockRestore()
    info.mockRestore()
  })
})

describe('classifySceneWrite — the discriminator, pinned', () => {
  const nodeA = { id: 'a' }
  const nodeB = { id: 'b' }

  test('remote-op lease wins first', () => {
    expect(
      classifySceneWrite(
        { nodes: { a: nodeA }, dirtyNodes: new Set() },
        { nodes: { b: nodeB }, dirtyNodes: new Set(), readOnly: true },
      ),
    ).toBe('remote-collab-op')
  })

  test('full swap + fresh empty dirtyNodes = host rehydration', () => {
    expect(
      classifySceneWrite(
        { nodes: { a: nodeA }, dirtyNodes: new Set(['a']) },
        { nodes: { a: { id: 'a' } }, dirtyNodes: new Set() },
      ),
    ).toBe('host-rehydration')
  })

  test('unload shape (nodes → empty) = host rehydration', () => {
    expect(
      classifySceneWrite(
        { nodes: { a: nodeA }, dirtyNodes: new Set(['a']) },
        { nodes: {}, dirtyNodes: new Set() },
      ),
    ).toBe('host-rehydration')
  })

  test('any surviving node identity = violation (incremental writes share untouched nodes)', () => {
    expect(
      classifySceneWrite(
        { nodes: { a: nodeA, b: nodeB }, dirtyNodes: new Set(['a']) },
        { nodes: { a: nodeA, b: { id: 'b' } }, dirtyNodes: new Set() },
      ),
    ).toBe('violation')
  })

  test('nodes swapped WITHOUT a dirtyNodes swap = violation', () => {
    const dirty = new Set<string>()
    expect(
      classifySceneWrite(
        { nodes: { a: nodeA }, dirtyNodes: dirty },
        { nodes: { a: { id: 'a' } }, dirtyNodes: dirty },
      ),
    ).toBe('violation')
  })

  test('a fresh-but-already-marked dirty set is still rehydration (host listeners run first)', () => {
    // zustand notifies in registration order: host systems subscribed before
    // the sentinel (the fence-lift tracker on the warner-2 repro) markDirty
    // IN PLACE into the freshly swapped Set before the sentinel's listener
    // sees the transition. The swap + zero surviving node identities is the
    // signature; the set's contents are not.
    expect(
      classifySceneWrite(
        { nodes: { a: nodeA }, dirtyNodes: new Set() },
        { nodes: { a: { id: 'a' } }, dirtyNodes: new Set(['a']) },
      ),
    ).toBe('host-rehydration')
  })

  test('hosts without dirty tracking never classify as rehydration (strong default)', () => {
    expect(
      classifySceneWrite({ nodes: { a: nodeA } }, { nodes: { a: { id: 'a' } } }),
    ).toBe('violation')
  })
})
