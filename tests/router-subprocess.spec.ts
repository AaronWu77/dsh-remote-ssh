import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { RemoteSshRuntime, WorkspacePathMapper, fileUriFromPosixPath } from '../src/index.ts'
import TransparentSubprocessRuntime, {
  DeferredAhpStdin,
  buildRemoteProcessCommand,
  buildRemoteInteractiveCommand,
  buildRemoteStdinWriterCommand,
} from '../src/router-subprocess.ts'
import type { Config } from '../src/router-subprocess.ts'
import { LocalOutputFixture, outputTestBash } from './fixtures/output-transport.ts'
import { RemoteSshShellExecutor } from '../src/shell.ts'
import type { AhpConnection } from '../src/index.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length !== 0) throw new AggregateError(errors, 'subprocess fixture cleanup failed')
})

function collectedSpec(stdin: SubprocessSpawnSpec['stdio']['stdin'] = 'ignore'): SubprocessSpawnSpec {
  return {
    argv: ['bash', '-c', "printf 'remote-stdout\n'; printf 'remote-stderr\n' >&2; exit 23"],
    cwd: resolve('tests', 'remote-process'),
    stdio: { stdin, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    // Generous: the transport bounds post-exit draining by graceMs, so the fixture
    // must never let fixture pacing decide the outcome. The bound has its own test.
    graceMs: 30_000,
  }
}

async function setup(config: Config = { outputChunkBytes: 1024, outputPollMs: 1 }, realShell = false) {
  const ctx = new Context()
  const client = await LocalOutputFixture.create()
  cleanups.push(async () => { try { await ctx.fiber.dispose() } finally { await client.dispose() } })
  const alias = resolve('tests', 'remote-process')
  const route = {
    kind: 'remote' as const,
    server: { id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' },
    workspace: { id: 'project', serverId: 'devbox', remotePath: '/srv/project' },
    aliasPath: alias, mapper: new WorkspacePathMapper(alias, '/srv/project'),
  }
  const remote = { runtimeRoot: client.runtimeRoot, clientId: 'fixture', getClient: async (_signal?: AbortSignal) => client }
  let shell: LocalOutputFixture | RemoteSshShellExecutor = client
  if (realShell) {
    ctx.provide('remoteSsh', remote as never)
    await ctx.plugin(RemoteSshShellExecutor, { localWorkspace: alias, remoteWorkspace: '/srv/project' })
    shell = ctx.shell as RemoteSshShellExecutor
  }
  let sshFallbacks = 0
  const release = vi.fn()
  const manager = {
    ownExecution: vi.fn((_route: unknown, _execution: { terminate(): void | Promise<void>; done: Promise<unknown> }) => release),
    route: () => route,
    workspaceContext: vi.fn(async () => ({ remote })),
    workspaceShell: vi.fn(async () => shell),
    sshTransport: () => { sshFallbacks += 1; throw new Error('SSH fallback is forbidden') },
  }
  ctx.provide('localSubprocess', { resolveExecutable: async (command: string) => command } as never)
  ctx.provide('remoteSshManager', manager as never)
  await ctx.plugin(TransparentSubprocessRuntime, config)
  return { ctx, client, remote, alias, manager, release, shell, getSshFallbacks: () => sshFallbacks }
}

function assertBounds(client: LocalOutputFixture, chunkBytes: number): void {
  expect(client.reads.every(read => read.bytes <= chunkBytes && read.wireChars <= 4 * Math.ceil(chunkBytes / 3))).toBe(true)
  for (const listing of client.listings) {
    const output = listing.filter(entry => /\.(?:part|chunk)$/.test(entry.name))
    expect(output.every(entry => entry.size <= chunkBytes)).toBe(true)
    // A listing may span an ACK/rename; at no time may each stream own two files.
    for (const stream of ['stdout', 'stderr']) expect(output.filter(entry => entry.name.startsWith(stream)).length).toBeLessThanOrEqual(1)
    expect(output.reduce((sum, entry) => sum + entry.size, 0)).toBeLessThanOrEqual(2 * chunkBytes)
  }
}

async function bytes(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

function deferred() {
  let resolvePromise!: () => void
  const promise = new Promise<void>(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

function unresolvedReadiness(client: LocalOutputFixture) {
  // Exercise the public waiting method without starting a constructor-owned host.
  const runtime = Object.create(RemoteSshRuntime.prototype) as RemoteSshRuntime
  let resolvePromise!: (connection: AhpConnection) => void
  const promise = new Promise<AhpConnection>(resolve => { resolvePromise = resolve })
  vi.spyOn(runtime, 'getConnection').mockReturnValue(promise)
  const resolve = () => { resolvePromise({ client: client as never, protocolVersion: '1.0' }) }
  cleanups.push(async () => { resolve(); await promise })
  return { runtime, resolve }
}

describe('remote argv', () => {
  it.each([
    ['C:\\tools\\rg.exe', 'rg'],
    ['C:\\approved\\python.exe', 'python'],
    ['\\\\host\\tools\\node.exe', 'node'],
    ['/local/node_modules/@vscode/ripgrep/bin/rg', 'rg'],
    ['/local/node_modules/@vscode/ripgrep/bin/rg.exe', 'rg'],
    ['/opt/approved/rg', '/opt/approved/rg'],
    ['/opt/approved/tool.exe', '/opt/approved/tool.exe'],
    ['/opt/tool with spaces', '/opt/tool with spaces'],
  ])('routes %s without changing argv arguments', (executable, expected) => {
    const command = buildRemoteProcessCommand([executable, "a'b", '', '汉字'], { SAFE: 'x y', UNSET: undefined }, '/tmp/in', '/tmp/out', '/tmp/err')
    expect(command).toContain("'" + expected + "' 'a'\"'\"'b' '' '汉字'")
    expect(command).toContain("'SAFE=x y'")
    expect(command).toContain("'-u' 'UNSET'")
    expect(buildRemoteInteractiveCommand([executable, 'argument'], undefined)).toContain("'" + expected + "' 'argument'")
  })
  it('splits remote stdin into records that fit a PTY canonical input buffer', async () => {
    const writes: string[] = []
    const stdin = new DeferredAhpStdin()
    stdin.bind({ write: async (data: string) => { writes.push(data) }, done: Promise.resolve({ exitCode: 0, signal: null }) } as never, 'EOF-MARKER')
    const payload = Buffer.alloc(5000, 0x61)
    stdin.write(payload)
    stdin.end()
    await once(stdin, 'finish')
    const records = writes.slice(0, -1)
    expect(records.length).toBeGreaterThan(1)
    for (const record of records) expect(Buffer.byteLength(record, 'utf8')).toBeLessThan(4096)
    expect(Buffer.concat(records.map(record => Buffer.from(record.trimEnd(), 'base64')))).toEqual(payload)
    expect(writes.at(-1)).toBe('EOF-MARKER\n')
  })
  it('streams ordered binary stdin records and EOF through its terminal', async () => {
    const writes: string[] = []
    const stdin = new DeferredAhpStdin()
    stdin.bind({ write: async (data: string) => { writes.push(data) }, done: Promise.resolve({ exitCode: 0, signal: null }) } as never, 'EOF-MARKER')
    stdin.write(Buffer.from([0, 1, 255])); stdin.end('汉字')
    await once(stdin, 'finish')
    expect(writes).toEqual([Buffer.from([0, 1, 255]).toString('base64') + '\n', Buffer.from('汉字').toString('base64') + '\n', 'EOF-MARKER\n'])
    expect(buildRemoteStdinWriterCommand("/tmp/a'b.fifo", "end'marker")).toContain("'/tmp/a'\"'\"'b.fifo'")
  })
})

// Windows uses isolated Git Bash FIFOs; hosts without a POSIX test shell skip explicitly.
describe.skipIf(outputTestBash === undefined)('AHP bounded subprocess output', () => {
  it.each([
    [{ outputChunkBytes: 0 }, 'outputChunkBytes'],
    [{ outputChunkBytes: -1 }, 'outputChunkBytes'],
    [{ outputChunkBytes: 1.5 }, 'outputChunkBytes'],
    [{ outputChunkBytes: Infinity }, 'outputChunkBytes'],
    [{ outputPollMs: 0 }, 'outputPollMs'],
    [{ outputPollMs: 1.5 }, 'outputPollMs'],
    [{ outputPollMs: 2_147_483_648 }, 'Node timer range'],
  ] as const)('rejects invalid transport configuration %j before allocation', async (config, message) => {
    await expect(setup(config)).rejects.toThrow(message)
  })

  it('resolves deployment defaults and explicitly disables shell timeout for managed subprocesses', async () => {
    const { ctx, client } = await setup({})
    const resolved = vi.spyOn(client, 'resolve')
    await ctx.subprocess.spawn(collectedSpec()).done
    const command = client.commands.find(command => command.includes('dsh_pump'))!
    expect(command).toContain('dd bs=65536 count=1')
    expect(command).toContain('sleep 0.04')
    expect(resolved.mock.calls.some(([request]) => request.onExpiry === 'none')).toBe(true)
    assertBounds(client, 65536)
  })

  it('preserves exit status, separate collected outputs, and deletes owned resources', async () => {
    const { ctx, client, getSshFallbacks } = await setup()
    const handle = ctx.subprocess.spawn(collectedSpec())
    await expect(handle.done).resolves.toEqual({ exitCode: 23, signal: null })
    expect(handle.collected.stdout?.readFrom(0)).toEqual({ text: 'remote-stdout\n', nextOffset: 14, lossy: false })
    expect(handle.collected.stderr?.readFrom(0).text).toBe('remote-stderr\n')
    expect(await readdir(client.root)).toEqual([])
    expect(client.processes.size).toBe(0)
    expect(getSshFallbacks()).toBe(0)
    assertBounds(client, 1024)
  })

  it('settles with the command status when a descendant holds an output pipe open', async () => {
    const { ctx, client } = await setup({ outputChunkBytes: 1024, outputPollMs: 5 })
    const spec = collectedSpec()
    spec.graceMs = 150
    // The descendant outlives the command but not the test: it holds the owned
    // FIFO open just long enough to prove the drain bound settles the outcome.
    spec.argv = ['bash', '-c', "printf 'before-descendant\\n'; (sleep 1 &); exit 5"]
    const handle = ctx.subprocess.spawn(spec)
    await expect(handle.done).resolves.toEqual({ exitCode: 5, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('before-descendant\n')
    expect(await readdir(client.root)).toEqual([])
  })

  it('reads every growing binary output byte exactly once over many chunks', async () => {
    const { ctx, client } = await setup()
    const spec = collectedSpec()
    spec.argv = ['bash', '-c', "head -c 32773 /dev/zero; head -c 17003 /dev/zero | tr '\\0' E >&2; exit 7"]
    spec.stdio.stdout = 'pipe'; spec.stdio.stderr = 'pipe'
    const handle = ctx.subprocess.spawn(spec)
    const output = bytes(handle.stdout!); const error = bytes(handle.stderr!)
    await expect(handle.done).resolves.toEqual({ exitCode: 7, signal: null })
    expect(await output).toEqual(Buffer.alloc(32773))
    expect(await error).toEqual(Buffer.alloc(17003, 'E'))
    expect(client.reads.reduce((sum, read) => sum + read.bytes, 0)).toBe(32773 + 17003)
    expect(client.reads.length).toBeGreaterThan(10)
    assertBounds(client, 1024)
    expect(await readdir(client.root)).toEqual([])
  })

  it('keeps exact tail offsets while spilling the complete bounded stream locally', async () => {
    const { ctx, client } = await setup({ outputChunkBytes: 127, outputPollMs: 1 })
    const spec = collectedSpec()
    spec.argv = ['bash', '-c', "head -c 3001 /dev/zero | tr '\\0' X"]
    spec.stdio.stdout = { maxBytes: 9, spill: { maxBytes: 3001 } }
    const handle = ctx.subprocess.spawn(spec)
    await handle.done
    const read = handle.collected.stdout!.readFrom(0)
    expect(read).toMatchObject({ text: 'X'.repeat(9), nextOffset: 3001, lossy: true })
    expect(read.spillPath).toBeDefined()
    if (read.spillPath === undefined) throw new Error('missing spill')
    cleanups.push(() => unlink(read.spillPath!))
    expect(await readFile(read.spillPath)).toEqual(Buffer.alloc(3001, 'X'))
    expect(handle.collected.stdout!.readFrom(2998).text).toBe('XXX')
    assertBounds(client, 127)
  })

  it('discards a spill exceeding its cap without losing tail bytes', async () => {
    const { ctx } = await setup()
    const spec = collectedSpec(); spec.stdio.stdout = { maxBytes: 4, spill: { maxBytes: 13 } }
    const handle = ctx.subprocess.spawn(spec); await handle.done
    expect(handle.collected.stdout!.readFrom(0)).toEqual({ text: 'out\n', nextOffset: 14, lossy: true })
  })

  it('blocks the producer on an unread pipe while independently draining stderr', async () => {
    const { ctx, client } = await setup()
    const spec = collectedSpec()
    spec.argv = ['bash', '-c', 'head -c 9000 /dev/zero >&2; exec head -c 16384 /dev/zero']
    spec.stdio.stdout = 'pipe'
    const handle = ctx.subprocess.spawn(spec)
    let settled = false; void handle.done.then(() => { settled = true })
    await client.waitFor(() => client.reads.some(read => read.uri.endsWith('/stdout.chunk')) && handle.collected.stderr!.readFrom(0).nextOffset === 9000)
    const directories = await readdir(client.root)
    await client.resourceList({ uri: fileUriFromPosixPath(client.runtimeRoot + '/' + directories[0]!) })
    expect(settled).toBe(false)
    expect(handle.stdout!.readableLength).toBeLessThanOrEqual(2 * 1024)
    assertBounds(client, 1024)
    const output = bytes(handle.stdout!); await handle.done
    expect(await output).toEqual(Buffer.alloc(16384))
    expect(client.reads.filter(read => read.uri.endsWith('/stdout.chunk')).reduce((sum, read) => sum + read.bytes, 0)).toBe(16384)
    expect(await readdir(client.root)).toEqual([])
  })

  it('preserves binary inherit writes with bounded pending output', async () => {
    const { ctx, client } = await setup()
    const captured: Buffer[] = []
    const target = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) { captured.push(Buffer.from(chunk)); callback() } })
    const original = process.stdout.write.bind(process.stdout)
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      const done = typeof encoding === 'function' ? encoding : callback
      if (Buffer.isBuffer(chunk) && chunk.length > 0 && chunk.every(byte => byte === 73)) return target.write(chunk, done)
      return typeof encoding === 'function' ? original(chunk, encoding) : original(chunk, encoding ?? 'utf8', callback)
    })
    try {
      const spec = collectedSpec(); spec.argv = ['bash', '-c', "head -c 4099 /dev/zero | tr '\\0' I"]; spec.stdio.stdout = 'inherit'
      const handle = ctx.subprocess.spawn(spec)
      await handle.done
      expect(Buffer.concat(captured)).toEqual(Buffer.alloc(4099, 'I'))
      expect(handle.stdout).toBeUndefined(); expect(handle.collected.stdout).toBeUndefined()
      assertBounds(client, 1024)
    } finally { write.mockRestore(); target.end() }
  })

  it('rejects a caller-closed pipe without acknowledging unread output', async () => {
    const { ctx, client } = await setup()
    const spec = collectedSpec(); spec.argv = ['bash', '-c', 'exec head -c 32768 /dev/zero']; spec.stdio.stdout = 'pipe'
    const handle = ctx.subprocess.spawn(spec)
    const done = expect(handle.done).rejects.toThrow('output pipe closed before EOF')
    await client.waitFor(() => client.reads.some(read => read.uri.endsWith('/stdout.chunk')))
    handle.stdout!.destroy()
    await done
    expect(await readdir(client.root)).toEqual([]); expect(client.processes.size).toBe(0)
  })

  it('terminates during pipe backpressure and joins pumps before resource cleanup', async () => {
    const { ctx, client } = await setup()
    const spec = collectedSpec(); spec.argv = ['bash', '-c', 'exec head -c 1048576 /dev/zero']; spec.stdio.stdout = 'pipe'
    const handle = ctx.subprocess.spawn(spec)
    await client.waitFor(() => client.reads.some(read => read.uri.endsWith('/stdout.chunk')))
    handle.terminate(); handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(await handle.waitForExit()).toBe(true)
    expect(client.processes.size).toBe(0)
    expect(await readdir(client.root)).toEqual([])
    assertBounds(client, 1024)
  })

  it('cancels before shell allocation or resource creation', async () => {
    const { ctx, client, manager } = await setup()
    const controller = new AbortController(); controller.abort()
    const handle = ctx.subprocess.spawn({ ...collectedSpec('pipe'), signal: controller.signal })
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(client.commands).toEqual([]); expect(client.reads).toEqual([])
    expect(manager.workspaceContext).not.toHaveBeenCalled(); expect(manager.workspaceShell).not.toHaveBeenCalled()
    const writeError = await new Promise<Error | null | undefined>(resolvePromise => { handle.stdin!.write('after cancel', error => { resolvePromise(error) }) })
    expect(writeError?.message).toContain('remote stdin is already closed')
    expect(await readdir(client.root)).toEqual([])
  })

  it.each(['readFailure', 'deleteFailure'] as const)('rejects %s and cancels/reaps the remote producer', async failure => {
    const { ctx, client, manager, release } = await setup()
    client[failure] = new Error('fixture RPC failure')
    const handle = ctx.subprocess.spawn(collectedSpec())
    await expect(handle.done).rejects.toThrow('fixture RPC failure')
    await expect(manager.ownExecution.mock.calls[0]![1].done).resolves.toBeUndefined()
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
    expect(client.processes.size).toBe(0); expect(await readdir(client.root)).toEqual([])
  })

  it('terminates a process waiting for shared client readiness without stopping another consumer', async () => {
    const { ctx, client, remote } = await setup()
    const ready = unresolvedReadiness(client); const entered = deferred()
    vi.spyOn(remote, 'getClient').mockImplementation(async signal => { entered.resolve(); await ready.runtime.getClient(signal); return client })
    const anotherConsumer = ready.runtime.getClient()
    const handle = ctx.subprocess.spawn(collectedSpec('pipe'))
    await entered.promise
    handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(client.commands).toEqual([]); expect(client.terminals.size).toBe(0)
    ready.resolve()
    expect(await anotherConsumer).toBe(client)
    const next = ctx.subprocess.spawn(collectedSpec()); await next.done
    expect(next.collected.stdout!.readFrom(0).text).toBe('remote-stdout\n')
  })

  it('terminates a registered pending terminal readiness wait without waiting for shared startup', async () => {
    const { ctx, client, remote, alias, manager } = await setup()
    const ready = unresolvedReadiness(client); const entered = deferred()
    vi.spyOn(remote, 'getClient').mockImplementation(async signal => { entered.resolve(); await ready.runtime.getClient(signal); return client })
    const anotherConsumer = ready.runtime.getClient()
    const allocation = ctx.subprocess.spawnTerminal({ argv: ['bash', '-i'], cwd: alias, rows: 24, cols: 80, graceMs: 100, terminalType: 'xterm-256color' })
    const failure = expect(allocation).rejects.toThrow('Remote workspace terminal removed')
    await entered.promise
    const owned = manager.ownExecution.mock.calls[0]![1]
    await owned.terminate(); await failure
    await expect(owned.done).resolves.toBeUndefined()
    expect(client.terminals.size).toBe(0)
    ready.resolve()
    expect(await anotherConsumer).toBe(client)
    const terminal = await ctx.subprocess.spawnTerminal({ argv: ['bash', '-c', 'printf ready; exit 0'], cwd: alias, rows: 24, cols: 80, graceMs: 100, terminalType: 'xterm-256color' })
    const output = bytes(terminal.output)
    await terminal.done; expect((await output).toString()).toBe('ready')
  })

  it('removes caller abort listeners on readiness cancellation and normal readiness settlement', async () => {
    const { client } = await setup()
    const ready = unresolvedReadiness(client)
    const controller = new AbortController(); const reason = new Error('caller canceled only')
    const add = vi.spyOn(controller.signal, 'addEventListener'); const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const waiting = ready.runtime.getClient(controller.signal)
    const rejected = expect(waiting).rejects.toBe(reason)
    controller.abort(reason); await rejected
    expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1)
    const other = new AbortController(); const removeOther = vi.spyOn(other.signal, 'removeEventListener')
    const next = ready.runtime.getClient(other.signal)
    ready.resolve(); expect(await next).toBe(client)
    expect(removeOther).toHaveBeenCalledTimes(1)
  })

  it('retains preparation resources and process ownership when actual shell cleanup is unknown', async () => {
    const { ctx, client, manager, release } = await setup({ outputChunkBytes: 1024, outputPollMs: 1 }, true)
    client.beforeRequest = async method => { if (method === 'disposeTerminal') throw new Error('preparation disposal unknown') }
    const handle = ctx.subprocess.spawn(collectedSpec())
    await expect(handle.done).rejects.toThrow('private resources retained at file:')
    await expect(manager.ownExecution.mock.calls[0]![1].done).rejects.toThrow('private resources retained at file:')
    expect(client.shellScripts).toHaveLength(1)
    expect(client.shellScripts[0]).toContain('mkfifo')
    expect(client.shellScripts.some(script => script.includes('dsh_pump'))).toBe(false)
    await Promise.all([...client.terminals.values()].map(terminal => terminal.execution?.done))
    expect((await readdir(client.root)).some(name => name.startsWith('process-'))).toBe(true)
    expect(release).not.toHaveBeenCalled()
    expect(client.processes.size).toBe(0)
  })

  it('releases process quiescence after preparation operation fails but actual shell disposal confirms cleanup', async () => {
    const { ctx, client, manager, release } = await setup({ outputChunkBytes: 1024, outputPollMs: 1 }, true)
    client.beforeRequest = async method => { if (method === 'createTerminal') throw new Error('preparation creation failed') }
    const handle = ctx.subprocess.spawn(collectedSpec())
    await expect(handle.done).rejects.toThrow('preparation creation failed')
    await expect(manager.ownExecution.mock.calls[0]![1].done).resolves.toBeUndefined()
    expect(client.requests.some(request => request.method === 'disposeTerminal')).toBe(true)
    expect(client.inputDispatches).toEqual([])
    expect(release).toHaveBeenCalledTimes(1)
    expect(await readdir(client.root)).toEqual([])
  })

  it('cancels preparation shell readiness before any owned request and leaves shared readiness usable', async () => {
    const { ctx, client, remote, manager, release } = await setup({ outputChunkBytes: 1024, outputPollMs: 1 }, true)
    const ready = unresolvedReadiness(client); const entered = deferred()
    let calls = 0
    vi.spyOn(remote, 'getClient').mockImplementation(async signal => {
      if (++calls === 1) return client
      entered.resolve(); await ready.runtime.getClient(signal); return client
    })
    const anotherConsumer = ready.runtime.getClient()
    const handle = ctx.subprocess.spawn(collectedSpec())
    await entered.promise
    handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await expect(manager.ownExecution.mock.calls[0]![1].done).resolves.toBeUndefined()
    expect(client.requests).toEqual([]); expect(client.shellScripts).toEqual([])
    expect(release).toHaveBeenCalledTimes(1)
    ready.resolve(); expect(await anotherConsumer).toBe(client)
  })

  it('requires main shell quiescence even after actual output helpers report STOPPED', async () => {
    const { ctx, client, shell, manager, release } = await setup({ outputChunkBytes: 1024, outputPollMs: 1 }, true)
    const original = (shell as RemoteSshShellExecutor).execute.bind(shell)
    vi.spyOn(shell as RemoteSshShellExecutor, 'execute').mockImplementation(async spec => {
      const execution = await original(spec)
      if (!spec.command.includes('dsh_pump')) return execution
      client.beforeRequest = async method => { if (method === 'disposeTerminal') throw new Error('main disposal unknown') }
      return execution
    })
    const handle = ctx.subprocess.spawn(collectedSpec())
    await expect(handle.done).rejects.toThrow('private resources retained at file:')
    await expect(manager.ownExecution.mock.calls[0]![1].done).rejects.toThrow('private resources retained at file:')
    const directory = (await readdir(client.root)).find(name => name.startsWith('process-'))!
    expect(await readdir(join(client.root, directory))).toContain('stopped')
    await Promise.all([...client.terminals.values()].map(terminal => terminal.execution?.done))
    expect(release).not.toHaveBeenCalled()
    expect(client.processes.size).toBe(0)
  })

  it('retains ownership and private resources when preparation allocation rejects before returning an execution', async () => {
    const { ctx, client, manager, release } = await setup()
    const original = client.execute.bind(client)
    vi.spyOn(client, 'execute').mockImplementation(async spec => {
      const execution = await original(spec); await execution.result()
      throw new Error('allocation returned no cleanup evidence')
    })
    const handle = ctx.subprocess.spawn(collectedSpec())
    await expect(handle.done).rejects.toThrow('private resources retained at file:')
    await expect(manager.ownExecution.mock.calls[0]![1].done).rejects.toThrow('private resources retained at file:')
    expect(release).not.toHaveBeenCalled()
    expect((await readdir(client.root)).some(name => name.startsWith('process-'))).toBe(true)
    expect(client.processes.size).toBe(0)
  })

  it.each(['create', 'subscribe'] as const)('cancels an output helper before %s dispatch and releases proven-safe cleanup', async phase => {
    const { ctx, client, shell, manager, release } = await setup({ outputChunkBytes: 1024, outputPollMs: 1 }, true)
    const entered = deferred(); const continueRPC = deferred()
    cleanups.push(async () => { continueRPC.resolve() })
    let blockedChannel = ''
    const block = async (channel: string) => {
      if (!client.shellScripts.at(-1)?.includes('dsh_pump')) return
      blockedChannel = channel; entered.resolve(); await continueRPC.promise
    }
    if (phase === 'create') client.beforeRequest = async (method, channel) => { if (method === 'createTerminal') await block(channel) }
    else client.beforeSubscribe = block
    const executions = vi.spyOn(shell as RemoteSshShellExecutor, 'execute')
    const handle = ctx.subprocess.spawn(collectedSpec())
    await entered.promise
    expect((await readdir(client.root)).some(name => name.startsWith('process-'))).toBe(true)
    const owned = manager.ownExecution.mock.calls[0]![1]
    handle.terminate(); continueRPC.resolve()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await expect(owned.done).resolves.toBeUndefined()
    const helper = await executions.mock.results[1]!.value
    await expect(helper.dispatched).resolves.toBe(false)
    expect(client.inputDispatches.some(input => input.channel === blockedChannel)).toBe(false)
    expect(client.disposedTerminals.has(blockedChannel)).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
    expect(await readdir(client.root)).toEqual([])
  })

  it('settles quiescence only after the final owned resource mutation acknowledges', async () => {
    const { ctx, client, manager, release } = await setup()
    const entered = deferred(); const continueRPC = deferred()
    cleanups.push(async () => { continueRPC.resolve() })
    client.afterDelete = async uri => {
      if (new URL(uri).pathname.split('/').at(-1)?.startsWith('process-')) { entered.resolve(); await continueRPC.promise }
    }
    const handle = ctx.subprocess.spawn(collectedSpec())
    const owned = manager.ownExecution.mock.calls[0]![1]
    let quiescent = false; void owned.done.then(() => { quiescent = true })
    await entered.promise
    expect(quiescent).toBe(false); expect(release).not.toHaveBeenCalled()
    continueRPC.resolve()
    await owned.done; await handle.done
    expect(release).toHaveBeenCalledTimes(1)
  })

  it.each(['create', 'subscribe'] as const)('normalizes pending raw terminal %s cancellation only after disposal ACK', async phase => {
    const { ctx, client, alias, manager, release } = await setup()
    const entered = deferred(); const continueRPC = deferred()
    cleanups.push(async () => { continueRPC.resolve() })
    let channel = ''
    const block = async (value: string) => { channel = value; entered.resolve(); await continueRPC.promise }
    if (phase === 'create') client.beforeRequest = async (method, value) => { if (method === 'createTerminal') await block(value) }
    else client.beforeSubscribe = block
    const allocation = ctx.subprocess.spawnTerminal({ argv: ['bash', '-i'], cwd: alias, rows: 24, cols: 80, graceMs: 100, terminalType: 'xterm-256color' })
    const outcome = expect(allocation).rejects.toThrow('Remote workspace terminal removed')
    await entered.promise
    const owned = manager.ownExecution.mock.calls[0]![1]
    const terminating = owned.terminate(); continueRPC.resolve()
    await terminating; await outcome
    await expect(owned.done).resolves.toBeUndefined()
    expect(client.disposedTerminals.has(channel)).toBe(true)
    expect(client.inputDispatches).toEqual([])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('retains pending raw terminal ownership when its disposal acknowledgment is uncertain', async () => {
    const { ctx, client, alias, manager, release } = await setup()
    const entered = deferred(); const continueRPC = deferred()
    cleanups.push(async () => { continueRPC.resolve() })
    client.beforeRequest = async method => {
      if (method === 'createTerminal') { entered.resolve(); await continueRPC.promise }
      else if (method === 'disposeTerminal') throw new Error('uncertain disposal')
    }
    const allocation = ctx.subprocess.spawnTerminal({ argv: ['bash', '-i'], cwd: alias, rows: 24, cols: 80, graceMs: 100, terminalType: 'xterm-256color' })
    const outcome = expect(allocation).rejects.toThrow('terminal allocation cleanup unobservable')
    await entered.promise
    const owned = manager.ownExecution.mock.calls[0]![1]
    const terminating = owned.terminate(); continueRPC.resolve()
    await terminating; await outcome
    await expect(owned.done).rejects.toThrow('terminal allocation cleanup unobservable')
    expect(client.inputDispatches).toEqual([])
    expect(release).not.toHaveBeenCalled()
  })

  it('retains ordinary process ownership when its stdin terminal allocation cleanup is uncertain', async () => {
    const { ctx, client, manager, release } = await setup()
    const original = client.execute.bind(client)
    vi.spyOn(client, 'execute').mockImplementation(async spec => {
      if (!spec.command.includes('dsh_pump')) return original(spec)
      const result = new Promise<{ exitCode: null; signal: 'SIGTERM'; timedOut: false; aborted: true; timeoutMs: number; stdout: { text: string; truncated: false }; stderr: { text: string; truncated: false } }>(resolvePromise => {
        const finish = () => { resolvePromise({ exitCode: null, signal: 'SIGTERM', timedOut: false, aborted: true, timeoutMs: 10_000, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }) }
        if (spec.signal?.aborted) finish()
        else spec.signal?.addEventListener('abort', finish, { once: true })
      })
      return { dispatched: Promise.resolve(false), quiescent: result.then(() => {}), result: () => result }
    })
    const entered = deferred(); const continueRPC = deferred()
    cleanups.push(async () => { continueRPC.resolve() })
    client.beforeRequest = async method => {
      if (method === 'createTerminal') { entered.resolve(); await continueRPC.promise }
      else if (method === 'disposeTerminal') throw new Error('stdin disposal uncertain')
    }
    const handle = ctx.subprocess.spawn(collectedSpec('pipe'))
    const failure = expect(handle.done).rejects.toThrow('owned helper cleanup unobservable; private resources retained at file:')
    await entered.promise
    handle.terminate(); continueRPC.resolve()
    await failure
    await expect(manager.ownExecution.mock.calls[0]![1].done).rejects.toThrow('owned helper cleanup unobservable')
    expect(release).not.toHaveBeenCalled()
    expect((await readdir(client.root)).some(name => name.startsWith('process-'))).toBe(true)
    expect(client.processes.size).toBe(0)
  })

  it('releases raw terminal quiescence after a subscription operation error and confirmed disposal', async () => {
    const { ctx, client, alias, manager, release } = await setup()
    const terminal = await ctx.subprocess.spawnTerminal({ argv: ['bash', '-c', 'exec cat'], cwd: alias, rows: 24, cols: 80, graceMs: 100, terminalType: 'xterm-256color' })
    const error = expect(terminal.done).rejects.toThrow('subscription ended before terminal exit')
    const remote = [...client.terminals.values()][0]!
    await remote.execution!.ready
    await remote.subscription.close()
    await error
    await expect(manager.ownExecution.mock.calls[0]![1].done).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledTimes(1)
    expect(client.processes.size).toBe(0)
  })

  it('keeps a subscription-close operation error separate from confirmed terminal disposal', async () => {
    const { ctx, client, alias, manager, release } = await setup()
    const terminal = await ctx.subprocess.spawnTerminal({ argv: ['bash', '-c', 'exec cat'], cwd: alias, rows: 24, cols: 80, graceMs: 100, terminalType: 'xterm-256color' })
    const remote = [...client.terminals.values()][0]!
    await remote.execution!.ready
    vi.spyOn(remote.subscription, 'close').mockRejectedValue(new Error('subscription close failed'))
    const outcome = expect(terminal.done).rejects.toThrow('subscription close failed')
    await terminal.terminate(); await outcome
    await expect(manager.ownExecution.mock.calls[0]![1].done).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledTimes(1)
    expect(client.processes.size).toBe(0)
  })

  it('preserves observed terminal exit and proven quiescence when later disposal fails', async () => {
    const { ctx, client, alias, manager, release } = await setup()
    client.beforeRequest = async method => { if (method === 'disposeTerminal') throw new Error('disposal after exit failed') }
    const terminal = await ctx.subprocess.spawnTerminal({ argv: ['bash', '-c', 'printf observed; exit 19'], cwd: alias, rows: 24, cols: 80, graceMs: 100, terminalType: 'xterm-256color' })
    const output = bytes(terminal.output)
    await expect(terminal.done).resolves.toEqual({ exitCode: 19, signal: null })
    expect((await output).toString()).toBe('observed')
    await expect(manager.ownExecution.mock.calls[0]![1].done).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledTimes(1)
    expect(client.processes.size).toBe(0)
  })

  it('retains allocated raw terminal ownership after uncertain disposal without an unhandled promise', async () => {
    const { ctx, client, alias, manager, release } = await setup()
    const terminal = await ctx.subprocess.spawnTerminal({ argv: ['bash', '-c', 'exec cat'], cwd: alias, rows: 24, cols: 80, graceMs: 100, terminalType: 'xterm-256color' })
    const remote = [...client.terminals.values()][0]!
    await remote.execution!.ready
    client.beforeRequest = async method => { if (method === 'disposeTerminal') throw new Error('terminal disposal uncertain') }
    const error = expect(terminal.done).rejects.toThrow('terminal cleanup unobservable')
    await expect(terminal.terminate()).rejects.toThrow('terminal cleanup unobservable')
    await error
    await expect(manager.ownExecution.mock.calls[0]![1].done).rejects.toThrow('terminal cleanup unobservable')
    expect(release).not.toHaveBeenCalled()
  })

  it('waits for an in-flight resource read to settle during cancellation', async () => {
    const { ctx, client } = await setup()
    const entered = deferred(); const release = deferred()
    client.beforeRead = async () => { entered.resolve(); await release.promise }
    const handle = ctx.subprocess.spawn(collectedSpec())
    await entered.promise; handle.terminate(); release.resolve()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(await readdir(client.root)).toEqual([])
  })

  it('rejects successful shell exit without output EOF instead of silently truncating', async () => {
    const { ctx, client } = await setup()
    const original = client.execute.bind(client)
    vi.spyOn(client, 'execute').mockImplementation(async spec => {
      if (!spec.command.includes('dsh_pump')) return original(spec)
      const directory = /dsh_dir='([^']+)'/.exec(spec.command)![1]!
      await client.resourceWrite({ uri: fileUriFromPosixPath(directory + '/stopped'), data: '', encoding: 'base64' })
      return { dispatched: Promise.resolve(true), quiescent: Promise.resolve(), result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 10_000, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }) }
    })
    await expect(ctx.subprocess.spawn(collectedSpec()).done).rejects.toThrow('before stdout/stderr EOF')
    expect(await readdir(client.root)).toEqual([])
  })

  it('waits for remote helper shutdown after an early terminal-disposal acknowledgment', async () => {
    const { ctx, client } = await setup()
    client.earlyCancellation = true
    const spec = collectedSpec(); spec.argv = ['bash', '-c', 'exec head -c 1048576 /dev/zero']; spec.stdio.stdout = 'pipe'; spec.graceMs = 3000
    const handle = ctx.subprocess.spawn(spec)
    await client.waitFor(() => client.reads.some(read => read.uri.endsWith('/stdout.chunk')))
    handle.terminate()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    expect(client.listings.some(entries => entries.some(entry => entry.name === 'stopped'))).toBe(true)
    expect(await readdir(client.root)).toEqual([])
    await client.waitFor(() => client.processes.size === 0)
  })

  it('retains bounded private resources and rejects unobservable dispatched helper shutdown', async () => {
    const { ctx, client, manager, release } = await setup()
    const original = client.execute.bind(client)
    vi.spyOn(client, 'execute').mockImplementation(spec => spec.command.includes('dsh_pump')
      ? Promise.resolve({ dispatched: Promise.resolve(true), quiescent: Promise.resolve(), result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 10_000, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }) })
      : original(spec))
    const spec = collectedSpec()
    // The observation deadline is graceMs: keep it short so the rejection is prompt.
    spec.graceMs = 300
    const handle = ctx.subprocess.spawn(spec)
    await expect(handle.done).rejects.toThrow('shutdown unobservable after graceMs; private resources retained at file:')
    await expect(handle.waitForExit()).rejects.toThrow('shutdown unobservable')
    await expect(manager.ownExecution.mock.calls[0]![1].done).rejects.toThrow('shutdown unobservable')
    expect(release).not.toHaveBeenCalled()
    expect((await readdir(client.root)).length).toBe(1)
    assertBounds(client, 1024)
  })

  it('bounds stopped-marker observation even when the AHP listing RPC stalls', async () => {
    const { ctx, client } = await setup()
    const entered = deferred(); const release = deferred(); const returned = deferred()
    client.beforeListReturn = async names => {
      if (names.includes('stopped')) { entered.resolve(); await release.promise; returned.resolve() }
    }
    const spec = collectedSpec()
    spec.graceMs = 300
    const handle = ctx.subprocess.spawn(spec)
    const done = expect(handle.done).rejects.toThrow('shutdown unobservable after graceMs')
    try {
      await entered.promise
      await done
      expect((await readdir(client.root)).length).toBe(1)
    } finally { release.resolve(); await returned.promise }
  })

  it('accepts complete EOF even when its deletion acknowledgment arrives after remote exit', async () => {
    const { ctx, client } = await setup()
    const entered = deferred(); const release = deferred()
    client.afterDelete = async uri => {
      if (uri.endsWith('/stdout.chunk') && client.reads.filter(read => read.uri === uri).at(-1)?.bytes === 0) {
        entered.resolve(); await release.promise
      }
    }
    const handle = ctx.subprocess.spawn(collectedSpec())
    await entered.promise
    await client.waitFor(() => client.processes.size === 0)
    release.resolve()
    await expect(handle.done).resolves.toEqual({ exitCode: 23, signal: null })
    expect(await readdir(client.root)).toEqual([])
  })

  it('forwards fixed and piped binary stdin through AHP while keeping outputs separate', async () => {
    const { ctx, client } = await setup()
    const input = Buffer.from([0, 255, 1, 10, 128])
    for (const { mode, expected } of [{ mode: { data: 'fixed\0汉字\n' }, expected: Buffer.from('fixed\0汉字\n') }, { mode: 'pipe', expected: input }] as const) {
      const spec = collectedSpec(mode); spec.argv = ['bash', '-c', "cat; printf end >&2"]
      spec.stdio.stdout = 'pipe'
      const handle = ctx.subprocess.spawn(spec)
      const output = bytes(handle.stdout!)
      if (mode === 'pipe') handle.stdin!.end(input)
      await handle.done
      expect(await output).toEqual(expected)
      expect(handle.collected.stderr!.readFrom(0).text).toBe('end')
    }
    expect(await readdir(client.root)).toEqual([])
  })

  it('allocates interactive terminals through the AHP path', async () => {
    const { ctx, alias, getSshFallbacks } = await setup()
    const terminal = await ctx.subprocess.spawnTerminal({ argv: ['bash', '-c', "printf interactive; exit 9"], cwd: alias, rows: 30, cols: 100, graceMs: 100, terminalType: 'xterm-256color' })
    const output = bytes(terminal.output)
    await expect(terminal.done).resolves.toEqual({ exitCode: 9, signal: null })
    expect((await output).toString()).toBe('interactive')
    expect(getSshFallbacks()).toBe(0)
  })
})
