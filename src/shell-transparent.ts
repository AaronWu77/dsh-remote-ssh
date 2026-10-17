/** Routes remote commands without replacing the host's native confinement behavior. */
import { Context, type Volatile } from '@deepseek-ai/cordis'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import SandboxPwshExecutor from '@deepseek-ai/dsh-pwsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import z from '@deepseek-ai/schemastery'
import type { RemoteSshManager } from './manager.ts'
import type {} from './local-bridge.ts'

/** Native shell budgets remain live; dialect and the legacy executable alias require reload. */
export interface Config extends LocalConfig {
  dialect: 'bash' | 'pwsh'
  /** Legacy PowerShell executable alias. Custom Bash executables are unsupported. */
  executable?: string
  /** Native PowerShell executable, re-resolved when its declared value changes. */
  pwshPath: Volatile<string | undefined>
}

/** Local calls retain the maintained native shell provider; remote calls never fall back locally. */
export class TransparentShellExecutor extends ShellExecutor {
  static inject = ['localSubprocess', 'remoteSshManager', 'sandbox', 'sandboxPolicy']
  static Config = z.object({
    dialect: z.union(['bash', 'pwsh'] as const).required(),
    cwd: z.string().volatile(),
    timeoutMs: z.number().default(120_000).volatile(),
    maxTimeoutMs: z.number().default(600_000).volatile(),
    maxOutputBytes: z.number().default(64_000).volatile(),
    maxSpillBytes: z.number().default(64 * 1024 * 1024).volatile(),
    graceMs: z.number().default(3_000).volatile(),
    executable: z.string(),
    pwshPath: z.string().volatile(),
  })
  private readonly local: Pick<ShellExecutor, 'sandboxMode' | 'resolve' | 'execute'>
  private readonly manager: RemoteSshManager
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    this.manager = ctx.remoteSshManager
    if (config.dialect === 'bash' && config.executable !== undefined && config.executable !== 'bash') {
      throw new Error('dsh-remote-ssh/shell-transparent: custom Bash executable is unsupported by the native sandbox executor; remove executable and configure bash on PATH')
    }
    const local = ctx.isolate('shell').isolate('subprocess')
    local.provide('subprocess', ctx.localSubprocess)
    const common = { cwd: config.cwd, timeoutMs: config.timeoutMs, maxTimeoutMs: config.maxTimeoutMs,
      maxOutputBytes: config.maxOutputBytes, maxSpillBytes: config.maxSpillBytes, graceMs: config.graceMs }
    const native = config.dialect === 'pwsh'
      ? new SandboxPwshExecutor(local, { ...common, pwshPath: config.executable === undefined ? config.pwshPath : { get: () => config.executable } })
      : new SandboxBashExecutor(local, common)
    // Cordis traces nested Service properties into the caller's context. Closures
    // retain the native executor's private subprocess realm across routed calls.
    this.local = {
      sandboxMode: native.sandboxMode,
      resolve: request => native.resolve(request),
      execute: spec => native.execute(spec),
    }
  }
  override get sandboxMode() { return this.local.sandboxMode }
  override resolve(request: ShellExecRequest): ShellExecSpec { return this.local.resolve(request) }
  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const route = this.manager.routeShell(spec.workdir, spec.dshEnv?.DSH_SESSION_ID)
    if (route.kind === 'local') return this.local.execute(spec)
    assertRemotePolicy(spec)
    return (await this.manager.workspaceShell(route, this.config.dialect)).execute(spec)
  }
}

function assertRemotePolicy(spec: ShellExecSpec): void {
  if (spec.sandboxPolicy?.mode !== 'danger-full-access') throw new Error('dsh-remote-ssh: the remote host cannot enforce this sandbox policy; explicitly select danger-full-access for this remote session or use a local workspace')
}
export default TransparentShellExecutor
