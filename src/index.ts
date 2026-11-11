import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { connectOwnedWebSocket, ownSshProcess } from './ssh-lifecycle.ts'
import { AgentHostConnectionError, RemoteSshLifecycleError, SshProcessCleanupError, SshExecutionError, formatConnectionDiagnostic } from './connection-error.ts'
import { Context, Service } from '@deepseek-ai/cordis'
import { runCaptured } from './ssh-command.ts'
import type { DiagnosticStageStatus } from './management-types.ts'

/** Startup phase observation without exposing endpoint credentials or raw output. */
export type StartupObserver = (stage: 'agentHost' | 'tunnel' | 'protocol', status: Extract<DiagnosticStageStatus, 'running' | 'succeeded' | 'failed'>) => void
import z from '@deepseek-ai/schemastery'
import { ahpProtocolMismatch, DSH_AHP_PROTOCOL_VERSIONS, formatAhpProtocolMismatch, validateProtocolVersions } from './ahp-compat.ts'

export interface Config {
  sshTarget: string
  remoteWorkspace?: string
  localWorkspace?: string
  remoteAccessRoot?: string
  sshExecutable?: string
  sshArgs?: string[]
  remoteCodeCommand?: string
  remoteRuntimeRoot?: string
  startupTimeoutMs?: number
  /** Budget for one installed candidate, including tunnel and protocol initialization. */
  embeddedStartupTimeoutMs?: number
  /** Budget for the standalone CLI, including tunnel and protocol initialization. */
  standaloneStartupTimeoutMs?: number
  /** Grace before forcefully stopping an owned SSH process. */
  shutdownTimeoutMs?: number
  requestTimeoutMs?: number
  protocolVersions?: string[]
  directUrl?: string
}

interface ResolvedConfig extends Config {
  sshExecutable: string
  sshArgs: string[]
  remoteCodeCommand: string
  remoteRuntimeRoot: string
  startupTimeoutMs: number
  embeddedStartupTimeoutMs: number
  standaloneStartupTimeoutMs: number
  shutdownTimeoutMs: number
  requestTimeoutMs: number
  protocolVersions: string[]
}

interface ConnectionOwner {
  readonly abort: AbortController
  closed?: boolean
  pendingStops?: Set<(graceMs: number) => Promise<void>>
  tunnel?: ChildProcessWithoutNullStreams
  embeddedAgentHost?: ChildProcessWithoutNullStreams
  embeddedPid?: number
  embeddedDataDir?: string
  client?: AhpClient
  shutdown?: Promise<void>
  monitor?: Promise<void>
  published?: boolean
  stopping?: boolean
  cleanup?: Promise<void>
  cleanupFailure?: unknown
  uncertainRemoteOwner?: boolean
}

export interface AhpConnection {
  client: AhpClient
  protocolVersion: string
  defaultDirectory?: string
}

export function quotePosix(value: string): string {
  if (value.includes('\0')) throw new Error('remote command arguments cannot contain NUL bytes')
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

/** Build the POSIX bootstrap that resolves the VS Code CLI and starts Agent Host. */
export function buildRemoteAgentHostCommand(remoteCodeCommand: string, dataRoot?: string): string {
  const requested = quotePosix(remoteCodeCommand)
  return [
    `dsh_code=${requested}`,
    ...(dataRoot === undefined ? [] : [`dsh_data_root=${quotePosix(dataRoot)}`]),
    'if [ "$dsh_code" = code ] && ! command -v "$dsh_code" >/dev/null 2>&1 && [ -x "$HOME/.dsh-remote-ssh/cli/bin/code" ]; then dsh_code="$HOME/.dsh-remote-ssh/cli/bin/code"; fi',
    'if ! command -v "$dsh_code" >/dev/null 2>&1; then printf \'dsh-remote-ssh: VS Code CLI not found: %s\\n\' "$dsh_code" >&2; exit 127; fi',
    'exec "$dsh_code" agent host --host 127.0.0.1 --port 0 --idle-timeout 60 --server-data-dir "${dsh_data_root:-$HOME/.dsh-remote-ssh}/server" --cli-data-dir "${dsh_data_root:-$HOME/.dsh-remote-ssh}/cli" --verbose',
  ].join('\n')
}

/** List installed VS Code Server entrypoints newest-first for compatibility probing. */
export function buildListEmbeddedAgentHostsCommand(): string {
  return 'find "$HOME/.vscode-server/cli/servers" -type f -path \'*/server/bin/code-server\' -perm -u+x -printf \'%T@ %p\\n\' 2>/dev/null | sort -nr | cut -d \' \' -f 2-'
}

/** Build the fallback bootstrap for a VS Code Server installation left by Remote - SSH. */
export function buildEmbeddedAgentHostCommand(codeServerPath?: string, instanceId = 'default', dataRoot?: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(instanceId)) throw new Error(`invalid embedded Agent Host instance id: ${instanceId}`)
  const resolveCodeServer = codeServerPath === undefined
    ? `dsh_code_server=$(${buildListEmbeddedAgentHostsCommand()} | head -n 1)`
    : `dsh_code_server=${quotePosix(codeServerPath)}`
  return [
    resolveCodeServer,
    ...(dataRoot === undefined ? [] : [`dsh_data_root=${quotePosix(dataRoot)}`]),
    'printf "DSH_AGENT_HOST_PID=%s\\n" "$$"',
    'if [ -z "$dsh_code_server" ]; then printf \'dsh-remote-ssh: no usable code agent host or VS Code Server code-server found\\n\' >&2; exit 127; fi',
    `exec "$dsh_code_server" --host 127.0.0.1 --port 0 --agent-host-port 0 --accept-server-license-terms --server-data-dir "\${dsh_data_root:-$HOME/.dsh-remote-ssh}/server-embedded/${instanceId}" --log info`,
  ].join('\n')
}

