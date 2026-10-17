import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { TransparentShellExecutor, type Config } from '../src/shell-transparent.ts'

const empty: SubprocessOutputReader = { readFrom: fromByte => ({ text: '', nextOffset: fromByte, lossy: false }) }
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

function fixture(mode: SandboxMode = 'read-only', stderrText = '') {
  const ctx = new Context()
  contexts.push(ctx)
  const policy: SandboxExecutionPolicy = { mode, workspaceRoot: process.cwd() }
  const outcome: SubprocessOutcome = { exitCode: stderrText ? 1 : 0, signal: null }
  const done = Promise.resolve(outcome)
  const stderr: SubprocessOutputReader = { readFrom: fromByte => ({ text: Buffer.from(stderrText).subarray(fromByte).toString('utf8'), nextOffset: Buffer.byteLength(stderrText), lossy: false }) }
  const handle: SubprocessHandle = {
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: { stdout: empty, stderr }, done,
    waitForExit: async () => true, terminate: () => true,
  }
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => handle)
  const routedSpawn = vi.fn(() => { throw new Error('local shell reached routed subprocess') })
  const confine = vi.fn(async (argv: readonly string[], selected: SandboxExecutionPolicy, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    return { argv: ['native-runner', ...argv], enforcement: 'partial' as const, denialSignatures: ['permission denied'], runnerFailureRules: [] }
  })
  const routeShell = vi.fn((_workdir: string, _session?: string) => ({ kind: 'local' as const }))
  const workspaceShell = vi.fn(async () => { throw new Error('unexpected remote allocation') })
  ctx.provide('localSubprocess', { spawn } as never)
  ctx.provide('subprocess', { spawn: routedSpawn } as never)
  ctx.provide('sandbox', { confine } as never)
  ctx.provide('sandboxPolicy', { defaultMode: mode, resolve: () => policy } as never)
  ctx.provide('remoteSshManager', { routeShell, workspaceShell } as never)
  return { ctx, policy, spawn, confine, routedSpawn, routeShell, workspaceShell }
}

