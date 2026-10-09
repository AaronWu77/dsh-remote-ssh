import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import RemoteSshFileSystem from './fs.ts'
import RemoteSshRuntime, { fileUriFromPosixPath, posixPathFromFileUri, WorkspacePathMapper } from './index.ts'
import RemoteSshShellExecutor from './shell.ts'
import { DSH_AHP_PROTOCOL_VERSIONS, validateProtocolVersions } from './ahp-compat.ts'

/** One SSH destination visible in Settings and workspace selection. */
export interface RemoteSshServer {
  id: string
  label: string
  sshTarget: string
  sshArgs?: string[]
  remoteCodeCommand?: string
  sshExecutable?: string
}

/** Durable projection from one local alias directory to one remote directory. */
export interface RemoteSshWorkspace {
  id: string
  serverId: string
  remotePath: string
  aliasPath?: string
  title?: string
}

/** Host-side policy for file links produced inside a remote Session. */
export type RemoteOpenFileMode = 'auto' | 'vscode' | 'cursor' | 'windsurf' | 'vscodium' | 'custom' | 'download'

/** Multi-host transparent routing configuration. */
export interface Config {
  aliasRoot?: string
  /** Absolute OpenSSH config path. Empty uses the platform user and system defaults. */
  sshConfigFile?: string
  servers?: RemoteSshServer[]
  workspaces?: RemoteSshWorkspace[]
  /** Removed custom alias paths that must remain non-local across restarts. */
  retiredAliases?: string[]
  /** Prefer a VS Code-compatible Remote SSH editor; download is the fallback. */
  openFileMode?: RemoteOpenFileMode
  /** Absolute executable path used when openFileMode is custom. */
  openFileEditorPath?: string
  /** Maximum size of one downloaded fallback snapshot. */
  openFileDownloadMaxBytes?: number
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  /** Bound for one SSH connect attempt, in milliseconds. */
  connectTimeoutMs?: number
  /** SDK-supported protocol subset, in negotiation preference order. */
  protocolVersions?: string[]
}

interface ResolvedConfig {
  aliasRoot: string
  sshConfigFile?: string
  servers: RemoteSshServer[]
  workspaces: RemoteSshWorkspace[]
  retiredAliases: string[]
  openFileMode: RemoteOpenFileMode
  openFileEditorPath?: string
  openFileDownloadMaxBytes: number
  startupTimeoutMs: number
  requestTimeoutMs: number
  shutdownTimeoutMs: number
  connectTimeoutMs: number
  protocolVersions: string[]
}

export interface RemoteWorkspaceRoute {
  kind: 'remote'
  server: RemoteSshServer
  workspace: RemoteSshWorkspace
  aliasPath: string
  mapper: WorkspacePathMapper
}

export interface LocalWorkspaceRoute {
  kind: 'local'
}

export type ExecutionRoute = LocalWorkspaceRoute | RemoteWorkspaceRoute

export interface RemoteWorkspaceContext {
  ctx: Context
  fs: FileSystem
  remote: RemoteSshRuntime
}

interface RemoteHostContext {
  ctx: Context
  remote: RemoteSshRuntime
  key: string
  server: RemoteSshServer
  transport: RemoteSshTransport
}

interface RemoteWorkspaceShellContext {
  ctx: Context
  shell: RemoteSshShellExecutor
  remote: RemoteSshRuntime
}

export interface RemoteSshTransport {
  executable: string
  args: string[]
  multiplexed: boolean
}

export interface RemoteDirectoryEntry {
  name: string
  path: string
}

export interface RemoteDirectoryListing {
  path: string
  home: string
  parent?: string
  entries: RemoteDirectoryEntry[]
}

const SETTINGS_ENTRY_ID = 'remote-ssh-manager'
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const serverSchema: z<RemoteSshServer> = z.object({
  id: z.string().required(),
  label: z.string().required(),
  sshTarget: z.string().required(),
  sshArgs: z.array(z.string()),
  remoteCodeCommand: z.string(),
  sshExecutable: z.string(),
})