export function fileUriFromPosixPath(path: string): string {
  if (!posix.isAbsolute(path)) throw new Error(`remote path must be absolute: ${path}`)
  return `file://${path.split('/').map(part => encodeURIComponent(part)).join('/')}`
}

export function posixPathFromFileUri(uri: string): string {
  const parsed = new URL(uri)
  if (parsed.protocol !== 'file:' || (parsed.hostname !== '' && parsed.hostname !== 'localhost')) {
    throw new Error(`expected a local file URI from Agent Host, received ${uri}`)
  }
  const path = decodeURIComponent(parsed.pathname)
  if (!posix.isAbsolute(path)) throw new Error(`Agent Host returned a non-absolute file URI: ${uri}`)
  return posix.normalize(path)
}

export class WorkspacePathMapper {
  readonly localWorkspace: string
  readonly remoteWorkspace: string

  constructor(localWorkspace: string, remoteWorkspace: string) {
    this.localWorkspace = resolve(localWorkspace)
    this.remoteWorkspace = posix.normalize(remoteWorkspace)
    if (!isAbsolute(this.localWorkspace)) throw new Error('localWorkspace must be an absolute local path')
    if (!posix.isAbsolute(this.remoteWorkspace)) {
      throw new Error(`remoteWorkspace must be an absolute POSIX path: ${remoteWorkspace}`)
    }
  }

  toRemotePath(input: string, cwd?: string): string {
    if (input.trim().length === 0) throw new Error('path must be a non-empty string')
    if (input.startsWith('file:')) return posixPathFromFileUri(input)

    const localAbsolute = isAbsolute(input)
    if (localAbsolute) {
      const rel = relative(this.localWorkspace, resolve(input))
      if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
        return posix.resolve(this.remoteWorkspace, rel.split(sep).join('/'))
      }
      // On POSIX, local and remote absolute paths share the same syntax. Paths
      // outside the alias are therefore remote; Windows local paths remain
      // distinguishable and must not escape the alias.
      if (input.startsWith('/')) return posix.normalize(input)
      throw new Error(`local path is outside the Remote SSH workspace alias: ${input}`)
    }

    if (input.startsWith('/')) return posix.normalize(input)

    const base = cwd === undefined ? this.remoteWorkspace : this.toRemotePath(cwd)
    return posix.resolve(base, input.replaceAll('\\', '/'))
  }

}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSsh: RemoteSshRuntime
  }
}

export class RemoteSshRuntime extends Service {
  static Config: z<Config> = z.object({
    sshTarget: z.string().required(),
    remoteWorkspace: z.string(),
    localWorkspace: z.string(),
    remoteAccessRoot: z.string(),
    sshExecutable: z.string().default('ssh'),
    sshArgs: z.array(z.string()).default([]),
    remoteCodeCommand: z.string().default('code'),
    remoteRuntimeRoot: z.string().default('/tmp/dsh-remote-ssh'),
    startupTimeoutMs: z.number().default(600_000),
    embeddedStartupTimeoutMs: z.number().default(15_000),
    standaloneStartupTimeoutMs: z.number().default(30_000),
    shutdownTimeoutMs: z.number().default(3_000),
    requestTimeoutMs: z.number().default(30_000),
    protocolVersions: z.array(z.string()).default([...DSH_AHP_PROTOCOL_VERSIONS]),
    directUrl: z.string(),
  })

  readonly mapper: WorkspacePathMapper | undefined
  readonly config: ResolvedConfig
  readonly clientId = `dsh-remote-ssh-${randomUUID()}`
  readonly runtimeRoot: string
  readonly remoteAccessRoot: string

  private ready: Promise<AhpConnection> | undefined
  private owner: ConnectionOwner = { abort: new AbortController() }
  private disposed = false
  private readonly lifetime = new AbortController()
  private readonly stopProcess = new WeakMap<ChildProcessWithoutNullStreams, (graceMs: number) => Promise<void>>()
  private startupDeadline = 0
  private closing: Promise<void> | undefined
  private phaseDeadline = Infinity

