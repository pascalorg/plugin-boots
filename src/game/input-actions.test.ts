import { describe, expect, test } from 'bun:test'
import { GAME_KEYS, MIC_KEY, MOVE_ITEM_KEY, takeAction } from './input'
import { MIC_KEY as VOICE_MIC_KEY } from './voice-policy'

/**
 * One-shot action claiming — the shared contract behind E (interact.tsx), M
 * (voice-controls.tsx), and L (item-place.tsx).
 *
 * Both run at frame priority -1 on the SAME array the viewmodel drains a few
 * priorities later, so the thing that has to hold is narrow and unforgiving:
 * exactly the claimed code disappears, everything else survives in its original
 * order, and the array identity never changes. Get any of that wrong and the
 * symptom is not a broken mic — it is a weapon slot key that stops working while
 * somebody is talking, which nobody would ever connect back to voice.
 */

describe('takeAction', () => {
  test('reports nothing on an empty queue and leaves it empty', () => {
    const actions: string[] = []
    expect(takeAction(actions, 'KeyM')).toBe(false)
    expect(actions).toEqual([])
  })

  test('claims its own code and removes it', () => {
    const actions = ['KeyM']
    expect(takeAction(actions, 'KeyM')).toBe(true)
    expect(actions).toEqual([])
  })

  test('leaves a queue that does not contain it completely untouched', () => {
    const actions = ['Digit1', 'KeyE', 'WheelUp']
    expect(takeAction(actions, 'KeyM')).toBe(false)
    expect(actions).toEqual(['Digit1', 'KeyE', 'WheelUp'])
  })

  test('preserves the ORDER of the survivors around the hole', () => {
    // The viewmodel reads this queue as a sequence — 'Digit1' then 'Digit2' is a
    // different session than the reverse, and compaction must not reorder.
    const actions = ['Digit1', 'KeyM', 'Digit2', 'KeyE', 'Digit3']
    expect(takeAction(actions, 'KeyM')).toBe(true)
    expect(actions).toEqual(['Digit1', 'Digit2', 'KeyE', 'Digit3'])
  })

  test('consumes EVERY copy — an auto-repeating held key is still one intent', () => {
    // A key held past the OS repeat delay pushes many entries. Consuming one per
    // frame would toggle the mic on and off for as long as the finger is down.
    const actions = ['KeyM', 'Digit1', 'KeyM', 'KeyM']
    expect(takeAction(actions, 'KeyM')).toBe(true)
    expect(actions).toEqual(['Digit1'])
  })

  test('mutates in place — the frame loop holds this exact array', () => {
    // Everyone at every priority captured `session.input.state.actions` already;
    // returning a new array would silently strand all of them on the old one.
    const actions = ['KeyE', 'KeyM']
    const same = actions
    takeAction(actions, 'KeyM')
    expect(same).toBe(actions)
    expect(same).toEqual(['KeyE'])
  })

  test('two claimants in one frame each get their own key', () => {
    // E and M are read by different components on the same frame. Whichever runs
    // first must not eat the other's press.
    const actions = ['KeyE', 'KeyM']
    expect(takeAction(actions, 'KeyE')).toBe(true)
    expect(takeAction(actions, 'KeyM')).toBe(true)
    expect(actions).toEqual([])
  })

  test('claiming twice does not fire twice', () => {
    const actions = ['KeyM']
    expect(takeAction(actions, 'KeyM')).toBe(true)
    expect(takeAction(actions, 'KeyM')).toBe(false)
  })

  test('the codes taken this way are codes the game actually claims', () => {
    // An unclaimed code never reaches the queue in the first place — it goes to
    // the host editor and runs a tool mid-session.
    expect(GAME_KEYS.has('KeyE')).toBe(true)
    expect(GAME_KEYS.has('KeyM')).toBe(true)
    expect(GAME_KEYS.has(MOVE_ITEM_KEY)).toBe(true)
  })
})

/**
 * MIC_KEY lives in input.ts (the set that claims the code) and voice-policy.ts
 * carries a copy for the labels the mic pill and the hints print. The two are
 * pinned equal here: a rebind on one side only would either print a key that
 * does nothing or leave the real key unclaimed — and an unclaimed code reaches
 * the host editor and runs a tool mid-session.
 */

describe('MIC_KEY', () => {
  test('is the physical M, claimed by the game, and the code voice-policy labels', () => {
    expect(MIC_KEY).toBe('KeyM')
    expect(GAME_KEYS.has(MIC_KEY)).toBe(true)
    expect(VOICE_MIC_KEY).toBe(MIC_KEY)
  })

  test('furniture move has its own physical key', () => {
    expect(MOVE_ITEM_KEY).toBe('KeyL')
    expect(MOVE_ITEM_KEY).not.toBe(MIC_KEY)
  })
})