const workspaceSchema: z<RemoteSshWorkspace> = z.object({
  id: z.string().required(),
  serverId: z.string().required(),
  remotePath: z.string().required(),
  aliasPath: z.string(),
  title: z.string(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSshManager: RemoteSshManager
  }
}

/**
 * Owns the durable host/workspace catalog and lazy remote workspace contexts.
 * An alias that was once remote remains a remote tombstone after removal, so
 * stale sessions fail closed instead of silently running on the local host.
 */
export class RemoteSshManager extends Service {
  static inject = ['settings']

  static Config = z.object({
    aliasRoot: z.string().default(resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'remote-ssh', 'workspaces')),
    sshConfigFile: z.string(),
    servers: z.array(serverSchema).default([]),
    workspaces: z.array(workspaceSchema).default([]),
    retiredAliases: z.array(z.string()).default([]),
    openFileMode: z.union(['auto', 'vscode', 'cursor', 'windsurf', 'vscodium', 'custom', 'download'] as const).default('auto'),
    openFileEditorPath: z.string(),
    openFileDownloadMaxBytes: z.number().default(64 * 1024 * 1024),
    startupTimeoutMs: z.number().default(600_000),
    requestTimeoutMs: z.number().default(30_000),
    shutdownTimeoutMs: z.number().default(3_000),
    connectTimeoutMs: z.number().default(10_000),
    protocolVersions: z.array(z.string()).default([...DSH_AHP_PROTOCOL_VERSIONS]),
  }).required().volatile()

  private readonly liveConfig: Volatile<Config>
  private current: ResolvedConfig
  private readonly routes = new Map<string, RemoteWorkspaceRoute>()
  private readonly routeByWorkspaceId = new Map<string, RemoteWorkspaceRoute>()
  private readonly remoteAliases = new Set<string>()
  private readonly executions = new Map<string, Set<{ terminate(): void | Promise<void>; done: Promise<unknown> }>>()
  private readonly retiring = new Set<string>()
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly contexts = new Map<string, Promise<RemoteWorkspaceContext>>()
  private readonly shellContexts = new Map<string, Promise<RemoteWorkspaceShellContext>>()
  private readonly hosts = new Map<string, Promise<RemoteHostContext>>()
  private readonly sessionWorlds = new Map<string, {
    owner: object
    workspaceId: string | null
    removedAlias?: string
  }>()
  private workspaceRegistry: WorkspaceRegistry | undefined
  private refreshTail: Promise<void> = Promise.resolve()
  private readonly initialRefresh: Promise<void>

  constructor(ctx: Context, config: Volatile<Config>) {
    super(ctx, 'remoteSshManager')
    this.liveConfig = config
    this.current = config.get() as ResolvedConfig
    this.validate(this.current)
    this.initialRefresh = this.queueRefresh(this.current)

    ctx.inject(['workspaceRegistry'], workspaceCtx => {
      this.workspaceRegistry = workspaceCtx.workspaceRegistry
      void this.registerAllWorkspaces().catch(error => { this.ctx.logger.error(error) })
      workspaceCtx.effect(() => () => {
        if (this.workspaceRegistry === workspaceCtx.workspaceRegistry) this.workspaceRegistry = undefined
      }, 'Remote SSH workspace registry attachment')
    })

    ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'Remote SSH settings presentation')
    const manager = this
    // The event reaches only the owning fiber, and its receiver is a Context
    // (never the fiber), so every delivery belongs to this manager.
    ctx.on('loader/volatile-update', () => {
      void manager.queueRefresh(manager.liveConfig.get() as ResolvedConfig).catch(error => { ctx.logger.error(error) })
    })

    ctx.effect(() => async () => {
      await this.refreshTail
      const contexts = await Promise.allSettled(this.contexts.values())
      await Promise.allSettled(contexts.flatMap(result => result.status === 'fulfilled' ? [result.value.ctx.fiber.dispose()] : []))
      this.contexts.clear()
      const shells = await Promise.allSettled(this.shellContexts.values())
      await Promise.allSettled(shells.flatMap(result => result.status === 'fulfilled' ? [result.value.ctx.fiber.dispose()] : []))
      this.shellContexts.clear()
      const hosts = await Promise.allSettled(this.hosts.values())
      await Promise.allSettled(hosts.flatMap(result => result.status === 'fulfilled' ? [this.disposeHost(result.value)] : []))
      this.hosts.clear()
    }, 'Remote SSH workspace context teardown')
  }

  /** Wait until the composition-layer catalog has published its aliases. */
  protected async [Service.init](): Promise<void> {
    await this.initialRefresh
  }

  /** Current detached catalog snapshot. */
  snapshot(): ResolvedConfig {
    return structuredClone(this.current)
  }

  /** Select one custom OpenSSH config, or restore the platform defaults. */
  async setSshConfigFile(path?: string): Promise<void> {
    await this.updateUserPreferences({ sshConfigFile: path ?? '' })
  }

  /** Update the native remote editor preference and its download fallback limit. */
  async setOpenFileSettings(input: {
    mode: RemoteOpenFileMode
    editorPath?: string
  }): Promise<void> {
    await this.updateUserPreferences({
      openFileMode: input.mode,
      openFileEditorPath: input.editorPath ?? '',
    })
  }

  /** Atomically update user-facing plugin preferences. Empty paths clear overrides. */
  async updateUserPreferences(input: {
    sshConfigFile?: string
    openFileMode?: RemoteOpenFileMode
    openFileEditorPath?: string
  }): Promise<void> {
    return this.mutation(async () => {
      const next = this.snapshot()
      if (input.sshConfigFile !== undefined) {
        if (input.sshConfigFile.trim() === '') delete next.sshConfigFile
        else next.sshConfigFile = input.sshConfigFile.trim()
      }
      if (input.openFileMode !== undefined) next.openFileMode = input.openFileMode
      if (input.openFileEditorPath !== undefined) {
        if (input.openFileEditorPath.trim() === '') delete next.openFileEditorPath
        else next.openFileEditorPath = input.openFileEditorPath.trim()
      }
      this.validate(next)
      await this.replaceSettings(next)
    })
  }

  /** Browse directories through the server's shared AHP filesystem connection. */
  async listRemoteDirectory(server: RemoteSshServer, requestedPath?: string): Promise<RemoteDirectoryListing> {
    const host = await this.hostContext(server)
    const connection = await host.remote.getConnection()
    const home = connection.defaultDirectory === undefined
      ? '/'
      : posixPathFromFileUri(String(connection.defaultDirectory))
    const path = posix.normalize(requestedPath?.trim() || home)
    if (!posix.isAbsolute(path)) throw new Error('remote directory path must be an absolute POSIX path')
    const listed = await connection.client.resourceList({ uri: fileUriFromPosixPath(path) })
    return {
      path,
      home,
      ...(path === '/' ? {} : { parent: posix.dirname(path) }),
      entries: listed.entries
        .filter(entry => entry.type === 'directory')
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(entry => ({ name: entry.name, path: posix.join(path, entry.name) })),
    }
  }

  /** Create a server entry through the settings provider. */
  async addServer(input: Omit<RemoteSshServer, 'id'> & { id?: string }): Promise<RemoteSshServer> {
    const server: RemoteSshServer = { ...input, id: input.id ?? randomUUID() }
    return this.mutation(async () => {
      const next = this.snapshot()
      next.servers.push(server)
      this.validate(next)
      await this.replaceSettings(next)
      return server
    })
  }

  /** Create and register one remote workspace alias. */
  async addWorkspace(serverId: string, remotePath: string): Promise<RemoteWorkspaceRoute> {
    return this.mutation(async () => {
      const normalized = posix.normalize(remotePath).replace(/[/]+$/, '') || '/'
      const next = this.snapshot()
      const existing = next.workspaces.find(workspace => workspace.serverId === serverId && (posix.normalize(workspace.remotePath).replace(/[/]+$/, '') || '/') === normalized)
      if (existing) return this.workspace(existing.id)
      const workspace: RemoteSshWorkspace = { id: randomUUID(), serverId, remotePath: normalized }
      next.workspaces.push(workspace)
      this.validate(next)
      await this.replaceSettings(next)
      return this.workspace(workspace.id)
    })
  }

  /** Rename one remote workspace without changing its execution route. */
  async renameWorkspace(id: string, title: string): Promise<RemoteWorkspaceRoute> {
    const normalizedTitle = title.trim()
    if (normalizedTitle.length === 0) throw new Error('remote workspace title must not be empty')
    return this.mutation(async () => {
      const next = this.snapshot()
      const workspace = next.workspaces.find(candidate => candidate.id === id)
      if (workspace === undefined) throw new Error(`dsh-remote-ssh: unknown remote workspace '${id}'`)
      workspace.title = normalizedTitle
      this.validate(next)
      await this.replaceSettings(next)
      return this.workspace(id)
    })
  }

  /** Remove execution routing while retaining alias, Workspace, and Session history. */
  async removeWorkspace(id: string): Promise<boolean> {
    return this.mutation(() => this.removeMapping(id))
  }

  /** Delete a sidebar registration together with its execution mapping, retaining files and Session logs.
   * @param path Registered canonical directory, absent when the workspace is already unknown.
   * @param remove Core registration deletion; a rejection restores the mapping or reports rollback failure.
   * @returns Whether the registration existed and was deleted.
   */
  removeRegisteredWorkspace(path: string | undefined, remove: () => Promise<boolean>): Promise<boolean> {
    return this.mutation(async () => {
      const route = path === undefined ? undefined : this.findAlias(path)
      if (!route) return remove()
      await this.removeMapping(route.workspace.id)
      try { return await remove() } catch (error) {
        const next = this.snapshot()
        next.workspaces.push(route.workspace)
        // removeMapping tombstoned both the configured and the canonical alias
        // spelling; the rollback must clear both or the restored directory keeps
        // failing closed as a removed remote alias.
        const canonical = normalizeLocal(route.aliasPath)
        const configured = normalizeLocal(resolve(route.workspace.aliasPath ?? resolve(next.aliasRoot, route.workspace.id)))
        next.retiredAliases = next.retiredAliases.filter(alias => {
          const normalized = normalizeLocal(resolve(alias))
          return normalized !== canonical && normalized !== configured
        })
        try { await this.replaceSettings(next) } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Workspace deletion failed and its disabled mapping could not be restored')
        }
        throw error
      }
    })
  }

  private async removeMapping(id: string): Promise<boolean> {
    const next = this.snapshot()
    const removed = next.workspaces.find(workspace => workspace.id === id)
    if (!removed) return false
    const alias = resolve(removed.aliasPath ?? resolve(next.aliasRoot, removed.id))
    const canonicalAlias = this.routeByWorkspaceId.get(id)?.aliasPath ?? alias
    next.retiredAliases = [...new Set([...next.retiredAliases, alias, canonicalAlias])]
    next.workspaces = next.workspaces.filter(workspace => workspace.id !== id)
    await this.replaceSettings(next)
    return true
  }

  /** Own a process or pending terminal allocation until it settles; removal cancels and drains it.
   * @param route Current mapped workspace; retirement rejects new ownership.
   * @param execution Cancellable owned activity with an authoritative settlement promise.
   * @returns The release callback, invoked only after settlement.
   */
  ownExecution(route: RemoteWorkspaceRoute, execution: { terminate(): void | Promise<void>; done: Promise<unknown> }): () => void {
    if (this.retiring.has(route.workspace.id) || !this.routeByWorkspaceId.has(route.workspace.id)) {
      void Promise.resolve(execution.terminate()).catch(error => this.ctx.logger.warn(String(error)))
      throw new Error('Remote workspace is being removed')
    }
    let owned = this.executions.get(route.workspace.id)
    if (!owned) { owned = new Set(); this.executions.set(route.workspace.id, owned) }
    owned.add(execution)
    return () => { owned.delete(execution); if (owned.size === 0) this.executions.delete(route.workspace.id) }
  }

  private mutation<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.mutationTail.then(run)
    this.mutationTail = pending.then(() => {}, () => {})
    return pending
  }

  /** Remove one server and tombstone all of its workspace execution routes. */
  async removeServer(id: string): Promise<boolean> {
    return this.mutation(async () => {
      const next = this.snapshot()
      const before = next.servers.length
      next.servers = next.servers.filter(server => server.id !== id)
      if (next.servers.length === before) return false
      next.retiredAliases = [...new Set([...next.retiredAliases, ...next.workspaces.filter(workspace => workspace.serverId === id).flatMap(workspace => [resolve(workspace.aliasPath ?? resolve(next.aliasRoot, workspace.id)), this.routeByWorkspaceId.get(workspace.id)?.aliasPath ?? resolve(workspace.aliasPath ?? resolve(next.aliasRoot, workspace.id))])])]
      next.workspaces = next.workspaces.filter(workspace => workspace.serverId !== id)
      await this.replaceSettings(next)
      return true
    })
  }

  /** Pre-register a local directory with the stable LOCAL display prefix. */
  async adoptLocalWorkspace(path: string): Promise<string> {
    const registry = this.workspaceRegistry
    if (registry === undefined) throw new Error('dsh-remote-ssh: workspace registry is unavailable')
    const absolute = resolve(path)
    const title = `LOCAL > ${basename(absolute)}`
    const workspace = await registry.create(absolute, title)
    if (workspace.title !== title) await workspace.setTitle(title)
    return workspace.path
  }

  /** Resolve a tool path/cwd into the only execution world allowed to handle it. */
  route(path?: string, cwd?: string): ExecutionRoute {
    const cwdRoute = cwd === undefined ? undefined : this.findAlias(cwd)
    if (cwdRoute !== undefined) return this.workspace(cwdRoute.workspace.id)
    if (cwd !== undefined && this.wasRemoteAlias(cwd)) {
      throw new Error(`dsh-remote-ssh: workspace alias is no longer configured: ${cwd}`)
    }
    if (path !== undefined && isAbsolute(path)) {
      const pathRoute = this.findAlias(path)
      if (pathRoute !== undefined) return this.workspace(pathRoute.workspace.id)
      if (this.wasRemoteAlias(path)) {
        throw new Error(`dsh-remote-ssh: workspace alias is no longer configured: ${path}`)
      }
    }
    const remotePathRoute = cwd === undefined ? undefined : this.findRemotePath(cwd)
    if (remotePathRoute !== undefined) return this.workspace(remotePathRoute.workspace.id)
    const absoluteRemotePathRoute = path === undefined ? undefined : this.findRemotePath(path)
    if (absoluteRemotePathRoute !== undefined) return this.workspace(absoluteRemotePathRoute.workspace.id)
    return { kind: 'local' }
  }

  /** Pin shell dispatch to the session workspace, regardless of an explicit tool workdir. */
  bindSession(sessionId: string, owner: object, cwd?: string): ExecutionRoute | undefined {
    if (cwd !== undefined && this.wasRemoteAlias(cwd)) {
      const route = this.findAlias(cwd)
      if (route !== undefined) {
        this.sessionWorlds.set(sessionId, { owner, workspaceId: route.workspace.id })
        return route
      }
      this.sessionWorlds.set(sessionId, { owner, workspaceId: null, removedAlias: cwd })
      return undefined
    }
    const route = cwd === undefined ? { kind: 'local' as const } : this.route(undefined, cwd)
    this.sessionWorlds.set(sessionId, {
      owner,
      workspaceId: route.kind === 'remote' ? route.workspace.id : null,
    })
    return route
  }

  /** Release only the binding owned by this exact live Agent. */
  unbindSession(sessionId: string, owner: object): void {
    if (this.sessionWorlds.get(sessionId)?.owner === owner) this.sessionWorlds.delete(sessionId)
  }

  /** Resolve the execution world bound to a live session without consulting path text. */
  sessionRoute(sessionId: string): ExecutionRoute | undefined {
    const bound = this.sessionWorlds.get(sessionId)
    if (bound === undefined) return undefined
    if (bound.removedAlias !== undefined) {
      throw new Error(`dsh-remote-ssh: workspace alias is no longer configured: ${bound.removedAlias}`)
    }
    return bound.workspaceId === null ? { kind: 'local' } : this.workspace(bound.workspaceId)
  }

  /** Resolve shell calls using their durable session world before considering workdir text. */
  routeShell(workdir: string, sessionId?: string): ExecutionRoute {
    const bound = sessionId === undefined ? undefined : this.sessionRoute(sessionId)
    if (bound !== undefined) return bound
    return this.route(undefined, workdir)
  }

  /** Model-facing shell dialect for a workspace cwd. Remote workspaces are POSIX today. */
  dialectFor(cwd?: string): 'bash' | 'pwsh' {
    if (cwd !== undefined && (this.findAlias(cwd) !== undefined || this.wasRemoteAlias(cwd) || this.findRemotePath(cwd) !== undefined)) {
      return 'bash'
    }
    return process.platform === 'win32' ? 'pwsh' : 'bash'
  }

  /** Presentation-only logical cwd that never exposes the local UUID alias. */
  displayRemoteCwd(route: RemoteWorkspaceRoute, workdir?: string): string {
    const remotePath = workdir === undefined || workdir.trim() === ''
      ? route.workspace.remotePath
      : route.mapper.toRemotePath(workdir, route.aliasPath)
    const normalized = posix.normalize(remotePath)
    const workspaceRoot = posix.normalize(route.workspace.remotePath)
    const relativePath = posix.relative(workspaceRoot, normalized)
    const workspaceTitle = route.workspace.title
      ?? `${route.server.label} > ${posix.basename(workspaceRoot) || workspaceRoot}`
    if (relativePath === '' || (relativePath !== '..' && !relativePath.startsWith('../') && !posix.isAbsolute(relativePath))) {
      return posix.join('/', workspaceTitle, relativePath)
    }
    return posix.join('/', `${route.server.label} > remote`, normalized)
  }

  /** Lookup a published route by its durable workspace id. */
  workspace(id: string): RemoteWorkspaceRoute {
    const route = this.routeByWorkspaceId.get(id)
    if (route === undefined || this.retiring.has(id)) throw new Error(`dsh-remote-ssh: unknown or removed remote workspace '${id}'`)
    return route
  }

  /** Lazily boot the AHP filesystem context for one remote workspace. */
  async workspaceContext(route: RemoteWorkspaceRoute): Promise<RemoteWorkspaceContext> {
    this.workspace(route.workspace.id)
    let pending = this.contexts.get(route.workspace.id)
    if (pending === undefined) {
      pending = this.createWorkspaceContext(route)
      this.contexts.set(route.workspace.id, pending)
      void pending.catch(() => {
        if (this.contexts.get(route.workspace.id) === pending) this.contexts.delete(route.workspace.id)
      })
    }
    return pending
  }

  /** Resolve the SSH executable/options shared by all channels for this host. */
  sshTransport(route: RemoteWorkspaceRoute): RemoteSshTransport {
    return this.transportFor(route.server)
  }

  /** AHP-backed shell view sharing the host runtime but retaining workspace path mapping. */
  async workspaceShell(route: RemoteWorkspaceRoute, dialect: 'bash' | 'pwsh'): Promise<RemoteSshShellExecutor> {
    this.workspace(route.workspace.id)
    const key = `${route.workspace.id}:${dialect}`
    let pending = this.shellContexts.get(key)
    if (pending === undefined) {
      pending = this.createWorkspaceShellContext(route, dialect)
      this.shellContexts.set(key, pending)
      void pending.catch(() => {
        if (this.shellContexts.get(key) === pending) this.shellContexts.delete(key)
      })
    }
    return (await pending).shell
  }

  private queueRefresh(config: ResolvedConfig): Promise<void> {
    const run = this.refreshTail.then(() => this.publish(config))
    this.refreshTail = run.then(() => {}, () => {})
    return run
  }

  private async publish(config: ResolvedConfig): Promise<void> {
    this.validate(config)
    const policyChanged = connectionPolicyKey(this.current) !== connectionPolicyKey(config)
    await mkdir(resolve(tmpdir(), 'dsh-ssh'), { recursive: true })
    for (const alias of config.retiredAliases) this.remoteAliases.add(normalizeLocal(resolve(alias)))
    const servers = new Map(config.servers.map(server => [server.id, server]))
    const nextRoutes = new Map<string, RemoteWorkspaceRoute>()
    const nextById = new Map<string, RemoteWorkspaceRoute>()
    for (const workspace of config.workspaces) {
      const server = servers.get(workspace.serverId) as RemoteSshServer
      const aliasPath = resolve(workspace.aliasPath ?? resolve(config.aliasRoot, workspace.id))
      await mkdir(aliasPath, { recursive: true })
      const canonicalAlias = await realpath(aliasPath)
      if (nextRoutes.has(normalizeLocal(canonicalAlias))) throw new Error(`dsh-remote-ssh: workspace aliases resolve to the same directory: ${canonicalAlias}`)
      const route: RemoteWorkspaceRoute = {
        kind: 'remote', server, workspace, aliasPath: canonicalAlias,
        mapper: new WorkspacePathMapper(canonicalAlias, workspace.remotePath),
      }
      nextRoutes.set(normalizeLocal(canonicalAlias), route)
      nextById.set(workspace.id, route)
      this.remoteAliases.add(normalizeLocal(aliasPath))
      this.remoteAliases.add(normalizeLocal(canonicalAlias))
    }
    const removedIds = [...this.routeByWorkspaceId.keys()].filter(id => !nextById.has(id) || routeRuntimeKey(this.routeByWorkspaceId.get(id)!) !== routeRuntimeKey(nextById.get(id)!))
    for (const id of removedIds) this.retiring.add(id)
    for (const id of removedIds) {
      const owned = [...this.executions.get(id) ?? []]
      await Promise.all(owned.map(execution => execution.terminate()))
      await Promise.all(owned.map(execution => execution.done))
      this.executions.delete(id)
    }
    for (const [id, pending] of this.contexts) {
      const previous = this.routeByWorkspaceId.get(id)
      const next = nextById.get(id)
      if (policyChanged || previous === undefined || next === undefined || routeRuntimeKey(previous) !== routeRuntimeKey(next)) {
        const settled = await Promise.resolve(pending).catch(() => undefined)
        if (settled !== undefined) await settled.ctx.fiber.dispose()
        this.contexts.delete(id)
      }
    }
    for (const [key, pending] of this.shellContexts) {
      const id = key.slice(0, key.lastIndexOf(':'))
      const previous = this.routeByWorkspaceId.get(id)
      const next = nextById.get(id)
      if (policyChanged || previous === undefined || next === undefined || routeRuntimeKey(previous) !== routeRuntimeKey(next)) {
        const settled = await Promise.resolve(pending).catch(() => undefined)
        if (settled !== undefined) await settled.ctx.fiber.dispose()
        this.shellContexts.delete(key)
      }
    }
    for (const [id, pending] of this.hosts) {
      const next = servers.get(id)
      const settled = await Promise.resolve(pending).catch(() => undefined)
      if (policyChanged || next === undefined || settled === undefined || settled.key !== serverRuntimeKey(next)) {
        if (settled !== undefined) await this.disposeHost(settled)
        this.hosts.delete(id)
      }
    }
    this.routes.clear()
    this.routeByWorkspaceId.clear()
    for (const [key, value] of nextRoutes) this.routes.set(key, value)
    for (const [key, value] of nextById) this.routeByWorkspaceId.set(key, value)
    this.current = structuredClone(config)
    for (const id of removedIds) this.retiring.delete(id)
    await this.registerAllWorkspaces()
  }

  private async registerAllWorkspaces(): Promise<void> {
    const registry = this.workspaceRegistry
    if (registry === undefined) return
    for (const route of this.routeByWorkspaceId.values()) {
      const title = route.workspace.title
        ?? `${route.server.label} > ${posix.basename(route.workspace.remotePath) || route.workspace.remotePath}`
      const workspace = await registry.create(route.aliasPath, title)
      if (workspace.title !== title) await workspace.setTitle(title)
    }
  }

  private findAlias(path: string): RemoteWorkspaceRoute | undefined {
    const absolute = normalizeLocal(resolve(path))
    let best: RemoteWorkspaceRoute | undefined
    for (const [alias, route] of this.routes) {
      if (!isContained(alias, absolute)) continue
      if (best === undefined || alias.length > normalizeLocal(best.aliasPath).length) best = route
    }
    return best
  }

  private findRemotePath(path: string): RemoteWorkspaceRoute | undefined {
    if (!posix.isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')) return undefined
    const normalized = posix.normalize(path)
    let best: RemoteWorkspaceRoute | undefined
    let bestLength = -1
    let ambiguous = false
    for (const route of this.routeByWorkspaceId.values()) {
      const root = posix.normalize(route.workspace.remotePath).replace(/[/]+$/, '') || '/'
      const rel = posix.relative(root, normalized)
      if (rel !== '' && (rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel))) continue
      if (root.length > bestLength) {
        best = route
        bestLength = root.length
        ambiguous = false
      } else if (root.length === bestLength && best?.workspace.id !== route.workspace.id) {
        if (best?.server.id !== route.server.id) ambiguous = true
        // Existing duplicate aliases share one execution world; keep the first durable route.
      }
    }
    if (ambiguous) throw new Error(`dsh-remote-ssh: remote path matches multiple workspaces: ${path}`)
    return best
  }

  private wasRemoteAlias(path: string): boolean {
    const absolute = normalizeLocal(resolve(path))
    return isContained(normalizeLocal(resolve(this.current.aliasRoot)), absolute) || [...this.remoteAliases].some(alias => isContained(alias, absolute))
  }

  private async createWorkspaceContext(route: RemoteWorkspaceRoute): Promise<RemoteWorkspaceContext> {
    const host = await this.hostContext(route.server)
    const child = new Context()
    try {
      child.provide('remoteSsh', host.remote)
      await child.plugin(RemoteSshFileSystem, {
        remoteWorkspace: route.workspace.remotePath,
        localWorkspace: route.aliasPath,
      })
      return { ctx: child, fs: child.fs, remote: host.remote }
    } catch (error) {
      await child.fiber.dispose().catch(() => {})
      throw error
    }
  }

  private async hostContext(server: RemoteSshServer): Promise<RemoteHostContext> {
    let pending = this.hosts.get(server.id)
    if (pending === undefined) {
      pending = this.createHostContext(server)
      this.hosts.set(server.id, pending)
      void pending.catch(() => {
        if (this.hosts.get(server.id) === pending) this.hosts.delete(server.id)
      })
    }
    return pending
  }

  private async createWorkspaceShellContext(route: RemoteWorkspaceRoute, dialect: 'bash' | 'pwsh'): Promise<RemoteWorkspaceShellContext> {
    const host = await this.hostContext(route.server)
    const child = new Context()
    try {
      child.provide('remoteSsh', host.remote)
      await child.plugin(RemoteSshShellExecutor, {
        localWorkspace: route.aliasPath,
        remoteWorkspace: route.workspace.remotePath,
        shellCommand: dialect,
      })
      return { ctx: child, shell: child.shell as RemoteSshShellExecutor, remote: host.remote }
    } catch (error) {
      await child.fiber.dispose().catch(() => {})
      throw error
    }
  }

  private async createHostContext(server: RemoteSshServer): Promise<RemoteHostContext> {
    const child = new Context()
    const policy = this.current
    const transport = this.transportFor(server)
    try {
      await child.plugin(RemoteSshRuntime, {
        sshTarget: server.sshTarget,
        sshExecutable: transport.executable,
        sshArgs: transport.args,
        remoteCodeCommand: server.remoteCodeCommand ?? 'code',
        remoteAccessRoot: '/',
        startupTimeoutMs: policy.startupTimeoutMs,
        requestTimeoutMs: policy.requestTimeoutMs,
        shutdownTimeoutMs: policy.shutdownTimeoutMs,
        protocolVersions: policy.protocolVersions,
      })
      return { ctx: child, remote: child.remoteSsh, key: serverRuntimeKey(server), server, transport }
    } catch (error) {
      await child.fiber.dispose().catch(() => {})
      throw error
    }
  }

  private transportFor(server: RemoteSshServer): RemoteSshTransport {
    const executable = server.sshExecutable ?? 'ssh'
    // Neither Windows OpenSSH nor Git-for-Windows honours ControlMaster; both
    // accepted the syntax in local probes and then reset every session.
    const multiplexed = process.platform !== 'win32'
    const args = [
      // No interactive prompt is possible on any of these channels, so a failed
      // authentication must fail fast instead of waiting for input that never comes.
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${Math.ceil(this.current.connectTimeoutMs / 1000)}`,
      ...(server.sshArgs ?? []),
    ]
    if (multiplexed) {
      // Include the local process id: a crashed/closed DSH instance may leave a
      // short-lived ControlPersist socket, and a new instance must never bind
      // to that stale master. All workspaces in this process still share it.
      const digest = createHash('sha256').update(`${process.pid}:${serverRuntimeKey(server)}`).digest('hex').slice(0, 16)
      const controlPath = resolve(tmpdir(), 'dsh-ssh', digest).replaceAll('\\', '/')
      args.push('-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${controlPath}`)
    }
    return { executable, args, multiplexed }
  }

  private async disposeHost(host: RemoteHostContext): Promise<void> {
    await host.ctx.fiber.dispose()
    if (!host.transport.multiplexed) return
    await closeControlMaster(host.transport, host.server.sshTarget)
  }

  private async replaceSettings(next: ResolvedConfig): Promise<void> {
    const descriptor = this.ctx.settings.describe().find(row => row.ns === SETTINGS_ENTRY_ID)
    if (descriptor === undefined) throw new Error('dsh-remote-ssh: remote-ssh-manager profile settings are unavailable')
    await this.ctx.settings.replace(descriptor.ns, next, descriptor.revision)
    await this.queueRefresh(this.liveConfig.get() as ResolvedConfig)
  }

  private validate(config: ResolvedConfig): void {
    if (!isAbsolute(config.aliasRoot)) throw new Error('dsh-remote-ssh: aliasRoot must be an absolute local path')
    if (config.retiredAliases.some(alias => !isAbsolute(alias))) throw new Error('retiredAliases must contain absolute local paths')
    if (config.sshConfigFile !== undefined && !isAbsolute(config.sshConfigFile)) throw new Error('dsh-remote-ssh: sshConfigFile must be an absolute path')
    if (config.openFileEditorPath !== undefined && !isAbsolute(config.openFileEditorPath)) throw new Error('dsh-remote-ssh: openFileEditorPath must be an absolute path')
    if (config.openFileMode === 'custom' && config.openFileEditorPath === undefined) throw new Error('dsh-remote-ssh: custom openFileMode requires openFileEditorPath')
    if (!Number.isSafeInteger(config.openFileDownloadMaxBytes) || config.openFileDownloadMaxBytes <= 0) throw new Error('dsh-remote-ssh: openFileDownloadMaxBytes must be a positive integer')
    if (!Number.isSafeInteger(config.startupTimeoutMs) || config.startupTimeoutMs <= 0) throw new Error('dsh-remote-ssh: startupTimeoutMs must be a positive integer')
    if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) throw new Error('dsh-remote-ssh: requestTimeoutMs must be a positive integer')
    if (!Number.isSafeInteger(config.shutdownTimeoutMs) || config.shutdownTimeoutMs <= 0) throw new Error('dsh-remote-ssh: shutdownTimeoutMs must be a positive integer')
    if (!Number.isSafeInteger(config.connectTimeoutMs) || config.connectTimeoutMs <= 0) throw new Error('dsh-remote-ssh: connectTimeoutMs must be a positive integer')
    validateProtocolVersions(config.protocolVersions)
    const serverIds = new Set<string>()
    for (const server of config.servers) {
      if (!ID_PATTERN.test(server.id) || serverIds.has(server.id)) throw new Error(`dsh-remote-ssh: invalid or duplicate server id '${server.id}'`)
      if (server.label.trim().length === 0 || server.sshTarget.trim().length === 0) throw new Error(`dsh-remote-ssh: server '${server.id}' requires label and sshTarget`)
      if (server.sshExecutable !== undefined && server.sshExecutable.trim().length === 0) throw new Error(`dsh-remote-ssh: server '${server.id}' sshExecutable must be non-empty`)
      serverIds.add(server.id)
    }
    const workspaceIds = new Set<string>()
    const aliases = new Set<string>()
    for (const workspace of config.workspaces) {
      if (!ID_PATTERN.test(workspace.id) || workspaceIds.has(workspace.id)) throw new Error(`dsh-remote-ssh: invalid or duplicate workspace id '${workspace.id}'`)
      if (!serverIds.has(workspace.serverId)) throw new Error(`dsh-remote-ssh: workspace '${workspace.id}' refers to unknown server '${workspace.serverId}'`)
      if (!posix.isAbsolute(workspace.remotePath)) throw new Error(`dsh-remote-ssh: workspace '${workspace.id}' remotePath must be an absolute POSIX path`)
      // A root mapping would claim every POSIX-absolute path on a POSIX host.
      if (posix.normalize(workspace.remotePath) === '/') throw new Error(`dsh-remote-ssh: workspace '${workspace.id}' must not map the remote root; register a subdirectory instead`)
      if (workspace.title !== undefined && workspace.title.trim().length === 0) throw new Error(`dsh-remote-ssh: workspace '${workspace.id}' title must be non-empty`)
      const alias = normalizeLocal(resolve(workspace.aliasPath ?? resolve(config.aliasRoot, workspace.id)))
      if (aliases.has(alias)) throw new Error(`dsh-remote-ssh: duplicate workspace alias '${alias}'`)
      aliases.add(alias)
      workspaceIds.add(workspace.id)
    }
  }
}

function connectionPolicyKey(config: ResolvedConfig): string {
  return JSON.stringify([config.protocolVersions, config.startupTimeoutMs, config.requestTimeoutMs, config.shutdownTimeoutMs, config.connectTimeoutMs])
}

function serverRuntimeKey(server: RemoteSshServer): string {
  return JSON.stringify([server.sshTarget, server.sshArgs ?? [], server.remoteCodeCommand ?? 'code', server.sshExecutable ?? null])
}

function routeRuntimeKey(route: RemoteWorkspaceRoute): string {
  return JSON.stringify([serverRuntimeKey(route.server), route.workspace.remotePath, normalizeLocal(route.aliasPath)])
}

async function closeControlMaster(transport: RemoteSshTransport, target: string): Promise<void> {
  await new Promise<void>(resolvePromise => {
    const child = spawn(transport.executable, [...transport.args, '-O', 'exit', target], {
      windowsHide: true,
      stdio: 'ignore',
    })
    const timer = setTimeout(() => { child.kill(); resolvePromise() }, 3_000)
    child.once('error', () => { clearTimeout(timer); resolvePromise() })
    child.once('close', () => { clearTimeout(timer); resolvePromise() })
  })
}

function normalizeLocal(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export default RemoteSshManager
