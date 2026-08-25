import { BaseNode, nodeType, objectId } from '@pascal-app/core'
import { z } from 'zod'

/** The trades a job marker can call for. The string persists in scene JSON. */
export const JobKind = z.enum(['fix', 'paint', 'install', 'clean', 'inspect'])
export type JobKind = z.infer<typeof JobKind>

/** Punch-list lifecycle — a job is open until someone walks up and does it. */
export const JobStatus = z.enum(['open', 'done'])
export type JobStatus = z.infer<typeof JobStatus>

/**
 * Schema for a placed job marker — a punch-list cone standing where work is
 * needed. Composed from the public `BaseNode` exactly the way built-in node
 * kinds are — `objectId`/`nodeType` come from `@pascal-app/core`, so the
 * plugin needs no private host internals to mint a persistable node.
 */
export const JobNode = BaseNode.extend({
  id: objectId('job'),
  type: nodeType('boots:job'),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  job: JobKind.default('fix'),
  status: JobStatus.default('open'),
})
export type JobNode = z.infer<typeof JobNode>
