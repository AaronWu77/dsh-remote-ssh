import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { Readable } from 'node:stream'
import { ActionType } from '@microsoft/agent-host-protocol'
import type { ContentEncoding, TerminalClientClaim } from '@microsoft/agent-host-protocol'
import type { AhpClient, Subscription } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { OutputCollector, prepareManagedProcessBinding } from '@deepseek-ai/dsh-subprocess-local/output'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalForeground,
  SubprocessTerminalActivity,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { RemoteShellExecution } from './shell.ts'
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'
import { fileUriFromPosixPath, quotePosix } from './index.ts'

/** Remote output transport limits, resolved before any subprocess allocation. */
export interface Config {
  /** Maximum bytes in each remote output slot and local pipe high-water mark. */
  outputChunkBytes?: number
  /** Client and remote deletion-ACK polling interval in milliseconds. */
  outputPollMs?: number
}

interface OutputTransportConfig {
  outputChunkBytes: number
  outputPollMs: number
}

/** Subprocess router that selects the host from `spec.cwd`, never tool identity. */
export class TransparentSubprocessRuntime extends SubprocessRuntime {
  static inject = ['localSubprocess', 'remoteSshManager']
  static Config: z<Config> = z.object({
    outputChunkBytes: z.number().default(64 * 1024),
    outputPollMs: z.number().default(40),
  })

  private readonly outputTransport: OutputTransportConfig

  private readonly local: SubprocessRuntime
  private readonly manager: RemoteSshManager
  private readonly remoteHandles = new Set<RemoteAhpProcessHandle>()
  private readonly remoteTerminals = new Set<RemoteAhpTerminalHandle>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.outputTransport = {
      outputChunkBytes: config.outputChunkBytes ?? 64 * 1024,
      outputPollMs: config.outputPollMs ?? 40,
    }
    for (const [name, value] of Object.entries(this.outputTransport)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(
        `dsh-remote-ssh/router-subprocess: ${name} must be a positive integer`,
      )
    }
    if (this.outputTransport.outputPollMs > 2_147_483_647) throw new Error('dsh-remote-ssh/router-subprocess: outputPollMs exceeds the Node timer range')
    this.local = ctx.localSubprocess
    this.manager = ctx.remoteSshManager
    ctx.effect(() => async () => {
      for (const handle of this.remoteHandles) handle.terminate()
      await Promise.allSettled([...this.remoteHandles].map(handle => handle.quiescent))
      await Promise.allSettled([...this.remoteTerminals].map(terminal => terminal.terminate()))
    }, 'Remote SSH subprocess teardown')
  }

  override resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    // Executable lookup has no cwd in the DSH seam. Keep constructor-time
    // discovery local; a remote spawn re-resolves the executable in the
    // selected workspace's execution world.
    return this.local.resolveExecutable(command, env, signal)
  }

  override terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    return this.local.terminalEnvironment(signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const route = this.manager.route(undefined, spec.cwd)
    if (route.kind === 'local') return this.local.spawn(spec)
    if (spec.stdio.control === 'pipe') throw new Error('dsh-remote-ssh: remote AHP subprocesses do not support a control pipe; keep the PTC interpreter on localSubprocess')
    const handle = new RemoteAhpProcessHandle(
      route,
      () => this.manager.workspaceContext(route),
      () => this.manager.workspaceShell(route, 'bash'),
      spec,
      this.outputTransport,
    )
    const release = this.manager.ownExecution(route, { terminate: () => { handle.terminate() }, done: handle.quiescent })
    this.remoteHandles.add(handle)
    void handle.quiescent.then(() => { release(); this.remoteHandles.delete(handle) }).catch(() => {})
    // Operation failure is caller-visible but does not determine cleanup ownership.
    void handle.done.catch(() => {})
    return handle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const route = this.manager.route(undefined, spec.cwd)
    if (route.kind === 'local') return this.local.spawnTerminal(spec)
    const controller = new AbortController()
    const signal = spec.signal ? AbortSignal.any([spec.signal, controller.signal]) : controller.signal
    let quiescent: Promise<void> = Promise.resolve()
    const allocation = this.manager.workspaceContext(route).then(workspace => RemoteAhpTerminalHandle.create(
      route, workspace, { ...spec, signal }, cleanup => { quiescent = cleanup },
    ))
    const execution = {
      terminate: () => { controller.abort(new Error('Remote workspace terminal removed')); return allocation.then(handle => handle.terminate(), () => {}) },
      // Allocation failure does not imply unknown cleanup; the allocator reports it separately.
      done: allocation.then(() => quiescent, () => quiescent),
    }
    const release = this.manager.ownExecution(route, execution)
    void execution.done.then(release).catch(() => {})
    const handle = await allocation
    this.remoteTerminals.add(handle)
    void handle.quiescent.then(() => { this.remoteTerminals.delete(handle) }).catch(() => {})
    void handle.done.catch(() => {})
    return handle
  }
}

