import { afterEach, describe, expect, test } from 'bun:test'
import {
  type CollabBus,
  type CollabBusMessage,
  NET_PROTOCOL,
  resetNetIdentity,
  resetNetKinds,
  startNet,
  stopNet,
} from './net'
import {
  readTreeCommand,
  readTreeFrame,
  startTreeSync,
  stepTreeSync,
  stopTreeSync,
  TREE_KIND,
  TREE_SYNC_CAP,
  type TreeFrame,
} from './tree-sync'

type TestBus = CollabBus & {
  published: Array<{ event: string; data: unknown }>
  handler: ((message: CollabBusMessage) => void) | null
}

const globals = globalThis as { __pascalCollabBus?: CollabBus }

function installBus(): TestBus {
  const bus: TestBus = {
    version: 1,
    projectId: 'project',
    sessionId: 'viewer',
    clientId: 'viewer-client',
    userId: 'viewer-user',
    published: [],
    handler: null,
    publish(_pluginId, event, data) {
      bus.published.push({ event, data })
      return 'sent'
    },
    subscribe(_pluginId, handler) {
      bus.handler = handler
      return () => {
        bus.handler = null
      }
    },
    getParticipants: () => [],
    onParticipants: () => () => {},
  }
  globals.__pascalCollabBus = bus
  return bus
}

afterEach(() => {
  stopTreeSync()
  stopNet()
  resetNetKinds()
  resetNetIdentity()
  delete globals.__pascalCollabBus
})

describe('shared combat-tree wire boundary', () => {
  test('accepts bounded grove state and cumulative damage', () => {
    expect(readTreeFrame({ v: 1, t: [[3, 1, 52, 24, 1.25, 3]] })).toEqual({
      v: 1,
      t: [[3, 1, 52, 24, 1.25, 3]],
    })
    expect(readTreeCommand({ v: 1, h: [[3, 2, 20, 1, 12]] })).toEqual({
      v: 1,
      h: [[3, 2, 20, 1, 12]],
    })
  })

  test('rejects hostile ids, state and unbounded arrays', () => {
    expect(readTreeFrame({ v: 1, t: [[-1, 0, 70, 0, 0, 3]] })).toBeNull()
    expect(readTreeFrame({ v: 1, t: [[1, 9, 70, 0, 0, 3]] })).toBeNull()
    expect(readTreeCommand({ v: 1, h: [[1, -1, 2, 0, 0]] })).toBeNull()
    expect(
      readTreeFrame({
        v: 1,
        t: Array(TREE_SYNC_CAP + 1).fill([0, 0, 70, 0, 0, 3]),
      }),
    ).toBeNull()
  })

  test('editor observer accepts live snapshots but never publishes or answers', () => {
    const bus = installBus()
    startNet()
    const applied: TreeFrame[] = []
    startTreeSync(
      {
        snapshot: () => ({ v: 1, t: [] }),
        applySnapshot: (frame) => applied.push(frame),
        applyDamage: () => {},
        pristine: () => true,
      },
      { receiveOnly: true },
    )
    const afterRequest = bus.published.length
    stepTreeSync(10)
    expect(bus.published).toHaveLength(afterRequest)

    const incoming: TreeFrame = { v: 1, t: [[0, 0, 70, 0, 0, 3]] }
    bus.handler?.({
      event: TREE_KIND,
      data: { v: NET_PROTOCOL, kind: TREE_KIND, seq: 1, data: incoming },
      sessionId: 'player-a',
      clientId: 'player-a-client',
      userId: 'player-a-user',
      sentAt: Date.now(),
    })
    expect(applied).toEqual([incoming])

    bus.handler?.({
      event: 'state-request',
      data: {
        v: NET_PROTOCOL,
        kind: 'state-request',
        seq: 1,
        data: { of: TREE_KIND },
      },
      sessionId: 'player-b',
      clientId: 'player-b-client',
      userId: 'player-b-user',
      sentAt: Date.now(),
    })
    expect(bus.published).toHaveLength(afterRequest)
  })
})
