import { jobEditContribution } from './definition.edit'
import { jobRenderDefinition } from './definition.render'

/**
 * The job-marker node definition. A punch-list cone: place it where work is
 * needed, walk up to it in first person, do the work, flip it to done.
 * `parametrics` gives the inspector for free; the Boots panel lists every
 * marker in the scene as the working punch list.
 *
 * Composed from the render half (`definition.render.ts`, what read-only
 * viewers load through `@pascal-app/plugin-boots/render`) and the editing half
 * (`definition.edit.ts`).
 */
export const jobDefinition = {
  ...jobRenderDefinition,
  ...jobEditContribution,
}