/**
 * Subprocess over the persistent host AHP connection. A short-lived remote
 * PTY launches argv through two bounded FIFO pumps. Each stream owns one
 * immutable resource slot; deletion acknowledges downstream acceptance. With
 * chunk size C, output files occupy at most 2C bytes including temporary files
 * (rename moves, never copies). Each resourceRead carries at most 4*ceil(C/3)
 * base64 characters. FIFO kernel buffers are additional, OS-bounded storage.
 * Local pipes have readable/writable high-water marks C and one pending chunk;
 * collection retains its requested tail/spill caps. Live stdin uses a second
 * AHP Terminal. Cleanup observes the wrapper/helper stopped marker within
 * graceMs; shell-owned dispatch evidence skips observation only for a command
 * known never submitted. Preparation and main shell cleanup acknowledgments
 * are required independently of that marker. Cleanup and operation outcome settle independently;
 * an unobservable dispatched wrapper rejects cleanup and retains its private
 * directory. AHP disposal cannot observe escaped command descendants or
 * cancel in-flight resource RPCs. Live stdin retains its terminal dispatch limits.
 */
class RemoteAhpProcessHandle implements SubprocessHandle {
  readonly pid = -1
  readonly control = undefined
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  /** Authoritative command/helper shutdown and settlement of owned resource operations. */
  readonly quiescent: Promise<void>

  private readonly cleanup = Promise.withResolvers<void>()
  private cleanupFailure: Error | undefined
  private readonly controller = new AbortController()
  private readonly stdoutSink: RemoteOutputSink
  private readonly stderrSink: RemoteOutputSink
  private readonly stdinPipe: DeferredAhpStdin | undefined
  private settled = false

  constructor(
    private readonly route: RemoteWorkspaceRoute,
    private readonly workspace: () => ReturnType<RemoteSshManager['workspaceContext']>,
    private readonly shell: () => ReturnType<RemoteSshManager['workspaceShell']>,
    private readonly spec: SubprocessSpawnSpec,
    private readonly transport: OutputTransportConfig,
  ) {
    this.quiescent = this.cleanup.promise
    void this.quiescent.catch(() => {})
    this.stdoutSink = new RemoteOutputSink(spec.stdio.stdout, process.stdout, 'stdout', transport.outputChunkBytes)
    this.stderrSink = new RemoteOutputSink(spec.stdio.stderr, process.stderr, 'stderr', transport.outputChunkBytes)
    this.stdout = this.stdoutSink.stream
    this.stderr = this.stderrSink.stream
    this.stdinPipe = spec.stdio.stdin === 'pipe' ? new DeferredAhpStdin() : undefined
    this.stdin = this.stdinPipe
    this.collected = {
      ...(this.stdoutSink.reader === undefined ? {} : { stdout: this.stdoutSink.reader }),
      ...(this.stderrSink.reader === undefined ? {} : { stderr: this.stderrSink.reader }),
    }
    const onAbort = () => { this.controller.abort(spec.signal?.reason) }
    if (spec.signal?.aborted) onAbort()
    else spec.signal?.addEventListener('abort', onAbort, { once: true })
    this.done = this.execute().catch(error => {
      this.stdinPipe?.fail(error)
      throw error
    }).finally(() => {
      try {
        this.settled = true
        this.stdinPipe?.finishRemote()
        spec.signal?.removeEventListener('abort', onAbort)
        this.stdoutSink.end()
        this.stderrSink.end()
      } finally {
        if (this.cleanupFailure === undefined) this.cleanup.resolve()
        else this.cleanup.reject(this.cleanupFailure)
      }
    })
  }

  terminate(): void {
    if (!this.settled) this.controller.abort(new Error('remote subprocess terminated'))
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false
    if (signal === undefined) { await this.quiescent; return true }
    const exited = this.quiescent.then(() => true)
    return new Promise<boolean>((resolvePromise, reject) => {
      const onAbort = (): void => { signal.removeEventListener('abort', onAbort); resolvePromise(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void exited.then(value => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      }, error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      })
      if (signal.aborted) onAbort()
    })
  }

