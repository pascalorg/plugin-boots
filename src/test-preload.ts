import { mock } from 'bun:test'

/**
 * bun-test preload (wired via bunfig.toml [test].preload).
 *
 * WHY THIS EXISTS — the 2026-08-25 prod hotfix gave session.ts top-level
 * `useEditor` / `useViewer` imports (it forces 3d/perspective view on Jump
 * in). In the HOST those packages resolve through the app bundler and are
 * fine; under `bun test` they load for real, and @pascal-app/viewer's dist
 * imports `three/examples/jsm/Addons.js` — a barrel whose TTFLoader /
 * LottieLoader use CDN URL imports (`https://cdn.jsdelivr.net/npm/...`)
 * that bun cannot resolve offline (ENOENT), while @pascal-app/editor ships
 * src-only and drags the whole editor app graph into every test process
 * (the hour-long 100%-CPU `bun test` hangs of 2026-08-25). Every unit test
 * runs headless game logic; none exercises the real editor/viewer stores,
 * so both packages are mocked wholesale with zustand-shaped stubs.
 *
 * If a future test needs real store behavior, override per-test with
 * `mock.module` in that file — preload mocks are the fallback, not a cage.
 */

/** Minimal zustand-like store: getState/setState/subscribe over a plain
 * object, enough for `useX.getState().field` reads and optional setters. */
function stubStore<T extends Record<string, unknown>>(initial: T) {
  let state = initial
  const listeners = new Set<(s: T) => void>()
  const useStore = (selector?: (s: T) => unknown) => (selector ? selector(state) : state)
  useStore.getState = () => state
  useStore.setState = (partial: Partial<T>) => {
    state = { ...state, ...partial }
    for (const listener of listeners) listener(state)
  }
  useStore.subscribe = (listener: (s: T) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return useStore
}

mock.module('@pascal-app/editor', () => ({
  useEditor: stubStore({
    viewMode: '3d' as string,
    setViewMode: (() => {}) as (mode: string) => void,
  }),
}))

mock.module('@pascal-app/viewer', () => ({
  useViewer: stubStore({
    cameraMode: 'perspective' as string,
    setCameraMode: (() => {}) as (mode: string) => void,
    // keep.ts reads selection.levelId when converting kept pieces to nodes.
    selection: { levelId: 'level-test' } as { levelId: string | null },
  }),
  // renderer.tsx's hook — inert in headless tests.
  useNodeEvents: () => {},
}))
