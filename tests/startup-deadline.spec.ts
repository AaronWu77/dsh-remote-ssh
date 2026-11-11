import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSshRuntime } from '../src/index.ts'

const fixture = vi.hoisted(() => ({ calls: [] as string[], onDiscovery: () => {} }))
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return {
  spawn: (_command: string, args: string[]) => {
    class Child extends EventEmitter {
      readonly stdout = new PassThrough()
      readonly stderr = new PassThrough()
      readonly stdin = new PassThrough()
      kill(): boolean { queueMicrotask(() => this.emit('close', null)); return true }
    }
    const child = new Child()
    const command = args.at(-1)!
    fixture.calls.push(command)
    queueMicrotask(() => {
      if (command.includes('find "$HOME/.vscode-server')) {
        child.stdout.write('/fake/first/server/bin/code-server\n/fake/second/server/bin/code-server\n')
        fixture.onDiscovery()
        child.emit('close', 0)
      } else if (command.includes('exec "$dsh_code" agent host')) {
        child.stderr.write('code missing')
        child.emit('close', 127)
      }
    })
    return child
  },
  }
})

afterEach(() => { vi.restoreAllMocks(); fixture.calls.length = 0; fixture.onDiscovery = () => {} })
function createRuntime(ctx: Context): RemoteSshRuntime {
  return new RemoteSshRuntime(ctx, {
    sshTarget: 'review.invalid', sshExecutable: 'fake-ssh', sshArgs: [],
    remoteCodeCommand: 'code', remoteRuntimeRoot: '/tmp/deadline-fixture',
    startupTimeoutMs: 60_000, shutdownTimeoutMs: 1, requestTimeoutMs: 100,
    protocolVersions: ['0.9.0'],
  })
}

describe('total Agent Host startup deadline', () => {
  it('does not spawn an embedded candidate after discovery exhausts the deadline', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    fixture.onDiscovery = () => { clock.mockReturnValue(now + 60_001) }
    const ctx = new Context()
    try {
      const runtime = createRuntime(ctx)
      await expect(runtime.getConnection()).rejects.toThrow('total Agent Host startup deadline exceeded')
      expect(fixture.calls).toHaveLength(1)
      expect(fixture.calls.filter(command => command.includes('exec "$dsh_code_server"'))).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not start another candidate when disposal cancels discovery', async () => {
    const ctx = new Context()
    let disposed: Promise<void> | undefined
    fixture.onDiscovery = () => { disposed = ctx.fiber.dispose() }
    try {
      const runtime = createRuntime(ctx)
      await expect(runtime.getConnection()).rejects.toThrow('connection disposed')
      await disposed
      expect(fixture.calls.filter(command => command.includes('exec "$dsh_code_server"'))).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })
})