  constructor(ctx: Context, config: Config, private readonly observer?: StartupObserver, private readonly dedicated = false) {
    super(ctx, 'remoteSsh')
    this.config = { ...config, embeddedStartupTimeoutMs: config.embeddedStartupTimeoutMs ?? 15_000, standaloneStartupTimeoutMs: config.standaloneStartupTimeoutMs ?? 30_000 } as ResolvedConfig
    if ((config.localWorkspace === undefined) !== (config.remoteWorkspace === undefined)) {
      throw new Error('dsh-remote-ssh: localWorkspace and remoteWorkspace must be configured together')
    }
    this.mapper = config.localWorkspace === undefined || config.remoteWorkspace === undefined
      ? undefined
      : new WorkspacePathMapper(config.localWorkspace, config.remoteWorkspace)
    this.remoteAccessRoot = posix.normalize(config.remoteAccessRoot ?? config.remoteWorkspace ?? '/')
    this.runtimeRoot = posix.join(this.config.remoteRuntimeRoot, this.clientId)
    this.validate()
    if (this.mapper !== undefined) mkdirSync(this.mapper.localWorkspace, { recursive: true })
    this.ready = this.startAttempt()
    ctx.effect(() => () => this.close(), 'Remote SSH AHP teardown')
  }

  /** Abort startup and join all owned SSH cleanup; repeated calls share the same outcome.
   * @returns Completion only after client and owned processes settle; cleanup failure rejects.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.disposed = true
    this.lifetime.abort(new Error('dsh-remote-ssh: connection disposed'))
    this.closing = (async () => {
      await this.ready?.catch(() => undefined)
      await this.resetSshAttempt()
    })()
    return this.closing
  }

  /** Whether startup lost its remote process ownership acknowledgement.
   * @returns True when diagnostics cannot attest remote daemon termination from SSH child exit alone.
   */
  hasUntrackedStandalone(): boolean { return this.owner.uncertainRemoteOwner === true }

  private observe(stage: 'agentHost' | 'tunnel' | 'protocol', status: 'running' | 'succeeded' | 'failed'): void {
    try { this.observer?.(stage, status) } catch (error) { this.ctx.logger.warn('Remote SSH observation callback failed', error) }
  }

  /**
   * Share startup and the live client; a later explicit call reconnects after verified cleanup.
   * No resource or terminal operation is replayed. Cleanup failure prevents another startup.
   * @returns The active connection, or a startup, cleanup or disposal rejection.
   */
  async getConnection(): Promise<AhpConnection> {
    if (this.disposed) throw new Error('Remote SSH service is disposing')
    if (this.owner.published && this.owner.client?.connectionState.status !== 'connected') this.invalidate(this.owner)
    const pending = (this.ready ??= this.startAttempt())
    const connection = await pending
    if (this.disposed) throw new Error('Remote SSH service is disposing')
    if (this.ready !== pending) throw new RemoteSshLifecycleError('connection_closed', 'dsh-remote-ssh: connection generation ended before readiness was delivered')
    this.owner.abort.signal.throwIfAborted()
    if (connection.client.connectionState.status !== 'connected') throw new RemoteSshLifecycleError('connection_closed', 'dsh-remote-ssh: connection closed before publication')
    return connection
  }

  /** Wait for the shared client without letting one caller cancel other workspaces' connection.
   * @param signal Optional caller lifetime; cancellation ends only this readiness wait.
   * @returns The active shared client; rejects with the caller's cancellation or startup failure.
   */
  async getClient(signal?: AbortSignal): Promise<AhpClient> {
    signal?.throwIfAborted()
    const ready = this.getConnection()
    if (signal === undefined) return (await ready).client
    return new Promise<AhpClient>((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      void ready.then(connection => {
        signal.removeEventListener('abort', onAbort)
        if (!signal.aborted) resolve(connection.client)
      }, error => { signal.removeEventListener('abort', onAbort); reject(error) })
    })
  }

  /** Workspace mapper for the legacy single-workspace providers. */
  getMapper(): WorkspacePathMapper {
    if (this.mapper === undefined) throw new Error('dsh-remote-ssh: this shared host runtime has no default workspace mapper')
    return this.mapper
  }

