/** Bridge-local revocation and cleanup, independent of the shared SSH manager's route lifetime. */
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'

/** Execution registered before async allocation and retained through authoritative cleanup. */
export type SidebarOwnedExecution = Parameters<RemoteSshManager['ownExecution']>[1]

/** Reject new effects synchronously, then drain pending and resident bridge-owned effects. */
export class SidebarExecutionLifetime {
  private revoked = false
  private readonly executions = new Set<SidebarOwnedExecution>()
  private disposal: Promise<void> | undefined

  /** Create a lifetime scoped to one selected remote workspace.
   * @param manager Shared route owner; bridge disposal must not retire its route.
   * @param route Authorized route identity.
   * @param failure Sidebar-owned unavailable error constructor.
   */
  constructor(private readonly manager: RemoteSshManager, private readonly route: RemoteWorkspaceRoute, private readonly failure: () => Error) {}

  /** Refuse effects from retained adapters after bridge revocation. */
  check(): void { if (this.revoked) throw this.failure() }

  /** Reserve both bridge and manager ownership before execution side effects.
   * @param execution Pending/running effect and its authoritative cleanup completion.
   * @returns Manager registration disposer; bridge ownership ends only on clean settlement.
   */
  ownExecution = (execution: SidebarOwnedExecution): (() => void) => {
    this.check()
    this.executions.add(execution)
    let release: () => void
    try { release = this.manager.ownExecution(this.route, execution) } catch (error) {
      this.executions.delete(execution)
      throw error
    }
    void execution.done.then(() => { this.executions.delete(execution) }, (_error) => { /* Unknown cleanup remains bridge-owned and manager-owned. */ })
    return release
  }

  /** Revoke retained capabilities before cancelling and awaiting every owned execution.
   * @returns Shared cleanup completion; failures reject and retain execution ownership.
   */
  dispose(): Promise<void> {
    this.revoked = true
    this.disposal ??= (async () => {
      const results = await Promise.allSettled([...this.executions].flatMap(execution => [Promise.resolve().then(() => execution.terminate()), execution.done]))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Sidebar remote workspace cleanup failed')
    })()
    return this.disposal
  }
}
