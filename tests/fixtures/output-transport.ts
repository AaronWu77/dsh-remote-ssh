/** Isolated AHP resource/terminal adapter executing the owned scripts locally. */
import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ActionType } from '@microsoft/agent-host-protocol'
import type { SubscriptionEvent } from '@microsoft/agent-host-protocol/client'

function posixPath(path: string): string {
  return process.platform === 'win32' ? '/' + path[0]!.toLowerCase() + path.slice(2).replaceAll('\\', '/') : path
}

function bashExecutable(): string | undefined {
  if (process.platform !== 'win32') return existsSync('/bin/bash') ? '/bin/bash' : undefined
  let git: string | undefined
  try {
    git = execFileSync('where.exe', ['git'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean)
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 1) return undefined
    throw error
  }
  if (git === undefined) return undefined
  const bash = resolve(dirname(git), '../bin/bash.exe')
  return existsSync(bash) ? bash : undefined
}

export const outputTestBash = bashExecutable()

class LocalSubscription implements AsyncIterableIterator<SubscriptionEvent> {
  private readonly queue: SubscriptionEvent[] = []
  private wake: (() => void) | undefined
  private closed = false
  push(action: object): void {
    if (this.closed) return
    this.queue.push({ type: 'action', params: { channel: 'ahp-terminal:/fixture', serverSeq: 1, action } } as SubscriptionEvent)
    this.wake?.(); this.wake = undefined
  }
  async next(): Promise<IteratorResult<SubscriptionEvent>> {
    while (!this.closed && this.queue.length === 0) await new Promise<void>(resolvePromise => { this.wake = resolvePromise })
    if (this.closed) return { done: true, value: undefined }
    return { done: false, value: this.queue.shift()! }
  }
  async close(): Promise<void> { this.closed = true; this.wake?.(); this.wake = undefined }
  [Symbol.asyncIterator](): this { return this }
}

