/** Git backends exercise real remote byte transport; lifecycle races replace only process allocation. */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '../src/local-bridge.ts'
import { createVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SidebarWorkspaceProviders } from 'dsh-better-sidebar/workspace-provider'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RemoteSshManager from '../src/manager.ts'
import { createSidebarGitBackend, type SidebarGitConfig } from '../src/sidebar-git.ts'
import * as subprocess from '../src/router-subprocess.ts'
import { SidebarExecutionLifetime } from '../src/sidebar-execution-lifetime.ts'
import { LocalOutputFixture, outputTestBash } from './fixtures/output-transport.ts'

// The fixture emits the loader event supported by the runtime but absent in the installed declaration.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

const config: SidebarGitConfig = {
  gitMaxOutputBytes: 4096, collectionStderrMaxBytes: 4096,
  cleanupGraceMs: 30_000, outputChunkBytes: 3, outputPollMs: 1,
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (failures.length > 0) throw new AggregateError(failures, 'Git fixture cleanup failed')
})

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
    if (revision !== this.revision || this.owner === undefined) throw new Error('settings owner or revision changed')
    updateVolatile(this.owner.config as Volatile<Record<string, unknown>>, createVolatile(structuredClone(next)))
    this.revision += 1
    this.owner.ctx.emit(this.owner, 'loader/volatile-update', [[]])
  }
}

function errorFactories() {
  // The runtime constructors belong to Sidebar; verify delegation without importing its host bundle.
  const errors: Pick<SidebarWorkspaceProviders, 'workspaceError' | 'gitCommandError'> = {
    workspaceError: vi.fn((code, message, status) => Object.assign(new Error(message), { code, status })),
    gitCommandError: vi.fn((message, command, exitCode) => Object.assign(new Error(message), { code: 'git', command, exitCode })),
  }
  return errors
}

async function setup(remotePath = '/srv/project') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sidebar-git-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(MemorySettings).await()
  await ctx.plugin(RemoteSshManager, {
    aliasRoot: root,
    servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'no-ssh-in-tests' }],
    workspaces: [{ id: 'project', serverId: 'devbox', remotePath }],
  }).await()
  const manager = ctx.remoteSshManager
  const route = manager.workspace('project')
  const errors = errorFactories()
  const context = vi.spyOn(manager, 'workspaceContext')
  context.mockRejectedValue(new Error('unexpected connection allocation'))
  const shell = vi.spyOn(manager, 'workspaceShell').mockRejectedValue(new Error('unexpected shell allocation'))
  const owned = vi.spyOn(manager, 'ownExecution')
  const routeShell = vi.spyOn(manager, 'routeShell')
  return { ctx, manager, route, errors, context, shell, owned, routeShell }
}

async function realSetup(limits: Partial<SidebarGitConfig> = {}) {
  const client = await LocalOutputFixture.create()
  cleanups.push(() => client.dispose())
  const fixture = await setup(client.runtimeRoot)
  fixture.context.mockResolvedValue({ ctx: fixture.ctx, fs: {} as never, remote: {
    clientId: 'sidebar-git', runtimeRoot: client.runtimeRoot, getClient: async () => client,
  } as never })
  fixture.shell.mockResolvedValue({
    resolve: client.resolve.bind(client),
    execute: (spec: Parameters<LocalOutputFixture['execute']>[0]) => client.execute({
      ...spec,
      // Git for Windows puts git.exe outside the fixture's /usr/bin:/bin utility PATH.
      command: (process.platform === 'win32' ? 'PATH=/mingw64/bin:/usr/bin:/bin; ' : '') + spec.command,
    }),
  } as never)
  const backend = createSidebarGitBackend(fixture.manager, fixture.route, { ...config, ...limits }, fixture.errors)
  return { ...fixture, client, backend }
}

function processFixture() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const done = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
  const complete = Promise.withResolvers<boolean>()
  const cleanup = Promise.withResolvers<void>()
  const terminate = vi.fn()
  const handle = { stdout, stderr, done: done.promise, outputComplete: complete.promise, quiescent: cleanup.promise, terminate }
  // The concrete allocator has private process internals; this replaces only the external transport.
  const spawn = vi.spyOn(subprocess, 'spawnOwnedRemoteProcess').mockReturnValue(handle as never)
  cleanups.push(async () => { stdout.end(); stderr.end(); done.resolve({ exitCode: 0, signal: null }); complete.resolve(true); cleanup.resolve() })
  return { stdout, stderr, done, complete, cleanup, terminate, spawn }
}

