/** Source-plane candidate sequencing; fake only SSH and loopback transport boundaries. */
import { Context } from '@deepseek-ai/cordis'
import { AhpErrorCodes } from '@microsoft/agent-host-protocol'
import { InMemoryTransport } from '@microsoft/agent-host-protocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSshRuntime } from '../src/index.ts'
const state = vi.hoisted(() => ({ commands: [] as string[], negotiations: 0, acceptSecond: false, standaloneExit: 127, active: new Set<object>(), tasks: [] as Promise<void>[] }))
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return { spawn: (_exe: string, args: string[]) => {
    class Child extends EventEmitter {
      stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough()
      exitCode: number | null = null
      close(code: number | null) { if (!state.active.delete(this)) return; this.exitCode = code; this.emit('close', code) }
      kill() { queueMicrotask(() => this.close(null)); return true }
    }
    const child = new Child(); state.active.add(child)
    const command = args.at(-1)!; state.commands.push(command)
    queueMicrotask(() => {
      if (args.includes('-N')) return
      if (command.includes('find "$HOME/.vscode-server')) {
        child.stdout.write('/new/server/bin/code-server\n/old/server/bin/code-server\n/new/server/bin/code-server\n')
        child.close(0)
      } else if (command.includes('exec "$dsh_code_server"')) {
        child.stdout.write('DSH_AGENT_HOST_PID=12345\nAgent host server listening on 127.0.0.1:45678\n')
      } else if (command.startsWith('cat ')) { child.stdout.write('fixture-token'); child.close(0) }
      else if (command.startsWith('dsh_pid=')) child.close(0)
      else child.close(state.standaloneExit)
    })
    return child
  } }
})
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    createServer: () => Object.assign(new EventEmitter(), { listen(_port: number, _host: string, ready: () => void) { queueMicrotask(ready) }, address: () => ({ port: 54321 }), close(done?: () => void) { done?.() } }),
    createConnection: () => { const socket = Object.assign(new EventEmitter(), { destroy() {} }); queueMicrotask(() => socket.emit('connect')); return socket },
  }
})
vi.mock('../src/ssh-lifecycle.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../src/ssh-lifecycle.ts')>()
  return { ...real, connectOwnedWebSocket: async () => {
    const [client, server] = InMemoryTransport.pair()
    const attempt = ++state.negotiations
    state.tasks.push((async () => {
      for (;;) {
        const frame = await server.recv()
        if (frame === null) return
        if (frame.kind !== 'text') continue
        const request = JSON.parse(frame.text)
        if (request.id === undefined) continue
        const result = request.method === 'initialize' ? { protocolVersion: '0.9.0', serverSeq: 0, snapshots: [] } : {}
        if (request.method === 'initialize' && !(state.acceptSecond && attempt === 2)) {
          server.send({ jsonrpc: '2.0', id: request.id, error: { code: AhpErrorCodes.UnsupportedProtocolVersion, message: 'fixture mismatch', data: { supportedVersions: ['^9.0.0'] } } })
        } else server.send({ jsonrpc: '2.0', id: request.id, result })
      }
    })())
    return client
  } }
})
afterEach(async () => { await Promise.all(state.tasks); state.tasks = []; expect(state.active.size).toBe(0); state.commands = []; state.negotiations = 0; state.acceptSecond = false; state.standaloneExit = 127 })
async function run(acceptSecond: boolean) {
  state.acceptSecond = acceptSecond
  const ctx = new Context()
  try {
    const runtime = new RemoteSshRuntime(ctx, { sshTarget: 'fixture', sshExecutable: 'fixture-ssh', sshArgs: [], remoteCodeCommand: 'code', remoteRuntimeRoot: '/tmp/fixture', startupTimeoutMs: 60000, shutdownTimeoutMs: 1, requestTimeoutMs: 1000, protocolVersions: ['0.9.0'] })
    if (acceptSecond) expect((await runtime.getConnection()).protocolVersion).toBe('0.9.0')
    else {
      const error = await runtime.getConnection().catch(error => error)
      expect(error.code).toBe('agent_host_unavailable')
      expect(error.message).toContain('standalone CLI (ssh exit ' + state.standaloneExit + ')')
      expect(error.message).toContain('AHP protocol mismatch: client offered [0.9.0], Agent Host accepts [^9.0.0]')
      expect(error.message.indexOf('embedded /new/')).toBeLessThan(error.message.indexOf('embedded /old/'))
    }
    const first = state.commands.findIndex(command => command.includes("dsh_code_server='/new/"))
    const cleanup = state.commands.findIndex(command => command.startsWith('dsh_pid='))
    const second = state.commands.findIndex(command => command.includes("dsh_code_server='/old/"))
    expect(first).toBeGreaterThan(0); expect(cleanup).toBeGreaterThan(first); expect(second).toBeGreaterThan(cleanup)
    expect(state.negotiations).toBe(2)
  } finally { await ctx.fiber.dispose() }
}
describe('candidate fallback ordering and AHP diagnostics', () => {
  it('retains protocol failures after standalone exit 255 when embedded discovery succeeds', async () => { state.standaloneExit = 255; await run(false) })
  it('reports each protocol failure newest-first and cleans the owned candidate before fallback', async () => { await run(false) })
  it('can still use a compatible older candidate after a protocol failure', async () => { await run(true) })
})
