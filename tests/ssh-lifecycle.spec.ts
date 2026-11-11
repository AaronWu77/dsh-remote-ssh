import { ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { connectOwnedWebSocket, ownSshProcess } from '../src/ssh-lifecycle.ts'

describe('owned SSH startup resources', () => {
  it('bounds an unacknowledged kill, retains the stopper, and verifies close on explicit retry', async () => {
    vi.useFakeTimers()
    const child = new ChildProcess()
    const kill = vi.spyOn(child, 'kill').mockReturnValue(true)
    const stop = ownSshProcess(child)
    try {
      const first = stop(50)
      expect(stop(50)).toBe(first)
      const failed = expect(first).rejects.toMatchObject({ code: 'cleanup_failed' })
      await vi.advanceTimersByTimeAsync(100)
      await failed
      expect(kill.mock.calls).toEqual([[], ['SIGKILL']])
      child.emit('close', null)
      await stop(50)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers(); kill.mockRestore() }
  })

  it('awaits child close and permits repeated teardown', async () => {
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stop = ownSshProcess(child)
    onTestFinished(() => stop(100))
    await once(child.stdout, 'data')
    let closed = false
    child.on('close', () => { closed = true })
    await stop(100)
    expect(closed).toBe(true)
    await stop(100)
  })

  it('closes a stalled WebSocket upgrade on cancellation', async () => {
    const server = createServer()
    const sockets = new Set<import('node:net').Socket>()
    let clientGone!: () => void
    const gone = new Promise<void>(resolve => { clientGone = resolve })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('data', () => {})
      socket.on('close', () => { sockets.delete(socket); clientGone() })
    })
    onTestFinished(async () => {
      for (const socket of sockets) socket.destroy()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('listener address missing')
    const controller = new AbortController()
    const connected = once(server, 'connection')
    const pending = connectOwnedWebSocket('ws://127.0.0.1:' + address.port, controller.signal)
    const rejected = expect(pending).rejects.toThrow('cancelled test connection')
    await connected
    controller.abort(new Error('cancelled test connection'))
    await rejected
    await gone
    expect(sockets.size).toBe(0)
  })
})