describe('selected Sidebar Git route', () => {
  it('revokes pending Git allocation and waits for workspace preparation without retiring its route', async () => {
    const f = await setup()
    const lifetime = new SidebarExecutionLifetime(f.manager, f.route, () => f.errors.workspaceError('workspace-unavailable', 'bridge removed', 503))
    const backend = createSidebarGitBackend(f.manager, f.route, config, f.errors, lifetime)
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
    f.context.mockImplementation(async () => { entered.resolve(); await release.promise; throw new Error('preparation cancelled') })
    const running = backend.run('/srv/project', ['status'], 30000)
    const failed = expect(running).rejects.toMatchObject({ status: 503 })
    let disposal: Promise<void> | undefined
    cleanups.push(async () => { release.resolve(); await Promise.allSettled([running, ...(disposal ? [disposal] : [])]) })
    await entered.promise
    let disposed = false
    disposal = lifetime.dispose().then(() => { disposed = true })
    await Promise.resolve(); expect(disposed).toBe(false)
    await expect(backend.run('/srv/project', ['add', '.'], 1000)).rejects.toMatchObject({ status: 503 })
    release.resolve()
    await Promise.all([failed, disposal])
    expect(f.manager.workspace(f.route.workspace.id)).toBe(f.route)
    expect(f.shell).toHaveBeenCalledTimes(1)
    expect(f.routeShell).not.toHaveBeenCalled()
  })
  it.each(['removed', 'replaced'] as const)('rejects a %s route before allocating either filesystem or process', async state => {
    const { manager, route, errors, context, shell, owned } = await setup()
    const backend = createSidebarGitBackend(manager, route, config, errors)
    if (state === 'removed') await manager.removeRegisteredWorkspace(route.aliasPath, async () => true)
    else vi.spyOn(manager, 'workspace').mockReturnValue({ ...route })
    await expect(backend.run(route.aliasPath, ['status'], 30_000)).rejects.toMatchObject({ code: 'git-error', status: 503 })
    await expect(backend.listDirectories(route.aliasPath)).rejects.toMatchObject({ code: 'git-error', status: 503 })
    expect(context).not.toHaveBeenCalled()
    expect(shell).not.toHaveBeenCalled()
    expect(owned).not.toHaveBeenCalled()
  })

  it('keeps POSIX joins and case-sensitive identity while mapping aliases', async () => {
    const { manager, route, errors } = await setup()
    const backend = createSidebarGitBackend(manager, route, config, errors)
    expect(backend.joinPath(route.aliasPath, 'A/../B')).toBe('/srv/project/B')
    expect(backend.pathIdentity('/srv/project/A')).not.toBe(backend.pathIdentity('/srv/project/a'))
    expect(backend.pathIdentity('/srv/project/a/../b')).toBe('/srv/project/b')
  })

  it('lists only selected remote directory names and rejects discovery failures', async () => {
    const { manager, route, errors, context, ctx } = await setup()
    const target = { targetKey: 'remote-target', displayPath: '/srv/project' }
    const resolve = vi.fn(async () => target)
    const listDir = vi.fn(async () => [{ name: 'dir', type: 'directory' }, { name: 'file', type: 'file' }])
    context.mockResolvedValue({ ctx, fs: { resolve, listDir } as never, remote: {} as never })
    const backend = createSidebarGitBackend(manager, route, config, errors)
    await expect(backend.listDirectories(route.aliasPath)).resolves.toEqual(['dir'])
    expect(context).toHaveBeenCalledWith(route)
    expect(resolve).toHaveBeenCalledWith('/srv/project', { signal: expect.any(AbortSignal) })
    expect(listDir).toHaveBeenCalledWith(target, expect.any(AbortSignal))
    listDir.mockRejectedValue(new Error('permission denied'))
    await expect(backend.listDirectories(route.aliasPath)).rejects.toThrow('permission denied')
    context.mockRejectedValue(new Error('transport unavailable'))
    await expect(backend.listDirectories(route.aliasPath)).rejects.toThrow('transport unavailable')
  })

  it('owns pending directory context allocation and drains it before workspace retirement', async () => {
    const { manager, route, errors, context, ctx } = await setup()
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const retiring = Promise.withResolvers<void>()
    const resolve = vi.fn(async () => ({ targetKey: 'target', displayPath: '/srv/project' }))
    const listDir = vi.fn(async () => [])
    context.mockImplementation(async () => {
      entered.resolve()
      await resume.promise
      return { ctx, fs: { resolve, listDir } as never, remote: {} as never }
    })
    const backend = createSidebarGitBackend(manager, route, config, errors)
    const listing = backend.listDirectories(route.aliasPath)
    const failed = expect(listing).rejects.toThrow('directory discovery removed')
    manager.ownExecution(route, { terminate: () => { retiring.resolve() }, done: Promise.resolve() })
    let deletion: Promise<boolean> | undefined
    cleanups.push(async () => { resume.resolve(); await Promise.allSettled([listing, ...(deletion ? [deletion] : [])]) })
    await entered.promise
    let removed = false
    deletion = manager.removeRegisteredWorkspace(route.aliasPath, async () => { removed = true; return true })
    await retiring.promise
    expect(removed).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
    resume.resolve()
    await failed
    await expect(deletion).resolves.toBe(true)
    expect(listDir).not.toHaveBeenCalled()
    expect(removed).toBe(true)
  })

  it('passes fixed argv, explicit environment, and separate pipes to the owned allocator', async () => {
    const { manager, route, errors } = await setup()
    const transport = processFixture()
    const backend = createSidebarGitBackend(manager, route, config, errors)
    const output = backend.run(route.aliasPath, ['status', '-z'], 30_000)
    const spec = transport.spawn.mock.calls[0]![2]
    expect(spec).toEqual({ argv: ['git', '-C', '/srv/project', '--no-pager', '-c', 'color.ui=false', 'status', '-z'],
      cwd: '/srv/project', env: { LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 30_000 })
    transport.stdout.end(Buffer.from('?? 汉字\0'))
    transport.stderr.end()
    transport.done.resolve({ exitCode: 0, signal: null })
    transport.complete.resolve(true)
    let settled = false
    void output.then(() => { settled = true })
    await transport.done.promise
    expect(settled).toBe(false)
    transport.cleanup.resolve()
    await expect(output).resolves.toBe('?? 汉字\0')
  })

  it('rejects bounded exit-zero output even when process completion precedes stream completion', async () => {
    const { manager, route, errors } = await setup()
    const transport = processFixture()
    const output = createSidebarGitBackend(manager, route, config, errors).run(route.aliasPath, ['status'], 30_000)
    const rejected = expect(output).rejects.toMatchObject({ code: 'git-error', status: 503, message: expect.stringContaining('incomplete') })
    transport.done.resolve({ exitCode: 0, signal: null })
    transport.complete.resolve(false)
    transport.cleanup.resolve()
    transport.stdout.end('partial'); transport.stderr.end()
    await rejected
    expect(errors.gitCommandError).not.toHaveBeenCalled()
  })

  it('reports executable launch failure as a workspace error, not a completed Git diagnostic', async () => {
    const { manager, route, errors } = await setup()
    const transport = processFixture()
    const output = createSidebarGitBackend(manager, route, config, errors).run(route.aliasPath, ['status'], 30_000)
    const rejected = expect(output).rejects.toMatchObject({ code: 'git-error', status: 503 })
    transport.done.resolve({ exitCode: 127, signal: null })
    transport.complete.resolve(true)
    transport.stdout.end(); transport.stderr.end("env: 'git': No such file or directory\n")
    transport.cleanup.resolve()
    await rejected
    expect(errors.gitCommandError).not.toHaveBeenCalled()
  })

  it('terminates on a deadline but waits for process, streams and cleanup before rejection', async () => {
    const { manager, route, errors } = await setup()
    const transport = processFixture()
    vi.useFakeTimers()
    const output = createSidebarGitBackend(manager, route, config, errors).run(route.aliasPath, ['status'], 20)
    const rejected = expect(output).rejects.toMatchObject({ code: 'git-error', status: 503, message: expect.stringContaining('timed out') })
    await vi.advanceTimersByTimeAsync(20)
    expect(transport.terminate).toHaveBeenCalledTimes(1)
    let settled = false
    void output.catch(() => { settled = true })
    transport.done.resolve({ exitCode: 0, signal: null })
    transport.complete.resolve(true)
    transport.stdout.end(); transport.stderr.end()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    transport.cleanup.resolve()
    await rejected
    expect(errors.gitCommandError).not.toHaveBeenCalled()
  })
})

describe.skipIf(outputTestBash === undefined)('Sidebar Git through actual local AHP output scripts', () => {
  it('preserves NUL and Unicode split across byte slots, with separate stderr', async () => {
    const { backend, client, route, routeShell, owned } = await realSetup()
    const args = ['-c', "alias.fixture=!printf '?? 汉字\\000'; printf '诊断\\000' >&2", 'fixture'] as const
    await expect(backend.run(route.aliasPath, args, 30_000)).resolves.toBe('?? 汉字\0')
    expect(args[0]).toBe('-c')
    expect(client.reads.filter(read => read.uri.endsWith('/stdout.chunk')).length).toBeGreaterThan(1)
    expect(client.reads.filter(read => read.uri.endsWith('/stderr.chunk')).length).toBeGreaterThan(1)
    expect(client.reads.every(read => read.bytes <= 3)).toBe(true)
    expect(routeShell).not.toHaveBeenCalled()
    await Promise.all(owned.mock.calls.map(([, execution]) => execution.done))
    expect(client.processes.size).toBe(0)
    expect(await readdir(client.root)).toEqual([])
  })

  it('decodes complete Unicode and NUL stderr independently from stdout on a completed Git failure', async () => {
    const { backend, route, errors, client } = await realSetup()
    await expect(backend.run(route.aliasPath,
      ['-c', "alias.fixture=!printf 'separate-output'; printf '诊断\\000' >&2; exit 7", 'fixture'], 30_000))
      .rejects.toMatchObject({ code: 'git', exitCode: 7, message: '诊断\0' })
    expect(errors.gitCommandError).toHaveBeenCalledWith('诊断\0', expect.any(String), 7)
    expect(client.processes.size).toBe(0)
    expect(await readdir(client.root)).toEqual([])
  })

  it('keeps stdout and stderr byte quotas independent', async () => {
    const { backend, route, client } = await realSetup({ gitMaxOutputBytes: 3, collectionStderrMaxBytes: 3, outputChunkBytes: 2 })
    await expect(backend.run(route.aliasPath, ['-c', "alias.fixture=!printf '汉'; printf '字' >&2", 'fixture'], 30_000)).resolves.toBe('汉')
    expect(client.processes.size).toBe(0)
    expect(await readdir(client.root)).toEqual([])
  })

  it('delegates actual non-repository stderr and exit status to the Git error constructor', async () => {
    const { backend, client, route, errors } = await realSetup({ outputChunkBytes: 64 })
    await expect(backend.run(route.aliasPath, ['status', '--porcelain=v1', '-z'], 30_000)).rejects.toMatchObject({ code: 'git', exitCode: 128 })
    expect(errors.gitCommandError).toHaveBeenCalledWith(expect.stringContaining('not a git repository'), expect.stringContaining('git -C'), 128)
    expect(errors.workspaceError).not.toHaveBeenCalled()
    expect(client.processes.size).toBe(0)
    expect(await readdir(client.root)).toEqual([])
  })

  it.each(['stdout', 'stderr'] as const)('rejects %s byte overflow visibly and cleans all allocated transport resources', async stream => {
    const { backend, client, route, errors } = await realSetup({ gitMaxOutputBytes: 4, collectionStderrMaxBytes: 4, outputChunkBytes: 8 })
    const redirect = stream === 'stderr' ? ' >&2' : ''
    await expect(backend.run(route.aliasPath, ['-c', `alias.fixture=!printf '汉字'${redirect}`, 'fixture'], 30_000))
      .rejects.toMatchObject({ code: 'git-error', status: 413, message: expect.stringContaining(stream) })
    expect(errors.gitCommandError).not.toHaveBeenCalled()
    expect(client.processes.size).toBe(0)
    expect(await readdir(client.root)).toEqual([])
  })

  it('reports remote resource-read transport failure rather than a Git diagnostic', async () => {
    const { backend, client, route, errors } = await realSetup({ outputChunkBytes: 64 })
    client.readFailure = new Error('wire disconnected')
    await expect(backend.run(route.aliasPath, ['--version'], 30_000)).rejects.toMatchObject({ code: 'git-error', status: 503 })
    expect(errors.gitCommandError).not.toHaveBeenCalled()
    expect(client.processes.size).toBe(0)
    expect(await readdir(client.root)).toEqual([])
  })
})