  private async execute(): Promise<SubprocessOutcome> {
    const stdinMode = this.spec.stdio.stdin
    const cancelled = (): SubprocessOutcome => ({ exitCode: null, signal: 'SIGTERM' })
    if (this.controller.signal.aborted) return cancelled()
    const [workspace, shell] = await Promise.all([this.workspace(), this.shell()])
    if (this.controller.signal.aborted) return cancelled()
    const { remote } = workspace
    const client = await remote.getClient(this.controller.signal).catch(error => {
      if (this.controller.signal.aborted) return undefined
      throw error
    })
    if (client === undefined || this.controller.signal.aborted) return cancelled()
    const directory = `${remote.runtimeRoot}/process-${randomUUID()}`
    const directoryUri = fileUriFromPosixPath(directory)
    const stdinPath = `${directory}/stdin.bin`
    const fifoPath = `${directory}/stdin.fifo`
    let writer: RemoteAhpTerminalHandle | undefined
    let stdinCleanup: Promise<void> | undefined
    let allocation: Promise<RemoteShellExecution> | undefined
    const shellAllocations: Promise<RemoteShellExecution>[] = []
    let run: Promise<import('@deepseek-ai/dsh-shell').ShellRunResult> | undefined
    let drains: Promise<boolean>[] | undefined
    let completed = false
    let transportFailure: unknown
    const execute = (command: string, longLived = false) => {
      const owned = shell.execute(shell.resolve({
        command, workdir: this.spec.cwd, signal: this.controller.signal,
        ...(longLived ? { onExpiry: 'none' as const } : {}),
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: this.route.aliasPath },
      }))
      shellAllocations.push(owned)
      void owned.then(execution => execution.quiescent).catch((_error) => { /* Observe early rejection without replacing the cleanup result. */ })
      return owned
    }
    try {
      const fifos = [`${directory}/stdout.fifo`, `${directory}/stderr.fifo`, ...(stdinMode === 'pipe' ? [fifoPath] : [])]
      const preparation = await execute(`umask 077; mkdir -- ${quotePosix(directory)} && mkfifo -- ${fifos.map(quotePosix).join(' ')}`)
      const prepared = await preparation.result()
      await preparation.quiescent
      if (this.controller.signal.aborted) return cancelled()
      if (prepared.exitCode !== 0) throw new Error(`dsh-remote-ssh: failed to prepare output transport (exit ${prepared.exitCode ?? prepared.signal})`)
      if (typeof stdinMode === 'object') await client.resourceWrite({
        uri: fileUriFromPosixPath(stdinPath), data: Buffer.from(stdinMode.data).toString('base64'), encoding: BASE64,
      })
      if (this.controller.signal.aborted) return cancelled()
      const inputPath = stdinMode === 'ignore' ? '/dev/null' : stdinMode === 'pipe' ? fifoPath : stdinPath
      const argvCommand = buildRemoteProcessCommand(this.spec.argv, this.spec.env, inputPath, fifos[0]!, fifos[1]!)
      allocation = execute(buildRemoteOutputTransportCommand(argvCommand, directory, this.transport.outputChunkBytes, this.transport.outputPollMs, this.spec.graceMs), true)
      run = allocation.then(execution => execution.result()).finally(() => { completed = true })
      // Observe failures while the optional stdin terminal is allocating.
      const failTransport = (error: unknown) => { transportFailure ??= error; this.controller.abort(error) }
      void run.then(result => {
        // Helper-side termination aborts the drains; whether both streams really
        // reached EOF is settled by the drain results below, because a bounded
        // drain legitimately ends without either zero-length EOF slot.
        if (result.signal !== null) this.controller.abort()
      }, failTransport)
      drains = [
        this.drain(client, directoryUri, 'stdout', this.stdoutSink, () => completed),
        this.drain(client, directoryUri, 'stderr', this.stderrSink, () => completed),
      ]
      for (const drain of drains) void drain.catch(failTransport)
      if (stdinMode === 'pipe') {
        const endMarker = `__DSH_STDIN_EOF_${randomUUID().replaceAll('-', '')}__`
        writer = await RemoteAhpTerminalHandle.create(this.route, workspace, {
          argv: ['bash', '-c', buildRemoteStdinWriterCommand(fifoPath, endMarker)],
          cwd: this.spec.cwd, rows: 24, cols: 80, terminalType: 'xterm-256color',
          graceMs: this.spec.graceMs, signal: this.controller.signal,
        }, cleanup => { stdinCleanup = cleanup })
        writer.output.resume()
        this.stdinPipe?.bind(writer, endMarker)
      }
      const [result, drained] = await Promise.all([run, Promise.all(drains)])
      if (transportFailure !== undefined) throw transportFailure
      if (result.signal === null && !this.controller.signal.aborted && drained.some(value => !value)) {
        throw new Error('dsh-remote-ssh: output transport ended before stdout/stderr EOF')
      }
      return { exitCode: result.exitCode, signal: result.signal }
    } catch (error) {
      const wasCancelled = this.controller.signal.aborted && transportFailure === undefined
      this.stdinPipe?.fail(error)
      this.controller.abort(error)
      await Promise.allSettled([...(run === undefined ? [] : [run]), ...(drains ?? [])])
      if (transportFailure !== undefined) throw transportFailure
      if (wasCancelled) return cancelled()
      throw error
    } finally {
      try {
        this.stdinPipe?.finishRemote()
        const cleanup = shellAllocations.map(async owned => (await owned).quiescent)
        if (writer !== undefined) cleanup.push(writer.terminate())
        if (stdinCleanup !== undefined) cleanup.push(stdinCleanup)
        if (allocation !== undefined) {
          const owned = allocation
          cleanup.push((async () => {
            if (await (await owned).dispatched) await this.observeTransportStop(client, directoryUri)
          })())
        }
        const settled = await Promise.allSettled(cleanup)
        const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'dsh-remote-ssh: owned helper cleanup unobservable; private resources retained at ' + directoryUri)
        await client.resourceDelete({ uri: directoryUri, recursive: true }).catch(() => {})
      } catch (error) {
        this.cleanupFailure = error instanceof Error && error.message.includes(directoryUri)
          ? error
          : new Error('dsh-remote-ssh: owned helper cleanup unobservable; private resources retained at ' + directoryUri, { cause: error })
        throw this.cleanupFailure
      }
    }
  }

  private async observeTransportStop(client: AhpClient, directoryUri: string): Promise<void> {
    const deadline = performance.now() + this.spec.graceMs
    const unobservable = new Error('dsh-remote-ssh: output helper shutdown unobservable after graceMs; private resources retained at ' + directoryUri)
    for (;;) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw unobservable
      let timer: ReturnType<typeof setTimeout> | undefined
      let stopped: boolean
      try {
        // AHP cannot cancel resourceList; a late read-only response is discarded.
        const listed = await Promise.race([
          client.resourceList({ uri: directoryUri }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(unobservable), remaining) }),
        ])
        stopped = listed.entries.some(entry => entry.name === 'stopped')
      } catch (error) {
        if (error === unobservable) throw error
        throw new Error('dsh-remote-ssh: cannot observe output helper shutdown; private resources retained at ' + directoryUri, { cause: error })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (stopped) return
      await delay(Math.min(this.transport.outputPollMs, Math.max(0, deadline - performance.now())))
    }
  }

  private async drain(client: AhpClient, directoryUri: string, name: string, sink: RemoteOutputSink, completed: () => boolean): Promise<boolean> {
    const uri = `${directoryUri}/${name}.chunk`
    while (!this.controller.signal.aborted) {
      const listed = await client.resourceList({ uri: directoryUri })
      if (this.controller.signal.aborted) return false
      if (listed.entries.some(entry => entry.name === `${name}.chunk`)) {
        const chunk = await readRemoteOutput(client, uri)
        if (chunk.length > this.transport.outputChunkBytes) throw new Error('dsh-remote-ssh: output slot exceeds configured byte limit')
        if (this.controller.signal.aborted) return false
        if (chunk.length > 0) await sink.append(chunk, this.controller.signal)
        if (this.controller.signal.aborted) return false
        await client.resourceDelete({ uri, recursive: false })
        if (chunk.length === 0) return true
      } else if (completed()) {
        // The transport script bounds post-exit draining. Re-list once: the earlier
        // snapshot can predate both the final chunk and the expiry marker.
        const settled = await client.resourceList({ uri: directoryUri })
        if (settled.entries.some(entry => entry.name === `${name}.chunk`)) continue
        return settled.entries.some(entry => entry.name === 'drain-expired')
      } else await delay(this.transport.outputPollMs, this.controller.signal)
    }
    return false
  }
}

