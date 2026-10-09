/** Artifact-plane regression: test:composition builds the plugin before the real Loader/profile restart. */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-persistence'
import Settings from '@deepseek-ai/dsh-settings'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { describe, expect, it } from 'vitest'
import type {} from '../src/manager.ts'
import { setup } from './fixtures/terminal-client.ts'
import type { RemoteShellExecution } from '../src/shell.ts'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { shippedWorkspace, workspaceReplacement } from './fixtures/shipped-workspace.ts'

async function createProfile(root: string, contexts: Context[]) {
  const aliasRoot = join(root, 'aliases')
  const dir = join(root, 'profiles', 'test')
  initProfile(dir, ['deletion-test-bundle'])
  const configPath = join(dir, 'cordis.yml')
  const bundle = join(dir, 'node_modules', 'deletion-test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'deletion-test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  const manifest = join(root, 'package.json')
  await writeFile(manifest, '{"name":"deletion-test-installation"}\n')
  const profile: ProfileContext = { name: 'test', startedBundles: ['deletion-test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: manifest, cwd: root, home: root, overlays: [], telemetryDisabledEnv: undefined }
  const config = { aliasRoot, servers: [{ id: 'test', label: 'Test', sshTarget: 'never-connect' }], workspaces: [{ id: 'project', serverId: 'test', remotePath: '/srv/project' }] }
  const rows = [
    ...['session', 'session-projection', 'storage'].map(name => ({ id: name, name: import.meta.resolve('@deepseek-ai/dsh-' + name) })),
    { id: 'settings', name: 'cordis:settings' },
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'session-persistence', name: import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'), config: { root: join(root, 'sessions'), compression: 'none' } },
    { id: 'storage-json', name: import.meta.resolve('@deepseek-ai/dsh-storage-json'), config: { root: join(root, 'storage') } },
    { id: 'storage-domain', name: import.meta.resolve('@deepseek-ai/dsh-storage-domain'), config: { backend: 'json' } },
    { id: 'remote-ssh-manager', name: new URL('../lib/manager.js', import.meta.url).href, config },
    shippedWorkspace(),
  ]
  await writeFile(configPath, '[]\n')
  const warnings: string[] = []
  const composed = applyEntryPatches(rows, workspaceReplacement(), message => warnings.push(message))
  expect(warnings).toEqual([])
  await writeFile(join(bundle, 'cordis.patch.yml'), dump([{ insert: composed }]))
  const start = async () => {
    const ctx = await boot('remote-ssh-delete-test', configPath, readProfilePatches('test', profile), ctx => { ctx.provide('profileContext', profile); Object.assign(ctx.loader.builtins, { settings: Settings, editor: ConfigEditor }) }, new URL('../', import.meta.url).href)
    contexts.push(ctx)
    expect(ctx.remoteSshManager).toBeDefined()
    expect(ctx.workspaceRegistry.constructor.name).toBe('RemoteWorkspaceRegistry')
    const providers = [...ctx.loader.entries()].filter(entry => ['@deepseek-ai/dsh-workspace', 'dsh-remote-ssh/workspace-registry'].includes(entry.options.name ?? '') && entry.fiber !== undefined)
    expect(providers.map(entry => entry.options.id)).toEqual(['remote-ssh-workspace-registry'])
    expect(providers[0]?.fiber?.state).toBe(2)
    return ctx
  }
  return { aliasRoot, profile, start }
}


describe('sidebar Remote SSH deletion through a real YAML profile', () => {
  it('refuses retirement after an ordinary dispatched shell terminal has no disposal acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-shell-delete-'))
    const contexts: Context[] = []
    try {
      const { aliasRoot, start } = await createProfile(root, contexts)
      const ctx = await start()
      await ctx.remoteSshManager.renameWorkspace('project', 'Test > project')
      const alias = join(aliasRoot, 'project')
      const workspace = ctx.workspaceRegistry.list().find(workspace => workspace.path === alias)
      const { client } = await setup(ctx, alias, true)
      const controller = new AbortController()
      client.controller = controller
      client.abortAt = 'dispatch'
      client.disposeError = new Error('disposal acknowledgement lost')
      const execution = await ctx.shell.execute(ctx.shell.resolve({ command: 'must-stop', workdir: alias, signal: controller.signal })) as RemoteShellExecution
      await expect(execution.result()).rejects.toThrow('terminal shutdown unobservable')
      expect(await execution.dispatched).toBe(true)
      await expect(execution.quiescent).rejects.toThrow('terminal shutdown unobservable')
      await expect(ctx.workspaceRegistry.delete(workspace!.id)).rejects.toThrow('terminal shutdown unobservable')
      await expect(ctx.workspaceRegistry.delete(workspace!.id)).rejects.toThrow('terminal shutdown unobservable')
      expect(ctx.workspaceRegistry.get(workspace!.id)).toBeDefined()
      expect(ctx.remoteSshManager.snapshot().workspaces).toHaveLength(1)
      expect(() => ctx.remoteSshManager.route(alias)).toThrow()
    } finally { for (const ctx of contexts.reverse()) await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('persists deletion across profile restart without removing directories or local workspace registrations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-delete-'))
    const contexts: Context[] = []
    try {
      const { aliasRoot, profile, start } = await createProfile(root, contexts)
      const first = await start()
      await first.remoteSshManager.renameWorkspace('project', 'Test > project')
      const alias = join(aliasRoot, 'project')
      const local = await first.workspaceRegistry.create(root, 'LOCAL > retained')
      const workspace = first.workspaceRegistry.list().find(workspace => workspace.path === alias)
      expect(workspace).toBeDefined()
      const session = first.sessions.create(undefined, { meta: { cwd: alias, agentPreset: 'standard' } })
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Retained Session history' }] }), { surfaceOp: 'append' })
      const writer = await first.sessionPersistence.create(session.header)
      try { await writer.append(session.snapshotEvents()); await writer.flush() } finally { await writer.close() }
      await workspace!.attachSession(session.id)
      const before = await first.sessionPersistence.open(session.id, 'read')
      const history = await before.read()
      await before.close()
      expect(await first.workspaceRegistry.delete(workspace!.id)).toBe(true)
      expect(first.remoteSshManager.snapshot().workspaces).toEqual([])
      expect(first.workspaceRegistry.list().map(workspace => workspace.id)).toEqual([local.id])
      expect((await stat(alias)).isDirectory()).toBe(true)
      const patch = await readFile(profile.patchPath, 'utf8')
      expect(patch).toContain('retiredAliases')
      expect(patch).toContain('workspaces: []')
      await first.fiber.dispose()
      const resumed = await start()
      expect(resumed.workspaceRegistry.list().map(workspace => workspace.id)).toEqual([local.id])
      expect(resumed.remoteSshManager.snapshot().workspaces).toEqual([])
      const retained = await resumed.sessionPersistence.open(session.id, 'read')
      try { expect(await retained.read()).toEqual(history); expect(retained.header.cwd).toBe(alias) } finally { await retained.close() }
      expect(() => resumed.remoteSshManager.route(undefined, alias)).toThrow('no longer configured')
      expect((await stat(alias)).isDirectory()).toBe(true)
    } finally {
      for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