/** The native provider, not the SSH router, owns confinement metadata and argv. */
describe('transparent native sandbox dispatch', () => {
  it.each(['bash', 'pwsh'] as const)('confines local %s with the supplied policy and preserves denial facts', async dialect => {
    const f = fixture('read-only', 'permission denied')
    await f.ctx.plugin(TransparentShellExecutor, { dialect, pwshPath: 'custom-pwsh' })
    const shell = f.ctx.shell
    expect(shell.sandboxMode).toBe('read-only')
    const spec = shell.resolve({ command: 'write', sandboxPolicy: f.policy })
    const execution = await shell.execute(spec)
    const result = await execution.result()
    expect(f.confine).toHaveBeenCalledWith(expect.any(Array), f.policy, expect.any(AbortSignal))
    expect(f.spawn.mock.calls[0]?.[0].argv[0]).toBe('native-runner')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
    await execution.done
    expect(execution.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
    expect(f.routedSpawn).not.toHaveBeenCalled()
    expect(f.workspaceShell).not.toHaveBeenCalled()
  })

  it('keeps volatile cwd, budgets, and PowerShell path live without replacing the shell', async () => {
    const f = fixture('danger-full-access')
    const initial = { dialect: 'pwsh' as const, cwd: 'first', timeoutMs: 1000, maxTimeoutMs: 2000, maxOutputBytes: 100, maxSpillBytes: 200, graceMs: 10, pwshPath: 'first-pwsh' }
    const fiber = f.ctx.plugin(TransparentShellExecutor, initial)
    await fiber
    const shell = f.ctx.shell
    const config: Config = fiber.config
    updateVolatile(config.cwd, createVolatile('second'))
    updateVolatile(config.timeoutMs, createVolatile(1500))
    updateVolatile(config.maxTimeoutMs, createVolatile(1600))
    updateVolatile(config.maxOutputBytes, createVolatile(300))
    updateVolatile(config.maxSpillBytes, createVolatile(400))
    updateVolatile(config.graceMs, createVolatile(20))
    updateVolatile(config.pwshPath, createVolatile('second-pwsh'))
    const spec = shell.resolve({ command: 'test', timeoutMs: 9000 })
    expect(spec).toMatchObject({ workdir: 'second', timeoutMs: 1600, stdoutMaxBytes: 300, sandboxPolicy: f.policy })
    await (await shell.execute(spec)).result()
    expect(f.spawn.mock.calls[0]?.[0]).toMatchObject({ argv: ['second-pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', expect.any(String)], graceMs: 20, stdio: { stdout: { maxBytes: 300, spill: { maxBytes: 400 } } } })
    expect(f.confine).not.toHaveBeenCalled()
  })

  it('cancels pending native confinement before any local or remote spawn', async () => {
    const f = fixture()
    const entered = Promise.withResolvers<void>()
    const continuePreparation = Promise.withResolvers<void>()
    f.confine.mockImplementation(async (argv, _policy, signal) => {
      entered.resolve()
      await continuePreparation.promise
      signal?.throwIfAborted()
      return { argv: ['native-runner', ...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }
    })
    await f.ctx.plugin(TransparentShellExecutor, { dialect: 'bash' })
    const abort = new AbortController()
    const pending = f.ctx.shell.execute(f.ctx.shell.resolve({ command: 'must-not-spawn', signal: abort.signal }))
    const rejected = expect(pending).rejects.toThrow('execution cancelled')
    try {
      await entered.promise
      abort.abort(new Error('execution cancelled'))
      await rejected
      expect(f.spawn).not.toHaveBeenCalled()
      expect(f.workspaceShell).not.toHaveBeenCalled()
    } finally { continuePreparation.resolve() }
  })

  it('rejects custom Bash executables rather than silently discarding them', async () => {
    const f = fixture()
    await expect(f.ctx.plugin(TransparentShellExecutor, { dialect: 'bash', executable: '/custom/bash' })).rejects.toThrow('custom Bash executable is unsupported')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('preserves the legacy PowerShell executable override', async () => {
    const f = fixture('danger-full-access')
    await f.ctx.plugin(TransparentShellExecutor, { dialect: 'pwsh', executable: 'legacy-pwsh', pwshPath: 'ignored-pwsh' })
    await (await f.ctx.shell.execute(f.ctx.shell.resolve({ command: 'test' }))).result()
    expect(f.spawn.mock.calls[0]?.[0].argv[0]).toBe('legacy-pwsh')
  })

  it('rejects remote restricted execution only after routing, without local fallback', async () => {
    const f = fixture()
    f.routeShell.mockReturnValue({ kind: 'remote' } as never)
    await f.ctx.plugin(TransparentShellExecutor, { dialect: 'bash' })
    const spec = f.ctx.shell.resolve({ command: 'test', workdir: '/host-same-name', dshEnv: { DSH_SESSION_ID: 'remote-session' } })
    await expect(f.ctx.shell.execute(spec)).rejects.toThrow('remote host cannot enforce this sandbox policy')
    expect(f.routeShell).toHaveBeenCalledWith('/host-same-name', 'remote-session')
    expect(f.workspaceShell).not.toHaveBeenCalled()
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.confine).not.toHaveBeenCalled()
  })

  it('never substitutes a local execution after remote allocation or stale-route failure', async () => {
    const f = fixture('danger-full-access')
    f.routeShell.mockReturnValue({ kind: 'remote' } as never)
    f.workspaceShell.mockRejectedValue(new Error('remote unavailable'))
    await f.ctx.plugin(TransparentShellExecutor, { dialect: 'bash' })
    const spec = f.ctx.shell.resolve({ command: 'test' })
    await expect(f.ctx.shell.execute(spec)).rejects.toThrow('remote unavailable')
    f.routeShell.mockImplementation(() => { throw new Error('workspace removed') })
    await expect(f.ctx.shell.execute(spec)).rejects.toThrow('workspace removed')
    expect(f.spawn).not.toHaveBeenCalled()
  })
})

describe('transparent shell failure observations', () => {
  it('retains the same UTF-8 note for consuming and independent background readers', async () => {
    const ctx = new Context()
    let rejectDone!: (error: Error) => void
    const done = new Promise<SubprocessOutcome>((_resolve, reject) => { rejectDone = reject })
    const handle: SubprocessHandle = {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: { stdout: empty, stderr: empty }, done,
      waitForExit: () => done.then(() => true), terminate: () => true,
    }
    ctx.provide('localSubprocess', { spawn: () => handle } as never)
    ctx.provide('sandbox', { confine: () => { throw new Error('unexpected confinement') } } as never)
    ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) } as never)
    ctx.provide('remoteSshManager', { routeShell: () => ({ kind: 'local' }) })
    try {
      await ctx.plugin(TransparentShellExecutor, { dialect: 'bash', timeoutMs: 1000, maxTimeoutMs: 1000, maxOutputBytes: 1000, maxSpillBytes: 1000, graceMs: 1 })
      const shell = ctx.shell
      const execution = await shell.execute(shell.resolve({ command: 'unused', workdir: process.cwd(), onExpiry: 'none' }))
      const error = new Error('无法启动 executable')
      rejectDone(error)
      await execution.done
      const note = 'subprocess failed before reporting an outcome: ' + String(error)
      const first = execution.observed.stderr.readFrom(0)
      expect(first).toEqual({ text: note, nextOffset: Buffer.byteLength(note), lossy: false })
      const consuming = execution.readOutput().delta
      expect(consuming).toBe('[stderr]\n' + note)
      expect({ observedStderr: first.text, consuming, nextByte: first.nextOffset }).toMatchSnapshot()
      expect(execution.readOutput().delta).toBe('')
      expect(execution.observed.stderr.readFrom(0)).toEqual(first)
      expect(execution.observed.stderr.readFrom(first.nextOffset).text).toBe('')
      const boundary = Buffer.byteLength('subprocess failed before reporting an outcome: Error: 无法')
      expect(execution.observed.stderr.readFrom(boundary).text).toBe('启动 executable')
      await expect(execution.result()).rejects.toBe(error)
    } finally { await ctx.fiber.dispose() }
  })
})
