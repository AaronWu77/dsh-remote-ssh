/** Short-lived diagnostics with private SSH/AHP ownership and credential-free reports. */
import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import RemoteSshRuntime, { fileUriFromPosixPath, posixPathFromFileUri, quotePosix } from './index.ts'
import RemoteSshShellExecutor, { type RemoteShellExecution } from './shell.ts'
import type { RemoteSshManager, RemoteSshServer } from './manager.ts'
import { runCaptured } from './ssh-command.ts'
import { RemoteSshManagementError } from './management-error.ts'
import type { DiagnosticId, DiagnosticReport, DiagnosticStageId, DiagnosticStageStatus, StartDiagnosticRequest } from './management-types.ts'

/** Deployment limits resolved by the Web provider, not by individual tasks. */
export interface DiagnosticPolicy {
  timeoutMs: number
  terminalTimeoutMs: number
  leaseMs: number
  retentionMs: number
  maxConcurrent: number
  maxRetained: number
}

interface OwnedDiagnostic {
  report: DiagnosticReport
  controller: AbortController
  done: Promise<void>
  lease: ReturnType<typeof setTimeout>
  retention?: ReturnType<typeof setTimeout>
}

const STAGES: DiagnosticStageId[] = ['config', 'ssh', 'agentHost', 'tunnel', 'protocol', 'directory', 'terminal', 'cleanup']
const PREREQUISITES = ['bash', 'base64', 'mkfifo', 'dd', 'mv', 'ps', 'awk', 'kill', 'rg'] as const
const SSH_CHECK = 'printf "DSH_SSH_READY\n"; printf "linux=%s\n" "$(uname -s)"; for dsh_cmd in ' + PREREQUISITES.join(' ') + '; do if command -v "$dsh_cmd" >/dev/null 2>&1; then printf "%s=1\n" "$dsh_cmd"; else printf "%s=0\n" "$dsh_cmd"; fi; done'

/** Validate a client-generated random id before using it as a diagnostic capability.
 * @param value - Untrusted JSON id.
 * @returns The validated branded id.
 */
export function parseDiagnosticId(value: unknown): DiagnosticId {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RemoteSshManagementError('diagnostic_invalid', 400, 'A random diagnostic id is required')
  }
  return value as DiagnosticId
}

/** Validate network input without accepting caller-supplied commands or SSH options.
 * @param body - Parsed request object.
 * @returns Validated request for a configured server.
 */
export function parseDiagnosticRequest(body: Record<string, unknown>): StartDiagnosticRequest {
  const id = parseDiagnosticId(body.id)
  if (typeof body.expectedRevision !== 'string' || !body.expectedRevision || typeof body.serverId !== 'string' || !body.serverId
    || (body.mode !== 'basic' && body.mode !== 'deep') || typeof body.terminal !== 'boolean' || typeof body.confirmDeep !== 'boolean'
    || (body.path !== undefined && (typeof body.path !== 'string' || !posix.isAbsolute(body.path) || body.path.includes('\0')))) {
    throw new RemoteSshManagementError('diagnostic_invalid', 400, 'Invalid diagnostic options')
  }
  if ((body.mode === 'deep' && !body.confirmDeep) || (body.terminal && body.mode !== 'deep')) {
    throw new RemoteSshManagementError('diagnostic_confirmation_required', 400, 'Confirm temporary remote resources before deep diagnosis')
  }
  return { id, expectedRevision: body.expectedRevision, serverId: body.serverId, mode: body.mode, terminal: body.terminal,
    confirmDeep: body.confirmDeep, ...(typeof body.path === 'string' ? { path: body.path } : {}) }
}

/** Own diagnostic lifetimes; status polling renews a lease and unloading joins cleanup. */
export class RemoteSshDiagnostics {
  private readonly records = new Map<DiagnosticId, OwnedDiagnostic>()
  private readonly cancelled = new Map<DiagnosticId, ReturnType<typeof setTimeout>>()
  private closed = false

  constructor(private readonly manager: Pick<RemoteSshManager, 'snapshot' | 'transportFor' | 'ownDiagnostic'>, private readonly policy: DiagnosticPolicy) {}