/** Interactive terminal over the same persistent AHP host connection. */
class RemoteAhpTerminalHandle implements SubprocessTerminalHandle {
  readonly pid = -1
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>
  readonly quiescent: Promise<void>

  private readonly cleanup = Promise.withResolvers<void>()
  private cleanupFailure: Error | undefined
  private exited = false

  private stopping: ((signal: NodeJS.Signals) => void) | undefined
  private readonly stopped = new Promise<NodeJS.Signals>(resolvePromise => { this.stopping = resolvePromise })
  private terminating: Promise<void> | undefined

  private constructor(
    private readonly client: AhpClient,
    private readonly channel: string,
    private readonly subscription: Subscription,
  ) {
    this.quiescent = this.cleanup.promise
    void this.quiescent.catch(() => {})
    this.done = this.pump().finally(() => {
      if (this.cleanupFailure === undefined) this.cleanup.resolve()
      else this.cleanup.reject(this.cleanupFailure)
    })
    void this.done.catch(() => {})
  }

  static async create(
    route: RemoteWorkspaceRoute,
    workspace: Awaited<ReturnType<RemoteSshManager['workspaceContext']>>,
    spec: SubprocessTerminalSpawnSpec,
    observeCleanup?: (quiescent: Promise<void>) => void,
  ): Promise<RemoteAhpTerminalHandle> {
    const cleanup = Promise.withResolvers<void>()
    void cleanup.promise.catch(() => {})
    observeCleanup?.(cleanup.promise)
    let client: AhpClient | undefined
    let attempted = false
    let handle: RemoteAhpTerminalHandle | undefined
    const channel = `ahp-terminal:/${randomUUID()}`
    try {
      spec.signal?.throwIfAborted()
      client = await workspace.remote.getClient(spec.signal)
      spec.signal?.throwIfAborted()
      const claim = { kind: 'client', clientId: workspace.remote.clientId } as TerminalClientClaim
      const params = {
        channel, claim, name: 'DeepSeek Harness Remote SSH subprocess',
        cwd: fileUriFromPosixPath(route.mapper.toRemotePath(spec.cwd)),
        cols: spec.cols, rows: spec.rows,
      }
      attempted = true
      await client.request('createTerminal', params)
      spec.signal?.throwIfAborted()
      const subscribed = await client.subscribe(channel)
      const terminal = new RemoteAhpTerminalHandle(client, channel, subscribed.subscription)
      handle = terminal
      void terminal.quiescent.then(cleanup.resolve, cleanup.reject)
      spec.signal?.throwIfAborted()
      if (spec.signal !== undefined) {
        const onAbort = () => { void terminal.terminate().catch(() => {}) }
        spec.signal.addEventListener('abort', onAbort, { once: true })
        void terminal.quiescent.finally(() => { spec.signal?.removeEventListener('abort', onAbort) }).catch(() => {})
      }
      client.dispatch(channel, { type: ActionType.TerminalInput, data: `${buildRemoteInteractiveCommand(spec.argv, spec.env)}\r` })
      return terminal
    } catch (error) {
      if (handle !== undefined) {
        await handle.terminate()
      } else if (client !== undefined && attempted) {
        try {
          await client.request('disposeTerminal', { channel })
        } catch (failure) {
          const unknown = new Error('dsh-remote-ssh: terminal allocation cleanup unobservable at ' + channel, { cause: failure })
          cleanup.reject(unknown)
          throw unknown
        }
        cleanup.resolve()
      } else cleanup.resolve()
      throw error
    }
  }
  async write(data: string): Promise<void> {
    this.client.dispatch(this.channel, { type: ActionType.TerminalInput, data })
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.client.dispatch(this.channel, { type: ActionType.TerminalResized, cols, rows })
  }

