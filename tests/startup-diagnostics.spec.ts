import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSshRuntime } from '../src/index.ts'

const fixture = vi.hoisted(() => ({ calls: [] as string[], startupCode: 127, startupOutput: '', discoveryCode: 0, discoveryOutput: '', discoveryError: '' }))
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return { spawn: (_executable: string, args: string[]) => {
    class Child extends EventEmitter {
      stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough()
      exitCode: number | null = null
      kill() { queueMicrotask(() => this.emit('close', null)); return true }
    }
    const child = new Child()
    const command = args.at(-1)!
    fixture.calls.push(command)
    queueMicrotask(() => {
      if (command.startsWith('dsh_pid=')) { child.emit('close', 0); return }
      const discovery = command.includes('find "$HOME/.vscode-server')
      child.stdout.write(discovery ? fixture.discoveryOutput : 'DSH_AGENT_HOST_PID=12345\n')
      child.stderr.write(discovery ? fixture.discoveryError : fixture.startupOutput)
      child.exitCode = discovery ? fixture.discoveryCode : fixture.startupCode
      child.emit('close', child.exitCode)
    })
    return child
  } }
})
afterEach(() => { vi.restoreAllMocks(); Object.assign(fixture, { calls: [], startupCode: 127, startupOutput: '', discoveryCode: 0, discoveryOutput: '', discoveryError: '' }) })
async function failure(remoteCodeCommand = 'code') {
  const ctx = new Context()
  try {
    const runtime = new RemoteSshRuntime(ctx, { sshTarget: 'fixture.invalid', sshExecutable: 'fake-ssh', sshArgs: [], remoteCodeCommand, remoteRuntimeRoot: '/tmp/diagnostic-fixture', startupTimeoutMs: 1000, requestTimeoutMs: 100, shutdownTimeoutMs: 1, protocolVersions: ['0.9.0'] })
    return await runtime.getConnection().then(() => { throw new Error('unexpected success') }, error => error as Error & { code: string; exitCode?: number; stage?: string })
  } finally { await ctx.fiber.dispose() }
}
describe('startup and discovery execution diagnostics', () => {
  it('stops after discovery SSH exit 255 before attempting a CLI or reporting missing Agent Host', async () => {
    fixture.startupCode = fixture.discoveryCode = 255
    const error = await failure()
    expect(error.code).toBe('ssh_execution_failed')
    expect(fixture.calls).toHaveLength(1)
    expect(error.message).toContain('embedded discovery (ssh exit 255)')
    expect(error.message).not.toContain('no installed code-server')
    expect(error).toMatchObject({ stage: 'embedded discovery', exitCode: 255 })
  })
  it('only treats successful empty discovery as no installed host', async () => {
    const error = await failure()
    expect(error.code).toBe('agent_host_unavailable')
    expect(error.message).toContain('standalone CLI (ssh exit 127)')
    expect(error.message).toContain('no installed code-server found')
  })
  it('rejects discovery nonzero even when stdout contains candidate paths', async () => {
    fixture.discoveryCode = 2; fixture.discoveryOutput = '/fake/server/bin/code-server'
    const error = await failure()
    expect(error.code).toBe('ssh_execution_failed')
    expect(error.message).toContain('embedded discovery (ssh exit 2)')
    expect(fixture.calls).toHaveLength(1)
  })
  it('retains bounded redacted execution diagnostics', async () => {
    fixture.discoveryCode = 255
    fixture.discoveryError = 'ws://localhost/?tkn=secret-token ' + 'x'.repeat(30000) + ' --connection-token secret-cli'
    const error = await failure()
    expect(error.message.length).toBeLessThanOrEqual(16384)
    expect(error.message).not.toContain('secret-token')
    expect(error.message).not.toContain('secret-cli')
    expect(error.message).toContain('ssh exit 255')
  })
  it('does not discover fallback candidates for a custom code command', async () => {
    fixture.startupCode = 255
    const error = await failure('/custom/code')
    expect(error.message).toContain('ssh exit 255')
    expect(fixture.calls).toHaveLength(2)
    expect(fixture.calls[1]).toMatch(/^dsh_pid=/)
    expect(fixture.calls.some(command => command.includes('find '))).toBe(false)
  })
})
