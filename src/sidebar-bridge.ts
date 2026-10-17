import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SidebarWorkspaceProviders, SidebarWorkspaceRouter } from 'dsh-better-sidebar/workspace-provider'
import { createSidebarRemoteWorkspace, resolveConfig as resolveWorkspaceConfig, type Config as WorkspaceConfig } from './sidebar-workspace.ts'
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'

/** Configuration for the Sidebar remote workspace bridge. The schema owns defaults. */
export interface SidebarBridgeConfig extends WorkspaceConfig {}

/** Resolved bridge configuration passed to the remote workspace provider. */
export type ResolvedSidebarBridgeConfig = Required<SidebarBridgeConfig>

/** Loader schema for the independently reloadable Sidebar capability bridge. */
export const Config = z.object({
  pathMetadata: z.union(['posix', 'ahp'] as const).default('posix'),
  fullReadMaxBytes: z.number().default(64 * 1024 * 1024),
  uploadChunkMaxBytes: z.number().default(64 * 1024),
  writeMaxBytes: z.number().default(64 * 1024 * 1024),
  searchMaxRows: z.number().default(200),
  searchMaxItems: z.number().default(10_000),
  searchMaxDepth: z.number().default(32),
  cleanupGraceMs: z.number().default(3_000),
  outputChunkBytes: z.number().default(64 * 1024),
  outputPollMs: z.number().default(10),
  gitMaxOutputBytes: z.number().default(4 * 1024 * 1024),
  collectionStderrMaxBytes: z.number().default(1024 * 1024),
  terminalArgv: z.array(z.string()).default(['bash']),
  terminalEnv: z.dict(z.string()).default({}),
  terminalType: z.string().default('xterm-256color'),
}).required()

/** Plugin id for independently reloading the remote Sidebar bridge. */
export const name = 'dsh-remote-ssh-sidebar-bridge'

/** Install the router contribution only while both host services are available.
 * @param ctx Host context with late-bound manager and Sidebar services.
 * @param config Resolved Loader configuration; this executor does not supply defaults.
 */
export function apply(ctx: Context, config: SidebarBridgeConfig): void {
  const resolved = resolveWorkspaceConfig(config)
  ctx.inject(['remoteSshManager', 'sidebarWorkspaceProviders'], injected => {
    const manager = injected.remoteSshManager
    const providers = injected.get('sidebarWorkspaceProviders') as SidebarWorkspaceProviders
    const workspaces = new WeakMap<RemoteWorkspaceRoute, Map<string, ReturnType<typeof createSidebarRemoteWorkspace>>>()
    const owned = new Set<ReturnType<typeof createSidebarRemoteWorkspace>>()
    let revoked = false
    const router: SidebarWorkspaceRouter = async scope => {
      if (revoked) throw providers.workspaceError('workspace-unavailable', 'Remote Sidebar bridge has been removed', 503)
      let route: ReturnType<RemoteSshManager['route']>
      try { route = manager.route(undefined, scope.cwd) } catch (error) {
        throw providers.workspaceError('workspace-unavailable', error instanceof Error ? error.message : String(error), 503)
      }
      if (route.kind !== 'remote') return { kind: 'local', cwd: scope.cwd }
      const remoteCwd = route.mapper.toRemotePath(scope.cwd, route.aliasPath)
      let scoped = workspaces.get(route)
      if (scoped === undefined) { scoped = new Map(); workspaces.set(route, scoped) }
      let workspace = scoped.get(remoteCwd)
      if (workspace === undefined) {
        workspace = createSidebarRemoteWorkspace(manager, route, remoteCwd, resolved, providers)
        scoped.set(remoteCwd, workspace)
        owned.add(workspace)
      }
      return workspace
    }
    injected.effect(() => {
      const unregister = providers.registerRouter(router)
      return async () => {
        revoked = true
        unregister()
        const results = await Promise.allSettled([...owned].map(workspace => workspace.dispose()))
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length) throw new AggregateError(failures, 'Remote Sidebar bridge cleanup failed')
        owned.clear()
      }
    }, 'Remote SSH Sidebar workspace provider')
  })
}

/** Loader entry carries configuration defaults together with the bridge implementation. */
export default { name, Config, apply }
