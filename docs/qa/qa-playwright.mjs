/**
 * WHERE PLAYWRIGHT LIVES, for harnesses that are not in the package that owns it.
 *
 * plugin-boots has no browser automation dependency of its own — the suite is
 * `bun test` — so `import { chromium } from 'playwright'` from a file in this
 * directory fails no matter which directory you run node from. Bare-specifier
 * resolution walks up from the IMPORTING FILE's own path, never from cwd, so
 * `cd private-editor && node .../docs/qa/foo.mjs` fails exactly like every other
 * invocation. That is the trap this module exists to close: the error is
 * `ERR_MODULE_NOT_FOUND: Cannot find package 'playwright'` and it reads like a
 * missing install rather than a resolution rule.
 *
 * So the harnesses ask for the browser here and this file goes looking:
 *
 *   1. `playwright` proper, in case a future install does give the plugin one,
 *   2. `$QA_PLAYWRIGHT`, an explicit override for any other checkout layout,
 *   3. the sibling app that already has it — private-editor beside us in the
 *      same parent directory, which is how these repos are actually cloned.
 *
 * The sibling path is a documented assumption, not a guess: if the two repos are
 * not siblings the override in (2) is the answer, and the throw below says so
 * instead of leaving a stack trace about package.json.
 */
import { pathToFileURL } from 'node:url'

const SIBLING = new URL('../../../private-editor/node_modules/playwright/index.mjs', import.meta.url)

/**
 * A file URL for an override, whether the operator named the package directory
 * or the ESM entry inside it. Importing a directory is its own error class
 * (`ERR_UNSUPPORTED_DIR_IMPORT`) that the loop below would rethrow as a failure
 * of the whole lookup, so the common form gets its entry point appended here.
 */
function overrideHref(value) {
  const entry = /\.(mjs|js)$/.test(value) ? value : `${value.replace(/\/$/, '')}/index.mjs`
  return pathToFileURL(entry).href
}

const CANDIDATES = [
  'playwright',
  process.env.QA_PLAYWRIGHT ? overrideHref(process.env.QA_PLAYWRIGHT) : null,
  SIBLING.href,
].filter(Boolean)

async function load() {
  const tried = []
  for (const specifier of CANDIDATES) {
    try {
      return await import(specifier)
    } catch (error) {
      // Only a resolution failure is worth walking past. A playwright that is
      // present but broken (a half-installed browser, a native build for the
      // wrong arch) must surface as itself rather than being reported as
      // "not found anywhere", which sends the next reader to `bun install`.
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
      tried.push(specifier)
    }
  }
  throw new Error(
    `qa: playwright not found. Tried:\n  ${tried.join('\n  ')}\n` +
      'Point QA_PLAYWRIGHT at a playwright install (the directory, e.g. ' +
      '/path/to/repo/node_modules/playwright) and run again.',
  )
}

const playwright = await load()

export const { chromium, devices, firefox, webkit } = playwright
