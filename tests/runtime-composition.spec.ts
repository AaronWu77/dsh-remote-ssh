/** Artifact-plane regression: build before booting the shipped shell and subprocess entries. */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import Settings from '@deepseek-ai/dsh-settings'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { dump } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import type {} from '../src/local-bridge.ts'
import type {} from '../src/manager.ts'

const dialect = process.platform === 'win32' ? 'pwsh' : 'bash'
const command = dialect === 'pwsh' ? "Write-Output 'composition-local'" : "printf 'composition-local\n'"

async function start(root: string) {
  const first = join(root, 'first')
  const second = join(root, 'second')
  await mkdir(first); await mkdir(second)
  const initial = { dialect, cwd: first, timeoutMs: 30_000, maxTimeoutMs: 60_000, maxOutputBytes: 1024, maxSpillBytes: 4096, graceMs: 3000 }
  const rows = [
    { id: 'local-world', name: 'cordis:group', group: true, isolate: { subprocess: true, fs: true }, config: [
      { id: 'native-fs', name: import.meta.resolve('@deepseek-ai/dsh-fs-sandbox') },
      { id: 'native-subprocess', name: import.meta.resolve('@deepseek-ai/dsh-subprocess-local') },
      { id: 'bridge', name: 'cordis:test-local-bridge' },
    ] },
    { id: 'session', name: import.meta.resolve('@deepseek-ai/dsh-session') },
    { id: 'session-projection', name: import.meta.resolve('@deepseek-ai/dsh-session-projection') },
    { id: 'working-directory', name: import.meta.resolve('@deepseek-ai/dsh-working-directory'), config: { defaultDirectory: first } },
    ...['llm','agent','tools','system-prompt'].map(name => ({ id: name, name: import.meta.resolve('@deepseek-ai/dsh-' + name) })),
    { id: 'agent-loop', name: import.meta.resolve('@deepseek-ai/dsh-agent-loop'), config: { agents: [] } },
    { id: 'fs-router', name: new URL('../lib/router-fs.js', import.meta.url).href },
    { id: 'tool-fs', name: import.meta.resolve('@deepseek-ai/dsh-tool-fs') },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'sandbox', name: 'cordis:test-sandbox' },
    { id: 'sandbox-policy', name: import.meta.resolve('@deepseek-ai/dsh-sandbox-policy'), config: { mode: 'read-only', workspaceRoot: first } },
    { id: 'remote-ssh-manager', name: new URL('../lib/manager.js', import.meta.url).href, config: { aliasRoot: join(root, 'aliases'), servers: [{ id: 'test', label: 'Test', sshTarget: 'must-not-connect' }], workspaces: [{ id: 'remote', serverId: 'test', remotePath: '/srv/project' }] } },
    { id: 'subprocess-router', name: new URL('../lib/router-subprocess.js', import.meta.url).href },
    { id: 'shell', name: new URL('../lib/shell-transparent.js', import.meta.url).href, config: initial },
  ]
  const configPath = join(root, 'cordis.yml')
  const manifest = join(root, 'package.json')
  const patchPath = join(root, 'cordis.patch.yml')
  initProfile(root, ['runtime-test-bundle'])
  const bundle = join(root, 'node_modules', 'runtime-test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'runtime-test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), dump([{ insert: rows }]))
  await writeFile(patchPath, dump([]))
  const profile: ProfileContext = { name: 'test', startedBundles: ['runtime-test-bundle'], dir: root, patchPath, installAnchor: manifest, cwd: first, home: root, overlays: [], telemetryDisabledEnv: undefined }
  await writeFile(configPath, dump([]))
  const ctx = await boot('remote-ssh-runtime-test', configPath, readProfilePatches('test', profile), ctx => {
    ctx.provide('profileContext', profile)
    Object.assign(ctx.loader.builtins, {
      'test-local-bridge': { name: 'test-local-bridge', inject: ['subprocess','fs'], apply(ctx: Context) { ctx.provide('localSubprocess', ctx.subprocess); ctx.provide('localFs', ctx.fs) } },
      settings: Settings, editor: ConfigEditor,
      'test-sandbox': { name: 'test-sandbox', apply(ctx: Context) { ctx.provide('sandbox', { confine: async () => { throw new SandboxUnavailableError('read-only', 'fixture runner unavailable') } } as never) } },
    })
  }, new URL('../', import.meta.url).href)
  return { ctx, initial, second }
}