  private validate(): void {
    const { sshTarget, sshExecutable, remoteCodeCommand, remoteRuntimeRoot, startupTimeoutMs, shutdownTimeoutMs, requestTimeoutMs, protocolVersions } = this.config
    if (sshTarget.trim().length === 0 && this.config.directUrl === undefined) {
      throw new Error('dsh-remote-ssh: sshTarget must be non-empty')
    }
    if (sshExecutable.trim().length === 0) throw new Error('dsh-remote-ssh: sshExecutable must be non-empty')
    if (remoteCodeCommand.trim().length === 0) throw new Error('dsh-remote-ssh: remoteCodeCommand must be non-empty')
    if (!posix.isAbsolute(remoteRuntimeRoot)) throw new Error('dsh-remote-ssh: remoteRuntimeRoot must be an absolute POSIX path')
    if (!posix.isAbsolute(this.remoteAccessRoot)) throw new Error('dsh-remote-ssh: remoteAccessRoot must be an absolute POSIX path')
    if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
      throw new Error('dsh-remote-ssh: startupTimeoutMs must be a positive integer')
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error('dsh-remote-ssh: requestTimeoutMs must be a positive integer')
    }
    if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) throw new Error('dsh-remote-ssh: shutdownTimeoutMs must be a positive integer')
    for (const key of ['embeddedStartupTimeoutMs', 'standaloneStartupTimeoutMs'] as const) {
      if (!Number.isSafeInteger(this.config[key]) || this.config[key] <= 0) throw new Error('dsh-remote-ssh: ' + key + ' must be a positive integer')
    }
    validateProtocolVersions(protocolVersions)
  }

  private startAttempt(): Promise<AhpConnection> {
    const pending = (async () => {
      await this.resetSshAttempt()
      this.lifetime.signal.throwIfAborted()
      this.owner = { abort: new AbortController() }
      this.startupDeadline = Date.now() + this.config.startupTimeoutMs
      this.phaseDeadline = Infinity
      const connection = await this.open()
      this.owner.abort.signal.throwIfAborted()
      if (connection.client.connectionState.status !== 'connected') throw new RemoteSshLifecycleError('connection_closed', 'dsh-remote-ssh: connection closed before publication')
      this.owner.published = true
      return connection
    })().catch(async (error: unknown) => {
      if (error instanceof SshProcessCleanupError) {
        (this.owner.pendingStops ??= new Set()).add(error.retryCleanup)
        this.owner.cleanupFailure = error
      }
      try {
        if (this.owner.cleanupFailure === undefined) await this.resetSshAttempt()
      } finally {
        if (this.ready === pending) this.ready = undefined
      }
      throw error
    })
    // Eager startup failures remain observable even before the first readiness caller.
    void pending.catch(error => this.ctx.logger.warn('Remote SSH startup failed', connectionDiagnostic(error, this.config.protocolVersions)))
    return pending
  }

  private invalidate(owner: ConnectionOwner): void {
    if (this.owner !== owner || !owner.published || owner.stopping || this.disposed) return
    owner.abort.abort(new RemoteSshLifecycleError('connection_closed', 'dsh-remote-ssh: active connection closed; request was not replayed'))
    owner.published = false
    this.ready = undefined
    this.ctx.logger.warn('Remote SSH connection closed; the next explicit request may reconnect after cleanup. Operations are not replayed.')
    void this.resetSshAttempt(owner).catch(error => this.ctx.logger.warn('Remote SSH cleanup failed; reconnect requires verified cleanup', connectionDiagnostic(error, this.config.protocolVersions)))
  }

  private ownProcess(child: ChildProcessWithoutNullStreams, owner = this.owner): void {
    this.stopProcess.set(child, ownSshProcess(child))
    child.once('close', () => {
      if (owner.stopping) return
      owner.closed = true
      if (owner.tunnel === child || owner.client || owner.published) owner.abort.abort(new RemoteSshLifecycleError('connection_closed', 'dsh-remote-ssh: owned SSH process closed'))
      this.invalidate(owner)
    })
  }

  private async candidate<T>(budgetMs: number, run: () => Promise<T>): Promise<T> {
    this.owner = { abort: new AbortController() }
    this.phaseDeadline = Date.now() + Math.min(this.remainingTotalStartup(), budgetMs)
    const owner = this.owner
    const timer = setTimeout(() => owner.abort.abort(new RemoteSshLifecycleError('candidate_startup_timeout', 'dsh-remote-ssh: Agent Host candidate startup timed out after ' + budgetMs + 'ms')), Math.max(1, this.phaseDeadline - Date.now()))
    try { return await run() } finally { clearTimeout(timer); this.phaseDeadline = Infinity }
  }

  private async open(): Promise<AhpConnection> {
    if (this.config.directUrl !== undefined) return this.connectEndpoint(this.config.directUrl)
    return this.openOverSsh()
  }

  private async connectEndpoint(url: string): Promise<AhpConnection> {
    this.observe('protocol', 'running')
    try {
      const connection = await this.initializeEndpoint(url)
      this.observe('protocol', 'succeeded')
      return connection
    } catch (error) { this.observe('protocol', 'failed'); throw error }
  }

  private async initializeEndpoint(url: string): Promise<AhpConnection> {
    const owner = this.owner
    const signal = AbortSignal.any([this.lifetime.signal, owner.abort.signal, AbortSignal.timeout(this.remainingStartup())])
    const transport = await connectOwnedWebSocket(url, signal)
    const client = new AhpClient(transport, { requestTimeoutMs: this.config.requestTimeoutMs })
    owner.client = client
    const states = client.stateChanges()
    owner.monitor = (async () => {
      for await (const state of states) {
        if (state.status === 'closed' || state.status === 'closing') { this.invalidate(owner); return }
      }
    })().catch(error => {
      owner.abort.abort(error)
      this.invalidate(owner)
      this.ctx.logger.warn('Remote SSH state monitor failed', connectionDiagnostic(error, this.config.protocolVersions))
    })
    client.connect()
    const abort = (): void => {
      owner.shutdown ??= client.shutdown()
      void owner.shutdown.catch(error => this.ctx.logger.warn('Remote SSH client shutdown failed', connectionDiagnostic(error, this.config.protocolVersions)))
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const initialized = await client.initialize({
        clientId: this.clientId,
        protocolVersions: this.config.protocolVersions,
        initialSubscriptions: ['ahp-root://'],
      })
      signal.throwIfAborted()
      const remoteUri = fileUriFromPosixPath(this.remoteAccessRoot)
      await client.resourceRequest({ uri: remoteUri, read: true, write: true })
      const runtimeUri = fileUriFromPosixPath(this.runtimeRoot)
      await client.resourceRequest({ uri: fileUriFromPosixPath(this.config.remoteRuntimeRoot), read: true, write: true })
      await client.resourceMkdir({ uri: runtimeUri })
      signal.throwIfAborted()
      return {
        client,
        protocolVersion: initialized.protocolVersion,
        ...(initialized.defaultDirectory !== undefined ? { defaultDirectory: initialized.defaultDirectory } : {}),
      }
    } catch (error: unknown) {
      abort()
      if (signal.aborted) throw signal.reason
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private async openOverSsh(): Promise<AhpConnection> {
    const diagnostics: string[] = []
    if (this.config.remoteCodeCommand === 'code') {
      const candidates = await this.listEmbeddedAgentHosts(diagnostics)
      for (const [index, codeServerPath] of candidates.entries()) {
        this.remainingTotalStartup()
        try {
          return await this.candidate(this.config.embeddedStartupTimeoutMs, async () => {
            const url = await this.startEmbeddedAgentHost(codeServerPath, index)
            return this.connectEndpoint(url)
          })
        } catch (error) {
          await this.resetSshAttempt()
          this.remainingTotalStartup()
          diagnostics.push('embedded ' + codeServerPath + ': ' + connectionDiagnostic(error, this.config.protocolVersions))
        }
      }
      if (candidates.length === 0) diagnostics.push('embedded VS Code Server: no installed code-server found')
    }
    this.remainingTotalStartup()
    try {
      return await this.candidate(this.config.standaloneStartupTimeoutMs, async () => {
        this.observe('agentHost', 'running')
        const command = buildRemoteAgentHostCommand(this.config.remoteCodeCommand, this.runtimeRoot)
        const endpoint = await this.startOwnedStandalone(command)
        const url = await this.openTunnel(endpoint.port, endpoint.token)
        return this.connectEndpoint(url)
      })
    } catch (error) {
      await this.resetSshAttempt()
      this.remainingTotalStartup()
      diagnostics.push((this.dedicated ? 'dedicated standalone CLI: ' : 'standalone CLI: ') + connectionDiagnostic(error, this.config.protocolVersions))
      if (this.config.remoteCodeCommand !== 'code') throw error
      if (error instanceof SshExecutionError && error.exitCode === 255 && !diagnostics.some(item => item.startsWith('embedded /'))) throw error
      throw new AgentHostConnectionError(this.config.protocolVersions, diagnostics)
    }
  }

  private async listEmbeddedAgentHosts(diagnostics: readonly string[]): Promise<string[]> {
    const result = await this.capture(
      this.config.sshExecutable,
      [...this.config.sshArgs, '-T', this.config.sshTarget, buildListEmbeddedAgentHostsCommand()],
      Math.min(this.remainingStartup(), this.config.requestTimeoutMs),
      this.startupSignal(),
      this.config.shutdownTimeoutMs,
    )
    if (result.exitCode !== 0) {
      throw new SshExecutionError('embedded discovery', result.exitCode, [
        ...diagnostics,
        `embedded discovery (ssh exit ${result.exitCode ?? 'unknown'}): ${tailDiagnostic(`${result.stdout}\n${result.stderr}`) || 'no output'}`,
      ])
    }
    return [...new Set(result.stdout.split(/\r?\n/u).map(path => path.trim()).filter(Boolean))]
  }

  private async startOwnedStandalone(command: string): Promise<{ port: number; token: string }> {
    const dataDir = posix.join(this.runtimeRoot, 'server')
    this.owner.embeddedDataDir = dataDir
    const ownedCommand = 'printf "DSH_AGENT_HOST_PID=%s\\n" "$$"\n' + command.replace('exec "$dsh_code" agent host ',
      'exec "$dsh_code" agent host --new-instance --foreground --user-data-dir ' + quotePosix(posix.join(this.runtimeRoot, 'user')) + ' ')
    this.remainingStartup()
    this.owner.uncertainRemoteOwner = true
    const child = spawn(this.config.sshExecutable, [...this.config.sshArgs, '-T', this.config.sshTarget, ownedCommand],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.ownProcess(child)
    this.owner.embeddedAgentHost = child
    return waitForStandaloneEndpoint(child, this.remainingStartup(), this.startupSignal(), pid => { this.owner.embeddedPid = pid; this.owner.uncertainRemoteOwner = false })
  }

  private async startEmbeddedAgentHost(codeServerPath: string, attempt: number): Promise<string> {
    this.observe('agentHost', 'running')
    const timeoutMs = this.remainingStartup()
    this.owner.uncertainRemoteOwner = true
    const instanceId = `${this.clientId}-${attempt}`
    this.owner.embeddedDataDir = posix.join(this.runtimeRoot, 'server-embedded', instanceId)
    const child = spawn(this.config.sshExecutable, [
      ...this.config.sshArgs,
      '-T',
      this.config.sshTarget,
      buildEmbeddedAgentHostCommand(codeServerPath, instanceId, this.runtimeRoot),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.ownProcess(child)
    this.owner.embeddedAgentHost = child
    const remotePort = await waitForAgentHostPort(child, timeoutMs, this.startupSignal(), pid => { this.owner.embeddedPid = pid; this.owner.uncertainRemoteOwner = false })
    const tokenResult = await this.capture(
      this.config.sshExecutable,
      [...this.config.sshArgs, '-T', this.config.sshTarget, `cat ${quotePosix(posix.join(this.runtimeRoot, 'server-embedded', instanceId, 'data/token'))}`],
      Math.min(this.remainingStartup(), this.config.requestTimeoutMs),
      this.startupSignal(),
      this.config.shutdownTimeoutMs,
    )
    const token = tokenResult.stdout.trim()
    if (tokenResult.exitCode !== 0 || token.length === 0 || /\s/.test(token)) {
      throw new Error(`dsh-remote-ssh: could not read the embedded Agent Host connection token\n${tokenResult.stderr}`)
    }
    return this.openTunnel(remotePort, token)
  }

  private async openTunnel(remotePort: number, token: string): Promise<string> {
    this.observe('agentHost', 'succeeded')
    this.observe('tunnel', 'running')
    try {
      const url = await this.startTunnel(remotePort, token)
      this.observe('tunnel', 'succeeded')
      return url
    } catch (error) { this.observe('tunnel', 'failed'); throw error }
  }

  private async startTunnel(remotePort: number, token: string): Promise<string> {
    this.remainingStartup()
    const localPort = await reservePort()
    const timeoutMs = Math.min(this.remainingStartup(), this.config.requestTimeoutMs)
    const tunnel = spawn(this.config.sshExecutable, [
      ...this.config.sshArgs,
      '-T',
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-L',
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      this.config.sshTarget,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.ownProcess(tunnel)
    this.owner.tunnel = tunnel
    await waitForPort(localPort, tunnel, timeoutMs, this.startupSignal())
    return `ws://127.0.0.1:${localPort}?tkn=${encodeURIComponent(token)}`
  }

  private async capture(...args: Parameters<typeof runCaptured>): ReturnType<typeof runCaptured> {
    const owner = this.owner
    try { return await runCaptured(...args) } catch (error) {
      if (error instanceof SshProcessCleanupError) {
        (owner.pendingStops ??= new Set()).add(error.retryCleanup)
        owner.cleanupFailure = error
      }
      throw error
    }
  }

  private startupSignal(): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, this.owner.abort.signal])
  }

  private remainingTotalStartup(): number {
    this.lifetime.signal.throwIfAborted()
    const remaining = this.startupDeadline - Date.now()
    if (remaining <= 0) throw new Error('dsh-remote-ssh: total Agent Host startup deadline exceeded')
    return remaining
  }

  private remainingStartup(): number {
    const remaining = this.remainingTotalStartup()
    this.owner.abort.signal.throwIfAborted()
    if (this.owner.closed) throw new RemoteSshLifecycleError('connection_closed', 'dsh-remote-ssh: owned SSH process closed')
    const phaseRemaining = this.phaseDeadline - Date.now()
    if (phaseRemaining <= 0) throw new RemoteSshLifecycleError('candidate_startup_timeout', 'dsh-remote-ssh: Agent Host candidate startup deadline exceeded')
    return Math.min(remaining, phaseRemaining)
  }

  private resetSshAttempt(owner = this.owner): Promise<void> {
    if (owner.cleanup) return owner.cleanup
    owner.stopping = true
    owner.cleanupFailure = undefined
    owner.cleanup = (async () => {
      const failures: unknown[] = []
      for (const stop of owner.pendingStops ?? []) {
        try { await stop(this.config.shutdownTimeoutMs); owner.pendingStops?.delete(stop) } catch (error) { failures.push(error) }
      }
      if (owner.client) {
        owner.shutdown ??= owner.client.shutdown()
        void owner.shutdown.catch(error => this.ctx.logger.warn('Remote SSH client shutdown failed', connectionDiagnostic(error, this.config.protocolVersions)))
      }
      try {
        if (owner.uncertainRemoteOwner) throw new RemoteSshLifecycleError('cleanup_failed', 'Remote Agent Host process ownership is unconfirmed; refusing another startup')
        if (owner.embeddedPid !== undefined && owner.embeddedDataDir !== undefined) {
          const cleanup = await this.capture(this.config.sshExecutable,
            [...this.config.sshArgs, '-T', this.config.sshTarget, buildStopEmbeddedAgentHostCommand(owner.embeddedPid, owner.embeddedDataDir, this.config.shutdownTimeoutMs)],
            this.config.requestTimeoutMs + 2 * this.config.shutdownTimeoutMs, new AbortController().signal, this.config.shutdownTimeoutMs)
          if (cleanup.exitCode !== 0) throw new Error('dsh-remote-ssh: owned remote Agent Host cleanup failed: ' + formatConnectionDiagnostic(cleanup.stderr, 2_000))
        }
        delete owner.embeddedPid
        delete owner.embeddedDataDir
      } catch (error) { failures.push(error) }
      const stopped = await Promise.allSettled([owner.tunnel, owner.embeddedAgentHost].map(child => child === undefined ? undefined : this.stopProcess.get(child)?.(this.config.shutdownTimeoutMs)))
      for (const result of stopped) if (result.status === 'rejected') failures.push(result.reason)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([Promise.all([owner.shutdown, owner.monitor]), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new RemoteSshLifecycleError('cleanup_failed', 'dsh-remote-ssh: client shutdown did not settle; startup stopped until cleanup is verified')), this.config.requestTimeoutMs)
        })])
      } catch (error) { failures.push(error) } finally { clearTimeout(timer) }
      if (failures.length) throw new RemoteSshLifecycleError('cleanup_failed', 'dsh-remote-ssh: owned cleanup failed; startup stopped: ' + failures.map(errorMessage).join('; '), { cause: new AggregateError(failures) })
    })().catch(error => { owner.cleanupFailure = error; delete owner.cleanup; throw error })
    return owner.cleanup
  }
}

