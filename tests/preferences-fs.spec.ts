/** Filesystem reservations participate in the real manager's preference admission checks. */
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import { FsTargetKey, FsVersion, type FileSystem, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import RemoteSshManager, { type RemoteWorkspaceContext } from '../src/manager.ts'
import type RemoteSshRuntime from '../src/index.ts'
import TransparentFileSystem from '../src/router-fs.ts'

class MemorySettings extends Service {
  owner?: Fiber
  revision = 0
  beforeWrite: (() => Promise<void>) | undefined
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure(_options: object, owner: Fiber) { this.owner = owner; return () => { delete this.owner } }
  describe() { return [{ ns: 'remote-ssh-manager' as SettingsNamespace, revision: this.revision }] }
  async replace(_ns: SettingsNamespace, values: Record<string, unknown>, revision: number) {
    if (!this.owner || revision !== this.revision) throw new Error('revision conflict')
    await this.beforeWrite?.()
    updateVolatile(this.owner.config as Volatile<Record<string, unknown>>, createVolatile(structuredClone(values)))
    this.revision += 1
    this.owner.ctx.emit(this.owner, 'loader/volatile-update', [[]])
  }
}

const outcome: FsWriteOutcome = { operation: 'update', version: FsVersion('written'), before: 'old', after: 'new' }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fs-preferences-'))
  const ctx = new Context()
  try {
    await ctx.plugin(MemorySettings)
    await ctx.plugin(RemoteSshManager, { aliasRoot: root,
      servers: [{ id: 'host', label: 'Host', sshTarget: 'fixture.invalid' }],
      workspaces: [{ id: 'work', serverId: 'host', remotePath: '/srv/work' }] })
    const manager = ctx.remoteSshManager
    const settings = ctx.settings
    if (!(settings instanceof MemorySettings)) throw new Error('settings fixture missing')
    const target = { targetKey: FsTargetKey('file:///srv/work/file.txt'), displayPath: '/srv/work/file.txt' }
    const wrapped = { ...target, targetKey: FsTargetKey('dsh-remote-ssh:' + Buffer.from(JSON.stringify({ workspaceId: 'work', targetKey: target.targetKey })).toString('base64url')) }
    const remoteFs = {
      resolve: vi.fn(async () => target),
      readText: vi.fn(async () => 'remote'),
      writeText: vi.fn<FileSystem['writeText']>(async () => outcome),
      editText: vi.fn<FileSystem['editText']>(async () => ({ version: outcome.version, before: 'old', after: 'new' })),
      writeBytes: vi.fn(async () => ({ operation: 'update' as const, version: outcome.version, bytes: 3 })),
      streamText: vi.fn<FileSystem['streamText']>(async () => (async function* () { yield 'buffered' })()),
    }
    // Provider doubles implement only the operations exercised by this router fixture.
    const remoteBackend: Partial<FileSystem> = remoteFs
    const remote: RemoteWorkspaceContext = { ctx, fs: remoteBackend as FileSystem, remote: {} as RemoteSshRuntime }
    const allocate = vi.spyOn(manager, 'workspaceContext').mockResolvedValue(remote)
    const localFs = { readText: vi.fn(async () => 'local'), sandboxMode: 'read-only' as const }
    const localBackend: Partial<FileSystem> = localFs
    ctx.provide('localFs', localBackend as FileSystem)
    await ctx.plugin(TransparentFileSystem)
    const config = join(root, 'ssh-config'); await writeFile(config, '')
    const save = () => manager.savePreferences({ ...manager.preferencesState(), sshConfigFile: config,
      expectedRevision: manager.preferencesState().revision, confirmConnectionReset: true })
    return { ctx, root, manager, settings, target, wrapped, remoteFs, localFs, remote, allocate, save,
      dispose: async () => { allocate.mockRestore(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
  } catch (error) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error }
}

describe('remote filesystem preference protection', () => {
  it.each(['write', 'edit', 'binary'] as const)('rejects SSH changes while a %s RPC is in flight without persisting configuration', async kind => {
    const f = await setup(); const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>()
    const wait = async () => { entered.resolve(); await finish.promise }
    f.remoteFs.writeText.mockImplementation(async () => { await wait(); return outcome })
    f.remoteFs.editText.mockImplementation(async () => { await wait(); return { version: outcome.version, before: 'old', after: 'new' } })
    f.remoteFs.writeBytes.mockImplementation(async () => { await wait(); return { operation: 'update', version: outcome.version, bytes: 3 } })
    const policy = { mode: 'danger-full-access' as const, workspaceRoot: f.root }
    const router = f.ctx.fs as TransparentFileSystem
    const pending = kind === 'write' ? router.writeText(f.wrapped, 'new', undefined, undefined, policy)
      : kind === 'edit' ? router.editText(f.wrapped, { oldString: 'old', newString: 'new', replaceAll: false }, undefined, undefined, policy)
      : router.writeBytes(f.wrapped, Uint8Array.of(1, 2, 3), undefined, undefined, policy)
    try {
      await entered.promise
      expect(f.manager.preferencesState().activeExecutions).toBe(1)
      await expect(f.save()).rejects.toMatchObject({ code: 'settings_busy' })
      expect(f.settings.revision).toBe(0)
      expect(f.manager.snapshot().sshConfigFile).toBeUndefined()
      if (kind === 'write') expect(f.remoteFs.writeText).toHaveBeenCalledWith(f.target, 'new', undefined, undefined, policy)
      finish.resolve(); await pending
      expect(f.manager.preferencesState().activeExecutions).toBe(0)
      await expect(f.save()).resolves.toMatchObject({ applicationState: 'applied' })
    } finally { finish.resolve(); await pending.catch(() => {}); await f.dispose() }
  })

  it('reserves before awaiting context allocation and releases a rejected allocation', async () => {
    const f = await setup(); const allocated = Promise.withResolvers<RemoteWorkspaceContext>()
    f.allocate.mockReturnValue(allocated.promise)
    const pending = f.ctx.fs.resolve('file.txt', { cwd: join(f.root, 'work') })
    const rejected = expect(pending).rejects.toThrow('allocation failed')
    try {
      expect(f.manager.preferencesState().activeExecutions).toBe(1)
      await expect(f.save()).rejects.toMatchObject({ code: 'settings_busy' })
      expect(f.remoteFs.resolve).not.toHaveBeenCalled()
      allocated.reject(new Error('allocation failed')); await rejected
      expect(f.manager.preferencesState().activeExecutions).toBe(0)
    } finally { allocated.reject(new Error('allocation failed')); await pending.catch(() => {}); await f.dispose() }
  })

  it('releases ownership on a rejected filesystem RPC and preserves the rejection', async () => {
    const f = await setup(); const failure = new Error('remote read failed')
    f.remoteFs.readText.mockRejectedValue(failure)
    try {
      await expect(f.ctx.fs.readText(f.wrapped)).rejects.toBe(failure)
      expect(f.manager.preferencesState().activeExecutions).toBe(0)
    } finally { await f.dispose() }
  })

  it('holds stream creation through its eager remote read but not buffered iteration', async () => {
    const f = await setup(); const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>()
    f.remoteFs.streamText.mockImplementation(async () => { entered.resolve(); await finish.promise; return (async function* () { yield 'buffered' })() })
    const pending = f.ctx.fs.streamText(f.wrapped)
    try {
      await entered.promise
      await expect(f.save()).rejects.toMatchObject({ code: 'settings_busy' })
      finish.resolve(); const stream = await pending
      expect(f.manager.preferencesState().activeExecutions).toBe(0)
      const chunks = []; for await (const chunk of stream) chunks.push(chunk)
      expect(chunks).toEqual(['buffered'])
    } finally { finish.resolve(); await pending; await f.dispose() }
  })

  it('rejects remote admission during configuration changes while local reads remain local', async () => {
    const f = await setup(); const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>()
    f.settings.beforeWrite = async () => { entered.resolve(); await finish.promise }
    const saving = f.save()
    try {
      await entered.promise
      await expect(f.ctx.fs.writeText(f.wrapped, 'new')).rejects.toMatchObject({ code: 'settings_apply_unconfirmed' })
      expect(f.allocate).not.toHaveBeenCalled()
      expect(f.remoteFs.writeText).not.toHaveBeenCalled()
      const local = { targetKey: FsTargetKey('local-file'), displayPath: join(f.root, 'local.txt') }
      await expect(f.ctx.fs.readText(local)).resolves.toBe('local')
      expect(f.localFs.readText).toHaveBeenCalledWith(local, undefined)
      expect(f.manager.preferencesState().activeExecutions).toBe(0)
    } finally { finish.resolve(); await saving; await f.dispose() }
  })
})
