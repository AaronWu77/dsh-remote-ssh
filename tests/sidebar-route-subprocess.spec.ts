import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ActionType, TerminalLifecycleStatus, type Snapshot, type TerminalState } from '@microsoft/agent-host-protocol'
import { AhpClient, InMemoryTransport, type AhpTransport } from '@microsoft/agent-host-protocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RemoteSshManager from '../src/manager.ts'
import { commitVolatileConfig } from './helpers/volatile-settings.ts'
import { spawnOwnedRemoteProcess, spawnOwnedRemoteTerminal } from '../src/router-subprocess.ts'
import RemoteSshShellExecutor from '../src/shell.ts'
import { LocalOutputFixture, outputTestBash } from './fixtures/output-transport.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length !== 0) throw new AggregateError(errors, 'sidebar subprocess cleanup failed')
  vi.restoreAllMocks()
})

class MemorySettings extends Service {
  private owner: Fiber | undefined
  private revision = 0
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure(_presentation: { auto: boolean }, owner: Fiber): () => void {
    this.owner = owner
    return () => { this.owner = undefined }
  }
  describe(): { ns: SettingsNamespace; revision: number }[] {
    return [{ ns: 'remote-ssh-manager' as SettingsNamespace, revision: this.revision }]
  }
  async replace(_namespace: SettingsNamespace, next: Record<string, unknown>, revision: number): Promise<void> {
    if (revision !== this.revision || this.owner === undefined) throw new Error('settings owner or revision changed')
    const paths = commitVolatileConfig(this.owner, next)
    this.revision += 1
    this.owner.ctx.emit(this.owner, 'loader/volatile-update', paths)
  }
}

/** The real SDK owns its queues; this peer owns only terminal protocol state. */
class TerminalPeer {
  readonly client: AhpClient
  readonly transport: AhpTransport
  private readonly remote: AhpTransport
  private readonly receiving: Promise<void>
  readonly terminals = new Set<string>()
  readonly subscriptions = new Set<string>()
  readonly unsubscribed = new Set<string>()
  readonly inputs: { channel: string; data: string }[] = []
  readonly requests: { method: string; channel: string }[] = []
  snapshot: Omit<Snapshot, 'resource'> | undefined
  replay: { serverSeq: number; action: object }[] = []
  beforeRequest: ((method: string, channel: string) => Promise<void>) | undefined
  disposalFailure: Error | undefined
  private readonly changed = new Set<() => void>()

  constructor() {
    const [transport, remote] = InMemoryTransport.pair()
    this.transport = transport
    this.remote = remote
    this.client = new AhpClient(transport)
    this.client.connect()
    this.receiving = this.receive()
    void this.receiving.catch((_error) => { /* close reports peer failures. */ })
    cleanups.push(() => this.close())
  }
  emit(channel: string, serverSeq: number, action: object): void {
    this.remote.send({ jsonrpc: '2.0', method: 'action', params: { channel, serverSeq, action } })
  }
  async waitFor(predicate: () => boolean): Promise<void> {
    if (predicate()) return
    await new Promise<void>(resolve => {
      const changed = () => { if (predicate()) { this.changed.delete(changed); resolve() } }
      this.changed.add(changed)
      changed()
    })
  }
  private async receive(): Promise<void> {
    for (;;) {
      const frame = await this.remote.recv()
      if (frame === null) return
      if (frame.kind !== 'text') throw new Error('terminal peer expects JSON text')
      const message: { method: string; id?: number; params: { channel: string; action?: { type: string; data?: string } } } = JSON.parse(frame.text)
      const { method, params } = message
      if (message.id !== undefined) {
        this.requests.push({ method, channel: params.channel })
        await this.beforeRequest?.(method, params.channel)
        if (method === 'disposeTerminal' && this.disposalFailure !== undefined) {
          this.remote.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: this.disposalFailure.message } })
          for (const changed of this.changed) changed()
          continue
        }
        if (method === 'createTerminal') this.terminals.add(params.channel)
        else if (method === 'disposeTerminal') this.terminals.delete(params.channel)
        else if (method === 'subscribe') {
          this.subscriptions.add(params.channel)
          for (const event of this.replay) this.emit(params.channel, event.serverSeq, event.action)
        } else throw new Error('unexpected terminal request: ' + method)
        this.remote.send({ jsonrpc: '2.0', id: message.id, result: method === 'subscribe' && this.snapshot !== undefined
          ? { snapshot: { resource: params.channel, ...this.snapshot } } : {} })
      } else if (method === 'dispatchAction') {
        if (params.action?.type === ActionType.TerminalInput) this.inputs.push({ channel: params.channel, data: params.action.data! })
      } else if (method === 'unsubscribe') {
        this.subscriptions.delete(params.channel)
        this.unsubscribed.add(params.channel)
      } else throw new Error('unexpected terminal notification: ' + method)
      for (const changed of this.changed) changed()
    }
  }
  async close(): Promise<void> {
    await this.client.shutdown()
    await this.remote.close()
    await this.receiving
  }
}

