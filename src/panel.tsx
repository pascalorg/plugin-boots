'use client'

import { type AnyNode, type AnyNodeId, useScene } from '@pascal-app/core'
import { useEditor } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import { useMemo } from 'react'
import { flushSync } from 'react-dom'
import { JobNode } from './schema'

const JOB_KIND = 'boots:job'

/**
 * Duck-typed host call: `setFirstPersonMode` ships in current hosts but not
 * in the published editor types this package compiles against. The flushSync
 * mirrors the host's own overlay button — FirstPersonControls must mount
 * synchronously inside the click gesture, or the browser denies the
 * pointer-lock request it makes on mount.
 */
function walkTheJob() {
  const editor = useEditor.getState() as unknown as {
    setFirstPersonMode?: (value: boolean) => void
  }
  if (!editor.setFirstPersonMode) return
  flushSync(() => editor.setFirstPersonMode?.(true))
}

function postJob() {
  const levelId = useViewer.getState().selection.levelId
  if (!levelId) return
  // Scatter near the level origin — markers are movable; precise placement
  // happens by dragging (or, next, by pointing at the spot in first person).
  const scatter = () => Math.round((Math.random() * 4 - 2) * 10) / 10
  const job = JobNode.parse({ position: [scatter(), 0, scatter()] })
  useScene.getState().createNode(job as unknown as AnyNode, levelId as AnyNodeId)
  useViewer.getState().setSelection({ selectedIds: [job.id as AnyNodeId] })
}

function selectJob(id: string) {
  useViewer.getState().setSelection({ selectedIds: [id as AnyNodeId] })
}

function toggleJob(job: JobNode) {
  const status = job.status === 'done' ? 'open' : 'done'
  useScene.getState().updateNode(job.id as AnyNodeId, { status } as never)
}

const JOB_LABEL: Record<JobNode['job'], string> = {
  fix: 'Fix',
  paint: 'Paint',
  install: 'Install',
  clean: 'Clean',
  inspect: 'Inspect',
}

/**
 * The Boots left-rail panel — clock in, walk the job in first person, and
 * work the punch list. The list is live scene state: every `boots:job`
 * marker in the scene, whatever level it stands on.
 */
export default function BootsPanel() {
  const nodes = useScene((s) => s.nodes)
  const levelId = useViewer((s) => s.selection.levelId)

  const jobs = useMemo(() => {
    const all = Object.values(nodes as Record<string, { type?: string }>)
    const parsed: JobNode[] = []
    for (const node of all) {
      if (node?.type !== JOB_KIND) continue
      const result = JobNode.safeParse(node)
      if (result.success) parsed.push(result.data)
    }
    return parsed.sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'open' ? -1 : 1))
  }, [nodes])

  const open = jobs.filter((j) => j.status === 'open').length

  return (
    <div className="flex flex-col gap-4 p-4 text-sidebar-foreground">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-base">Boots</h2>
          <span className="rounded-full border border-sidebar-border/60 bg-sidebar-accent px-1.5 py-px font-semibold text-[9px] text-sidebar-foreground/70 uppercase tracking-widest">
            Beta
          </span>
        </div>
        <p className="text-sidebar-foreground/50 text-xs leading-relaxed">
          Put your boots on. Walk the job in first person and work the punch list from the ground.
        </p>
      </header>

      <button
        className="flex w-full items-center justify-center gap-2 rounded-md bg-sidebar-accent px-3 py-2 font-semibold text-sm hover:bg-sidebar-accent/80"
        onClick={walkTheJob}
        type="button"
      >
        ⏵ Walk the job
      </button>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-xs uppercase tracking-wider text-sidebar-foreground/70">
            Punch list
          </h3>
          <span className="text-[11px] text-sidebar-foreground/50">
            {open} open / {jobs.length}
          </span>
        </div>

        {jobs.length === 0 ? (
          <p className="text-sidebar-foreground/50 text-xs leading-relaxed">
            No jobs yet. Post one — a cone lands in the scene where the work is.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {jobs.map((job) => (
              <li className="flex items-center gap-2" key={job.id}>
                <input
                  checked={job.status === 'done'}
                  className="accent-orange-500"
                  onChange={() => toggleJob(job)}
                  type="checkbox"
                />
                <button
                  className={`flex-1 truncate text-left text-xs hover:underline ${
                    job.status === 'done'
                      ? 'text-sidebar-foreground/40 line-through'
                      : 'text-sidebar-foreground/80'
                  }`}
                  onClick={() => selectJob(job.id)}
                  type="button"
                >
                  {JOB_LABEL[job.job]}
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          className="rounded-md border border-sidebar-border/60 px-3 py-1.5 text-xs hover:bg-sidebar-accent/60 disabled:opacity-40"
          disabled={!levelId}
          onClick={postJob}
          type="button"
        >
          + Post a job
        </button>
        {!levelId && (
          <p className="text-[11px] text-sidebar-foreground/40">Select a level to post jobs.</p>
        )}
      </section>
    </div>
  )
}