  async inspectActivity(): Promise<SubprocessTerminalActivity> {
    return { state: 'unknown', revision: 0 }
  }

  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return undefined
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    if (signal === 'SIGINT') {
      await this.write('\x03')
      return -1
    }
    if (signal === 'SIGTSTP') {
      await this.write('\x1a')
      return -1
    }
    throw new Error(`dsh-remote-ssh: AHP PTY cannot address a foreground process group for ${signal}`)
  }

  terminate(): Promise<void> {
    this.terminating ??= (async () => {
      // The pump retries disposal and reports authoritative cleanup after both calls settle.
      await this.client.request('disposeTerminal', { channel: this.channel }).catch(() => {})
      this.stopping?.('SIGTERM')
      await this.quiescent
    })()
    return this.terminating
  }

  private async pump(): Promise<SubprocessOutcome> {
    try {
      for (;;) {
        const next = await Promise.race([
          this.subscription.next().then(result => ({ kind: 'event' as const, result })),
          this.stopped.then(signal => ({ kind: 'stopped' as const, signal })),
        ])
        if (next.kind === 'stopped') return { exitCode: null, signal: next.signal }
        if (next.result.done) throw new Error('dsh-remote-ssh: AHP terminal subscription ended before terminal exit')
        const event = next.result.value
        if (event.type !== 'action') continue
        const action = event.params.action
        if (action.type === ActionType.TerminalData) this.output.write(action.data)
        else if (action.type === ActionType.TerminalExited) {
          this.exited = true
          return { exitCode: action.exitCode ?? null, signal: action.exitCode === undefined ? 'SIGTERM' : null }
        }
      }
    } finally {
      this.output.end()
      const cleanup = await Promise.allSettled([
        this.subscription.close(),
        this.client.request('disposeTerminal', { channel: this.channel }),
      ])
      const disposal = cleanup[1]!
      if (disposal.status === 'rejected' && !this.exited) {
        this.cleanupFailure = new Error('dsh-remote-ssh: terminal cleanup unobservable at ' + this.channel, { cause: disposal.reason })
        throw this.cleanupFailure
      }
      const subscription = cleanup[0]!
      if (subscription.status === 'rejected') throw subscription.reason
    }
  }
}