async function waitForStandaloneEndpoint(child: ChildProcessWithoutNullStreams, timeoutMs: number, signal: AbortSignal, onPid: (pid: number) => void): Promise<{ port: number; token: string }> {
  return new Promise((resolve, reject) => {
    let output = ''
    let pid: number | undefined
    const finish = (action: () => void): void => {
      clearTimeout(timer); child.stdout.off('data', append); child.stderr.off('data', append)
      child.off('error', failed); child.off('close', closed); signal.removeEventListener('abort', aborted); action()
    }
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (Buffer.byteLength(output) > 4 * 1024 * 1024) { finish(() => reject(new Error('Agent Host startup output limit exceeded'))); return }
      const matchPid = /(?:^|\r?\n)DSH_AGENT_HOST_PID=(\d+)\r?\n/.exec(output)
      if (matchPid) { pid = Number(matchPid[1]); onPid(pid) }
      const endpoint = /ws:\/\/(?:localhost|127\.0\.0\.1):(\d+)\?tkn=([^\s]+)[\r\n]/.exec(stripAnsi(output))
      if (pid !== undefined && endpoint?.[1] && endpoint[2]) finish(() => resolve({ port: Number(endpoint[1]), token: endpoint[2]! }))
    }
    const failed = (error: Error): void => finish(() => reject(error))
    const closed = (code: number | null): void => finish(() => reject(new SshExecutionError('standalone CLI', code, ['standalone CLI (ssh exit ' + (code ?? 'unknown') + '): ' + tailDiagnostic(output)])))
    const aborted = (): void => finish(() => reject(signal.reason))
    const timer = setTimeout(() => finish(() => reject(new RemoteSshLifecycleError('candidate_startup_timeout', 'Standalone Agent Host startup timed out'))), timeoutMs)
    child.stdout.on('data', append); child.stderr.on('data', append); child.once('error', failed); child.once('close', closed)
    signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted()
  })
}

