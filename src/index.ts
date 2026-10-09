import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { connectOwnedWebSocket, ownSshProcess } from './ssh-lifecycle.ts'
import { AgentHostConnectionError } from './connection-error.ts'
import { Context, Service } from '@deepseek-ai/cordis'
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
  shutdownTimeoutMs: number
  requestTimeoutMs: number
  protocolVersions: string[]
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

  private readonly ready: Promise<AhpConnection>
  private tunnel: ChildProcessWithoutNullStreams | undefined
  private embeddedAgentHost: ChildProcessWithoutNullStreams | undefined
  private embeddedPid: number | undefined
  private embeddedDataDir: string | undefined
  private disposed = false
  private readonly lifetime = new AbortController()
  private readonly stopProcess = new WeakMap<ChildProcessWithoutNullStreams, (graceMs: number) => Promise<void>>()
  private startupDeadline = 0

  constructor(ctx: Context, config: Config) {
    super(ctx, 'remoteSsh')
    this.config = config as ResolvedConfig
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
    this.startupDeadline = Date.now() + this.config.startupTimeoutMs
    this.ready = this.open().catch(async (error: unknown) => { await this.resetSshAttempt(); throw error })
    void this.ready.catch(() => {})
    ctx.effect(() => async () => {
      this.disposed = true
      this.lifetime.abort(new Error('dsh-remote-ssh: connection disposed'))
      try {
        const connection = await this.ready
        await connection.client.shutdown()
      } catch {
        // A failed startup owns its original diagnostic.
      } finally {
        await this.resetSshAttempt()
      }
    }, 'Remote SSH AHP teardown')
  }

  async getConnection(): Promise<AhpConnection> {
    if (this.disposed) throw new Error('Remote SSH service is disposing')
    const connection = await this.ready
    if (this.disposed) throw new Error('Remote SSH service is disposing')
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
    validateProtocolVersions(protocolVersions)
  }

  private async open(): Promise<AhpConnection> {
    if (this.config.directUrl !== undefined) return this.connectEndpoint(this.config.directUrl)
    return this.openOverSsh()
  }

  private async connectEndpoint(url: string): Promise<AhpConnection> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.remainingStartup())])
    const transport = await connectOwnedWebSocket(url, signal)
    const client = new AhpClient(transport, { requestTimeoutMs: this.config.requestTimeoutMs })
    client.connect()
    const abort = (): void => { client.shutdown() }
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
      await client.shutdown().catch(() => {})
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  private async openOverSsh(): Promise<AhpConnection> {
    const diagnostics: string[] = []
    const startupCommand = buildRemoteAgentHostCommand(this.config.remoteCodeCommand, this.runtimeRoot)
    let startup: CapturedProcess
    try {
      startup = await runCaptured(
        this.config.sshExecutable,
        [...this.config.sshArgs, '-T', this.config.sshTarget, startupCommand],
        this.remainingStartup(),
        this.lifetime.signal,
        this.config.shutdownTimeoutMs,
      )
    } catch (error: unknown) {
      if (this.config.remoteCodeCommand !== 'code') throw error
      diagnostics.push(`standalone CLI: ${errorMessage(error)}`)
      startup = { exitCode: null, stdout: '', stderr: '' }
    }
    const clean = stripAnsi(`${startup.stdout}\n${startup.stderr}`)
    const endpoint = /ws:\/\/(?:localhost|127\.0\.0\.1):(\d+)\?tkn=([^\s]+)/.exec(clean)
    if (endpoint?.[1] !== undefined && endpoint[2] !== undefined) {
      try {
        const url = await this.openTunnel(Number(endpoint[1]), endpoint[2])
        return await this.connectEndpoint(url)
      } catch (error: unknown) {
        await this.resetSshAttempt()
        diagnostics.push(`standalone CLI: ${connectionDiagnostic(error, this.config.protocolVersions)}`)
        if (this.config.remoteCodeCommand !== 'code') {
          throw new Error(`dsh-remote-ssh: configured VS Code Agent Host failed\n${diagnostics.at(-1)}`, { cause: error })
        }
      }
    } else if (clean.trim().length > 0) {
      diagnostics.push(`standalone CLI (ssh exit ${startup.exitCode ?? 'unknown'}): ${tailDiagnostic(clean)}`)
    }

    // A Remote - SSH server installation exposes bin/remote-cli/code, but that
    // wrapper deliberately refuses ordinary SSH sessions. Its sibling
    // bin/code-server can host the same official Agent Host directly. Probe
    // every installed build newest-first: a newer VS Code may speak a protocol
    // that the bundled AHP client has not adopted yet, while an older compatible
    // build remains usable.
    if (this.config.remoteCodeCommand !== 'code') {
      throw new Error(`dsh-remote-ssh: remote VS Code Agent Host failed to start (ssh exit ${startup.exitCode})\n${clean}`)
    }
    const candidates = await this.listEmbeddedAgentHosts()
    for (const [index, codeServerPath] of candidates.entries()) {
      this.remainingStartup()
      try {
        const url = await this.startEmbeddedAgentHost(codeServerPath, index)
        return await this.connectEndpoint(url)
      } catch (error: unknown) {
        await this.resetSshAttempt()
        this.remainingStartup()
        diagnostics.push(`embedded ${codeServerPath}: ${connectionDiagnostic(error, this.config.protocolVersions)}`)
      }
    }
    if (candidates.length === 0) diagnostics.push('embedded VS Code Server: no installed code-server found')
    throw new AgentHostConnectionError(this.config.protocolVersions, diagnostics)
  }

  private async listEmbeddedAgentHosts(): Promise<string[]> {
    const result = await runCaptured(
      this.config.sshExecutable,
      [...this.config.sshArgs, '-T', this.config.sshTarget, buildListEmbeddedAgentHostsCommand()],
      Math.min(this.remainingStartup(), this.config.requestTimeoutMs),
      this.lifetime.signal,
      this.config.shutdownTimeoutMs,
    )
    if (result.exitCode !== 0) return []
    return [...new Set(result.stdout.split(/\r?\n/u).map(path => path.trim()).filter(Boolean))]
  }

  private async startEmbeddedAgentHost(codeServerPath: string, attempt: number): Promise<string> {
    const timeoutMs = this.remainingStartup()
    const instanceId = `${this.clientId}-${attempt}`
    this.embeddedDataDir = posix.join(this.runtimeRoot, 'server-embedded', instanceId)
    const child = spawn(this.config.sshExecutable, [
      ...this.config.sshArgs,
      '-T',
      this.config.sshTarget,
      buildEmbeddedAgentHostCommand(codeServerPath, instanceId, this.runtimeRoot),
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.stopProcess.set(child, ownSshProcess(child))
    this.embeddedAgentHost = child
    const remotePort = await waitForAgentHostPort(child, timeoutMs, this.lifetime.signal, pid => { this.embeddedPid = pid })
    const tokenResult = await runCaptured(
      this.config.sshExecutable,
      [...this.config.sshArgs, '-T', this.config.sshTarget, `cat ${quotePosix(posix.join(this.runtimeRoot, 'server-embedded', instanceId, 'data/token'))}`],
      Math.min(this.remainingStartup(), this.config.requestTimeoutMs),
      this.lifetime.signal,
      this.config.shutdownTimeoutMs,
    )
    const token = tokenResult.stdout.trim()
    if (tokenResult.exitCode !== 0 || token.length === 0 || /\s/.test(token)) {
      throw new Error(`dsh-remote-ssh: could not read the embedded Agent Host connection token\n${tokenResult.stderr}`)
    }
    return this.openTunnel(remotePort, token)
  }

  private async openTunnel(remotePort: number, token: string): Promise<string> {
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
    this.stopProcess.set(tunnel, ownSshProcess(tunnel))
    this.tunnel = tunnel
    await waitForPort(localPort, tunnel, timeoutMs, this.lifetime.signal)
    return `ws://127.0.0.1:${localPort}?tkn=${encodeURIComponent(token)}`
  }

  private remainingStartup(): number {
    this.lifetime.signal.throwIfAborted()
    const remaining = this.startupDeadline - Date.now()
    if (remaining <= 0) throw new Error('dsh-remote-ssh: total Agent Host startup deadline exceeded')
    return remaining
  }

  private async resetSshAttempt(): Promise<void> {
    const pid = this.embeddedPid
    const dataDir = this.embeddedDataDir
    const children = [this.tunnel, this.embeddedAgentHost]
    this.tunnel = undefined
    this.embeddedAgentHost = undefined
    try {
      if (pid !== undefined && dataDir !== undefined) {
        const cleanup = await runCaptured(
          this.config.sshExecutable,
          [...this.config.sshArgs, '-T', this.config.sshTarget, buildStopEmbeddedAgentHostCommand(pid, dataDir, this.config.shutdownTimeoutMs)],
          this.config.requestTimeoutMs + 2 * this.config.shutdownTimeoutMs,
          new AbortController().signal,
          this.config.shutdownTimeoutMs,
        )
        if (cleanup.exitCode !== 0) throw new Error('dsh-remote-ssh: owned remote Agent Host cleanup failed: ' + cleanup.stderr)
      }
      this.embeddedPid = undefined
      this.embeddedDataDir = undefined
    } finally {
      await Promise.all(children.map(child => child === undefined ? undefined : this.stopProcess.get(child)?.(this.config.shutdownTimeoutMs)))
    }
  }
}

interface CapturedProcess {
  exitCode: number | null
  stdout: string
  stderr: string
}

async function runCaptured(command: string, args: string[], timeoutMs: number, signal: AbortSignal, graceMs: number): Promise<CapturedProcess> {
  signal.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = ownSshProcess(child)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let failure: unknown
    const fail = (error: unknown): void => {
      failure ??= error
      void stop(graceMs)
    }
    const append = (bucket: Buffer[], chunk: Buffer): void => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) { fail(new Error('dsh-remote-ssh: SSH startup output exceeded 4 MiB')); return }
      if (failure === undefined) bucket.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => { append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { append(stderr, chunk) })
    child.once('error', fail)
    const abort = (): void => { fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => fail(new Error('dsh-remote-ssh: SSH startup timed out after ' + timeoutMs + 'ms')), timeoutMs)
    child.once('close', exitCode => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (failure !== undefined) reject(failure)
      else resolvePromise({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    if (signal.aborted) abort()
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
      finish(() => reject(new Error(`embedded Agent Host startup timed out after ${timeoutMs}ms\n${stripAnsi(output)}`)))
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
  return clean.length <= maxLength ? clean : `…${clean.slice(-maxLength)}`
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
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    if (child.exitCode !== null) throw new Error(`dsh-remote-ssh: SSH tunnel exited with code ${child.exitCode}`)
    const connected = await new Promise<boolean>((resolvePromise) => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolvePromise(true) })
      socket.once('error', () => { socket.destroy(); resolvePromise(false) })
    })
    if (connected) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  child.kill()
  throw new Error(`dsh-remote-ssh: SSH tunnel did not open port ${port} within ${timeoutMs}ms`)
}

export default RemoteSshRuntime
