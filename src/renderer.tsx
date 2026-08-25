'use client'

import { useRegistry } from '@pascal-app/core'
import { useNodeEvents } from '@pascal-app/viewer'
import { useRef } from 'react'
import type { Group } from 'three'
import type { JobNode } from './schema'

/** Site-cone orange while the job is open; jobsite-tape green once done. */
const OPEN_COLOR = '#ff6d1f'
const DONE_COLOR = '#3ecf8e'
const BAND_COLOR = '#f5f0e6'

/**
 * Renderer for a `boots:job` node — a traffic cone with a reflective band.
 * Plain standard materials only: the host renders through WebGPURenderer, so
 * no raw WebGL calls and no depth tricks. Selection / hover outline come from
 * the host via the selectable capability + useNodeEvents + useRegistry trio.
 */
export default function JobRenderer({ node }: { node: JobNode }) {
  const ref = useRef<Group>(null!)
  const handlers = useNodeEvents(node as never, node.type as never)
  useRegistry(node.id, node.type, ref)
  const color = node.status === 'done' ? DONE_COLOR : OPEN_COLOR
  return (
    <group position={node.position} rotation={node.rotation} ref={ref} {...handlers}>
      <mesh castShadow receiveShadow position={[0, 0.015, 0]}>
        <boxGeometry args={[0.36, 0.03, 0.36]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      <mesh castShadow position={[0, 0.29, 0]}>
        <coneGeometry args={[0.155, 0.52, 24]} />
        <meshStandardMaterial color={color} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.3, 0]}>
        <cylinderGeometry args={[0.108, 0.132, 0.1, 24]} />
        <meshStandardMaterial color={BAND_COLOR} roughness={0.4} />
      </mesh>
    </group>
  )
}