/**
 * One base64 record per write. The remote reader consumes newline-delimited
 * records from a PTY, whose canonical input buffer is 4096 bytes: a larger
 * record is silently truncated before the newline arrives. 2048 raw bytes
 * encode to 2731 characters, leaving room for the newline.
 */
const STDIN_RECORD_BYTES = 2048

/** Writable exposed synchronously while its remote AHP input pump boots. */
export class DeferredAhpStdin extends Writable {
  private readonly binding: Promise<{ terminal: RemoteAhpTerminalHandle; endMarker: string }>
  private resolveBinding!: (value: { terminal: RemoteAhpTerminalHandle; endMarker: string }) => void
  private rejectBinding!: (reason: unknown) => void
  private bound = false
  private remoteFinished = false

  constructor() {
    super()
    this.binding = new Promise((resolvePromise, reject) => {
      this.resolveBinding = resolvePromise
      this.rejectBinding = reject
    })
    // A process can end before any caller writes or awaits the pending binding.
    void this.binding.catch(() => {})
    // Match ChildProcess.stdin: an EPIPE is observable by callbacks without
    // becoming an unhandled EventEmitter error when callers only await done.
    this.on('error', () => {})
  }

  bind(terminal: RemoteAhpTerminalHandle, endMarker: string): void {
    if (this.bound || this.remoteFinished) return
    this.bound = true
    this.resolveBinding({ terminal, endMarker })
  }

  fail(reason: unknown): void {
    if (!this.bound) {
      this.remoteFinished = true
      this.rejectBinding(reason)
    }
    if (!this.destroyed) this.destroy(reason instanceof Error ? reason : new Error(String(reason)))
  }

  finishRemote(): void {
    this.remoteFinished = true
    if (!this.bound) this.rejectBinding(new Error('dsh-remote-ssh: remote stdin pump ended before startup'))
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.sendChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)).then(() => callback(), callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    void (async () => {
      const { terminal, endMarker } = await this.binding
      await terminal.write(`${endMarker}\n`)
      const outcome = await terminal.done
      if (outcome.exitCode !== 0) throw new Error(`dsh-remote-ssh: stdin pump failed (exit ${outcome.exitCode ?? outcome.signal})`)
    })().then(() => callback(), callback)
  }

  private async sendChunk(chunk: Buffer): Promise<void> {
    if (this.remoteFinished) throw new Error('dsh-remote-ssh: remote stdin is already closed')
    const { terminal } = await this.binding
    for (let offset = 0; offset < chunk.length; offset += STDIN_RECORD_BYTES) {
      await terminal.write(`${chunk.subarray(offset, offset + STDIN_RECORD_BYTES).toString('base64')}\n`)
    }
  }
}

class RemoteOutputSink {
  readonly stream: PassThrough | undefined
  readonly reader: SubprocessOutputReader | undefined
  private readonly collector: OutputCollector | undefined

  constructor(mode: SubprocessOutputMode, private readonly inherited: Writable, label: string, chunkBytes: number) {
    this.stream = mode === 'pipe' ? new PassThrough({ highWaterMark: chunkBytes }) : undefined
    if (typeof mode === 'object') {
      const binding = mode.spill === undefined ? undefined : prepareManagedProcessBinding()
      this.collector = new OutputCollector(mode.maxBytes, label, binding === undefined ? undefined : {
        maxBytes: mode.spill!.maxBytes,
        dir: binding.spillDir,
        onFailure: binding.onSpillFailure,
      })
      this.reader = this.collector
    }
  }

