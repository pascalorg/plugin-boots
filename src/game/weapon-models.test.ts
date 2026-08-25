import { describe, expect, test } from 'bun:test'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import {
  BootsPairModel,
  GrenadeModel,
  HammerModel,
  KnifeModel,
  MinigunModel,
  MUZZLE_OFFSETS,
  PistolModel,
  RifleModel,
  SirenBeaconModel,
  WarhammerModel,
} from './weapon-models'

/**
 * Render tests for the primitive weapon/prop models. Every component is
 * static JSX over r3f host tags, so two cheap checks cover the contract:
 * renderToString proves the tree serializes without throwing (no undefined
 * components, no invalid children), and a direct element-tree walk verifies
 * the structural promises consumers rely on (WebGPU-safe materials, the
 * beacon's tagged light group, the pair of boots).
 */

const MODELS: ReadonlyArray<readonly [string, () => ReactElement]> = [
  ['PistolModel', PistolModel],
  ['RifleModel', RifleModel],
  ['MinigunModel', MinigunModel],
  ['KnifeModel', KnifeModel],
  ['HammerModel', HammerModel],
  ['WarhammerModel', WarhammerModel],
  ['GrenadeModel', GrenadeModel],
  ['BootsPairModel', BootsPairModel],
  ['SirenBeaconModel', SirenBeaconModel],
]

type ElementProps = { children?: ReactNode; userData?: { role?: string } } & Record<
  string,
  unknown
>

/** Depth-first walk over a static element tree (host tags + arrays only). */
function walk(node: ReactNode, visit: (el: ReactElement<ElementProps>) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isValidElement<ElementProps>(node)) return
  visit(node)
  walk(node.props.children, visit)
}

function tags(root: ReactElement): string[] {
  const out: string[] = []
  walk(root, (el) => {
    if (typeof el.type === 'string') out.push(el.type)
  })
  return out
}

/** react-dom/server doesn't know r3f host tags — it renders them fine but
 * logs casing/attribute warnings. Silence console.error for the duration. */
function renderQuietly(Model: () => ReactElement): string {
  const original = console.error
  console.error = () => {}
  try {
    return renderToString(createElement(Model))
  } finally {
    console.error = original
  }
}

describe('every model renderToString\'s', () => {
  for (const [name, Model] of MODELS) {
    test(name, () => {
      const html = renderQuietly(Model)
      expect(html.length).toBeGreaterThan(0)
      expect(html).toContain('<group')
      expect(html).toContain('<mesh')
    })
  }
})

describe('WebGPU-safe materials only', () => {
  for (const [name, Model] of MODELS) {
    test(`${name} uses standard/basic materials and one material per mesh`, () => {
      const all = tags(Model())
      const materials = all.filter((t) => t.toLowerCase().includes('material'))
      const meshes = all.filter((t) => t === 'mesh')
      expect(materials.length).toBe(meshes.length)
      for (const material of materials) {
        expect(['meshStandardMaterial', 'meshBasicMaterial']).toContain(material)
      }
    })
  }
})

describe('structural contracts', () => {
  test('MUZZLE_OFFSETS covers every flash-indexable weapon id', () => {
    expect(Object.keys(MUZZLE_OFFSETS).sort()).toEqual(['hammer', 'minigun', 'pistol', 'rifle'])
  })

  test('WarhammerModel has the back spike (cone) and a long haft', () => {
    const all = tags(WarhammerModel())
    expect(all).toContain('coneGeometry')
    expect(all.filter((t) => t === 'cylinderGeometry').length).toBeGreaterThan(2)
  })

  test('GrenadeModel has the pull-pin ring (torus)', () => {
    expect(tags(GrenadeModel())).toContain('torusGeometry')
  })

  test('BootsPairModel is a mirrored pair sitting on y=0', () => {
    const groups: ReactElement<ElementProps>[] = []
    walk(BootsPairModel(), (el) => {
      if (el.type === 'group' && Array.isArray(el.props.position)) groups.push(el)
    })
    expect(groups.length).toBe(2)
    const xs = groups.map((g) => (g.props.position as number[])[0]!).sort((a, b) => a - b)
    expect(xs[0]).toBeLessThan(0)
    expect(xs[1]).toBeGreaterThan(0)
    expect(xs[0]).toBeCloseTo(-xs[1]!, 5)
    // Soles rest on the tabletop: no mesh dips below y=0.
    walk(BootsPairModel(), (el) => {
      if (el.type === 'mesh' && Array.isArray(el.props.position)) {
        expect((el.props.position as number[])[1]!).toBeGreaterThanOrEqual(0)
      }
    })
  })

  test('SirenBeaconModel tags its rotating light bar for consumers', () => {
    let light: ReactElement<ElementProps> | null = null
    walk(SirenBeaconModel(), (el) => {
      if (el.type === 'group' && el.props.userData?.role === 'beacon-light') light = el
    })
    expect(light).not.toBeNull()
    const inner = tags(light!)
    // The tagged group actually contains lamp meshes to sweep around.
    expect(inner.filter((t) => t === 'mesh').length).toBeGreaterThanOrEqual(2)
  })

  test('SirenBeaconModel dome is translucent so the bar reads through', () => {
    let translucent = 0
    walk(SirenBeaconModel(), (el) => {
      if (
        el.type === 'meshStandardMaterial' &&
        el.props.transparent === true &&
        typeof el.props.opacity === 'number' &&
        el.props.opacity < 1
      ) {
        translucent++
      }
    })
    expect(translucent).toBeGreaterThanOrEqual(1)
  })
})