async function waitForAgentHostPort(child: ChildProcessWithoutNullStreams, timeoutMs: number, signal: AbortSignal, onPid: (pid: number) => void): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let output = ''
    let settled = false
    let processId: number | undefined
    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.removeListener('data', append)
      child.stderr.removeListener('data', append)
      child.removeListener('error', failed)
      child.removeListener('close', closed)
      signal.removeEventListener('abort', aborted)
      operation()
    }
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (Buffer.byteLength(output, 'utf8') > 4 * 1024 * 1024) {
        finish(() => reject(new Error('embedded Agent Host startup output exceeded 4 MiB')))
        return
      }
      const pid = /DSH_AGENT_HOST_PID=(\d+)/.exec(output)
      if (pid !== null) { processId = Number(pid[1]); onPid(processId) }
      const match = /Agent host server listening on (?:localhost|127\.0\.0\.1):(\d+)/.exec(stripAnsi(output))
      if (match?.[1] !== undefined && processId !== undefined) finish(() => resolvePromise(Number(match[1])))
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const failed = (error: Error): void => { finish(() => reject(error)) }
    const closed = (code: number | null): void => { finish(() => reject(new Error('embedded Agent Host SSH process exited with code ' + code + ': ' + stripAnsi(output)))) }
    const aborted = (): void => { finish(() => reject(signal.reason)) }
    child.once('error', failed)
    child.once('close', closed)
    signal.addEventListener('abort', aborted, { once: true })
    const timer = setTimeout(() => {
      finish(() => reject(new RemoteSshLifecycleError('candidate_startup_timeout', `embedded Agent Host startup timed out after ${timeoutMs}ms\n${stripAnsi(output)}`)))
    }, timeoutMs)
    if (signal.aborted) aborted()
  })
}

