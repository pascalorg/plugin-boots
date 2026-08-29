import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { useScene } from '@pascal-app/core'
import { useBoots } from '../store'
import { armSceneWriteSentinel } from './session'

/**
 * Scene-write sentinel discriminator (co-presence): the sentinel's ERROR
 * must stay a clean local-bug signal. A scene-store write during play is
 *  - an INVARIANT VIOLATION scream (console.error) when it happened under
 *    normal write access — some in-game code path wrote the store;
 *  - a calm console.info when the store was under the host's remote-op
 *    lease (useScene.getState().readOnly === true): a PEER's collaboration
 *    edit landed, our world snapshot stays frozen, nothing local is wrong.
 */

type SceneStore = {
  getState: () => {
    setScene: (nodes: Record<string, unknown>, roots: string[]) => void
    setReadOnly?: (readOnly: boolean) => void
    readOnly?: boolean
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

afterEach(() => {
  useBoots.getState().setPhase('editor')
  scene.getState().setReadOnly?.(false)
  scene.getState().setScene({}, [])
})

describe('scene-write sentinel — local writes still scream', () => {
  test('a store write during play (no lease) is an INVARIANT VIOLATION error', () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const info = spyOn(console, 'info').mockImplementation(() => {})
    useBoots.getState().setPhase('game')
    const teardown = arm()
    scene.getState().setScene({ 'node-1': { id: 'node-1' } }, ['node-1'])
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls[0]?.[0])).toContain('INVARIANT VIOLATION')
    expect(info).not.toHaveBeenCalled()
    release(teardown)
    error.mockRestore()
    info.mockRestore()
  })

  test('nothing fires outside game phase (editor writes are normal life)', () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const info = spyOn(console, 'info').mockImplementation(() => {})
    useBoots.getState().setPhase('editor')
    const teardown = arm()
    scene.getState().setScene({ 'node-2': { id: 'node-2' } }, ['node-2'])
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
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const info = spyOn(console, 'info').mockImplementation(() => {})
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
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const info = spyOn(console, 'info').mockImplementation(() => {})
    useBoots.getState().setPhase('game')
    const teardown = arm()
    scene.getState().setReadOnly?.(true)
    scene.getState().setScene({ 'node-4': { id: 'node-4' } }, ['node-4'])
    scene.getState().setReadOnly?.(false)
    error.mockClear()
    scene.getState().setScene({ 'node-5': { id: 'node-5' } }, ['node-5'])
    expect(error).toHaveBeenCalled()
    release(teardown)
    error.mockRestore()
    info.mockRestore()
  })

  test('teardown disarms the sentinel', () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    useBoots.getState().setPhase('game')
    const teardown = arm()
    release(teardown)
    scene.getState().setScene({ 'node-6': { id: 'node-6' } }, ['node-6'])
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
