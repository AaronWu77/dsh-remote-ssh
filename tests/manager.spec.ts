import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import RemoteSshManager from '../src/manager.ts'
import { describe, expect, it } from 'vitest'

class MemorySettings extends Service {
  private owner: Fiber | undefined
  private revision = 0
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure(_presentation: { auto: boolean }, owner: Fiber): () => void {
    this.owner = owner
    return () => { this.owner = undefined }
  }
  describe(): { ns: SettingsNamespace; revision: number }[] {
    return [{ ns: 'remote-ssh-manager' as SettingsNamespace, revision: this.revision }]
  }
  async replace(_namespace: SettingsNamespace, next: Record<string, unknown>, revision: number): Promise<void> {
    if (revision !== this.revision) throw new Error('revision changed')
    if (this.owner === undefined) throw new Error('no settings owner')
    updateVolatile(this.owner.config as Volatile<Record<string, unknown>>, createVolatile(structuredClone(next)))
    this.revision += 1
    this.owner.ctx.emit(this.owner, 'loader/volatile-update', [[]])
  }
}

async function createContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings).await()
  return ctx
}

describe('RemoteSshManager', () => {
  it('reuses an existing server/root for repeated and concurrent workspace picks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, { aliasRoot: root, servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }] })
      const [first, second] = await Promise.all([ctx.remoteSshManager.addWorkspace('devbox', '/srv/project/'), ctx.remoteSshManager.addWorkspace('devbox', '/srv/project')])
      expect(first.workspace.id).toBe(second.workspace.id)
      expect(ctx.remoteSshManager.snapshot().workspaces).toHaveLength(1)
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('drains owned executions, retires sidebar routes and keeps deleted aliases non-local after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    let resumed: Context | undefined
    try {
      const custom = resolve(root, 'custom')
      const aliasRoot = resolve(root, 'aliases')
      await ctx.plugin(RemoteSshManager, { aliasRoot, servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }], workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project', aliasPath: custom }] })
      const manager = ctx.remoteSshManager
      const route = manager.workspace('project')
      let settle: (() => void) | undefined
      const done = new Promise<void>(resolve => { settle = resolve })
      let stopped = false
      manager.ownExecution(route, { done, terminate: () => { stopped = true; settle?.() } })
      let deleted = false
      expect(await manager.removeRegisteredWorkspace(custom, async () => { expect(stopped).toBe(true); deleted = true; return true })).toBe(true)
      expect(deleted).toBe(true)
      expect(manager.snapshot().workspaces).toHaveLength(0)
      expect(await stat(custom)).toBeDefined()
      resumed = await createContext()
      await resumed.plugin(RemoteSshManager, manager.snapshot())
      expect(() => resumed!.remoteSshManager.route(undefined, custom)).toThrow('no longer configured')
      expect(() => resumed!.remoteSshManager.route(undefined, resolve(aliasRoot, 'unknown-old-id'))).toThrow('no longer configured')
      resumed.remoteSshManager.bindSession('stale', {}, custom)
      expect(() => resumed!.remoteSshManager.sessionRoute('stale')).toThrow('no longer configured')
    } finally { await resumed?.fiber.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('refuses sidebar deletion and repeat retirement when owned cleanup is unconfirmed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, { aliasRoot: root, servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }], workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }] })
      const manager = ctx.remoteSshManager
      const route = manager.workspace('project')
      let fail!: (reason: Error) => void
      const done = new Promise<void>((_resolve, reject) => { fail = reject })
      manager.ownExecution(route, { done, terminate: () => { fail(new Error('owned cleanup unconfirmed')) } })
      let deleted = false
      const remove = () => manager.removeRegisteredWorkspace(route.aliasPath, async () => { deleted = true; return true })
      await expect(remove()).rejects.toThrow('owned cleanup unconfirmed')
      expect(deleted).toBe(false)
      expect(() => manager.route(undefined, route.aliasPath)).toThrow('unknown or removed')
      expect((await stat(route.aliasPath)).isDirectory()).toBe(true)
      await expect(remove()).rejects.toThrow('owned cleanup unconfirmed')
      expect(deleted).toBe(false)
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('restores a route when sidebar registration deletion fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, { aliasRoot: root, servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }], workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }] })
      const alias = resolve(root, 'project')
      await expect(ctx.remoteSshManager.removeRegisteredWorkspace(alias, async () => { throw new Error('registry failure') })).rejects.toThrow('registry failure')
      expect(ctx.remoteSshManager.route(undefined, alias)).toMatchObject({ kind: 'remote' })
      expect(ctx.remoteSshManager.snapshot().workspaces).toHaveLength(1)
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('persists remote open preferences atomically with safe defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, { aliasRoot: root })
      const manager = ctx.remoteSshManager
      expect(manager.snapshot()).toMatchObject({
        openFileMode: 'auto',
        openFileDownloadMaxBytes: 64 * 1024 * 1024,
      })

      const editor = resolve(root, 'Editor.exe')
      await manager.updateUserPreferences({
        sshConfigFile: resolve(root, 'ssh-config'),
        openFileMode: 'custom',
        openFileEditorPath: editor,
      })
      expect(manager.snapshot()).toMatchObject({
        sshConfigFile: resolve(root, 'ssh-config'),
        openFileMode: 'custom',
        openFileEditorPath: editor,
      })
      await manager.updateUserPreferences({ openFileMode: 'download', openFileEditorPath: '' })
      expect(manager.snapshot().openFileEditorPath).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('selects a remote execution world from the workspace alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const alias = resolve(root, 'project')
      const route = ctx.remoteSshManager.route('src/index.ts', alias)
      expect(route).toMatchObject({
        kind: 'remote',
        aliasPath: alias,
        server: { id: 'devbox', label: 'Devbox' },
        workspace: { id: 'project', remotePath: '/srv/project' },
      })
      expect(ctx.remoteSshManager.route(resolve(root, '..', 'local'), resolve(root, '..', 'local'))).toEqual({ kind: 'local' })
      const renamed = await ctx.remoteSshManager.renameWorkspace('project', 'Backend')
      expect(renamed.workspace.title).toBe('Backend')
      expect(ctx.remoteSshManager.snapshot().workspaces[0]?.title).toBe('Backend')
      expect(ctx.remoteSshManager.displayRemoteCwd(renamed)).toBe('/Backend')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves legacy aliases, rejects cross-server ties and selects a deeper root after an earlier tie', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, { aliasRoot: root, servers: [{ id: 'a', label: 'A', sshTarget: 'never-a' }, { id: 'b', label: 'B', sshTarget: 'never-b' }], workspaces: [
        { id: 'first', serverId: 'a', remotePath: '/srv/project' },
        { id: 'duplicate', serverId: 'a', remotePath: '/srv/project/' },
        { id: 'tie-a', serverId: 'a', remotePath: '/srv' },
        { id: 'tie-b', serverId: 'b', remotePath: '/srv' },
        { id: 'deeper', serverId: 'b', remotePath: '/srv/deeper' },
      ] })
      const manager = ctx.remoteSshManager
      expect(manager.route('/srv/project/file')).toMatchObject({ workspace: { id: 'first' } })
      expect(manager.route(undefined, manager.workspace('duplicate').aliasPath)).toMatchObject({ workspace: { id: 'duplicate' } })
      expect(manager.route('/srv/deeper/file')).toMatchObject({ workspace: { id: 'deeper' } })
      expect(() => manager.route('/srv/file')).toThrow('matches multiple workspaces')
      expect(manager.snapshot().workspaces).toHaveLength(5)
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('keeps explicit POSIX workdirs in the session-bound remote world', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const manager = ctx.remoteSshManager
      const owner = {}
      manager.bindSession('remote-session', owner, resolve(root, 'project'))

      expect(manager.sessionRoute('remote-session')).toMatchObject({
        kind: 'remote',
        workspace: { id: 'project' },
      })

      expect(manager.routeShell('/srv/project/coffee', 'remote-session')).toMatchObject({
        kind: 'remote',
        workspace: { id: 'project' },
      })
      expect(manager.route(undefined, '/srv/project/coffee')).toMatchObject({
        kind: 'remote',
        workspace: { id: 'project' },
      })

      const otherOwner = {}
      manager.unbindSession('remote-session', otherOwner)
      expect(manager.routeShell('/outside', 'remote-session')).toMatchObject({ kind: 'remote' })
      manager.unbindSession('remote-session', owner)
      expect(manager.sessionRoute('remote-session')).toBeUndefined()
      expect(manager.routeShell('/outside', 'remote-session')).toEqual({ kind: 'local' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not let a remote-looking workdir escape a session-bound local world', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const manager = ctx.remoteSshManager
      manager.bindSession('local-session', {}, resolve(root, '..', 'local'))
      expect(manager.sessionRoute('local-session')).toEqual({ kind: 'local' })
      expect(manager.routeShell('/srv/project', 'local-session')).toEqual({ kind: 'local' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders logical remote cwd labels without exposing the alias directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const manager = ctx.remoteSshManager
      const route = manager.workspace('project')
      expect(manager.displayRemoteCwd(route)).toBe('/Devbox > project')
      expect(manager.displayRemoteCwd(route, '/srv/project/coffee')).toBe('/Devbox > project/coffee')
      expect(manager.displayRemoteCwd(route, '/var/log')).toBe('/Devbox > remote/var/log')
      expect(manager.dialectFor(route.aliasPath)).toBe('bash')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects workspaces that refer to an absent server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await expect(ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [],
        workspaces: [{ id: 'project', serverId: 'missing', remotePath: '/srv/project' }],
      })).rejects.toThrow(/unknown server 'missing'/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tombstones removed aliases so stale sessions stay readable but cannot execute locally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const manager = ctx.remoteSshManager
      const alias = resolve(root, 'project')
      await manager.removeWorkspace('project')

      expect((await stat(alias)).isDirectory()).toBe(true)
      expect(manager.snapshot().workspaces).toEqual([])
      expect(() => manager.workspace('project')).toThrow(/unknown or removed remote workspace/)
      expect(() => manager.route('README.md', alias)).toThrow(/workspace alias is no longer configured/)
      expect(() => manager.route(resolve(alias, 'README.md'))).toThrow(/workspace alias is no longer configured/)
      expect(() => manager.routeShell('/srv/project', 'stale-session')).not.toThrow()

      manager.bindSession('removed-session', {}, alias)
      expect(() => manager.routeShell('/srv/project', 'removed-session')).toThrow(/workspace alias is no longer configured/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('shares one host runtime across multiple workspaces on the same server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [
          { id: 'project-a', serverId: 'devbox', remotePath: '/srv/project-a' },
          { id: 'project-b', serverId: 'devbox', remotePath: '/srv/project-b' },
        ],
      })
      const manager = ctx.remoteSshManager
      const hostCtx = new Context()
      const sharedRemote = { marker: 'shared-host-runtime' }
      let creations = 0
      let disposals = 0
      const fixtureManager = manager as unknown as { createHostContext(server: unknown): Promise<unknown>; refreshTail: Promise<void> }
      fixtureManager.createHostContext = async () => {
        creations += 1
        const ownedCtx = creations === 1 ? hostCtx : new Context()
        ownedCtx.effect(() => () => { disposals += 1 }, 'host policy test teardown')
        return {
          ctx: ownedCtx,
          remote: sharedRemote,
          key: JSON.stringify(['test-devbox', [], 'code', null]),
          server: { id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' },
          transport: { executable: 'ssh', args: [], multiplexed: false },
        }
      }

      const a = await manager.workspaceContext(manager.workspace('project-a'))
      const b = await manager.workspaceContext(manager.workspace('project-b'))

      expect(creations).toBe(1)
      expect(a.remote).toBe(sharedRemote)
      expect(b.remote).toBe(sharedRemote)
      expect(a.fs).not.toBe(b.fs)

      await manager.removeWorkspace('project-a')
      const stillShared = await manager.workspaceContext(manager.workspace('project-b'))
      expect(creations).toBe(1)
      expect(stillShared.remote).toBe(sharedRemote)
      for (const change of [{ protocolVersions: ['0.9.0'] }, { startupTimeoutMs: 12_345 }, { requestTimeoutMs: 23_456 }, { shutdownTimeoutMs: 1_234 }]) {
        const previousCreations = creations
        const descriptor = ctx.settings.describe()[0]!
        await ctx.settings.replace(descriptor.ns, { ...manager.snapshot(), ...change }, descriptor.revision)
        await fixtureManager.refreshTail
        const reconnected = await manager.workspaceContext(manager.workspace('project-b'))
        expect(creations).toBe(previousCreations + 1)
        expect(disposals).toBe(previousCreations)
        expect(reconnected).not.toBe(stillShared)
      }
      expect(() => manager.route(undefined, resolve(root, 'project-a'))).toThrow(/no longer configured/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists only remote directories from the shared AHP host connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [],
      })
      const manager = ctx.remoteSshManager
      const hostCtx = new Context()
      const requestedUris: string[] = []
      const remote = {
        getConnection: async () => ({
          defaultDirectory: 'file:///home/tester',
          client: {
            resourceList: async ({ uri }: { uri: string }) => {
              requestedUris.push(uri)
              return { entries: [{ name: 'projects', type: 'directory' }, { name: 'notes.txt', type: 'file' }, { name: 'archive', type: 'directory' }] }
            },
          },
        }),
      }
      ;(manager as unknown as { createHostContext(server: unknown): Promise<unknown> }).createHostContext = async server => ({
        ctx: hostCtx,
        remote,
        key: JSON.stringify(['test-devbox', [], 'code', null]),
        server,
        transport: { executable: 'ssh', args: [], multiplexed: false },
      })

      const server = manager.snapshot().servers[0]!
      await expect(manager.listRemoteDirectory(server)).resolves.toEqual({
        path: '/home/tester',
        home: '/home/tester',
        parent: '/home',
        entries: [
          { name: 'archive', path: '/home/tester/archive' },
          { name: 'projects', path: '/home/tester/projects' },
        ],
      })
      expect(requestedUris).toEqual(['file:///home/tester'])
      await expect(manager.listRemoteDirectory(server, 'relative/path')).rejects.toThrow(/absolute POSIX path/)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('bounds every SSH transport with a non-interactive connect window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: root,
        connectTimeoutMs: 15_000,
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
      })
      const transport = ctx.remoteSshManager.sshTransport(ctx.remoteSshManager.workspace('project'))
      expect(transport.args).toContain('BatchMode=yes')
      expect(transport.args).toContain('ConnectTimeout=15')
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('refuses a workspace that would claim every POSIX-absolute path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      await ctx.plugin(RemoteSshManager, { aliasRoot: root, servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }] })
      await expect(ctx.remoteSshManager.addWorkspace('devbox', '/')).rejects.toThrow('must not map the remote root')
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('clears both alias spellings when a registration deletion rolls back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-manager-'))
    const ctx = await createContext()
    try {
      const target = join(root, 'target')
      const link = join(root, 'link')
      await mkdir(target, { recursive: true })
      await symlink(target, link, 'junction')
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: join(root, 'aliases'),
        servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'test-devbox' }],
        workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project', aliasPath: link }],
      })
      const manager = ctx.remoteSshManager
      const canonical = manager.workspace('project').aliasPath
      await expect(manager.removeRegisteredWorkspace(canonical, () => Promise.reject(new Error('registration delete failed'))))
        .rejects.toThrow('registration delete failed')
      const restored = manager.snapshot()
      expect(restored.workspaces.map(workspace => workspace.id)).toEqual(['project'])
      expect(restored.retiredAliases).toEqual([])
      expect(() => manager.workspace('project')).not.toThrow()
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })
})
