/** Owned SSH processes and cancellable WebSocket startup. */
import type { ChildProcess } from 'node:child_process'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'
import { SshProcessCleanupError } from './connection-error.ts'

/**
 * Register process completion before startup listeners can settle.
 * @param child - A newly spawned SSH child owned by the caller.
 * @returns A stopper that waits for close, escalating after the configured grace.
 */
export function ownSshProcess(child: ChildProcess): (graceMs: number) => Promise<void> {
  let closed = false
  const done = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve() }))
  child.on('error', () => { /* Spawn failures also emit close; startup owns their diagnostic. */ })
  let stopping: Promise<void> | undefined
  const stop = (graceMs: number): Promise<void> => {
    if (closed) return Promise.resolve()
    if (stopping) return stopping
    stopping = (async () => {
      child.kill()
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([done, new Promise<never>((_resolve, reject) => {
          forceTimer = setTimeout(() => child.kill('SIGKILL'), graceMs)
          deadlineTimer = setTimeout(() => reject(new SshProcessCleanupError(stop)), 2 * graceMs)
        })])
      } finally {
        clearTimeout(forceTimer); clearTimeout(deadlineTimer)
        stopping = undefined
      }
    })()
    return stopping
  }
  return stop
}

/**
 * Own a WebSocket during opening so cancellation closes pending handshakes.
 * @param url - Agent Host endpoint; query credentials must not be logged.
 * @param signal - Connection deadline or runtime disposal.
 * @returns The SDK transport after the socket opens.
 */
export async function connectOwnedWebSocket(url: string, signal: AbortSignal): Promise<WebSocketTransport> {
  signal.throwIfAborted()
  const socket = new WebSocket(url)
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', failed)
        signal.removeEventListener('abort', aborted)
      }
      const opened = (): void => { cleanup(); resolve() }
      const failed = (): void => { cleanup(); reject(new Error('dsh-remote-ssh: Agent Host WebSocket failed to open')) }
      const aborted = (): void => { cleanup(); reject(signal.reason) }
      socket.addEventListener('open', opened)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', failed)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
    })
    signal.throwIfAborted()
    return WebSocketTransport.fromSocket(socket)
  } catch (error) {
    socket.close()
    throw error
  }
}
