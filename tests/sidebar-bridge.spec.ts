/** Bridge consumers use injected services; the Sidebar public leaf is type-only. */
import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SidebarWorkspaceProviders, SidebarWorkspaceRouter } from 'dsh-better-sidebar/workspace-provider'
import { WorkspacePathMapper } from '../src/index.ts'
import bridge, { apply, Config } from '../src/sidebar-bridge.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(dispose => dispose()))
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, 'bridge fixture teardown')
})

function providersFixture(onUnregister: () => void) {
  let router: SidebarWorkspaceRouter | undefined
  const providers: Pick<SidebarWorkspaceProviders, 'registerRouter' | 'workspaceError' | 'gitCommandError' | 'resolve'> = {
    registerRouter(contribution) {
      if (router) throw new Error('duplicate router')
      router = contribution
      return () => { if (router === contribution) { router = undefined; onUnregister() } }
    },
    workspaceError: (code, message, status) => Object.assign(new Error(message), { code, status }),
    gitCommandError: (message, command, exitCode) => Object.assign(new Error(message), { code: 'git-error', command, exitCode }),
    resolve(scope) {
      if (router) return router(scope)
      return Promise.reject(providers.workspaceError('workspace-unavailable', 'missing contribution', 503))
    },
  }
  return providers
}

function fixture() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const removal = Promise.withResolvers<void>()
  const providers = providersFixture(() => { removal.resolve() })
  const aliasPath = resolve('tests', 'bridge-alias')
  const selected = { kind: 'remote' as const,
    server: { id: 'server', label: 'Server', sshTarget: 'no-ssh' },
    workspace: { id: 'workspace', serverId: 'server', remotePath: '/srv/project' },
    aliasPath, mapper: new WorkspacePathMapper(aliasPath, '/srv/project') }
  const manager = {
    route: vi.fn((_path?: string, cwd?: string) => cwd === aliasPath || cwd === aliasPath + '/sub' ? selected : { kind: 'local' as const }),
    workspace: vi.fn((id: string) => { if (id !== selected.workspace.id) throw new Error('missing'); return selected }),
    ownExecution: vi.fn(() => () => {}),
    workspaceContext: vi.fn(async () => { throw new Error('not reached') }),
    workspaceShell: vi.fn(async () => { throw new Error('not reached') }),
  }
  const scope = (cwd = aliasPath) => ({ sessionId: 'fixture-session' as never, cwd })
  const mount = () => ctx.plugin(bridge, {})
  return { ctx, providers, manager, selected, scope, mount, unregistered: removal.promise }
}

describe('Remote SSH Sidebar bridge', () => {
  it('registers an authoritative remote provider and removes it with the owning fiber', async () => {
    const f = fixture()
    f.ctx.provide('remoteSshManager', f.manager as never)
    f.ctx.provide('sidebarWorkspaceProviders', f.providers as never)
    const plugin = f.mount()
    await plugin.await()
    const workspace = await f.providers.resolve(f.scope())
    expect(workspace.kind).toBe('remote')
    expect(workspace.cwd).toBe('/srv/project')
    expect(f.manager.route).toHaveBeenCalledWith(undefined, f.scope().cwd)
    expect(f.manager.workspaceContext).not.toHaveBeenCalled()
    expect(await f.providers.resolve(f.scope())).toBe(workspace)
    expect(await f.providers.resolve(f.scope(f.scope().cwd + '/sub'))).not.toBe(workspace)
    await plugin.dispose()
    await expect(f.providers.resolve(f.scope())).rejects.toMatchObject({ status: 503 })
  })
  it('unregisters and revokes retained adapters before waiting for pending context allocation', async () => {
    const f = fixture()
    f.ctx.provide('remoteSshManager', f.manager as never)
    f.ctx.provide('sidebarWorkspaceProviders', f.providers as never)
    const plugin = f.mount(); await plugin.await()
    const workspace = await f.providers.resolve(f.scope())
    if (workspace.kind !== 'remote') throw new Error('Expected remote capability')
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
    f.manager.workspaceContext.mockImplementation(async () => { entered.resolve(); await release.promise; throw new Error('allocation released') })
    const reading = workspace.fs.read('/srv/project/file', 10, true)
    const failed = expect(reading).rejects.toMatchObject({ status: 503 })
    let disposal: Promise<void> | undefined
    cleanups.push(async () => { release.resolve(); await Promise.allSettled([reading, ...(disposal ? [disposal] : [])]) })
    await entered.promise
    let disposed = false
    disposal = plugin.dispose().then(() => { disposed = true })
    await f.unregistered
    await expect(f.providers.resolve(f.scope())).rejects.toMatchObject({ status: 503 })
    await expect(workspace.fs.write('/srv/project/file', 'late', true)).rejects.toMatchObject({ status: 503 })
    await expect(workspace.git.run(workspace.cwd, ['status'], 1000)).rejects.toMatchObject({ status: 503 })
    expect(disposed).toBe(false)
    release.resolve(); await Promise.all([failed, disposal])
    expect(f.manager.workspace(f.selected.workspace.id)).toBe(f.selected)
  })

  it('returns local only when the manager positively selects local', async () => {
    const f = fixture()
    f.ctx.provide('remoteSshManager', f.manager as never)
    f.ctx.provide('sidebarWorkspaceProviders', f.providers as never)
    await f.mount().await()
    expect(await f.providers.resolve(f.scope('C:/positive-local'))).toEqual({ kind: 'local', cwd: 'C:/positive-local' })
  })
  it('remains dormant until both services are published and unregisters on service removal', async () => {
    const f = fixture()
    const plugin = f.mount()
    await plugin.await()
    await expect(f.providers.resolve(f.scope())).rejects.toMatchObject({ status: 503 })
    f.ctx.provide('remoteSshManager', f.manager as never)
    const remove = f.ctx.provide('sidebarWorkspaceProviders', f.providers as never)
    await plugin.await()
    expect((await f.providers.resolve(f.scope())).kind).toBe('remote')
    await remove()
    await expect(f.providers.resolve(f.scope())).rejects.toMatchObject({ status: 503 })
  })
  it('preserves a manager rejection and cannot select local or allocate a context', async () => {
    const f = fixture()
    f.manager.route.mockImplementation(() => { throw new Error('retired remote alias') })
    f.ctx.provide('remoteSshManager', f.manager as never)
    f.ctx.provide('sidebarWorkspaceProviders', f.providers as never)
    await f.mount().await()
    await expect(f.providers.resolve(f.scope())).rejects.toThrow('retired remote alias')
    expect(f.manager.workspaceContext).not.toHaveBeenCalled()
  })
  it('provides explicit schema defaults and rejects invalid deployment limits', async () => {
    const f = fixture()
    expect(Config({})).toMatchObject({ terminalArgv: ['bash'], terminalEnv: {}, fullReadMaxBytes: 64 * 1024 * 1024 })
    expect(() => apply(f.ctx, Config({ fullReadMaxBytes: -1 }))).toThrow('fullReadMaxBytes')
  })
})
