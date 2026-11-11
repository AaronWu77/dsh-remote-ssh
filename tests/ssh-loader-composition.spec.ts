/** Artifact plane: build first. Real Loader, Settings, manager and runtime; only SSH spawn is replaced. */
import childProcess, { type ChildProcess } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { dump } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import { discoverSshConfigHosts } from '../src/ssh-config.ts'
import type {} from '../src/manager.ts'

// Keep app-boot's reload WeakMap in the same native module plane as ConfigEditor.
const artifacts = process.env.DSH_REMOTE_SSH_TEST_LIB === undefined
  ? new URL('../lib/', import.meta.url)
  : pathToFileURL(resolve(process.env.DSH_REMOTE_SSH_TEST_LIB) + '/')

const { boot, readProfilePatches } = createRequire(import.meta.url)('@deepseek-ai/dsh-app-boot') as typeof import('@deepseek-ai/dsh-app-boot')

async function fixture(run: (ctx: Context, root: string, calls: string[][]) => Promise<void>, discoveryCode = 255) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-loader-'))
  let ctx: Context | undefined
  const calls: string[][] = []
  const children = new Set<EventEmitter>()
  const original = childProcess.spawn
  // Native ESM modules loaded by Loader must see the same external-process boundary.
  const mock = vi.spyOn(childProcess, 'spawn').mockImplementation(((executable: string, args: string[]) => {
    if (executable !== 'fixture-ssh') throw new Error('unexpected external process: ' + executable)
    calls.push([...args])
    class Child extends EventEmitter {
      stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough()
      exitCode: number | null = null
      kill() { queueMicrotask(() => this.finish(null)); return true }
      finish(code: number | null) { if (!children.delete(this)) return; this.exitCode = code; this.emit('close', code) }
    }
    const child = new Child(); children.add(child)
    queueMicrotask(() => {
      const discovery = args.at(-1)!.includes('find "$HOME/.vscode-server')
      child.finish(discovery ? discoveryCode : 255)
    })
    return child as unknown as ChildProcess
  }) as typeof childProcess.spawn)
  syncBuiltinESMExports()
  try {
    const configPath = join(root, 'cordis.yml')
    const sshConfigFile = join(root, 'custom ssh config')
    await writeFile(sshConfigFile, "Host custom-only\n  HostName fixture.invalid\n  User fixture\n  ProxyJump fixture-jump\n  IdentityFile fixture-key\n")
    const profile: ProfileContext = { name: 'test', startedBundles: ['./fixture-bundle'], dir: root, patchPath: join(root, 'cordis.patch.yml'), installAnchor: join(root, 'package.json'), cwd: root, home: join(root, 'home'), overlays: [], telemetryDisabledEnv: undefined }
    await writeFile(profile.installAnchor, JSON.stringify({ name: 'ssh-loader-fixture', dsh: { profile: { bundles: ['./fixture-bundle'] } } }))
    await mkdir(join(root, 'fixture-bundle'))
    await writeFile(join(root, 'fixture-bundle', 'package.json'), JSON.stringify({ name: 'fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: 'bundle.patch.yml' } } }))
    await writeFile(profile.patchPath, dump([{ id: 'remote-ssh-manager', config: {
      sshConfigFile, aliasRoot: join(root, 'aliases'),
      servers: [{ id: 'fixture', label: 'Fixture', sshTarget: 'custom-only', sshExecutable: 'fixture-ssh', sshArgs: ['-l', 'explicit-user', '-J', 'explicit-jump', '-i', 'explicit-key'] }],
      workspaces: [{ id: 'project', serverId: 'fixture', remotePath: '/srv/project' }],
    } }]))
    await writeFile(configPath, '[]')
    await writeFile(join(root, 'fixture-bundle', 'bundle.patch.yml'), dump([{ insert: [
      { id: 'settings', name: import.meta.resolve('@deepseek-ai/dsh-settings') },
      { id: 'config-editor', name: import.meta.resolve('@deepseek-ai/dsh-config-editor') },
      { id: 'remote-ssh-web', name: new URL('web.js', artifacts).href },
      { id: 'remote-ssh-manager', name: new URL('manager.js', artifacts).href, config: {
        aliasRoot: join(root, 'aliases'),
        servers: [{ id: 'fixture', label: 'Fixture', sshTarget: 'custom-only', sshExecutable: 'fixture-ssh', sshArgs: ['-l', 'explicit-user', '-J', 'explicit-jump', '-i', 'explicit-key'] }],
        workspaces: [{ id: 'project', serverId: 'fixture', remotePath: '/srv/project' }],
      } },
    ] }]))
    ctx = await boot('ssh-loader-fixture', configPath, readProfilePatches('test', profile), prepared => {
      prepared.provide('profileContext', profile)
    }, new URL('../', import.meta.url).href)
    await run(ctx, root, calls)
  } finally {
    await ctx?.fiber.dispose()
    mock.mockRestore(); syncBuiltinESMExports()
    expect(childProcess.spawn).toBe(original)
    await rm(root, { recursive: true, force: true })
    expect(children.size).toBe(0)
  }
}

describe('built SSH transport through real YAML Loader', () => {
  it('uses the same selected -F for the Web probe and returns classified directory diagnostics', async () => {
    await fixture(async (ctx, root, calls) => {
      // No listening socket: capture only the external HTTP request/response boundary.
      const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
      ctx.provide('webServer', { register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
        routes.set(route.path, route.handler); return () => { routes.delete(route.path) }
      } } as never)
      ctx.provide('connection', { requestRejection: () => undefined } as never)
      const web = await import(new URL('web.js', artifacts).href) as typeof import('../src/web.ts')
      await ctx.fiber.await()
      const request = async (path: string, body?: unknown) => {
        const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage
        req.method = body === undefined ? 'GET' : 'POST'; req.headers = {}
        let status = 0; let text = ''
        const res = { writeHead: (code: number) => { status = code }, end: (value: string) => { text = value } } as unknown as ServerResponse
        await routes.get(path)!(req, res)
        return { status, value: JSON.parse(text) }
      }
      const state = await request(web.REMOTE_SSH_STATE_PATH)
      expect(state.value.discoveredServerCount).toBe(1)
      expect(state.value.servers[0].sshTarget).toBe('custom-only')
      expect(calls).toHaveLength(0)
      await request(web.REMOTE_SSH_PROBE_PATH, { id: 'fixture' })
      const probe = calls.at(-1)!
      expect(probe.filter(arg => arg === '-F')).toHaveLength(1)
      expect(probe[probe.indexOf('-F') + 1]).toBe(join(root, 'custom ssh config'))
      expect(probe).toContain('ConnectTimeout=5')
      expect(probe).not.toContain('ConnectTimeout=10')
      const directory = await request(web.REMOTE_SSH_DIRECTORY_PATH, { serverId: 'fixture' })
      expect(directory.status).toBe(400)
      expect(directory.value.code).toBe('ssh_execution_failed')
      expect(directory.value.error).not.toContain('standalone CLI')
      expect(directory.value.error).toContain('embedded discovery (ssh exit 255)')
      expect(directory.value.error).not.toContain('no installed code-server')
      const preferences = await request(web.REMOTE_SSH_SETTINGS_PATH)
      expect(preferences.status).toBe(200)
      const saved = await request(web.REMOTE_SSH_SETTINGS_PATH, {
        expectedRevision: preferences.value.revision, openFileMode: 'download', confirmConnectionReset: false,
      })
      expect(saved).toMatchObject({ status: 200, value: { openFileMode: 'download', applicationState: 'applied' } })
      const conflict = await request(web.REMOTE_SSH_SETTINGS_PATH, { expectedRevision: preferences.value.revision, openFileMode: 'auto' })
      expect(conflict).toMatchObject({ status: 409, value: { code: 'settings_conflict' } })
      const diagnosticId = 'd0b8bdb1-2538-4bc5-bf09-a45c468f3976'
      const started = await request('/plugins/dsh-remote-ssh/diagnostics/start', {
        id: diagnosticId, expectedRevision: saved.value.revision, serverId: 'fixture', mode: 'basic', terminal: false, confirmDeep: false,
      })
      expect(started.status).toBe(202)
      await vi.waitFor(async () => {
        const status = await request('/plugins/dsh-remote-ssh/diagnostics/status', { id: diagnosticId })
        expect(status.value.status).toBe('failed')
        expect(status.value.stages.find((stage: { id: string }) => stage.id === 'ssh')).toMatchObject({ status: 'failed', code: 'ssh_failed' })
      })
      const stillMapped = await ctx.remoteSshManager.workspaceContext(ctx.remoteSshManager.workspace('project'))
      await expect(stillMapped.remote.getConnection()).rejects.toMatchObject({ code: 'ssh_execution_failed' })
      for (const runtime of calls.slice(1)) {
        expect(runtime[runtime.indexOf('-F') + 1]).toBe(probe[probe.indexOf('-F') + 1])
        expect(runtime).toContain('ConnectTimeout=10')
      }
    })
  })

  it('retains silent startup/discovery failures and the config-only alias with real services', async () => {
    await fixture(async (ctx, root, calls) => {
      const config = join(root, 'custom ssh config')
      const discovery = await discoverSshConfigHosts([config])
      expect(discovery.hosts.map(host => host.sshTarget)).toContain('custom-only')
      const manager = ctx.remoteSshManager
      const workspace = await manager.workspaceContext(manager.workspace('project'))
      await expect(workspace.remote.getConnection()).rejects.toMatchObject({ code: 'ssh_execution_failed', exitCode: 255, stage: 'embedded discovery' })
      const failedRounds = calls.length
      expect(failedRounds).toBeGreaterThan(0)
      await expect(workspace.remote.getConnection()).rejects.toThrow('embedded discovery (ssh exit 255)')
      // A later explicit request starts one discovery and no Agent Host after SSH failure.
      expect(calls).toHaveLength(failedRounds + 1)
      expect(calls.every(args => args.at(-1)!.includes('find "$HOME/.vscode-server'))).toBe(true)
      for (const args of calls) {
        expect(args.filter(arg => arg === '-F')).toHaveLength(1)
        expect(args[args.indexOf('-F') + 1]).toBe(config)
        expect(args).toEqual(expect.arrayContaining(['-l', 'explicit-user', '-J', 'explicit-jump', '-i', 'explicit-key', 'custom-only']))
        expect(args).toContain('ConnectTimeout=10')
      }
    })
  })
  it('invalidates an already-created host and workspace after a real Loader config update', async () => {
    await fixture(async (ctx, root, calls) => {
      const manager = ctx.remoteSshManager
      const first = await manager.workspaceContext(manager.workspace('project'))
      await expect(first.remote.getConnection()).rejects.toMatchObject({ code: 'ssh_execution_failed' })
      const nextConfig = join(root, 'second-config')
      await writeFile(nextConfig, "Host custom-only\n  HostName second.invalid\n")
      const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'remote-ssh-manager')!
      await entry.update({ config: { ...manager.snapshot(), sshConfigFile: nextConfig } })
      await ctx.loader.await()
      await (manager as unknown as { refreshTail: Promise<void> }).refreshTail
      expect(manager.snapshot().sshConfigFile).toBe(nextConfig)
      await expect(first.remote.getConnection()).rejects.toThrow('disposing')
      const second = await manager.workspaceContext(manager.workspace('project'))
      expect(second.remote).not.toBe(first.remote)
      await expect(second.remote.getConnection()).rejects.toMatchObject({ code: 'ssh_execution_failed' })
      expect(calls.at(-1)![calls.at(-1)!.indexOf('-F') + 1]).toBe(nextConfig)
      const defaults = manager.snapshot()
      delete defaults.sshConfigFile
      await entry.update({ config: defaults })
      await ctx.loader.await()
      await (manager as unknown as { refreshTail: Promise<void> }).refreshTail
      const third = await manager.workspaceContext(manager.workspace('project'))
      await expect(third.remote.getConnection()).rejects.toMatchObject({ code: 'ssh_execution_failed' })
      expect(calls.at(-1)).not.toContain('-F')
    })
  })
})
