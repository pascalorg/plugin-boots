/**
 * Render-entry boundary gate: bundles `@pascal-app/plugin-boots/render` (every
 * static and lazy import, dependencies included) and fails if anything resolves
 * to `@pascal-app/editor` or `next`. As a self-test it bundles the root entry
 * too, which must fail — the game engine on the system slot reaches the editor.
 *
 * Run: bun run check:render
 */
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { BunPlugin } from 'bun'

const root = resolve(import.meta.dir, '..')
const forbiddenSpecifier = /^(?:@pascal-app\/editor|next)(?:\/|$)/
const forbiddenPath = /(?:^|\/)node_modules\/(?:@pascal-app\/editor|next)(?:\/|$)/

function boundary(violations: string[]): BunPlugin {
  return {
    name: 'render-boundary',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // three's examples barrel carries CDN URL imports; they are not packages.
        if (/^https?:\/\//.test(args.path)) return { path: args.path, external: true }
        if (forbiddenSpecifier.test(args.path)) {
          violations.push(`${args.path} (imported by ${args.importer})`)
          return { path: args.path, external: true }
        }
        let resolved: string | undefined
        try {
          resolved = realpathSync(Bun.resolveSync(args.path, dirname(args.importer || root)))
        } catch {
          return undefined // let the bundler report a genuinely unresolvable import
        }
        if (forbiddenPath.test(resolved.replaceAll('\\', '/'))) {
          violations.push(`${resolved} (imported by ${args.importer})`)
          return { path: args.path, external: true }
        }
        return undefined
      })
    },
  }
}

async function check(entry: string) {
  const violations: string[] = []
  const result = await Bun.build({
    entrypoints: [resolve(root, entry)],
    target: 'browser',
    splitting: true,
    throw: false,
    loader: { '.glb': 'file', '.webp': 'file', '.jpg': 'file', '.png': 'file' },
    plugins: [boundary(violations)],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`Bundling ${entry} failed`)
  }
  return violations
}

const renderViolations = await check('src/render.ts')
if (renderViolations.length) {
  console.error('src/render.ts reaches forbidden render dependencies:')
  for (const v of renderViolations) console.error(`  - ${v}`)
  process.exit(1)
}

const rootViolations = await check('src/index.ts')
if (!rootViolations.length) {
  console.error('Self-test failed: the root entry should reach @pascal-app/editor via the game system')
  process.exit(1)
}

console.log('check:render ok — ./render reaches neither @pascal-app/editor nor next')
