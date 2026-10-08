import { Context } from '@deepseek-ai/cordis'
import { resolveLocalPwsh } from './local-shell.ts'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import type { RemoteSshManager } from './manager.ts'

export interface Config {
  dialect: 'bash' | 'pwsh'
  cwd?: string
  timeoutMs?: number
  maxTimeoutMs?: number
  maxOutputBytes?: number
  maxSpillBytes?: number
  graceMs?: number
  executable?: string
  /** Preserve the stock PowerShell executable configuration when replacing its row. */
  pwshPath?: string
}

interface ResolvedConfig extends Config {
  timeoutMs: number
  maxTimeoutMs: number
  maxOutputBytes: number
  maxSpillBytes: number
  graceMs: number
}

const PWSH_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** Syntax-specific shell provider over the cwd-routed subprocess service. */
export class TransparentShellExecutor extends ShellExecutor {
  static inject = ['subprocess', 'remoteSshManager']
  static Config: z<Config> = z.object({
    dialect: z.union(['bash', 'pwsh'] as const).required(),
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(64 * 1024 * 1024),
    graceMs: z.number().default(3_000),
    executable: z.string(),
    pwshPath: z.string(),
  })

  private readonly config: ResolvedConfig
  private readonly manager: RemoteSshManager

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    this.manager = ctx.remoteSshManager
    for (const name of ['timeoutMs', 'maxTimeoutMs', 'maxOutputBytes', 'maxSpillBytes', 'graceMs'] as const) {
      const value = this.config[name]
      if (!Number.isFinite(value) || value <= 0) throw new Error(`dsh-remote-ssh/shell-transparent: ${name} must be positive`)
    }
  }

  /** Remote and local routing is explicitly unconfined at the process layer. */
  override get sandboxMode(): 'danger-full-access' {
    return 'danger-full-access'
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = Math.min(Math.floor(request.timeoutMs ?? this.config.timeoutMs), this.config.maxTimeoutMs)
    const stdoutMaxBytes = Math.floor(request.stdoutMaxBytes ?? this.config.maxOutputBytes)
    if (timeoutMs <= 0 || stdoutMaxBytes <= 0) throw new Error('dsh-remote-ssh/shell-transparent: timeout and output limits must be positive')
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes,
      signal: request.signal,
      stdin: request.stdin,
      env: request.env,
      dshEnv: request.dshEnv,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    assertUnconfined(spec)
    const route = this.manager.routeShell(spec.workdir, spec.dshEnv?.DSH_SESSION_ID)
    if (route.kind === 'remote') return (await this.manager.workspaceShell(route, this.config.dialect)).execute(spec)
    const controller = new AbortController()
    let cause: 'timeout' | 'abort' | undefined
    const abort = (): void => {
      if (cause !== undefined) return
      cause = 'abort'
      controller.abort(spec.signal?.reason)
    }
    if (spec.signal?.aborted) abort()
    else spec.signal?.addEventListener('abort', abort, { once: true })
    const timer = spec.onExpiry === 'none' ? undefined : setTimeout(() => {
      if (cause !== undefined) return
      cause = 'timeout'
      controller.abort(new Error('shell timeout'))
    }, spec.timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', abort)
    }
    let handle: SubprocessHandle
    try {
      handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, spec.stdoutMaxBytes, controller.signal))
    } catch (error) {
      cleanup()
      throw error
    }
    const collected = requireCollected(handle)
    const result = handle.done.then(outcome => ({
      ...outcome,
      timedOut: cause === 'timeout',
      aborted: cause === 'abort',
      timeoutMs: spec.timeoutMs,
      stdout: finalOutput(collected.stdout),
      stderr: finalOutput(collected.stderr),
      sandbox: { mode: 'danger-full-access' as const, denied: false },
    })).finally(cleanup)
    let stdoutOffset = 0
    let stderrOffset = 0
    let spawnFailure: Buffer | undefined
    const observedStderr: SubprocessOutputReader = {
      readFrom: fromByte => {
        if (spawnFailure === undefined) return collected.stderr.readFrom(fromByte)
        return { text: spawnFailure.subarray(Math.min(fromByte, spawnFailure.length)).toString('utf8'), nextOffset: spawnFailure.length, lossy: false }
      },
    }
    const processHandle: ShellExecution = {
      status: 'running', exitCode: null, signal: null,
      result: () => result,
      observed: { stdout: collected.stdout, stderr: observedStderr },
      sandbox: { mode: 'danger-full-access', denied: false },
      done: result.then(outcome => {
        processHandle.exitCode = outcome.exitCode
        processHandle.signal = outcome.signal
        processHandle.status = outcome.signal === null ? 'completed' : 'killed'
      }, (error: unknown) => {
        processHandle.status = 'killed'
        processHandle.signal = 'SIGTERM'
        let detail = 'unprintable provider failure'
        try { detail = String(error) } catch (formatError) { /* Rejection formatting cannot make done reject. */ }
        spawnFailure = Buffer.from('spawn failed: ' + detail, 'utf8')
      }),
      readOutput: (): ShellProcessRead => {
        const stdout = collected.stdout.readFrom(stdoutOffset)
        const stderr = observedStderr.readFrom(stderrOffset)
        stdoutOffset = stdout.nextOffset
        stderrOffset = stderr.nextOffset
        const error = stderr.text
        return {
          delta: stdout.text + (error.length === 0 ? '' : (stdout.text.length > 0 && !stdout.text.endsWith('\n') ? '\n' : '') + '[stderr]\n' + error),
          lossy: stdout.lossy || stderr.lossy,
          ...(stdout.spillPath === undefined ? {} : { stdoutSpillPath: stdout.spillPath }),
          ...(stderr.spillPath === undefined ? {} : { stderrSpillPath: stderr.spillPath }),
        }
      },
      kill: (): boolean => {
        if (processHandle.status !== 'running') return false
        processHandle.status = 'killed'
        handle.terminate()
        return true
      },
    }
    return processHandle
  }

  private spawnSpec(spec: ShellExecSpec, stdoutMaxBytes: number, signal: AbortSignal | undefined): SubprocessSpawnSpec {
    const collect = (maxBytes: number) => ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv: this.argv(spec.command),
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      env: { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', ...spec.env, ...spec.dshEnv },
    }
  }

  private argv(command: string): string[] {
    if (this.config.dialect === 'bash') return [this.config.executable ?? 'bash', '-c', command]
    return [resolveLocalPwsh(this.config.executable ?? this.config.pwshPath), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PWSH_PREAMBLE + command]
  }
}

function assertUnconfined(spec: ShellExecSpec): void {
  if (spec.sandboxPolicy !== undefined && spec.sandboxPolicy.mode !== 'danger-full-access') {
    throw new Error(`dsh-remote-ssh: transparent shell cannot enforce ${spec.sandboxPolicy.mode} across SSH; select danger-full-access or confine the SSH account`)
  }
}

function requireCollected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
  const { stdout, stderr } = handle.collected
  if (stdout === undefined || stderr === undefined) throw new Error('dsh-remote-ssh: subprocess dropped requested collected output')
  return { stdout, stderr }
}

function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const value = reader.readFrom(0)
  return {
    text: value.text,
    truncated: value.lossy,
    ...(value.spillPath === undefined ? {} : { spillPath: value.spillPath }),
  }
}

export default TransparentShellExecutor
