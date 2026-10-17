/**
 * Source-plane startup recovery. Only the SSH child-process boundary, the
 * loopback transport, and the AHP wire are replaced; the real runtime owns
 * retry, cleanup ownership and disposal.
 */
import { Context } from '@deepseek-ai/cordis'
import { InMemoryTransport } from '@microsoft/agent-host-protocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSshRuntime } from '../src/index.ts'

const state = vi.hoisted(() => ({
  /** Which boundary the first failing round reaches before it fails. */
  failAt: 'ssh' as 'ssh' | 'connect',
  failRounds: 1,
  hangDiscovery: false,
  rounds: 0,
  discoveryRuns: 0,
  cleanupRuns: 0,
  cleanupCode: 0,
  cleanupGate: undefined as Promise<void> | undefined,
  negotiations: 0,
  active: new Set<object>(),
  tasks: [] as Promise<void>[],
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return { spawn: (_executable: string, args: string[]) => {
    class Child extends EventEmitter {
      stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough()
      exitCode: number | null = null
      close(code: number | null) { if (!state.active.delete(this)) return; this.exitCode = code; this.emit('close', code) }
      kill() { queueMicrotask(() => this.close(null)); return true }
    }
    const child = new Child(); state.active.add(child)
    const command = args.at(-1)!
    queueMicrotask(() => {
      // A tunnel stays open for the lifetime of the connection.
      if (args.includes('-N')) return
      if (command.includes('find "$HOME/.vscode-server')) {
        state.discoveryRuns += 1
        if (state.hangDiscovery) return
        if (state.rounds <= state.failRounds && state.failAt === 'ssh') { child.close(255); return }
        child.stdout.write('/cache/server/bin/code-server\n'); child.close(0); return
      }
      if (command.includes('exec "$dsh_code_server"')) {
        child.stdout.write('DSH_AGENT_HOST_PID=12345\nAgent host server listening on 127.0.0.1:45678\n'); return
      }
      if (command.startsWith('cat ')) { child.stdout.write('fixture-token'); child.close(0); return }
      if (command.startsWith('dsh_pid=')) {
        state.cleanupRuns += 1
        void (async () => { if (state.cleanupGate !== undefined) await state.cleanupGate; child.close(state.cleanupCode) })()
        return
      }
      // The standalone VS Code CLI is absent on this remote, as in the reported failure.
      state.rounds += 1
      child.stderr.write('ssh: connect to host fixture.invalid port 22: Connection timed out\n')
      child.close(255)
    })
    return child
  } }
})

vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    createServer: () => Object.assign(new EventEmitter(), {
      listen(_port: number, _host: string, ready: () => void) { queueMicrotask(ready) },
      address: () => ({ port: 54321 }),
      close(done?: () => void) { done?.() },
    }),
    createConnection: () => {
      const socket = Object.assign(new EventEmitter(), { destroy() {} })
      queueMicrotask(() => socket.emit('connect'))
      return socket
    },
  }
})

vi.mock('../src/ssh-lifecycle.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../src/ssh-lifecycle.ts')>()
  return { ...real, connectOwnedWebSocket: async () => {
    if (state.rounds <= state.failRounds && state.failAt === 'connect') throw new Error('fixture transport refused')
    const [client, server] = InMemoryTransport.pair()
    state.negotiations += 1
    state.tasks.push((async () => {
      for (;;) {
        const frame = await server.recv()
        if (frame === null) return
        if (frame.kind !== 'text') continue
        const request = JSON.parse(frame.text)
        if (request.id === undefined) continue
        const result = request.method === 'initialize' ? { protocolVersion: '0.9.0', serverSeq: 0, snapshots: [] } : {}
        server.send({ jsonrpc: '2.0', id: request.id, result })
      }
    })())
    return client
  } }
})

afterEach(async () => {
  await Promise.all(state.tasks)
  state.tasks = []
  expect(state.active.size).toBe(0)
  Object.assign(state, {
    failAt: 'ssh', failRounds: 1, hangDiscovery: false, rounds: 0, discoveryRuns: 0,
    cleanupRuns: 0, cleanupCode: 0, cleanupGate: undefined, negotiations: 0,
  })
})