/**
 * Stop a verified Linux process group, retaining member birth identities after its leader exits.
 * @param pid - PID emitted by the embedded bootstrap.
 * @param dataDir - Unique server-data-dir for that attempt.
 * @param graceMs - Grace after TERM and bounded settling time after KILL.
 * @returns A Linux /proc cleanup command; an unverifiable owner or surviving live member fails.
 */
export function buildStopEmbeddedAgentHostCommand(pid: number, dataDir: string, graceMs: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('invalid embedded Agent Host PID')
  return [
    'dsh_pid=' + pid,
    'dsh_data=' + quotePosix(dataDir),
    "dsh_live() { dsh_table=$(ps -eo pid=,pgid=,stat=) || return 1; printf \"%s\\n\" \"$dsh_table\" | awk -v group=\"$dsh_pid\" '$2 == group && $3 !~ /^[ZX]/ { print $1 }'; }",
    "dsh_birth() { dsh_stat=$(cat \"/proc/$1/stat\" 2>/dev/null) || return 1; dsh_stat=${dsh_stat##*) }; set -- $dsh_stat; case \"$1\" in Z|X) return 1;; esac; [ \"$3\" = \"$dsh_pid\" ] && [ \"$4\" = \"$dsh_pid\" ] || return 1; shift 19; printf \"%s\\n\" \"$1\"; }",
    "dsh_anchor() { for dsh_entry in $dsh_owned; do dsh_member=${dsh_entry%%:*}; dsh_start=${dsh_entry#*:}; dsh_current=$(dsh_birth \"$dsh_member\") || continue; [ \"$dsh_start\" = \"$dsh_current\" ] && return 0; done; return 1; }",
    "dsh_members=$(dsh_live) || exit 1",
    "[ -n \"$dsh_members\" ] || exit 0",
    "dsh_args=$(ps -o args= -p \"$dsh_pid\")",
    "case \"$dsh_args\" in *\"$dsh_data\"*) ;; *) printf \"Agent Host PID owner unavailable or changed\\n\" >&2; exit 1;; esac",
    "dsh_owned=",
    "for dsh_member in $dsh_members; do dsh_start=$(dsh_birth \"$dsh_member\") || continue; dsh_owned=\"$dsh_owned $dsh_member:$dsh_start\"; done",
    "if ! dsh_anchor; then printf \"Agent Host process group owner changed\\n\" >&2; exit 1; fi",
    "if ! env kill -s TERM -- \"-$dsh_pid\" 2>/dev/null; then dsh_members=$(dsh_live) || exit 1; [ -z \"$dsh_members\" ] && exit 0; printf \"Agent Host SIGTERM failed\\n\" >&2; exit 1; fi",
    "dsh_members=$(dsh_live) || exit 1",
    "[ -n \"$dsh_members\" ] || exit 0",
    'sleep ' + (graceMs / 1000),
    "dsh_members=$(dsh_live) || exit 1",
    "[ -n \"$dsh_members\" ] || exit 0",
    "if ! dsh_anchor; then printf \"Agent Host surviving group ownership cannot be verified\\n\" >&2; exit 1; fi",
    "if ! env kill -s KILL -- \"-$dsh_pid\" 2>/dev/null; then dsh_members=$(dsh_live) || exit 1; [ -z \"$dsh_members\" ] && exit 0; printf \"Agent Host SIGKILL failed\\n\" >&2; exit 1; fi",
    'sleep ' + (graceMs / 1000),
    "dsh_members=$(dsh_live) || exit 1",
    "if [ -n \"$dsh_members\" ]; then printf \"Agent Host process group still has live members\\n\" >&2; exit 1; fi",
  ].join('\n')
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tailDiagnostic(value: string, maxLength = 2_000): string {
  const clean = stripAnsi(value).trim()
  return formatConnectionDiagnostic(clean, maxLength)
}

function connectionDiagnostic(error: unknown, offeredVersions: readonly string[]): string {
  const mismatch = ahpProtocolMismatch(error, offeredVersions)
  return mismatch === undefined ? tailDiagnostic(errorMessage(error)) : `AHP protocol mismatch: ${formatAhpProtocolMismatch(mismatch)}`
}

async function reservePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('dsh-remote-ssh: failed to reserve a TCP port'))
        return
      }
      const port = address.port
      server.close(error => error === undefined ? resolvePromise(port) : reject(error))
    })
  })
}