async function setup(client: AhpClient | LocalOutputFixture) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sidebar-subprocess-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(MemorySettings).await()
  await ctx.plugin(RemoteSshManager, {
    aliasRoot: root,
    servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'no-ssh-in-tests' }],
    workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
  }).await()
  const manager = ctx.remoteSshManager
  const route = manager.workspace('project')
  const remote = { clientId: 'sidebar-client', runtimeRoot: client instanceof LocalOutputFixture ? client.runtimeRoot : '/tmp/sidebar-terminal', getClient: async () => client }
  // Replace only the remote connection composition; routing and ownership stay real.
  vi.spyOn(manager, 'workspaceContext').mockResolvedValue({ ctx, fs: {} as never, remote: remote as never })
  ctx.provide('remoteSsh', remote as never)
  await ctx.plugin(RemoteSshShellExecutor, { localWorkspace: route.aliasPath, remoteWorkspace: '/srv/project' }).await()
  vi.spyOn(manager, 'workspaceShell').mockResolvedValue(ctx.shell as RemoteSshShellExecutor)
  const routeShell = vi.spyOn(manager, 'routeShell')
  const bindSession = vi.spyOn(manager, 'bindSession')
  const owned = vi.spyOn(manager, 'ownExecution')
  const spec: SubprocessTerminalSpawnSpec = {
    argv: ['bash', '-i'], cwd: route.aliasPath, rows: 24, cols: 80, graceMs: 30_000, terminalType: 'xterm-256color',
  }
  return { ctx, manager, route, spec, routeShell, bindSession, owned }
}