  /** Start once for a client id. Repeated starts return the same result, never replay work.
   * @param input - Validated options.
   * @param server - Destination resolved from the current catalog.
   * @returns A credential-free detached report.
   */
  start(input: StartDiagnosticRequest, server: RemoteSshServer): DiagnosticReport {
    if (this.closed) throw new RemoteSshManagementError('diagnostic_unavailable', 503, 'Diagnostics are closing')
    const existing = this.records.get(input.id)
    if (existing) return structuredClone(existing.report)
    if (this.cancelled.has(input.id)) throw new RemoteSshManagementError('diagnostic_cancelled', 409, 'Diagnostic was cancelled before startup')
    const running = [...this.records.values()].filter(record => !record.report.finishedAt).length
    if (running >= this.policy.maxConcurrent) throw new RemoteSshManagementError('diagnostic_capacity', 429, 'Wait for another diagnostic to finish')
    while (this.records.size >= this.policy.maxRetained) {
      const entry = [...this.records].find(([, record]) => record.report.finishedAt !== undefined)
      if (!entry) throw new RemoteSshManagementError('diagnostic_capacity', 429, 'Diagnostic capacity reached')
      clearTimeout(entry[1].retention); this.records.delete(entry[0])
    }
    const release = this.manager.ownDiagnostic(input.expectedRevision)
    let spec: ReturnType<RemoteSshManager['snapshot']>
    let transport: ReturnType<RemoteSshManager['transportFor']>
    try {
      spec = this.manager.snapshot()
      transport = this.manager.transportFor(server, 'runtime')
    } catch (error) { release(); throw error }
    // No multiplexed master is shared with normal workspaces, including on POSIX.
    const args = ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...transport.args]
    const report: DiagnosticReport = { id: input.id, revision: input.expectedRevision, mode: input.mode, terminal: input.terminal,
      status: 'running', startedAt: Date.now(), stages: STAGES.map(id => ({ id, status: 'pending', elapsedMs: 0 })) }
    const controller = new AbortController()
    const lease = setTimeout(() => controller.abort(new Error('lease_expired')), this.policy.leaseMs)
    lease.unref()
    const record: OwnedDiagnostic = { report, controller, lease, done: Promise.resolve() }
    this.records.set(input.id, record)
    record.done = this.run(record, input, server, spec, transport.executable, args).finally(() => {
      release(); clearTimeout(record.lease)
      record.retention = setTimeout(() => { this.records.delete(input.id) }, this.policy.retentionMs)
      record.retention.unref()
    })
    return structuredClone(report)
  }

  /** Read a report and keep its owned work alive while a consumer is present.
   * @param id - Validated capability.
   * @returns Detached report or a not-found error after expiry/restart.
   */
  status(id: DiagnosticId): DiagnosticReport {
    const record = this.records.get(id)
    if (!record) throw new RemoteSshManagementError('diagnostic_expired', 404, 'Diagnostic expired or server restarted')
    if (record.report.finishedAt === undefined) record.lease.refresh()
    return structuredClone(record.report)
  }

  /** Cancel owned work, retaining pre-start tombstones for ambiguous start requests.
   * @param id - Validated capability, including ids whose start response was lost.
   * @returns Current report, or undefined when no start was accepted.
   */
  cancel(id: DiagnosticId): DiagnosticReport | undefined {
    const record = this.records.get(id)
    if (record) {
      if (record.report.finishedAt === undefined) { record.report.status = 'cancelling'; record.controller.abort(new Error('cancelled')) }
      return structuredClone(record.report)
    }
    if (!this.cancelled.has(id)) {
      if (this.cancelled.size >= this.policy.maxRetained) throw new RemoteSshManagementError('diagnostic_capacity', 429, 'Cancellation capacity reached')
      const timer = setTimeout(() => { this.cancelled.delete(id) }, this.policy.retentionMs)
      timer.unref(); this.cancelled.set(id, timer)
    }
    return undefined
  }

  /** Stop accepting tasks and join every owned runtime before releasing the registry.
   * @returns Completion after all task cleanup has settled.
   */
  async close(): Promise<void> {
    this.closed = true
    for (const record of this.records.values()) record.controller.abort(new Error('cancelled'))
    await Promise.all([...this.records.values()].map(record => record.done))
    for (const record of this.records.values()) { clearTimeout(record.lease); clearTimeout(record.retention) }
    for (const timer of this.cancelled.values()) clearTimeout(timer)
    this.records.clear(); this.cancelled.clear()
  }

  private async run(record: OwnedDiagnostic, input: StartDiagnosticRequest, server: RemoteSshServer,
    spec: ReturnType<RemoteSshManager['snapshot']>, executable: string, args: string[]): Promise<void> {
    const { report, controller } = record
    const timeout = setTimeout(() => controller.abort(new Error('timeout')), this.policy.timeoutMs)
    timeout.unref()
    const starts = new Map<DiagnosticStageId, number>()
    const active: { stage: DiagnosticStageId } = { stage: 'config' }
    const set = (id: DiagnosticStageId, status: DiagnosticStageStatus, code?: string): void => {
      const stage = report.stages.find(stage => stage.id === id)!
      if (status === 'running') { active.stage = id; starts.set(id, Date.now()) }
      stage.status = status; stage.elapsedMs = Date.now() - (starts.get(id) ?? Date.now())
      if (code !== undefined) stage.code = code
      else delete stage.code
    }
    const step = async <T>(id: DiagnosticStageId, run: () => Promise<T>): Promise<T> => {
      controller.signal.throwIfAborted(); set(id, 'running')
      const value = await run(); controller.signal.throwIfAborted(); set(id, 'succeeded'); return value
    }
    const ctx = new Context()
    let remote: RemoteSshRuntime | undefined
    let success = false
    let terminalStarted = false
    let terminalExecution: RemoteShellExecution | undefined
    let closeRuntime: Promise<void> | undefined
    const abort = (): void => { if (remote && !terminalStarted) { closeRuntime ??= remote.close(); void closeRuntime.catch(() => {}) } }
    controller.signal.addEventListener('abort', abort, { once: true })
    try {
      await step('config', async () => { if (spec.sshConfigFile) await access(spec.sshConfigFile) })
      const facts = await step('ssh', async () => {
        const result = await runCaptured(executable, [...args, '-T', server.sshTarget, SSH_CHECK],
          Math.min(this.policy.timeoutMs, spec.requestTimeoutMs), controller.signal, spec.shutdownTimeoutMs)
        if (result.exitCode !== 0 || !result.stdout.split(/\r?\n/).includes('DSH_SSH_READY')) throw new Error('ssh_failed')
        const rows = new Set(result.stdout.split(/\r?\n/))
        return Object.fromEntries([...PREREQUISITES.map(name => [name, rows.has(name + '=1')] as const), ['linux', rows.has('linux=Linux')]])
      })
      report.prerequisites = facts
      if (!Object.values(facts).every(Boolean)) set('ssh', 'succeeded', 'prerequisites_missing')
      const required = input.mode === 'deep' ? ['linux', 'bash', 'ps', 'awk', 'kill', ...(input.terminal ? ['base64', 'mkfifo', 'dd', 'mv'] : [])] : []
      if (required.some(name => !facts[name])) {
        set('ssh', 'failed', 'prerequisites_missing')
        throw new Error('prerequisites_missing')
      }
      if (input.mode === 'deep') {
        controller.signal.throwIfAborted()
        remote = new RemoteSshRuntime(ctx, {
          sshTarget: server.sshTarget, sshExecutable: executable, sshArgs: args,
          remoteCodeCommand: server.remoteCodeCommand ?? 'code', remoteRuntimeRoot: '/tmp/dsh-remote-ssh',
          startupTimeoutMs: Math.min(spec.startupTimeoutMs, this.policy.timeoutMs), requestTimeoutMs: spec.requestTimeoutMs,
          embeddedStartupTimeoutMs: spec.embeddedStartupTimeoutMs, standaloneStartupTimeoutMs: spec.standaloneStartupTimeoutMs,
          shutdownTimeoutMs: spec.shutdownTimeoutMs, protocolVersions: spec.protocolVersions,
        }, (id, status) => set(id, status, status === 'failed' ? id === 'agentHost' ? 'agent_host_failed' : id + '_failed' : undefined), true)
        if (controller.signal.aborted) abort()
        const connection = await remote.getConnection()
        if (!spec.protocolVersions.includes(connection.protocolVersion)) throw new Error('protocol_failed')
        report.protocolVersion = connection.protocolVersion
        const path = input.path ?? (connection.defaultDirectory ? posixPathFromFileUri(String(connection.defaultDirectory)) : '/')
        await step('directory', async () => {
          const listing = await connection.client.resourceList({ uri: fileUriFromPosixPath(path) })
          report.directoryCount = listing.entries.filter(entry => entry.type === 'directory').length
        })
        if (input.terminal) await step('terminal', async () => {
          terminalStarted = true
          const shell = new RemoteSshShellExecutor(ctx, { localWorkspace: resolve(tmpdir(), 'dsh-diagnostic-' + randomUUID()),
            remoteWorkspace: path, shellCommand: 'bash', defaultTimeoutMs: this.policy.terminalTimeoutMs,
            maxTimeoutMs: this.policy.terminalTimeoutMs, outputMaxBytes: 4096, maxOutputMaxBytes: 4096 })
          const execution = terminalExecution = await shell.execute(shell.resolve({ command: "printf 'DSH_DIAGNOSTIC_OK\n'", workdir: path,
            signal: controller.signal, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: path } }))
          const result = await execution.result()
          await execution.quiescent
          if (result.exitCode !== 0 || result.aborted || result.timedOut || !result.stdout.text.includes('DSH_DIAGNOSTIC_OK')) throw new Error('terminal_failed')
        })
      }
      success = true
    } catch (error) {
      const cancelled = controller.signal.aborted
      const timedOut = cancelled && controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout'
      const code = timedOut ? 'timeout' : cancelled ? 'cancelled' : active.stage === 'agentHost' ? 'agent_host_failed' : active.stage + '_failed'
      const stage = report.stages.find(stage => stage.id === active.stage)!
      if (stage.status !== 'failed') set(active.stage, cancelled ? 'cancelled' : 'failed', code)
      // Raw SSH/AHP exceptions can contain proxy credentials and are never returned or exported.
      void error
    } finally {
      clearTimeout(timeout); controller.signal.removeEventListener('abort', abort)
      for (const stage of report.stages) {
        if (stage.status === 'pending') stage.status = 'skipped'
        else if (stage.status === 'running') {
          stage.status = controller.signal.aborted ? 'cancelled' : 'failed'
          stage.elapsedMs = Date.now() - (starts.get(stage.id) ?? Date.now())
          stage.code = controller.signal.aborted ? 'cancelled' : 'diagnostic_failed'
        }
      }
      set('cleanup', 'running')
      let cleaned = true
      if (terminalExecution) {
        terminalExecution.kill()
        try { await terminalExecution.quiescent } catch (error) { cleaned = false; void error }
      }
      try { if (remote) await (closeRuntime ??= remote.close()) } catch (error) { cleaned = false; void error }
      try { await ctx.fiber.dispose() } catch (error) { cleaned = false; void error }
      if (remote?.hasUntrackedStandalone()) cleaned = false
      if (remote && cleaned) {
        try {
          const removed = await runCaptured(executable, [...args, '-T', server.sshTarget, 'rm -rf -- ' + quotePosix(remote.runtimeRoot)],
            spec.requestTimeoutMs, new AbortController().signal, spec.shutdownTimeoutMs)
          if (removed.exitCode !== 0) cleaned = false
        } catch (error) { cleaned = false; void error }
      }
      set('cleanup', cleaned ? 'succeeded' : 'failed', cleaned ? undefined : 'cleanup_failed')
      const timedOut = controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout'
      report.status = !cleaned || timedOut ? 'failed' : controller.signal.aborted ? 'cancelled' : success ? 'succeeded' : 'failed'
      report.finishedAt = Date.now()
    }
  }
}
