/** Owned SSH processes and cancellable WebSocket startup. */
import type { ChildProcess } from 'node:child_process'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'

/**
 * Register process completion before startup listeners can settle.
 * @param child - A newly spawned SSH child owned by the caller.
 * @returns A stopper that waits for close, escalating after the configured grace.
 */
export function ownSshProcess(child: ChildProcess): (graceMs: number) => Promise<void> {
  let closed = false
  const done = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve() }))
  child.on('error', () => { /* Spawn failures also emit close; startup owns their diagnostic. */ })
  return async graceMs => {
    if (closed) return
    child.kill()
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
    try { await done } finally { clearTimeout(timer) }
  }
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