function runtime(ctx: Context): RemoteSshRuntime {
  return new RemoteSshRuntime(ctx, {
    sshTarget: 'fixture.invalid', sshExecutable: 'fixture-ssh', sshArgs: [],
    remoteCodeCommand: 'code', remoteRuntimeRoot: '/tmp/retry-fixture',
    startupTimeoutMs: 60_000, shutdownTimeoutMs: 1, requestTimeoutMs: 1_000,
    protocolVersions: ['0.9.0'],
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(inner => { resolve = inner })
  return { promise, resolve }
}

/** Wait until the fixture has actually produced the observable event. */
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 1_000 && !predicate(); index += 1) await Promise.resolve()
  expect(predicate()).toBe(true)
}

describe('failed startup recovery', () => {
  it('retries SSH startup on the next explicit call and shares one round with concurrent callers', async () => {
    const ctx = new Context()
    try {
      const ssh = runtime(ctx)
      await expect(ssh.getConnection()).rejects.toMatchObject({
        code: 'ssh_execution_failed',
        message: expect.stringContaining('embedded discovery (ssh exit 255)'),
      })
      expect(state.discoveryRuns).toBe(1)

      const [first, second] = await Promise.all([ssh.getConnection(), ssh.getConnection()])
      expect(first).toBe(second)
      expect(state.discoveryRuns).toBe(2)
      expect(state.negotiations).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not start another round while the failed round still owns its cleanup', async () => {
    state.failAt = 'connect'
    const gate = deferred()
    state.cleanupGate = gate.promise
    const ctx = new Context()
    try {
      const ssh = runtime(ctx)
      const first = ssh.getConnection()
      await until(() => state.cleanupRuns === 1)

      const second = ssh.getConnection()
      await Promise.resolve()
      expect(state.discoveryRuns).toBe(1)
      expect(state.rounds).toBe(1)

      gate.resolve()
      await expect(first).rejects.toMatchObject({ code: 'agent_host_unavailable' })
      await expect(second).rejects.toMatchObject({ code: 'agent_host_unavailable' })
      expect(state.discoveryRuns).toBe(1)

      const recovered = await ssh.getConnection()
      expect(recovered.protocolVersion).toBe('0.9.0')
      expect(state.discoveryRuns).toBe(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps an unverifiable cleanup failure visible without starting another round', async () => {
    state.failAt = 'connect'
    state.cleanupCode = 1
    const ctx = new Context()
    try {
      const ssh = runtime(ctx)
      await expect(ssh.getConnection()).rejects.toThrow('owned remote Agent Host cleanup failed')
      await expect(ssh.getConnection()).rejects.toThrow('owned remote Agent Host cleanup failed')
      // No new startup round: the cached rejection stays closed.
      expect(state.discoveryRuns).toBe(1)
      // The candidate loop and the outer recovery each attempt the same owned cleanup.
      expect(state.cleanupRuns).toBe(2)
      // The refused loopback transport never produced an AHP session.
      expect(state.negotiations).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('gives each explicit round a fresh startup deadline', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const ctx = new Context()
    try {
      const ssh = runtime(ctx)
      await expect(ssh.getConnection()).rejects.toMatchObject({ code: 'ssh_execution_failed' })
      clock.mockReturnValue(now + 60_001)
      await expect(ssh.getConnection()).resolves.toMatchObject({ protocolVersion: '0.9.0' })
      expect(state.negotiations).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('aborts a pending startup on disposal and refuses later calls without spawning', async () => {
    state.hangDiscovery = true
    const ctx = new Context()
    try {
      const ssh = runtime(ctx)
      const pending = ssh.getConnection()
      await until(() => state.discoveryRuns === 1)
      await ctx.fiber.dispose()
      await expect(pending).rejects.toThrow('connection disposed')
      await expect(ssh.getConnection()).rejects.toThrow('disposing')
      expect(state.discoveryRuns).toBe(1)
      expect(state.rounds).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })
})
