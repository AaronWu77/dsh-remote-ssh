import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import RemoteSshManager from '../src/manager.ts'
import { commitVolatileConfig } from './helpers/volatile-settings.ts'
import type { PreferencesState, SavePreferencesRequest } from '../src/management-types.ts'

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
    const paths = commitVolatileConfig(this.owner, values)
    this.revision += 1
    this.owner.ctx.emit(this.owner, 'loader/volatile-update', paths)
  }
}

function draft(state: PreferencesState, extra: Partial<SavePreferencesRequest> = {}): SavePreferencesRequest {
  return { expectedRevision: state.revision, sshConfigFile: state.sshConfigFile, openFileMode: state.openFileMode,
    openFileEditorPath: state.openFileEditorPath, confirmConnectionReset: false, ...extra }
}

async function fixture(run: (manager: RemoteSshManager, settings: MemorySettings, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preferences-'))
  const ctx = new Context()
  try {
    await ctx.plugin(MemorySettings)
    await ctx.plugin(RemoteSshManager, { aliasRoot: root,
      servers: [{ id: 'host', label: 'Host', sshTarget: 'fixture.invalid' }],
      workspaces: [{ id: 'work', serverId: 'host', remotePath: '/srv/work' }] })
    const settings = ctx.settings
    if (!(settings instanceof MemorySettings)) throw new Error('fixture settings missing')
    await run(ctx.remoteSshManager, settings, root)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}

describe('safe user preferences', () => {
  it('saves and reads back only preference fields without changing workspaces', async () => fixture(async manager => {
    const catalog = manager.snapshot()
    const before = manager.preferencesState()
    const result = await manager.savePreferences(draft(before, { openFileMode: 'download' }))
    expect(result).toMatchObject({ openFileMode: 'download', applicationState: 'applied', activeExecutions: 0 })
    expect(result.revision).not.toBe(before.revision)
    expect(manager.preferencesState()).toEqual(result)
    expect(manager.snapshot().servers).toEqual(catalog.servers)
    expect(manager.snapshot().workspaces).toEqual(catalog.workspaces)
  }))

  it('rejects a stale browser revision instead of overwriting another tab', async () => fixture(async manager => {
    const old = manager.preferencesState()
    await manager.savePreferences(draft(old, { openFileMode: 'cursor' }))
    await expect(manager.savePreferences(draft(old, { openFileMode: 'download' }))).rejects.toMatchObject({ code: 'settings_conflict' })
    expect(manager.preferencesState().openFileMode).toBe('cursor')
  }))

  it('rejects missing, relative and directory paths before persistence', async () => fixture(async (manager, settings, root) => {
    const before = manager.preferencesState()
    for (const path of ['relative-config', join(root, 'missing'), root]) {
      await expect(manager.savePreferences(draft(before, { sshConfigFile: path }))).rejects.toMatchObject({ code: 'settings_invalid_path' })
    }
    expect(settings.revision).toBe(0)
    expect(manager.preferencesState()).toEqual(before)
  }))

  it('requires an editor executable for custom mode and permits default restoration', async () => fixture(async (manager, _settings, root) => {
    await expect(manager.savePreferences(draft(manager.preferencesState(), { openFileMode: 'custom' }))).rejects.toMatchObject({ code: 'settings_invalid_path' })
    const config = join(root, 'custom config')
    await writeFile(config, 'Host fixture\n HostName fixture.invalid\n')
    const saved = await manager.savePreferences(draft(manager.preferencesState(), { sshConfigFile: config, openFileMode: 'download' }))
    const defaults = await manager.savePreferences(draft(saved, { sshConfigFile: '', openFileMode: 'auto', openFileEditorPath: '' }))
    expect(defaults).toMatchObject({ sshConfigFile: '', openFileMode: 'auto', openFileEditorPath: '' })
  }))

  it('refuses SSH changes during active tasks but allows editor-only preferences without termination', async () => fixture(async (manager, _settings, root) => {
    const terminated = vi.fn()
    const done = Promise.withResolvers<void>()
    const release = manager.ownExecution(manager.workspace('work'), { terminate: terminated, done: done.promise })
    const config = join(root, 'ssh config'); await writeFile(config, '')
    try {
      await expect(manager.savePreferences(draft(manager.preferencesState(), { sshConfigFile: config, confirmConnectionReset: true }))).rejects.toMatchObject({ code: 'settings_busy' })
      await manager.savePreferences(draft(manager.preferencesState(), { openFileMode: 'download' }))
      expect(terminated).not.toHaveBeenCalled()
      expect(manager.preferencesState().activeExecutions).toBe(1)
    } finally { done.resolve(); release() }
  }))

  it('keeps diagnostic connection policy fixed until cleanup releases ownership', async () => fixture(async (manager, _settings, root) => {
    const config = join(root, 'ssh config'); await writeFile(config, '')
    const release = manager.ownDiagnostic(manager.preferencesState().revision)
    try {
      await expect(manager.savePreferences(draft(manager.preferencesState(), { sshConfigFile: config }))).rejects.toMatchObject({ code: 'settings_busy' })
    } finally { release(); release() }
    expect(manager.preferencesState().activeExecutions).toBe(0)
    await expect(manager.savePreferences(draft(manager.preferencesState(), { sshConfigFile: config }))).resolves.toMatchObject({ sshConfigFile: config })
  }))

  it('blocks new execution admission while a connection-changing save is pending', async () => fixture(async (manager, settings, root) => {
    const route = manager.workspace('work')
    const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>()
    settings.beforeWrite = async () => { entered.resolve(); await finish.promise }
    const config = join(root, 'ssh config'); await writeFile(config, '')
    const saving = manager.savePreferences(draft(manager.preferencesState(), { sshConfigFile: config }))
    try {
      await entered.promise
      const terminate = vi.fn()
      expect(() => manager.ownExecution(route, { terminate, done: Promise.resolve() })).toThrow()
      expect(terminate).toHaveBeenCalledOnce()
      expect(() => manager.workspace('work')).toThrow('configuration is changing')
    } finally { finish.resolve(); await saving }
    expect(manager.workspace('work').workspace.id).toBe('work')
  }))

  it('reports storage failure without claiming that preferences were applied', async () => fixture(async (manager, settings) => {
    settings.beforeWrite = async () => { throw new Error('storage failed') }
    const before = manager.preferencesState()
    await expect(manager.savePreferences(draft(before, { openFileMode: 'download' }))).rejects.toMatchObject({ code: 'settings_apply_unconfirmed' })
    expect(manager.preferencesState()).toEqual({ ...before, applicationState: 'unconfirmed' })
  }))
})