async function bytes(stream: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function terminalState(content: TerminalState['content'], lifecycle: TerminalState['lifecycle'] = { status: TerminalLifecycleStatus.Running }): TerminalState {
  return { title: 'fixture shell', content, lifecycle, claim: { kind: 'client', clientId: 'sidebar-client' } as TerminalState['claim'] }
}

describe('authorized sidebar terminal route through the real AHP SDK', () => {
  it('retains snapshot prompt and command VT bytes while discarding covered, duplicate and stale sequence events', async () => {
    const peer = new TerminalPeer()
    peer.snapshot = { fromSeq: 10, state: terminalState([
      { type: 'command', commandId: 'previous', commandLine: 'pwd', output: '/srv/project\r\n', timestamp: 0, isComplete: true },
      { type: 'unclassified', value: '\x1b[32mremote$ \x1b[0m' },
    ]) }
    peer.replay = [
      { serverSeq: 9, action: { type: ActionType.TerminalData, data: 'covered-old' } },
      { serverSeq: 10, action: { type: ActionType.TerminalData, data: 'covered-prompt' } },
      { serverSeq: 11, action: { type: ActionType.TerminalData, data: 'live\r\n' } },
      { serverSeq: 11, action: { type: ActionType.TerminalData, data: 'duplicate' } },
      { serverSeq: 10, action: { type: ActionType.TerminalExited, exitCode: 99 } },
      { serverSeq: 12, action: { type: ActionType.TerminalData, data: '\x1b[?25h' } },
      { serverSeq: 13, action: { type: ActionType.TerminalExited, exitCode: 7 } },
    ]
    const { manager, route, spec, owned, routeShell, bindSession } = await setup(peer.client)
    const terminal = await spawnOwnedRemoteTerminal(manager, route, spec)
    const output = bytes(terminal.output)
    await expect(terminal.done).resolves.toEqual({ exitCode: 7, signal: null })
    expect(await output).toBe('/srv/project\r\n\x1b[32mremote$ \x1b[0mlive\r\n\x1b[?25h')
    await owned.mock.calls[0]![1].done
    await peer.waitFor(() => peer.unsubscribed.size === 1)
    expect(peer.terminals.size).toBe(0)
    expect(peer.subscriptions.size).toBe(0)
    expect(routeShell).not.toHaveBeenCalled()
    expect(bindSession).not.toHaveBeenCalled()
  })

  it('deduplicates live sequences even when subscribe returns no snapshot', async () => {
    const peer = new TerminalPeer()
    peer.replay = [
      { serverSeq: 20, action: { type: ActionType.TerminalData, data: 'one' } },
      { serverSeq: 20, action: { type: ActionType.TerminalData, data: 'duplicate' } },
      { serverSeq: 19, action: { type: ActionType.TerminalData, data: 'stale' } },
      { serverSeq: 21, action: { type: ActionType.TerminalExited, exitCode: 0 } },
    ]
    const { manager, route, spec } = await setup(peer.client)
    const terminal = await spawnOwnedRemoteTerminal(manager, route, spec)
    const output = bytes(terminal.output)
    await expect(terminal.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(await output).toBe('one')
    await peer.waitFor(() => peer.unsubscribed.size === 1)
    expect(peer.subscriptions.size).toBe(0)
  })

  it('does not dispatch argv into an already-exited snapshot and releases the SDK fan-out', async () => {
    const peer = new TerminalPeer()
    peer.snapshot = { fromSeq: 4, state: terminalState([{ type: 'unclassified', value: 'final prompt' }], { status: TerminalLifecycleStatus.Exited, exitCode: 23 }) }
    const { manager, route, spec } = await setup(peer.client)
    const terminal = await spawnOwnedRemoteTerminal(manager, route, spec)
    const output = bytes(terminal.output)
    await expect(terminal.done).resolves.toEqual({ exitCode: 23, signal: null })
    expect(await output).toBe('final prompt')
    await peer.waitFor(() => peer.unsubscribed.size === 1)
    expect(peer.inputs).toEqual([])
    expect(peer.terminals.size).toBe(0)
    expect(peer.subscriptions.size).toBe(0)
    await expect(terminal.write('late input')).rejects.toThrow('remote terminal is closed')
  })

  it('retains execution ownership and the sidebar registration when pending allocation disposal fails over the SDK wire', async () => {
    const peer = new TerminalPeer()
    peer.disposalFailure = new Error('remote disposal refused')
    const entered = Promise.withResolvers<void>()
    const continueAllocation = Promise.withResolvers<void>()
    peer.beforeRequest = async method => {
      if (method === 'subscribe') { entered.resolve(); await continueAllocation.promise }
    }
    const { manager, route, spec, owned } = await setup(peer.client)
    cleanups.push(async () => { continueAllocation.resolve() })
    const allocation = spawnOwnedRemoteTerminal(manager, route, spec)
    const failed = expect(allocation).rejects.toThrow('terminal cleanup unobservable')
    await entered.promise
    const retiring = Promise.withResolvers<void>()
    manager.ownExecution(route, { done: Promise.resolve(), terminate: () => { retiring.resolve() } })
    const removeRegistration = vi.fn(async () => true)
    const removal = manager.removeRegisteredWorkspace(route.aliasPath, removeRegistration)
    const removalFailed = expect(removal).rejects.toThrow('terminal cleanup unobservable')
    await retiring.promise
    continueAllocation.resolve()
    await failed
    await removalFailed
    await expect(owned.mock.calls[0]![1].done).rejects.toThrow('terminal cleanup unobservable')
    await peer.waitFor(() => peer.unsubscribed.size === 1)
    expect(peer.terminals.size).toBe(1)
    expect(peer.subscriptions.size).toBe(0)
    expect(peer.inputs).toEqual([])
    expect(removeRegistration).not.toHaveBeenCalled()
    expect(() => manager.workspace(route.workspace.id)).toThrow('unknown or removed')
    await expect(manager.removeRegisteredWorkspace(route.aliasPath, removeRegistration)).rejects.toThrow('terminal cleanup unobservable')
    expect(removeRegistration).not.toHaveBeenCalled()
  })

  it.each(['createTerminal', 'subscribe'] as const)('retirement waits for pending %s and authoritative disposal before deleting the sidebar registration', async phase => {
    const peer = new TerminalPeer()
    const entered = Promise.withResolvers<void>()
    const continueAllocation = Promise.withResolvers<void>()
    const disposalEntered = Promise.withResolvers<void>()
    const continueDisposal = Promise.withResolvers<void>()
    peer.beforeRequest = async method => {
      if (method === phase) { entered.resolve(); await continueAllocation.promise }
      if (method === 'disposeTerminal') { disposalEntered.resolve(); await continueDisposal.promise }
    }
    const { manager, route, spec, owned } = await setup(peer.client)
    cleanups.push(async () => { continueAllocation.resolve(); continueDisposal.resolve() })
    const allocation = spawnOwnedRemoteTerminal(manager, route, spec)
    const failed = expect(allocation).rejects.toThrow('Remote workspace terminal removed')
    await entered.promise
    const removeRegistration = vi.fn(async () => true)
    const retiring = Promise.withResolvers<void>()
    manager.ownExecution(route, { done: Promise.resolve(), terminate: () => { retiring.resolve() } })
    const removal = manager.removeRegisteredWorkspace(route.aliasPath, removeRegistration)
    await retiring.promise
    expect(() => manager.workspace(route.workspace.id)).toThrow('unknown or removed')
    expect(() => spawnOwnedRemoteProcess(manager, route, {
      argv: ['bash'], cwd: route.aliasPath, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100,
    })).toThrow('being removed')
    await expect(spawnOwnedRemoteTerminal(manager, route, spec)).rejects.toThrow('being removed')
    await Promise.all(owned.mock.calls.slice(2).map(([, execution]) => execution.done))
    expect(manager.workspaceContext).toHaveBeenCalledTimes(1)
    expect(manager.workspaceShell).not.toHaveBeenCalled()
    expect(removeRegistration).not.toHaveBeenCalled()
    continueAllocation.resolve()
    await disposalEntered.promise
    let settled = false
    void owned.mock.calls[0]![1].done.then(() => { settled = true })
    expect(settled).toBe(false)
    expect(removeRegistration).not.toHaveBeenCalled()
    continueDisposal.resolve()
    await failed
    await expect(removal).resolves.toBe(true)
    await owned.mock.calls[0]![1].done
    expect(removeRegistration).toHaveBeenCalledTimes(1)
    expect(peer.inputs).toEqual([])
    expect(peer.terminals.size).toBe(0)
    if (phase === 'subscribe') {
      await peer.waitFor(() => peer.unsubscribed.size === 1)
      expect(peer.subscriptions.size).toBe(0)
    }
  })
})

describe.skipIf(outputTestBash === undefined)('cold sidebar route with locally executed AHP output transport', () => {
  it('runs collected output and a terminal without a live Agent or session binding and deletes their owned resources', async () => {
    const client = await LocalOutputFixture.create()
    cleanups.push(() => client.dispose())
    const { manager, route, spec, owned, routeShell, bindSession } = await setup(client)
    const process = spawnOwnedRemoteProcess(manager, route, {
      argv: ['bash', '-c', "printf cold-stdout; printf cold-stderr >&2; exit 17"], cwd: route.aliasPath,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 30_000,
    }, { outputChunkBytes: 1024, outputPollMs: 1 })
    await expect(process.done).resolves.toEqual({ exitCode: 17, signal: null })
    expect(process.collected.stdout!.readFrom(0).text).toBe('cold-stdout')
    expect(process.collected.stderr!.readFrom(0).text).toBe('cold-stderr')
    const terminal = await spawnOwnedRemoteTerminal(manager, route, { ...spec, argv: ['bash', '-c', 'printf cold-terminal; exit 5'] })
    const output = bytes(terminal.output)
    await expect(terminal.done).resolves.toEqual({ exitCode: 5, signal: null })
    expect(await output).toBe('cold-terminal')
    await Promise.all(owned.mock.calls.map(([, execution]) => execution.done))
    expect(routeShell).not.toHaveBeenCalled()
    expect(bindSession).not.toHaveBeenCalled()
    const channel = client.requests.filter(request => request.method === 'createTerminal').at(-1)!.channel
    expect(client.unsubscribedTerminals.has(channel)).toBe(true)
    expect(client.subscribedTerminals.has(channel)).toBe(false)
    expect(client.processes.size).toBe(0)
    expect(await readdir(client.root)).toEqual([])
    await expect(manager.removeRegisteredWorkspace(route.aliasPath, async () => true)).resolves.toBe(true)
  })
})
