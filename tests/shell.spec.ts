import RemoteRuntime, { type AhpConnection } from '../src/index.ts'
import type { RemoteShellExecution } from '../src/shell.ts'
import { setup } from './fixtures/terminal-client.ts'
import { describe, expect, it, vi } from 'vitest'

describe('RemoteSshShellExecutor', () => {
  it.each(['create', 'subscribe', 'dispatch'] as const)('rejects unknown terminal cleanup after cancellation at %s', async stage => {
    const { ctx, client } = await setup()
    try {
      const controller = new AbortController()
      client.controller = controller
      client.abortAt = stage
      client.disposeError = new Error('disposal acknowledgement lost')
      const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'must-stop', signal: controller.signal })) as RemoteShellExecution
      await expect(execution.result()).rejects.toThrow('terminal shutdown unobservable')
      await expect(execution.quiescent).rejects.toThrow('terminal shutdown unobservable')
      expect(await execution.dispatched).toBe(stage === 'dispatch')
    } finally { await ctx.fiber.dispose() }
  })

  it.each([false, true])('distinguishes failed allocation from cleanup uncertainty (unknown disposal: %s)', async unknown => {
    const { ctx, client } = await setup()
    try {
      client.createError = new Error('terminal allocation reply lost')
      if (unknown) client.disposeError = new Error('terminal disposal reply lost')
      const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'not-submitted' })) as RemoteShellExecution
      await expect(execution.result()).rejects.toThrow(unknown ? 'terminal shutdown unobservable' : 'terminal allocation reply lost')
      expect(await execution.dispatched).toBe(false)
      if (unknown) await expect(execution.quiescent).rejects.toThrow('terminal shutdown unobservable')
      else { await expect(execution.quiescent).resolves.toBeUndefined(); expect(client.disposed).toBe(true) }
    } finally { await ctx.fiber.dispose() }
  })

  it('retains an early terminal-exit operation error while accepting observed shutdown without disposal ACK', async () => {
    const { ctx, client } = await setup()
    try {
      client.exitedWithoutMarker = true
      client.disposeError = new Error('disposal acknowledgement lost after exit')
      const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'early-exit' })) as RemoteShellExecution
      await expect(execution.result()).rejects.toThrow('terminal exited before the output marker')
      await expect(execution.quiescent).resolves.toBeUndefined()
      expect(await execution.dispatched).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('settles ordinary shell cancellation while shared readiness remains pending for another workspace', async () => {
    const { ctx, client, runtime, local } = await setup()
    const sharedClient = await runtime.getClient()
    let ready!: (connection: AhpConnection) => void
    const pending = new Promise<AhpConnection>(resolve => { ready = resolve })
    runtime.getConnection = () => pending
    vi.spyOn(runtime, 'getClient').mockImplementation(signal => RemoteRuntime.prototype.getClient.call(runtime, signal))
    try {
      const other = runtime.getClient()
      const controller = new AbortController()
      const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'must-not-run', workdir: local, signal: controller.signal }))
      controller.abort(new Error('caller cancelled'))
      expect(await execution.result()).toMatchObject({ aborted: true, exitCode: null })
      expect(client.dispatched).toBe(0)
      expect(client.writes).toEqual([])
      ready({ client: sharedClient, protocolVersion: '1.0.0' })
      expect(await other).toBe(client)
    } finally { ready({ client: sharedClient, protocolVersion: '1.0.0' }); await ctx.fiber.dispose() }
  })

  it.each(['before', 'write', 'create', 'subscribe'] as const)('does not dispatch a command cancelled during %s allocation', async stage => {
    const { ctx, client } = await setup()
    try {
      const controller = new AbortController()
      client.controller = controller
      if (stage === 'before') controller.abort()
      else client.abortAt = stage
      const spec = ctx.shell.resolve({ command: 'must-not-run', signal: controller.signal })
      const result = await (await ctx.shell.execute(spec)).result()
      expect(result).toMatchObject({ aborted: true, exitCode: null })
      expect(client.dispatched).toBe(0)
      if (stage === 'create' || stage === 'subscribe') expect(client.disposed).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('projects AHP terminal command actions into a ShellRunResult', async () => {
    const { ctx, client, local } = await setup()
    const execution = await ctx.shell.execute(ctx.shell.resolve({
      command: 'printf remote-output',
      workdir: local,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: local },
    }))
    const projection = execution.result()
    expect(execution.result()).toBe(projection)
    const result = await projection
    const observed = execution.observed.stdout.readFrom(0)
    expect(observed.text).toBe(result.stdout.text)
    expect(execution.readOutput().delta).toBe(result.stdout.text)
    expect(execution.readOutput().delta).toBe('')
    expect(execution.observed.stdout.readFrom(0)).toEqual(observed)
    expect(result).toMatchObject({ exitCode: 7, signal: null, timedOut: false, aborted: false })
    expect(result.stdout).toEqual({ text: 'remote-output\r\n', truncated: false })
    expect(result.stderr).toEqual({ text: '', truncated: false })
    expect(client.writes).toHaveLength(1)
    expect(client.disposed).toBe(true)
    expect(client.unsubscribed).toBe(true)
  })

  it('rejects quiescence when server subscription removal is unobservable after successful command exit', async () => {
    const { ctx, client } = await setup()
    try {
      client.unsubscribeError = new Error('unsubscribe delivery failed')
      const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'completed' })) as RemoteShellExecution
      await expect(execution.result()).rejects.toThrow('subscription cleanup unobservable')
      await expect(execution.quiescent).rejects.toThrow('subscription cleanup unobservable')
      expect(client.disposed).toBe(true)
      expect(client.unsubscribed).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects restrictive modes rather than pretending a remote shell is confined', async () => {
    const { ctx, local } = await setup()
    await expect((await ctx.shell.execute(ctx.shell.resolve({
      command: 'true',
      workdir: local,
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: local },
    }))).result()).rejects.toThrow(/cannot confine arbitrary remote commands/)
  })
})
