/** Source-plane candidate sequencing; fake only SSH and loopback transport boundaries. */
import { Context } from '@deepseek-ai/cordis'
import { AhpErrorCodes } from '@microsoft/agent-host-protocol'
import { InMemoryTransport } from '@microsoft/agent-host-protocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSshRuntime } from '../src/index.ts'
const state = vi.hoisted(() => ({ commands: [] as string[], negotiations: 0, acceptSecond: false, standaloneExit: 127, standaloneHang: false, noEmbedded: false, standaloneSuccess: false, phaseHang: undefined as undefined | 'startup' | 'tunnel' | 'initialize', startedEmbedded: 0, acceptAll: false, active: new Set<object>(), tasks: [] as Promise<void>[] }))
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
        if (!state.noEmbedded) child.stdout.write('/new/server/bin/code-server\n/old/server/bin/code-server\n/new/server/bin/code-server\n')
        child.close(0)
      } else if (command.includes('exec "$dsh_code_server"')) {
        state.startedEmbedded += 1
        child.stdout.write('DSH_AGENT_HOST_PID=12345\n')
        if (state.phaseHang !== 'startup' || state.startedEmbedded !== 1) child.stdout.write('Agent host server listening on 127.0.0.1:45678\n')
      } else if (command.startsWith('cat ')) { child.stdout.write('fixture-token'); child.close(0) }
      else if (command.startsWith('dsh_pid=')) child.close(0)
      else {
        child.stdout.write('DSH_AGENT_HOST_PID=12345\n')
        if (state.standaloneSuccess) child.stdout.write('ws://localhost:45678?tkn=fixture-token\n')
        else if (!state.standaloneHang) child.close(state.standaloneExit)
      }
    })
    return child
  } }
})
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    createServer: () => Object.assign(new EventEmitter(), { listen(_port: number, _host: string, ready: () => void) { queueMicrotask(ready) }, address: () => ({ port: 54321 }), close(done?: () => void) { done?.() } }),
    createConnection: () => { const socket = Object.assign(new EventEmitter(), { destroy() {} }); if (state.phaseHang !== 'tunnel' || state.startedEmbedded !== 1) queueMicrotask(() => socket.emit('connect')); return socket },
  }
})
vi.mock('../src/ssh-lifecycle.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../src/ssh-lifecycle.ts')>()
  return { ...real, connectOwnedWebSocket: async () => {
    const [client, server] = InMemoryTransport.pair()
    state.negotiations += 1
    const attempt = state.startedEmbedded
    state.tasks.push((async () => {
      for (;;) {
        const frame = await server.recv()
        if (frame === null) return
        if (frame.kind !== 'text') continue
        const request = JSON.parse(frame.text)
        if (request.id === undefined) continue
        if (request.method === 'initialize' && state.phaseHang === 'initialize' && attempt === 1) continue
        const result = request.method === 'initialize' ? { protocolVersion: '0.9.0', serverSeq: 0, snapshots: [] } : {}
        if (request.method === 'initialize' && !(state.acceptAll || state.acceptSecond && attempt === 2)) {
          server.send({ jsonrpc: '2.0', id: request.id, error: { code: AhpErrorCodes.UnsupportedProtocolVersion, message: 'fixture mismatch', data: { supportedVersions: ['^9.0.0'] } } })
        } else server.send({ jsonrpc: '2.0', id: request.id, result })
      }
    })())
    return client
  } }
})
afterEach(async () => { await Promise.all(state.tasks); state.tasks = []; expect(state.active.size).toBe(0); state.commands = []; state.negotiations = 0; state.acceptSecond = false; state.standaloneExit = 127; state.standaloneHang = false; state.noEmbedded = false; state.standaloneSuccess = false; state.phaseHang = undefined; state.startedEmbedded = 0; state.acceptAll = false; vi.useRealTimers() })
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
  it('reaches compatible installed hosts before a hanging default CLI can consume the startup budget', async () => {
    state.acceptSecond = true; state.standaloneHang = true
    const ctx = new Context()
    try {
      const runtime = new RemoteSshRuntime(ctx, { sshTarget: 'fixture', sshExecutable: 'fixture-ssh', sshArgs: [], remoteCodeCommand: 'code', remoteRuntimeRoot: '/tmp/fixture', startupTimeoutMs: 60000, shutdownTimeoutMs: 1, requestTimeoutMs: 1000, protocolVersions: ['0.9.0'] })
      const pending = runtime.getConnection()
      void pending.catch(() => {})
      for (let index = 0; index < 1000 && state.negotiations < 2; index += 1) await Promise.resolve()
      expect(state.negotiations).toBe(2)
      expect((await pending).protocolVersion).toBe('0.9.0')
      expect(state.commands.some(command => command.includes('exec "$dsh_code" agent host'))).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['startup', 'tunnel', 'initialize'] as const)('bounds a hanging embedded %s phase, cleans it, then tries the older candidate', async phase => {
    vi.useFakeTimers()
    state.phaseHang = phase; state.acceptAll = true
    const ctx = new Context()
    try {
      const runtime = new RemoteSshRuntime(ctx, { sshTarget: 'fixture', sshExecutable: 'fixture-ssh', sshArgs: [], remoteCodeCommand: 'code', remoteRuntimeRoot: '/tmp/fixture', startupTimeoutMs: 1000, embeddedStartupTimeoutMs: 100, standaloneStartupTimeoutMs: 200, shutdownTimeoutMs: 10, requestTimeoutMs: 1000, protocolVersions: ['0.9.0'] })
      const pending = runtime.getConnection()
      void pending.catch(() => {})
      for (let index = 0; index < 1000 && state.startedEmbedded < 1; index += 1) await Promise.resolve()
      expect(state.startedEmbedded).toBe(1)
      await vi.advanceTimersByTimeAsync(100)
      expect((await pending).protocolVersion).toBe('0.9.0')
      const cleanup = state.commands.findIndex(command => command.startsWith('dsh_pid='))
      const second = state.commands.findIndex(command => command.includes("dsh_code_server='/old/"))
      expect(cleanup).toBeGreaterThan(0)
      expect(second).toBeGreaterThan(cleanup)
      expect(state.startedEmbedded).toBe(2)
      expect(state.commands.some(command => command.includes('exec "$dsh_code" agent host'))).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['code', '/custom/code'])('owns foreground standalone %s and reconnects only after verified PID cleanup', async remoteCodeCommand => {
    state.noEmbedded = true; state.standaloneSuccess = true; state.acceptAll = true
    const ctx = new Context()
    try {
      const runtime = new RemoteSshRuntime(ctx, { sshTarget: 'fixture', sshExecutable: 'fixture-ssh', sshArgs: [], remoteCodeCommand, remoteRuntimeRoot: '/tmp/fixture', startupTimeoutMs: 1000, shutdownTimeoutMs: 10, requestTimeoutMs: 1000, protocolVersions: ['0.9.0'] })
      expect(runtime.config.embeddedStartupTimeoutMs).toBe(15000)
      expect(runtime.config.standaloneStartupTimeoutMs).toBe(30000)
      const first = await runtime.getConnection()
      expect(runtime.hasUntrackedStandalone()).toBe(false)
      await first.client.shutdown()
      const [second, concurrent] = await Promise.all([runtime.getConnection(), runtime.getConnection()])
      expect(second.client).not.toBe(first.client)
      expect(concurrent).toBe(second)
      const launches = state.commands.filter(command => command.includes('--new-instance --foreground'))
      expect(launches).toHaveLength(2)
      const firstLaunch = state.commands.indexOf(launches[0]!)
      const secondLaunch = state.commands.lastIndexOf(launches[1]!)
      const cleanup = state.commands.findIndex(command => command.startsWith('dsh_pid='))
      expect(cleanup).toBeGreaterThan(firstLaunch)
      expect(secondLaunch).toBeGreaterThan(cleanup)
      if (remoteCodeCommand !== 'code') expect(state.commands.some(command => command.includes('find '))).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('bounds a hanging standalone fallback without replay or background startup', async () => {
    vi.useFakeTimers()
    state.noEmbedded = true; state.standaloneHang = true
    const ctx = new Context()
    try {
      const runtime = new RemoteSshRuntime(ctx, { sshTarget: 'fixture', sshExecutable: 'fixture-ssh', sshArgs: [], remoteCodeCommand: 'code', remoteRuntimeRoot: '/tmp/fixture', startupTimeoutMs: 1000, embeddedStartupTimeoutMs: 100, standaloneStartupTimeoutMs: 200, shutdownTimeoutMs: 10, requestTimeoutMs: 1000, protocolVersions: ['0.9.0'] })
      const pending = runtime.getConnection()
      const failed = expect(pending).rejects.toMatchObject({ code: 'agent_host_unavailable', message: expect.stringContaining('timed out') })
      for (let index = 0; index < 1000 && !state.commands.some(command => command.includes('--foreground')); index += 1) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(200)
      await failed
      expect(state.commands.filter(command => command.includes('--foreground'))).toHaveLength(1)
      expect(state.commands.filter(command => command.startsWith('dsh_pid='))).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(state.commands.filter(command => command.includes('--foreground'))).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('retains protocol failures after standalone exit 255 when embedded discovery succeeds', async () => { state.standaloneExit = 255; await run(false) })
  it('reports each protocol failure newest-first and cleans the owned candidate before fallback', async () => { await run(false) })
  it('can still use a compatible older candidate after a protocol failure', async () => { await run(true) })
})