function result(exitCode: number | null, signal: NodeJS.Signals | null) {
  return { exitCode, signal, timedOut: false, aborted: signal !== null, timeoutMs: 10_000,
    stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
}

interface LocalExecution {
  child: ChildProcess
  ready: Promise<string>
  done: Promise<ReturnType<typeof result>>
  output: EventEmitter
  stop(): Promise<void>
}

export class LocalOutputFixture {
  readonly changes = new EventEmitter()
  readonly reads: { uri: string; bytes: number; wireChars: number }[] = []
  readonly commands: string[] = []
  readonly shellScripts: string[] = []
  readonly requests: { method: string; channel: string }[] = []
  readonly inputDispatches: { channel: string; data: string }[] = []
  readonly disposedTerminals = new Set<string>()
  beforeRequest: ((method: string, channel: string) => Promise<void>) | undefined
  beforeSubscribe: ((channel: string) => Promise<void>) | undefined
  readonly listings: { name: string; size: number }[][] = []
  readonly terminals = new Map<string, { subscription: LocalSubscription; execution?: LocalExecution }>()
  readonly processes = new Set<LocalExecution>()
  earlyCancellation = false
  afterDelete: ((uri: string) => Promise<void>) | undefined
  readFailure: Error | undefined
  deleteFailure: Error | undefined
  beforeRead: (() => Promise<void>) | undefined
  beforeListReturn: ((names: string[]) => Promise<void>) | undefined

  private constructor(readonly root: string, readonly runtimeRoot: string) {}
  static async create(): Promise<LocalOutputFixture> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-output-test-'))
    return new LocalOutputFixture(root, posixPath(root))
  }
  private native(uri: string): string {
    const path = decodeURIComponent(new URL(uri).pathname)
    if (!path.startsWith(this.runtimeRoot + '/') && path !== this.runtimeRoot) throw new Error('fixture resource escaped its private root')
    return join(this.root, path.slice(this.runtimeRoot.length))
  }
  async resourceWrite(params: { uri: string; data: string; encoding: string }) {
    if (params.uri.endsWith('.sh')) this.shellScripts.push(params.data)
    await writeFile(this.native(params.uri), Buffer.from(params.data, params.encoding === 'base64' ? 'base64' : 'utf8'))
    return {}
  }
  async resourceRead({ uri }: { uri: string }) {
    if (this.beforeRead !== undefined) await this.beforeRead()
    if (this.readFailure !== undefined) throw this.readFailure
    const bytes = await readFile(this.native(uri))
    const data = bytes.toString('base64')
    this.reads.push({ uri, bytes: bytes.length, wireChars: data.length })
    this.changes.emit('change')
    return { data, encoding: 'base64' }
  }
  async resourceList({ uri }: { uri: string }) {
    const path = this.native(uri)
    const entries: { name: string; type: string; size: number }[] = []
    for (const entry of await readdir(path, { withFileTypes: true })) {
      try {
        const info = await stat(join(path, entry.name))
        entries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: info.size })
      } catch (error) {
        // A published slot can be acknowledged between readdir and stat.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.listings.push(entries.map(({ name, size }) => ({ name, size })))
    this.changes.emit('change')
    await this.beforeListReturn?.(entries.map(entry => entry.name))
    return { entries }
  }
  async resourceDelete({ uri, recursive }: { uri: string; recursive?: boolean }) {
    if (this.deleteFailure !== undefined && !recursive) throw this.deleteFailure
    await rm(this.native(uri), { recursive: recursive ?? false, force: false })
    this.changes.emit('change')
    await this.afterDelete?.(uri)
    return {}
  }
  async execute(spec: { command: string; signal?: AbortSignal }) {
    this.commands.push(spec.command)
    if (spec.signal?.aborted) return { dispatched: Promise.resolve(false), quiescent: Promise.resolve(), result: async () => result(null, 'SIGTERM') }
    const execution = this.launch(spec.command)
    let cancelled!: () => void
    const cancellation = new Promise<ReturnType<typeof result>>(resolvePromise => { cancelled = () => resolvePromise(result(null, 'SIGTERM')) })
    const stop = () => { cancelled(); void execution.stop().catch(() => {}) }
    spec.signal?.addEventListener('abort', stop, { once: true })
    if (spec.signal?.aborted) stop()
    void execution.done.finally(() => spec.signal?.removeEventListener('abort', stop)).catch(() => {})
    const operation = this.earlyCancellation ? Promise.race([execution.done, cancellation]) : execution.done
    return { dispatched: Promise.resolve(true), quiescent: operation.then(() => {}), result: () => operation }
  }
  resolve(request: Record<string, unknown>) { return { timeoutMs: 10_000, stdoutMaxBytes: 4096, ...request } }

  launch(command: string): LocalExecution {
    if (outputTestBash === undefined) throw new Error('POSIX bash is unavailable')
    let readyResolve!: (pid: string) => void
    let readyReject!: (error: Error) => void
    const ready = new Promise<string>((resolvePromise, reject) => { readyResolve = resolvePromise; readyReject = reject })
    void ready.catch(() => {})
    const child = spawn(outputTestBash, ['-c', 'PATH=/usr/bin:/bin; printf "__DSH_TEST_PID=%s\\n" "$$"; ' + command], {
      cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Remote cancellation can close stdin while its write callback is pending.
    child.stdin!.on('error', () => {})
    let exited = false
    let stopped = false
    let prefix = ''
    let stopping: Promise<void> | undefined
    const output = new EventEmitter()
    child.stdout.on('data', (chunk: Buffer) => {
      if (prefix !== 'ready') {
        prefix += chunk.toString()
        const newline = prefix.indexOf('\n')
        if (newline === -1) return
        const match = /^__DSH_TEST_PID=(\d+)$/.exec(prefix.slice(0, newline))
        if (match === null) { readyReject(new Error('invalid fixture shell PID')); return }
        readyResolve(match[1]!); const rest = prefix.slice(newline + 1); prefix = 'ready'
        if (rest !== '') output.emit('data', rest)
      } else output.emit('data', chunk.toString())
    })
    child.stderr.on('data', (chunk: Buffer) => { output.emit('data', chunk.toString()) })
    const done = new Promise<ReturnType<typeof result>>((resolvePromise, reject) => {
      child.once('error', error => { exited = true; readyReject(error); reject(error) })
      child.once('close', (code, signal) => {
        exited = true
        if (prefix !== 'ready') readyReject(new Error('fixture shell exited before readiness'))
        resolvePromise(result(stopped ? null : code, stopped ? 'SIGTERM' : signal))
      })
    })
    const execution = { child, ready, done, output, stop: (): Promise<void> => {
      stopping ??= (async () => {
        if (exited) return
        stopped = true
        const pid = await ready
        if (exited) return
        const killer = spawn(outputTestBash!, ['-c', 'kill -TERM ' + pid], { cwd: this.root, stdio: 'ignore' })
        await new Promise<void>((resolvePromise, reject) => { killer.once('error', reject); killer.once('close', () => resolvePromise()) })
        await done
      })()
      return stopping
    } }
    this.processes.add(execution)
    void done.finally(() => { this.processes.delete(execution); this.changes.emit('change') }).catch(() => {})
    return execution
  }

  async request(method: string, params: { channel: string }) {
    this.requests.push({ method, channel: params.channel })
    await this.beforeRequest?.(method, params.channel)
    if (method === 'createTerminal') this.terminals.set(params.channel, { subscription: new LocalSubscription() })
    else if (method === 'disposeTerminal') { await this.terminals.get(params.channel)?.execution?.stop(); this.disposedTerminals.add(params.channel) }
    return {}
  }
  async subscribe(channel: string) {
    await this.beforeSubscribe?.(channel)
    return { result: {}, subscription: this.terminals.get(channel)!.subscription }
  }
  dispatch(channel: string, action: { type: string; data?: string }) {
    if (action.type === ActionType.TerminalInput) {
      this.inputDispatches.push({ channel, data: action.data! })
      const terminal = this.terminals.get(channel)!
      if (terminal.execution === undefined) {
        terminal.execution = this.launch(action.data!.replace(/\r$/, ''))
        terminal.execution.output.on('data', (data: string) => terminal.subscription.push({ type: ActionType.TerminalData, data }))
        void terminal.execution.done.then(outcome => terminal.subscription.push({ type: ActionType.TerminalExited, exitCode: outcome.exitCode ?? undefined }))
      } else terminal.execution.child.stdin!.write(action.data)
    }
    return { clientSeq: 1 }
  }
  async waitFor(predicate: () => boolean): Promise<void> {
    if (predicate()) return
    await new Promise<void>(resolvePromise => {
      const changed = () => { if (predicate()) { this.changes.removeListener('change', changed); resolvePromise() } }
      this.changes.on('change', changed); changed()
    })
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.processes].map(execution => execution.stop()))
    await rm(this.root, { recursive: true, force: true })
  }
}