  async append(chunk: Buffer, signal: AbortSignal): Promise<void> {
    if (this.collector !== undefined) { this.collector.push(chunk); return }
    const target = this.stream ?? this.inherited
    if (signal.aborted) return
    await new Promise<void>((resolvePromise, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort)
        target.removeListener('error', onError)
        target.removeListener('close', onClose)
      }
      const onAbort = () => { cleanup(); resolvePromise() }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const onClose = () => { cleanup(); reject(new Error('dsh-remote-ssh: output pipe closed before EOF')) }
      signal.addEventListener('abort', onAbort, { once: true })
      target.once('error', onError)
      target.once('close', onClose)
      // A PassThrough write callback waits until its readable side has room.
      target.write(chunk, error => { cleanup(); error ? reject(error) : resolvePromise() })
    })
  }

  end(): void {
    this.collector?.seal()
    this.stream?.end()
  }
}

const BASE64 = 'base64' as ContentEncoding

async function readRemoteOutput(client: AhpClient, uri: string): Promise<Buffer> {
  const result = await client.resourceRead({ uri, encoding: BASE64 })
  return result.encoding === BASE64 ? Buffer.from(result.data, 'base64') : Buffer.from(result.data, 'utf8')
}

/**
 * Fixed-owned POSIX output transport: one immutable slot per stream, bounded
 * by outputChunkBytes. Deletion ACK allows the next FIFO read; zero bytes is EOF.
 * A joined timer interrupts the owning shell's post-exit pipe waits after
 * graceMs. Only that owner stops and joins its pumps; the timer never signals
 * pump PIDs after they may have exited or been reaped.
 * @param command - quoted argv command redirecting outputs to owned FIFOs.
 * @param directory - private directory already allocated by the caller.
 * @param outputChunkBytes - positive per-slot byte limit.
 * @param outputPollMs - positive ACK polling interval in milliseconds.
 * @param graceMs - positive drain window after the command exits.
 * @returns a script joining the command and both output pumps.
 */
export function buildRemoteOutputTransportCommand(command: string, directory: string, outputChunkBytes: number, outputPollMs: number, graceMs: number): string {
  const graceSeconds = Math.max(graceMs, 1) / 1000
  return [
    'umask 077',
    `dsh_dir=${quotePosix(directory)}`,
    'dsh_command=; dsh_stdout=; dsh_stderr=; dsh_watchdog=; dsh_cancelled=; dsh_expired=',
    'dsh_cleanup() {',
    "  trap - EXIT; trap '' HUP INT TERM USR1",
    '  [ -z "$dsh_command" ] || kill -KILL "$dsh_command" 2>/dev/null || :',
    '  if [ -n "$dsh_watchdog" ]; then kill -TERM "$dsh_watchdog" 2>/dev/null || :; wait "$dsh_watchdog" 2>/dev/null || :; fi',
    '  for dsh_pid in "$dsh_stdout" "$dsh_stderr"; do [ -z "$dsh_pid" ] || kill -TERM "$dsh_pid" 2>/dev/null || :; done',
    '  for dsh_pid in "$dsh_command" "$dsh_stdout" "$dsh_stderr"; do [ -z "$dsh_pid" ] || wait "$dsh_pid" 2>/dev/null || :; done',
    '  : > "$dsh_dir/stopped"',
    '}',
    'trap dsh_cleanup EXIT',
    "trap 'dsh_cancelled=1' HUP INT TERM",
    'dsh_check_cancel() { [ -z "$dsh_cancelled" ] || exit 143; }',
    ': > "$dsh_dir/started" || exit 125',
    'dsh_pump() {',
    '  trap - EXIT',
    '  dsh_name=$1; dsh_reader=; dsh_cancelled=',
    "  trap 'dsh_cancelled=1' HUP INT TERM",
    '  dsh_check_pump() {',
    '    [ -n "$dsh_cancelled" ] || return 0',
    "    trap '' HUP INT TERM",
    '    [ -z "$dsh_reader" ] || { kill -KILL "$dsh_reader" 2>/dev/null || :; wait "$dsh_reader" 2>/dev/null || :; }',
    '    exit 143',
    '  }',
    '  while :; do',
    '    dsh_check_pump',
    `    dd bs=${outputChunkBytes} count=1 <&3 > "$dsh_dir/$dsh_name.part" 2>/dev/null &`,
    '    dsh_reader=$!; dsh_check_pump; wait "$dsh_reader"; dsh_read_status=$?; dsh_check_pump; dsh_reader=',
    '    [ "$dsh_read_status" = 0 ] || exit 125',
    '    dsh_eof=; [ -s "$dsh_dir/$dsh_name.part" ] || dsh_eof=1',
    '    mv "$dsh_dir/$dsh_name.part" "$dsh_dir/$dsh_name.chunk" &',
    '    dsh_reader=$!; dsh_check_pump; wait "$dsh_reader"; dsh_move_status=$?; dsh_check_pump; dsh_reader=',
    '    [ "$dsh_move_status" = 0 ] || exit 125',
    '    while [ -e "$dsh_dir/$dsh_name.chunk" ]; do',
    `      sleep ${outputPollMs / 1000} &`,
    '      dsh_reader=$!; dsh_check_pump; wait "$dsh_reader"; dsh_check_pump; dsh_reader=',
    '    done',
    '    [ -z "$dsh_eof" ] || return 0',
    '  done',
    '}',
    'dsh_check_cancel',
    'dsh_pump stdout 3< "$dsh_dir/stdout.fifo" & dsh_stdout=$!; dsh_check_cancel',
    'dsh_pump stderr 3< "$dsh_dir/stderr.fifo" & dsh_stderr=$!; dsh_check_cancel',
    `(${command}) & dsh_command=$!; dsh_check_cancel`,
    'wait "$dsh_command"; dsh_status=$?; dsh_check_cancel; dsh_command=',
    // The guard keeps a watchdog that outlived a normally finished transport from
    // signalling a recycled pid. Its standard streams go to /dev/null so the
    // watchdog itself never counts as a descendant holding the terminal open.
    // It is killed, never waited for: bash defers its own termination until a
    // foreground `sleep` returns.
    `( sleep ${graceSeconds}; if [ -e "$dsh_dir/stopped" ]; then exit 0; fi; : > "$dsh_dir/drain-expired"; kill -TERM "$dsh_stdout" "$dsh_stderr" 2>/dev/null || : ) >/dev/null 2>&1 </dev/null & dsh_watchdog=$!`,
    'wait "$dsh_stdout"; dsh_out_status=$?; dsh_check_cancel; dsh_stdout=',
    'wait "$dsh_stderr"; dsh_err_status=$?; dsh_check_cancel; dsh_stderr=',
    'kill "$dsh_watchdog" 2>/dev/null || :; dsh_watchdog=',
    'if [ -e "$dsh_dir/drain-expired" ]; then exit "$dsh_status"; fi',
    '[ "$dsh_out_status" = 0 ] && [ "$dsh_err_status" = 0 ] || exit 125',
    'exit "$dsh_status"',
  ].join('\n')
}

