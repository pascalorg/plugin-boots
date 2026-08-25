'use client'

import { Component, type ReactNode } from 'react'
import { exitGame } from './session'

/**
 * The game's own error boundary. Without it, any exception in the game
 * subtree bubbles to the HOST viewer's boundary, which unmounts the whole
 * scene — the user gets a frozen fullscreen frame with every input still
 * swallowed (prod incident 2026-08-25). Here we catch, log, and unwind the
 * session cleanly instead: the editor comes back exactly as it was.
 */
export class GameBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false }

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error('[boots] game crashed — restoring the editor', error)
    try {
      exitGame()
    } catch {
      // restore-path failures must not mask the original crash
    }
  }

  override render(): ReactNode {
    if (this.state.crashed) return null
    return this.props.children
  }
}