async function waitForPort(port: number, child: ChildProcessWithoutNullStreams, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new RemoteSshLifecycleError('candidate_startup_timeout', 'dsh-remote-ssh: SSH tunnel did not open within ' + timeoutMs + 'ms')), timeoutMs)
  const cancelled = AbortSignal.any([signal, timeout.signal])
  try {
    while (Date.now() < deadline) {
      cancelled.throwIfAborted()
      if (child.exitCode !== null) throw new RemoteSshLifecycleError('connection_closed', 'dsh-remote-ssh: SSH tunnel exited with code ' + child.exitCode)
      const connected = await new Promise<boolean>((resolvePromise, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port })
        const finish = (action: () => void): void => {
          cancelled.removeEventListener('abort', aborted)
          socket.removeListener('connect', connected)
          socket.removeListener('error', failed)
          socket.destroy()
          action()
        }
        const connected = (): void => finish(() => resolvePromise(true))
        const failed = (): void => finish(() => resolvePromise(false))
        const aborted = (): void => finish(() => reject(cancelled.reason))
        socket.once('connect', connected)
        socket.once('error', failed)
        cancelled.addEventListener('abort', aborted, { once: true })
        if (cancelled.aborted) aborted()
      })
      if (connected) return
      await new Promise<void>((resolvePromise, reject) => {
        const retry = setTimeout(() => { cancelled.removeEventListener('abort', aborted); resolvePromise() }, Math.min(50, Math.max(1, deadline - Date.now())))
        const aborted = (): void => { clearTimeout(retry); cancelled.removeEventListener('abort', aborted); reject(cancelled.reason) }
        cancelled.addEventListener('abort', aborted, { once: true })
        if (cancelled.aborted) aborted()
      })
    }
    throw new RemoteSshLifecycleError('candidate_startup_timeout', 'dsh-remote-ssh: SSH tunnel did not open within ' + timeoutMs + 'ms')
  } finally { clearTimeout(timer) }
}

export default RemoteSshRuntime