export function buildRemoteProcessCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined,
  stdinPath: string,
  stdoutPath: string,
  stderrPath: string,
): string {
  const executable = argv[0]
  if (executable === undefined || executable.length === 0) throw new Error('dsh-remote-ssh: subprocess argv must contain a program')
  const envArgs: string[] = []
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`dsh-remote-ssh: invalid environment variable '${key}'`)
    if (value === undefined) envArgs.push('-u', key)
    else envArgs.push(`${key}=${value}`)
  }
  const remoteArgv = [remoteExecutable(executable), ...argv.slice(1)]
  return `exec env ${envArgs.map(quotePosix).join(' ')} ${remoteArgv.map(quotePosix).join(' ')} < ${quotePosix(stdinPath)} > ${quotePosix(stdoutPath)} 2> ${quotePosix(stderrPath)}`
}

export function buildRemoteInteractiveCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
): string {
  const executable = argv[0]
  if (executable === undefined || executable.length === 0) throw new Error('dsh-remote-ssh: terminal argv must contain a program')
  const envArgs: string[] = []
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`dsh-remote-ssh: invalid environment variable '${key}'`)
    envArgs.push(`${key}=${value}`)
  }
  const remoteArgv = [remoteExecutable(executable), ...argv.slice(1)]
  return `exec env ${envArgs.map(quotePosix).join(' ')} ${remoteArgv.map(quotePosix).join(' ')}`
}

/** Decode newline-delimited base64 records until the unguessable EOF marker. */
export function buildRemoteStdinWriterCommand(fifoPath: string, endMarker: string): string {
  return `while IFS= read -r line; do [ "$line" = ${quotePosix(endMarker)} ] && break; printf '%s' "$line" | base64 -d; done > ${quotePosix(fifoPath)}`
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>(resolvePromise => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolvePromise() }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

function remoteExecutable(executable: string): string {
  // Cwd-less host lookup returns Windows paths; remote PATH resolves their basenames.
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(executable)) return win32.basename(executable).replace(/\.exe$/i, '')
  // Packaged host rg re-resolves through remote PATH; approved POSIX paths stay exact.
  if (executable.startsWith('/') && /\/@vscode\/ripgrep\/(?:bin\/)?rg(?:\.exe)?$/.test(executable)) return 'rg'
  return executable
}

export default TransparentSubprocessRuntime