describe('native shell routing through real YAML composition', () => {
  it('preserves restricted defaults and updates native budgets without remounting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-shell-composition-'))
    let ctx: Context | undefined
    try {
      const started = await start(root); ctx = started.ctx
      expect(ctx.shell.sandboxMode).toBe('read-only')
      const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'shell')!
      const uid = entry.fiber!.uid
      await entry.update({ config: { ...started.initial, cwd: started.second, timeoutMs: 40_000, maxTimeoutMs: 45_000, maxOutputBytes: 2048 } })
      await ctx.loader.await()
      expect(entry.fiber!.uid).toBe(uid)
      const resolved = ctx.shell.resolve({ command, timeoutMs: 90_000 })
      expect(resolved).toMatchObject({ workdir: started.second, timeoutMs: 45_000, stdoutMaxBytes: 2048, sandboxPolicy: { mode: 'read-only' } })
      await expect(ctx.shell.execute(resolved)).rejects.toThrow('fixture runner unavailable')
      const execution = await ctx.shell.execute(ctx.shell.resolve({ command, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: started.second } }))
      const result = await execution.result()
      expect(result.exitCode).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.aborted).toBe(false)
      expect({ text: result.stdout.text.trim(), sandbox: result.sandbox }).toMatchSnapshot()
    } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('rejects session-owned remote restricted calls and removed bindings before local dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-shell-composition-'))
    let ctx: Context | undefined
    try {
      const started = await start(root); ctx = started.ctx
      const owner = {}
      ctx.remoteSshManager.bindSession('remote-session', owner, join(root, 'aliases', 'remote'))
      const request = { command, workdir: started.second, dshEnv: { DSH_SESSION_ID: 'remote-session' } }
      await expect(ctx.shell.execute(ctx.shell.resolve(request))).rejects.toThrow('remote host cannot enforce this sandbox policy')
      ctx.remoteSshManager.unbindSession('remote-session', owner)
      await expect(ctx.shell.execute(ctx.shell.resolve({ ...request, sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: started.second } }))).rejects.toThrow('no execution world is bound')
      await ctx.remoteSshManager.removeWorkspace('remote')
      await expect(ctx.shell.execute(ctx.shell.resolve({ command, workdir: join(root, 'aliases', 'remote') }))).rejects.toThrow('workspace alias is no longer configured')
    } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
  })
  it('stamps session policy onto write and edit while retaining the restricted deployment default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-fs-composition-'))
    let ctx: Context | undefined
    try {
      const started = await start(root); ctx = started.ctx
      expect(ctx.fs.sandboxMode).toBe('read-only')
      const handle = await ctx.agents.create({sessionId:SessionId('filesystem-session'),meta:{cwd:started.initial.cwd}})
      const active = handle.agent
      let calls = 0
      const call = (name:string,args:Record<string,string>) => ctx!.tools.execute({callId:ToolCallId('fs-'+(++calls)),name,arguments:args,agent:active,signal:new AbortController().signal})
      const denied = await call('write',{file_path:'note.txt',content:'initial'})
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain('read-only')
      expect(JSON.stringify(denied)).not.toContain('undefined')
      setSandboxMode(active.session,'danger-full-access')
      expect((await call('write',{file_path:'note.txt',content:'initial'})).isError).toBe(false)
      expect(await readFile(join(started.initial.cwd,'note.txt'),'utf8')).toBe('initial')
      setSandboxMode(active.session,'workspace-write')
      expect((await call('edit',{file_path:'note.txt',old_string:'initial',new_string:'edited'})).isError).toBe(false)
      const outside = await call('write',{file_path:join(started.second,'outside.txt'),content:'blocked'})
      // The native policy also permits its system temporary directory.
      expect(outside.isError).toBe(false)
      expect(await readFile(join(started.second,'outside.txt'),'utf8')).toBe('blocked')
      setSandboxMode(active.session,'read-only')
      expect((await call('edit',{file_path:'note.txt',old_string:'edited',new_string:'blocked'})).isError).toBe(true)
      expect(await readFile(join(started.initial.cwd,'note.txt'),'utf8')).toBe('edited')
      expect(ctx.fs.sandboxMode).toBe('read-only')
      await handle.dispose()
    } finally { await ctx?.fiber.dispose(); await rm(root,{recursive:true,force:true}) }
  })
})
