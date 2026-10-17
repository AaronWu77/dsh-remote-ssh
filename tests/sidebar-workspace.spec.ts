/** Actual AHP SDK requests exercise the remote filesystem provider and cleanup ownership. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '../src/local-bridge.ts'
import { ActionType, AhpErrorCodes, TerminalLifecycleStatus } from '@microsoft/agent-host-protocol'
import { AhpClient, InMemoryTransport, type AhpTransport } from '@microsoft/agent-host-protocol/client'
import type { SidebarWorkspaceProviders } from 'dsh-better-sidebar/workspace-provider'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RemoteSshManager from '../src/manager.ts'
import RemoteSshFileSystem from '../src/fs.ts'
import { fileUriFromPosixPath, posixPathFromFileUri } from '../src/index.ts'
import { createSidebarRemoteWorkspace, resolveConfig, type Config } from '../src/sidebar-workspace.ts'

declare module '@deepseek-ai/cordis' {
  interface Events { 'loader/volatile-update'(paths: readonly (readonly string[])[]): void }
}
const config: Config = {
  pathMetadata: 'ahp',
  fullReadMaxBytes: 64, uploadChunkMaxBytes: 3, writeMaxBytes: 64,
  searchMaxRows: 20, searchMaxItems: 40, searchMaxDepth: 4,
  cleanupGraceMs: 30_000, outputChunkBytes: 1024, outputPollMs: 1,
  terminalArgv: ['bash', '-i'], terminalEnv: { LANG: 'C' }, terminalType: 'xterm-256color',
  gitMaxOutputBytes: 4096, collectionStderrMaxBytes: 4096,
}
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const dispose of cleanups.splice(0).reverse()) { try { await dispose() } catch (error) { errors.push(error) } }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'workspace fixture teardown')
})
class MemorySettings extends Service {
  private owner: Fiber | undefined
  private revision = 0
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure(_presentation: { auto: boolean }, owner: Fiber) { this.owner = owner; return () => { this.owner = undefined } }
  describe() { return [{ ns: 'remote-ssh-manager' as SettingsNamespace, revision: this.revision }] }
  async replace(_namespace: SettingsNamespace, next: Record<string, unknown>, revision: number) {
    if (revision !== this.revision || this.owner === undefined) throw new Error('Settings owner or revision changed')
    updateVolatile(this.owner.config as Volatile<Record<string, unknown>>, createVolatile(structuredClone(next)))
    this.revision++
    this.owner.ctx.emit(this.owner, 'loader/volatile-update', [[]])
  }
}
interface NodeEntry { type: 'file' | 'directory' | 'symlink'; bytes: Buffer; version: number; link?: string; mode?: number }
interface Request { method: string; params: { uri?: string; source?: string; destination?: string; followSymlinks?: boolean; data?: string; encoding?: string; mode?: string; recursive?: boolean; createOnly?: boolean; failIfExists?: boolean; channel?: string; cwd?: string; cols?: number; rows?: number } }

class ResourcePeer {
  readonly nodes = new Map<string, NodeEntry>()
  readonly requests: Request[] = []
  readonly terminalInputs: string[] = []
  readonly terminalNotifications: Array<{ type: string; cols?: number; rows?: number }> = []
  readonly subscriptions = new Set<string>()
  readonly terminals = new Set<string>()
  readonly client: AhpClient
  private readonly remote: AhpTransport
  private readonly receiving: Promise<void>
  private readonly changed = new Set<() => void>()
  private seq = 0
  beforeRequest: ((request: Request) => Promise<void>) | undefined
  afterRead: (() => void) | undefined
  legacyMetadata = false
  denied = new Set<string>()
  constructor() {
    const [transport, remote] = InMemoryTransport.pair()
    this.remote = remote
    this.client = new AhpClient(transport)
    this.client.connect()
    this.receiving = this.receive()
    void this.receiving.catch((_error) => { /* close awaits peer failures. */ })
    cleanups.push(() => this.close())
    for (const path of ['/', '/srv', '/srv/project', '/srv/project/sub', '/outside']) this.dir(path)
  }
  dir(path: string, mode?: number) { this.nodes.set(path, { type: 'directory', bytes: Buffer.alloc(0), version: 1, ...(mode === undefined ? {} : { mode }) }) }
  file(path: string, bytes: string | Buffer) { this.nodes.set(path, { type: 'file', bytes: Buffer.from(bytes), version: (this.nodes.get(path)?.version ?? 0) + 1 }) }
  link(path: string, link: string) { this.nodes.set(path, { type: 'symlink', bytes: Buffer.alloc(0), version: 1, link }) }
  canonical(path: string, follow: boolean): string {
    let candidate = posix.normalize(path)
    for (let tries = 0; tries < 20; tries++) {
      let replaced = false
      const parts = candidate.split('/').filter(Boolean)
      for (let index = 0; index < parts.length; index++) {
        const prefix = '/' + parts.slice(0, index + 1).join('/')
        const node = this.nodes.get(prefix)
        if (node?.type === 'symlink' && (follow || index < parts.length - 1)) {
          candidate = posix.join(node.link!, ...parts.slice(index + 1)); replaced = true; break
        }
      }
      if (!replaced) return candidate
    }
    throw new Error('symlink cycle')
  }
  async waitFor(predicate: () => boolean): Promise<void> {
    if (predicate()) return
    await new Promise<void>(resolve => {
      const changed = () => { if (predicate()) { this.changed.delete(changed); resolve() } }
      this.changed.add(changed); changed()
    })
  }
  private async receive() {
    for (;;) {
      const frame = await this.remote.recv()
      if (frame === null) return
      if (frame.kind !== 'text') throw new Error('Expected JSON SDK frame')
      const message: { id?: number; method: string; params: Request['params'] & { action?: { type: string; data?: string; cols?: number; rows?: number } } } = JSON.parse(frame.text)
      if (message.id === undefined) {
        if (message.method === 'unsubscribe') this.subscriptions.delete(message.params.channel!)
        else if (message.method === 'dispatchAction') {
          const action = message.params.action!
          this.terminalNotifications.push(action)
          if (action.type === ActionType.TerminalInput) {
            this.terminalInputs.push(action.data!)
            this.remote.send({ jsonrpc: '2.0', method: 'action', params: { channel: message.params.channel, serverSeq: ++this.seq, action: { type: ActionType.TerminalData, data: action.data } } })
          }
        } else throw new Error('Unexpected notification ' + message.method)
      } else {
        const request = { method: message.method, params: message.params }
        this.requests.push(request)
        try {
          await this.beforeRequest?.(request)
          const result = this.respond(request)
          this.remote.send({ jsonrpc: '2.0', id: message.id, result })
        } catch (error) {
          const code = error instanceof Error && 'code' in error && typeof error.code === 'number' ? error.code : -32000
          this.remote.send({ jsonrpc: '2.0', id: message.id, error: { code, message: error instanceof Error ? error.message : String(error) } })
        }
      }
      for (const changed of this.changed) changed()
    }
  }
  private respond({ method, params }: Request): object {
    if (method === 'createTerminal') { this.terminals.add(params.channel!); return {} }
    if (method === 'disposeTerminal') { this.terminals.delete(params.channel!); return {} }
    if (method === 'subscribe') {
      this.subscriptions.add(params.channel!)
      return { snapshot: { resource: params.channel, fromSeq: this.seq, state: { title: 'remote', content: [{ type: 'unclassified', value: '\x1b[32mremote$\x1b[0m ' }], lifecycle: { status: TerminalLifecycleStatus.Running }, claim: { kind: 'client', clientId: 'fixture' } } } }
    }
    const path = params.uri ? posixPathFromFileUri(params.uri) : ''
    if (this.denied.has(path)) throw Object.assign(new Error('permission denied'), { code: AhpErrorCodes.PermissionDenied })
    const canonical = this.canonical(path, this.legacyMetadata || params.followSymlinks !== false)
    const node = this.nodes.get(canonical)
    if (method === 'resourceResolve') {
      if (!node) throw Object.assign(new Error('missing'), { code: AhpErrorCodes.NotFound })
      return { uri: this.legacyMetadata ? params.uri : fileUriFromPosixPath(canonical), type: node.type, size: node.bytes.byteLength, etag: String(node.version) }
    }
    if (method === 'resourceRead') {
      if (node?.type !== 'file') throw Object.assign(new Error('missing file'), { code: AhpErrorCodes.NotFound })
      const result = { data: node.bytes.toString('base64'), encoding: 'base64' }
      this.afterRead?.()
      return result
    }
    if (method === 'resourceMkdir') {
      const parts = path.split('/').filter(Boolean)
      for (let index = 0; index < parts.length; index++) {
        const parent = '/' + parts.slice(0, index + 1).join('/')
        if (!this.nodes.has(parent)) this.dir(parent)
      }
      return {}
    }
    if (method === 'resourceWrite') {
      if (params.createOnly && this.nodes.has(canonical)) throw Object.assign(new Error('exists'), { code: AhpErrorCodes.AlreadyExists })
      if (!this.nodes.has(posix.dirname(canonical))) throw new Error('missing parent')
      const bytes = Buffer.from(params.data!, params.encoding === 'base64' ? 'base64' : 'utf8')
      this.file(canonical, params.mode === 'append' ? Buffer.concat([node?.bytes ?? Buffer.alloc(0), bytes]) : bytes)
      return {}
    }
    if (method === 'resourceList') {
      if (node?.type !== 'directory') throw new Error('not directory')
      return { entries: [...this.nodes].flatMap(([child, info]) => posix.dirname(child) === canonical && child !== canonical ? [{ name: posix.basename(child), type: info.type, size: info.bytes.byteLength }] : []) }
    }
    if (method === 'resourceMove') {
      const source = posixPathFromFileUri(params.source!)
      const destination = posixPathFromFileUri(params.destination!)
      const info = this.nodes.get(source)
      if (!info) throw Object.assign(new Error('missing source'), { code: AhpErrorCodes.NotFound })
      if (params.failIfExists && this.nodes.has(destination)) throw Object.assign(new Error('exists'), { code: AhpErrorCodes.AlreadyExists })
      this.nodes.set(destination, info); this.nodes.delete(source)
      return {}
    }
    if (method === 'resourceDelete') {
      const info = this.nodes.get(path)
      if (!info) throw Object.assign(new Error('missing'), { code: AhpErrorCodes.NotFound })
      if (params.recursive && info.type === 'directory') for (const candidate of [...this.nodes.keys()]) { if (candidate.startsWith(path + '/')) this.nodes.delete(candidate) }
      this.nodes.delete(path)
      return {}
    }
    throw new Error('Unexpected resource method ' + method)
  }
  async close() { await this.client.shutdown(); await this.remote.close(); await this.receiving }
}

async function setup(overrides: Partial<Config> = {}, cwd = '/srv/project/sub') {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-workspace-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const peer = new ResourcePeer()
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(MemorySettings).await()
  await ctx.plugin(RemoteSshManager, {
    aliasRoot: root, servers: [{ id: 'devbox', label: 'Devbox', sshTarget: 'no-ssh-in-tests' }],
    workspaces: [{ id: 'project', serverId: 'devbox', remotePath: '/srv/project' }],
  }).await()
  const manager = ctx.remoteSshManager
  const route = manager.workspace('project')
  const remote = { clientId: 'fixture', runtimeRoot: '/tmp/not-acquired', mapper: route.mapper, getClient: async () => peer.client }
  ctx.provide('remoteSsh', remote as never)
  await ctx.plugin(RemoteSshFileSystem, { localWorkspace: route.aliasPath, remoteWorkspace: route.workspace.remotePath, diffBasisMaxBytes: 1024, maxReadBytes: 4096 }).await()
  const context = vi.spyOn(manager, 'workspaceContext').mockResolvedValue({ ctx, remote: remote as never, fs: ctx.fs as RemoteSshFileSystem })
  const execute = vi.fn(async (spec: { command: string }) => {
    if (spec.command.startsWith("set -o pipefail; stat --printf='%n\\0%F\\0' -- ")) {
      const quoted = (path: string) => "'" + path.replaceAll("'", "'\\''") + "'"
      const paths = [...peer.nodes.keys()].filter(path => spec.command.includes(quoted(path))).sort((a, b) => spec.command.indexOf(quoted(a)) - spec.command.indexOf(quoted(b)))
      const text = paths.map(path => { const type = peer.nodes.get(path)!.type; return path + '\0' + (type === 'symlink' ? 'symbolic link' : type === 'directory' ? 'directory' : 'regular file') + '\0' }).join('')
      return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: Buffer.from(text).toString('base64'), truncated: false } }), quiescent: Promise.resolve() }
    }
    const canonicalPath = /^set -o pipefail; realpath -z -m -- '([\s\S]*)' \| base64 -w0$/.exec(spec.command)?.[1]
    if (canonicalPath !== undefined) {
      const encoded = Buffer.from(peer.canonical(canonicalPath.replaceAll("'\\''", "'"), true) + '\0').toString('base64')
      return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: encoded, truncated: false } }), quiescent: Promise.resolve() }
    }
    const statPath = /^stat --printf='%F' -- '([\s\S]*)'$/.exec(spec.command)?.[1]
    if (statPath !== undefined) {
      const node = peer.nodes.get(statPath.replaceAll("'\\''", "'"))
      const type = node?.type
      const text = type === 'symlink' ? 'symbolic link' : type === 'directory' ? 'directory' : type === 'file' ? 'regular file' : 'stat: cannot stat: No such file or directory\n'
      return { result: async () => ({ exitCode: type ? 0 : 1, signal: null, timedOut: false, aborted: false, stdout: { text, truncated: false } }), quiescent: Promise.resolve() }
    }
    const match = /^umask 077; mkdir -- '([^']+)'$/.exec(spec.command)
    if (!match) throw new Error('Expected private directory command')
    if (peer.nodes.has(match[1]!)) throw new Error('mkdir collision')
    peer.dir(match[1]!, 0o700)
    return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false }), quiescent: Promise.resolve() }
  })
  const shell = vi.spyOn(manager, 'workspaceShell').mockResolvedValue({ resolve: (spec: object) => spec, execute } as never)
  const errors: Pick<SidebarWorkspaceProviders, 'workspaceError' | 'gitCommandError'> = {
    workspaceError: vi.fn((code, message, status) => Object.assign(new Error(message), { code, status })),
    gitCommandError: vi.fn((message, command, exitCode) => Object.assign(new Error(message), { code: 'git-error', command, exitCode })),
  }
  const workspace = createSidebarRemoteWorkspace(manager, route, cwd, resolveConfig({ ...config, ...overrides }), errors)
  return { root, ctx, manager, route, peer, workspace, errors, execute, context, shell }
}
const chunks = (...parts: Array<string | Uint8Array>) => (async function* () { for (const part of parts) yield part })()
const privatePaths = (peer: ResourcePeer) => [...peer.nodes.keys()].filter(path => path.includes('/.dsh-sidebar-'))

describe('explicit remote Sidebar workspace config', () => {
  it.each(['fullReadMaxBytes', 'uploadChunkMaxBytes', 'writeMaxBytes', 'searchMaxRows', 'searchMaxItems', 'searchMaxDepth', 'cleanupGraceMs', 'outputChunkBytes', 'outputPollMs', 'gitMaxOutputBytes', 'collectionStderrMaxBytes'] as const)('rejects missing/invalid %s instead of defaulting', name => {
    expect(() => resolveConfig({ ...config, [name]: 0 })).toThrow(name)
    expect(() => resolveConfig({ ...config, [name]: Number.NaN })).toThrow(name)
  })
  it('clones terminal argv and env and rejects unsafe values', () => {
    const resolved = resolveConfig(config)
    expect(resolved.terminalArgv).not.toBe(config.terminalArgv)
    expect(resolved.terminalEnv).not.toBe(config.terminalEnv)
    expect(() => resolveConfig({ ...config, terminalArgv: [] })).toThrow('terminalArgv')
    expect(() => resolveConfig({ ...config, terminalEnv: { 'bad-key': 'value' } })).toThrow('terminalEnv')
    expect(() => resolveConfig({ ...config, terminalType: '' })).toThrow('terminalType')
  })
})

describe('remote filesystem through the real AHP SDK', () => {
  it('keeps canonical fences and lexical symlink deletion when deployed AHP metadata ignores followSymlinks', async () => {
    const { peer, workspace, execute } = await setup({ pathMetadata: 'posix' })
    peer.legacyMetadata = true
    peer.file('/outside/target.txt', 'outside')
    peer.link('/srv/project/sub/link.txt', '/outside/target.txt')
    peer.file('/srv/project/sub/quote\'s\n中文.txt', 'inside')
    await expect(workspace.fs.read('link.txt', 64, true)).rejects.toMatchObject({ status: 403 })
    expect((await workspace.fs.read('link.txt', 64, false)).content).toBe('outside')
    expect((await workspace.fs.read('quote\'s\n中文.txt', 64, true)).content).toBe('inside')
    const listing = await workspace.fs.list(workspace.cwd, 20, true)
    expect(listing.entries.find(row => row.name === 'link.txt')).toMatchObject({ isSymlink: true })
    expect(await workspace.fs.search('中文')).toEqual({ matches: ['quote\'s\n中文.txt'], truncated: false })
    expect(execute.mock.calls.filter(([spec]) => spec.command.startsWith("set -o pipefail; stat --printf='%n\\0%F\\0' -- "))).toHaveLength(2)
    await workspace.fs.rename('link.txt', 'renamed-link.txt', true)
    await workspace.fs.remove('renamed-link.txt', true)
    expect(peer.nodes.has('/outside/target.txt')).toBe(true)
    expect(execute.mock.calls.some(([spec]) => spec.command.startsWith('set -o pipefail; realpath -z -m -- '))).toBe(true)
  })

  it('rejects incomplete canonical path command output before reading any resource bytes', async () => {
    const { peer, workspace, execute } = await setup({ pathMetadata: 'posix' })
    peer.file('/srv/project/sub/read.txt', 'inside')
    execute.mockResolvedValue({ result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: '', truncated: true } }), quiescent: Promise.resolve() })
    await expect(workspace.fs.read('read.txt', 64, true)).rejects.toMatchObject({ status: 503 })
    expect(peer.requests.some(request => request.method === 'resourceRead')).toBe(false)
  })

  it('retains uncertain POSIX metadata cleanup in both bridge and manager ownership', async () => {
    const { workspace, manager, route, execute } = await setup({ pathMetadata: 'posix' })
    const entered = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>()
    execute.mockImplementation(async () => {
      entered.resolve()
      return { result: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: Buffer.from(workspace.cwd + '\0').toString('base64'), truncated: false } }), quiescent: cleanup.promise }
    })
    const reading = workspace.fs.resolve('.', true)
    const failed = expect(reading).rejects.toMatchObject({ status: 503, message: expect.stringContaining('metadata cleanup unobservable') })
    cleanups.push(async () => { cleanup.resolve(); await reading.catch(() => undefined) })
    await entered.promise
    cleanup.reject(new Error('metadata shell unsubscribe ACK missing'))
    await failed
    await expect(workspace.dispose()).rejects.toMatchObject({ errors: [expect.objectContaining({ status: 503, message: expect.stringContaining('metadata cleanup unobservable') })] })
    expect(manager.workspace(route.workspace.id)).toBe(route)
    let removed = false
    await expect(manager.removeRegisteredWorkspace(route.aliasPath, async () => { removed = true; return true })).rejects.toThrow('metadata cleanup unobservable')
    expect(removed).toBe(false)
  })

  it('keeps nested Session fences and POSIX semantics on the selected host', async () => {
    const { peer, workspace, route } = await setup()
    peer.file('/srv/project/sub/read.txt', 'inside')
    peer.file('/srv/project/parent.txt', 'parent')
    expect(workspace.cwd).toBe('/srv/project/sub')
    expect(workspace.paths.absolute(join(route.aliasPath, 'sub', 'read.txt'))).toBe('/srv/project/sub/read.txt')
    await expect(workspace.fs.resolve('read.txt', true)).resolves.toBe('/srv/project/sub/read.txt')
    await expect(workspace.fs.resolve('../parent.txt', true)).rejects.toMatchObject({ status: 403 })
    await expect(workspace.fs.read('../parent.txt', 64, false)).resolves.toMatchObject({ content: 'parent' })
    expect(() => workspace.paths.absolute('Z:\\unrelated\\file.txt')).toThrow()
    await expect(workspace.fs.exists('missing.txt')).resolves.toBe(false)
    peer.denied.add('/srv/project/sub/denied.txt')
    await expect(workspace.fs.exists('denied.txt')).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })
  it('uses the canonical Session directory when its header path is a symlink', async () => {
    const { peer, workspace } = await setup()
    peer.dir('/outside/session')
    peer.link('/srv/project/sub', '/outside/session')
    peer.file('/outside/session/read.txt', 'canonical')
    expect(await workspace.fs.read('read.txt', 64, true)).toMatchObject({ content: 'canonical' })
    expect(await workspace.fs.upload({ dir: workspace.cwd, relativePath: 'uploaded.txt', chunks: chunks('upload'), limit: 64, fence: true })).toEqual({ path: '/outside/session/uploaded.txt', size: 6 })
    expect(await workspace.fs.rename('/outside/session/uploaded.txt', 'renamed.txt', true)).toEqual({ path: '/outside/session/renamed.txt' })
    await expect(workspace.fs.read('/srv/project/parent.txt', 64, true)).rejects.toMatchObject({ status: 403 })
  })
  it('refuses canonical symlink escape even when the lexical row lies inside the Session', async () => {
    const { peer, workspace } = await setup()
    peer.file('/outside/file.txt', 'secret')
    peer.link('/srv/project/sub/link', '/outside')
    await expect(workspace.fs.read('link/file.txt', 64, true)).rejects.toMatchObject({ status: 403 })
    await expect(workspace.fs.read('link/file.txt', 64, false)).resolves.toMatchObject({ content: 'secret' })
  })
  it('returns byte-safe text preview, binary head and complete media bytes', async () => {
    const { peer, workspace } = await setup()
    peer.file('/srv/project/sub/unicode.txt', 'A汉字Z')
    expect(await workspace.fs.read('unicode.txt', 3, true)).toMatchObject({ content: 'A', truncated: true, size: 8, binary: false })
    expect(await workspace.fs.readBytes('unicode.txt', 8, true)).toEqual(Buffer.from('A汉字Z'))
    peer.file('/srv/project/sub/binary', Buffer.from([0, 255, 1]))
    expect(await workspace.fs.read('binary', 64, true)).toEqual({ content: '', binary: true, size: 3, truncated: false, head: 'AP8B' })
  })
  it('rejects oversized whole-resource reads before issuing resourceRead', async () => {
    const { peer, workspace } = await setup({ fullReadMaxBytes: 4 })
    peer.file('/srv/project/sub/large', '12345')
    await expect(workspace.fs.read('large', 2, true)).rejects.toMatchObject({ status: 413 })
    await expect(workspace.fs.readBytes('large', 100, true)).rejects.toMatchObject({ status: 413 })
    expect(peer.requests.filter(request => request.method === 'resourceRead')).toHaveLength(0)
  })
  it('rejects changed post-read metadata instead of returning inconsistent bytes', async () => {
    const { peer, workspace } = await setup()
    peer.file('/srv/project/sub/read', 'original')
    peer.afterRead = () => peer.file('/srv/project/sub/read', 'modified')
    await expect(workspace.fs.readBytes('read', 64, true)).rejects.toMatchObject({ status: 409 })
  })
  it('preserves lexical symlink row paths and bounded explorer results', async () => {
    const { peer, workspace } = await setup()
    peer.link('/srv/project/sub/external', '/outside')
    peer.link('/srv/project/sub/broken', '/missing')
    peer.file('/srv/project/sub/file', 'x')
    expect((await workspace.fs.list(workspace.cwd, 20, true)).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'external', path: '/srv/project/sub/external', isDir: true, isSymlink: true }),
      expect.objectContaining({ name: 'broken', broken: true, isSymlink: true }),
    ]))
    expect(await workspace.fs.list(workspace.cwd, 1, true)).toMatchObject({ entries: [expect.any(Object)], truncated: true })
  })
  it('renames and deletes symlink rows without following their targets', async () => {
    const { peer, workspace } = await setup()
    peer.file('/outside/kept', 'safe')
    peer.link('/srv/project/sub/external', '/outside')
    await expect(workspace.fs.rename('external', 'renamed', true)).resolves.toEqual({ path: '/srv/project/sub/renamed' })
    expect(peer.nodes.get('/srv/project/sub/renamed')?.type).toBe('symlink')
    await workspace.fs.remove('renamed', true)
    expect(peer.nodes.get('/outside/kept')?.bytes.toString()).toBe('safe')
    expect(peer.requests.findLast(request => request.method === 'resourceDelete')?.params).toMatchObject({ uri: 'file:///srv/project/sub/renamed', recursive: false })
    const count = peer.requests.filter(request => ['resourceMove', 'resourceDelete'].includes(request.method)).length
    await expect(workspace.fs.rename(workspace.cwd, 'root', false)).rejects.toMatchObject({ status: 403 })
    await expect(workspace.fs.remove(workspace.cwd, false)).rejects.toMatchObject({ status: 403 })
    expect(peer.requests.filter(request => ['resourceMove', 'resourceDelete'].includes(request.method))).toHaveLength(count)
  })
  it('rejects existing rename destinations and lexical escape without mutation', async () => {
    const { peer, workspace } = await setup()
    peer.file('/srv/project/sub/source', 'source')
    peer.file('/srv/project/sub/destination', 'kept')
    await expect(workspace.fs.rename('source', 'destination', true)).rejects.toMatchObject({ status: 409 })
    await expect(workspace.fs.rename('source', '../escape', true)).rejects.toMatchObject({ status: 400 })
    expect(peer.requests.some(request => request.method === 'resourceMove')).toBe(false)
  })
})

describe('private publication and acknowledged cleanup', () => {
  it('publishes uploads only after bounded byte appends and deletes private staging', async () => {
    const { peer, workspace, execute } = await setup()
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    peer.beforeRequest = async request => {
      if (request.method === 'resourceWrite' && request.params.mode === 'append') { entered.resolve(); await resume.promise }
    }
    const input = { dir: workspace.cwd, relativePath: 'nested/upload', chunks: chunks('汉', Buffer.from([0, 255, 3, 7])), limit: 32, fence: true }
    const uploading = workspace.fs.upload(input)
    cleanups.push(async () => { resume.resolve(); await Promise.allSettled([uploading]) })
    await entered.promise
    expect(peer.nodes.has('/srv/project/sub/nested/upload')).toBe(false)
    expect(privatePaths(peer).length).toBeGreaterThan(0)
    expect(peer.nodes.get(privatePaths(peer)[0]!)?.mode).toBe(0o700)
    resume.resolve()
    expect(await uploading).toEqual({ path: '/srv/project/sub/nested/upload', size: 7 })
    expect(peer.nodes.get('/srv/project/sub/nested/upload')?.bytes).toEqual(Buffer.concat([Buffer.from('汉'), Buffer.from([0, 255, 3, 7])]))
    expect(privatePaths(peer)).toEqual([])
    expect(execute.mock.calls[0]?.[0].command).toMatch(/^umask 077; mkdir -- '/)
    const writes = peer.requests.filter(request => request.method === 'resourceWrite')
    expect(writes[0]?.params.createOnly).toBe(true)
    expect(writes.slice(1).every(request => Buffer.from(request.params.data!, 'base64').byteLength <= 3)).toBe(true)
    expect(peer.requests.find(request => request.method === 'resourceMove')?.params.failIfExists).toBe(true)
  })
  it('keeps existing upload destinations and refuses a publication race', async () => {
    const { peer, workspace } = await setup()
    peer.file('/srv/project/sub/existing', 'kept')
    await expect(workspace.fs.upload({ dir: workspace.cwd, relativePath: 'existing', chunks: chunks('new'), limit: 64, fence: true })).rejects.toMatchObject({ status: 409 })
    peer.beforeRequest = async request => { if (request.method === 'resourceMove') peer.file('/srv/project/sub/race', 'racer') }
    await expect(workspace.fs.upload({ dir: workspace.cwd, relativePath: 'race', chunks: chunks('new'), limit: 64, fence: true })).rejects.toThrow('exists')
    expect(peer.nodes.get('/srv/project/sub/existing')?.bytes.toString()).toBe('kept')
    expect(peer.nodes.get('/srv/project/sub/race')?.bytes.toString()).toBe('racer')
    expect(privatePaths(peer)).toEqual([])
  })
  it('replaces text atomically and rejects write/upload byte overflow without publishing', async () => {
    const { peer, workspace } = await setup({ writeMaxBytes: 4 })
    peer.file('/srv/project/sub/file', 'old')
    await workspace.fs.write('file', 'new', true)
    expect(peer.nodes.get('/srv/project/sub/file')?.bytes.toString()).toBe('new')
    await expect(workspace.fs.write('file', '汉字', true)).rejects.toMatchObject({ status: 413 })
    await expect(workspace.fs.upload({ dir: workspace.cwd, relativePath: 'large', chunks: chunks('12', '345'), limit: 4, fence: true })).rejects.toMatchObject({ status: 413 })
    expect(peer.nodes.has('/srv/project/sub/large')).toBe(false)
    expect(privatePaths(peer)).toEqual([])
  })
  it('bridge revocation drains pending upload and cleanup ACK without retiring the shared route', async () => {
    const { peer, workspace, manager, route } = await setup()
    const appendEntered = Promise.withResolvers<void>(); const appendResume = Promise.withResolvers<void>()
    const cleanupEntered = Promise.withResolvers<void>(); const cleanupResume = Promise.withResolvers<void>()
    peer.beforeRequest = async request => {
      if (request.method === 'resourceWrite' && request.params.mode === 'append') { appendEntered.resolve(); await appendResume.promise }
      if (request.method === 'resourceDelete') { cleanupEntered.resolve(); await cleanupResume.promise }
    }
    const uploading = workspace.fs.upload({ dir: workspace.cwd, relativePath: 'revoked', chunks: chunks('bytes'), limit: 64, fence: true })
    const failed = expect(uploading).rejects.toMatchObject({ status: 503, code: 'workspace-unavailable' })
    let disposal: Promise<void> | undefined
    cleanups.push(async () => { appendResume.resolve(); cleanupResume.resolve(); await Promise.allSettled([uploading, ...(disposal ? [disposal] : [])]) })
    await appendEntered.promise
    let disposed = false
    disposal = workspace.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    await expect(workspace.fs.read('file', 10, true)).rejects.toMatchObject({ status: 503 })
    await expect(workspace.git.run(workspace.cwd, ['status'], 1000)).rejects.toMatchObject({ status: 503 })
    appendResume.resolve()
    await cleanupEntered.promise
    expect(disposed).toBe(false)
    cleanupResume.resolve()
    await Promise.all([failed, disposal])
    expect(manager.workspace(route.workspace.id)).toBe(route)
    expect(peer.nodes.has('/srv/project/sub/revoked')).toBe(false)
    expect(privatePaths(peer)).toEqual([])
  })

  it('retirement waits for pending append and cleanup ACK without publishing late content', async () => {
    const { peer, workspace, manager, route } = await setup()
    const appendEntered = Promise.withResolvers<void>()
    const appendResume = Promise.withResolvers<void>()
    const cleanupEntered = Promise.withResolvers<void>()
    const cleanupResume = Promise.withResolvers<void>()
    const retiring = Promise.withResolvers<void>()
    peer.beforeRequest = async request => {
      if (request.method === 'resourceWrite' && request.params.mode === 'append') { appendEntered.resolve(); await appendResume.promise }
      if (request.method === 'resourceDelete') { cleanupEntered.resolve(); await cleanupResume.promise }
    }
    const uploading = workspace.fs.upload({ dir: workspace.cwd, relativePath: 'retired', chunks: chunks('bytes'), limit: 64, fence: true })
    const failed = expect(uploading).rejects.toMatchObject({ status: 503, code: 'workspace-unavailable' })
    manager.ownExecution(route, { terminate: () => { retiring.resolve() }, done: Promise.resolve() })
    let deletion: Promise<boolean> | undefined
    cleanups.push(async () => { appendResume.resolve(); cleanupResume.resolve(); await Promise.allSettled([uploading, ...(deletion ? [deletion] : [])]) })
    await appendEntered.promise
    let removed = false
    deletion = manager.removeRegisteredWorkspace(route.aliasPath, async () => { removed = true; return true })
    await retiring.promise
    expect(removed).toBe(false)
    appendResume.resolve()
    await cleanupEntered.promise
    expect(removed).toBe(false)
    expect(peer.nodes.has('/srv/project/sub/retired')).toBe(false)
    cleanupResume.resolve()
    await failed
    await expect(deletion).resolves.toBe(true)
    expect(privatePaths(peer)).toEqual([])
  })
  it('retains unknown private cleanup ownership and rejects retirement', async () => {
    const { peer, workspace, manager, route } = await setup()
    peer.beforeRequest = async request => { if (request.method === 'resourceDelete') throw new Error('cleanup ACK failed') }
    await expect(workspace.fs.upload({ dir: workspace.cwd, relativePath: 'published', chunks: chunks('x'), limit: 4, fence: true })).rejects.toThrow('cleanup unobservable')
    expect(privatePaths(peer).length).toBeGreaterThan(0)
    let removed = false
    await expect(manager.removeRegisteredWorkspace(route.aliasPath, async () => { removed = true; return true })).rejects.toThrow('cleanup unobservable')
    expect(removed).toBe(false)
  })
  it('awaits delete ACK before reporting upload success', async () => {
    const { peer, workspace } = await setup()
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    peer.beforeRequest = async request => { if (request.method === 'resourceDelete') { entered.resolve(); await resume.promise } }
    let completed = false
    const uploading = workspace.fs.upload({ dir: workspace.cwd, relativePath: 'published', chunks: chunks('x'), limit: 4, fence: true }).then(value => { completed = true; return value })
    cleanups.push(async () => { resume.resolve(); await Promise.allSettled([uploading]) })
    await entered.promise
    expect(completed).toBe(false)
    expect(peer.nodes.has('/srv/project/sub/published')).toBe(true)
    resume.resolve()
    await uploading
    expect(privatePaths(peer)).toEqual([])
  })
})

describe('remote search, retirement and terminals', () => {
  it('returns relative names without walking symlinks, VCS or build/dependency directories', async () => {
    const { peer, workspace } = await setup()
    peer.dir('/srv/project/sub/deep')
    for (const name of ['.GIT', 'Node_Modules', '.cache', 'dist']) {
      peer.dir('/srv/project/sub/' + name); peer.file('/srv/project/sub/' + name + '/File.txt', 'noise')
    }
    peer.file('/srv/project/sub/deep/File.txt', 'x')
    peer.file('/outside/File.txt', 'secret'); peer.link('/srv/project/sub/out', '/outside')
    expect(await workspace.fs.search(' FILE ')).toEqual({ matches: ['deep/File.txt'], truncated: false })
    expect(peer.requests.filter(request => request.method === 'resourceList').map(request => request.params.uri)).toEqual([
      'file:///srv/project/sub', 'file:///srv/project/sub/deep',
    ])
  })
  it('returns useful root matches when a deeper directory exceeds its row budget', async () => {
    const { peer, workspace } = await setup({ searchMaxRows: 2 })
    peer.file('/srv/project/sub/README.md', 'root')
    peer.dir('/srv/project/sub/data')
    for (let index = 0; index < 5; index++) peer.file('/srv/project/sub/data/item' + index, 'x')
    expect(await workspace.fs.search('readme')).toEqual({ matches: ['README.md'], truncated: true })
    const children = peer.requests.filter(request => request.method === 'resourceResolve' && request.params.followSymlinks === false)
    expect(children.filter(request => request.params.uri?.includes('/data/item'))).toHaveLength(2)
  })
  it('caps total examined entries and never enters queued directories after exhaustion', async () => {
    const { peer, workspace } = await setup({ searchMaxItems: 2 })
    peer.file('/srv/project/sub/README.md', 'root'); peer.dir('/srv/project/sub/data')
    peer.file('/srv/project/sub/data/README.md', 'child')
    expect(await workspace.fs.search('readme')).toEqual({ matches: ['README.md'], truncated: true })
    expect(peer.requests.filter(request => request.method === 'resourceList')).toHaveLength(1)
  })
  it('keeps shallower matches when the depth budget skips a deeper directory', async () => {
    const { peer, workspace } = await setup({ searchMaxDepth: 1 })
    peer.dir('/srv/project/sub/a'); peer.dir('/srv/project/sub/a/b')
    peer.file('/srv/project/sub/README.md', 'root'); peer.file('/srv/project/sub/a/README.md', 'one')
    peer.file('/srv/project/sub/a/b/README.md', 'two')
    expect(await workspace.fs.search('readme')).toEqual({ matches: ['README.md', 'a/README.md'], truncated: true })
    expect(peer.requests.some(request => request.method === 'resourceList' && request.params.uri?.endsWith('/a/b'))).toBe(false)
  })
  it('caps matching rows, including directories and lexical links, without reading file contents', async () => {
    const { peer, workspace } = await setup({ searchMaxRows: 2 })
    peer.dir('/srv/project/sub/readme-folder'); peer.link('/srv/project/sub/README-link', '/outside')
    expect(await workspace.fs.search('readme')).toEqual({ matches: ['README-link', 'readme-folder'], truncated: true })
    expect(peer.requests.filter(request => request.method === 'resourceRead')).toEqual([])
    expect(peer.requests.filter(request => request.method === 'resourceList')).toHaveLength(1)
  })
  it('returns an empty completed result without allocation for a blank query', async () => {
    const { peer, workspace, context } = await setup()
    expect(await workspace.fs.search('  ')).toEqual({ matches: [], truncated: false })
    expect(context).not.toHaveBeenCalled(); expect(peer.requests).toEqual([])
  })
  it('distinguishes a completed no-match search from truncation and a transport/permission failure', async () => {
    const { peer, workspace } = await setup()
    peer.file('/srv/project/sub/README.md', 'root')
    expect(await workspace.fs.search('absent')).toEqual({ matches: [], truncated: false })
    peer.denied.add('/srv/project/sub')
    await expect(workspace.fs.search('readme')).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })
  it('rejects an already-aborted caller before resource or context allocation', async () => {
    const { peer, workspace, context } = await setup()
    const cancelled = new Error('caller cancelled')
    await expect(workspace.fs.search('readme', AbortSignal.abort(cancelled))).rejects.toBe(cancelled)
    expect(context).not.toHaveBeenCalled(); expect(peer.requests).toEqual([])
  })
  it('awaits an in-flight listing after caller cancellation and never continues traversal', async () => {
    const { peer, workspace } = await setup()
    peer.dir('/srv/project/sub/deep'); peer.file('/srv/project/sub/deep/README.md', 'child')
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
    peer.beforeRequest = async request => { if (request.method === 'resourceList') { entered.resolve(); await resume.promise } }
    const controller = new AbortController(), cancelled = new Error('query superseded')
    let settled = false
    const search = workspace.fs.search('readme', controller.signal).finally(() => { settled = true })
    const rejected = expect(search).rejects.toBe(cancelled)
    cleanups.push(async () => { resume.resolve(); await search.catch(() => undefined) })
    await entered.promise; controller.abort(cancelled)
    expect(settled).toBe(false)
    resume.resolve(); await rejected
    expect(peer.requests.filter(request => request.method === 'resourceList')).toHaveLength(1)
    await workspace.dispose()
  })
  it('rejects a stale route before any context allocation or terminal effect', async () => {
    const { manager, workspace, route, context, peer } = await setup()
    vi.spyOn(manager, 'workspace').mockReturnValue({ ...route })
    await expect(workspace.fs.exists('file')).rejects.toMatchObject({ status: 503, code: 'workspace-unavailable' })
    await expect(workspace.createTerminal({ cwd: workspace.cwd, cols: 80, rows: 24 })).rejects.toMatchObject({ status: 503 })
    expect(context).not.toHaveBeenCalled()
    expect(peer.requests).toEqual([])
  })
  it('refuses ownership before scheduled filesystem allocation', async () => {
    const { manager, workspace, context, peer } = await setup()
    vi.spyOn(manager, 'ownExecution').mockImplementation(() => { throw new Error('ownership refused') })
    await expect(workspace.fs.exists('file')).rejects.toThrow('ownership refused')
    expect(context).not.toHaveBeenCalled()
    expect(peer.requests).toEqual([])
  })
  it('rejects aborted allocation, invalid geometry and file cwd before terminal side effects', async () => {
    const { peer, workspace } = await setup()
    peer.file('/srv/project/sub/file', 'x')
    await expect(workspace.createTerminal({ cwd: '/srv/project/sub/file', cols: 80, rows: 24 })).rejects.toMatchObject({ status: 400 })
    await expect(workspace.createTerminal({ cwd: workspace.cwd, cols: 0, rows: 24 })).rejects.toMatchObject({ status: 400 })
    await expect(workspace.createTerminal({ cwd: workspace.cwd, cols: 80, rows: 24, signal: AbortSignal.abort() })).rejects.toMatchObject({ status: 503 })
    expect(peer.requests.some(request => request.method === 'createTerminal')).toBe(false)
  })
  it('revokes a resident terminal immediately and awaits backend ACK without changing the shared route', async () => {
    const { peer, workspace, manager, route } = await setup()
    const terminal = await workspace.createTerminal({ cwd: workspace.cwd, cols: 80, rows: 24 })
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
    peer.beforeRequest = async request => { if (request.method === 'disposeTerminal') { entered.resolve(); await release.promise } }
    cleanups.push(async () => { release.resolve(); await terminal.terminate() })
    let disposed = false
    const disposal = workspace.dispose().then(() => { disposed = true })
    await entered.promise
    expect(disposed).toBe(false)
    const notifications = peer.terminalNotifications.length
    await expect(terminal.write('must not reach old bridge')).rejects.toMatchObject({ status: 503 })
    await expect(terminal.resize(99, 30)).rejects.toMatchObject({ status: 503 })
    await expect(workspace.createTerminal({ cwd: workspace.cwd, cols: 80, rows: 24 })).rejects.toMatchObject({ status: 503 })
    expect(peer.terminalNotifications).toHaveLength(notifications)
    release.resolve()
    await disposal
    expect(disposed).toBe(true)
    expect(peer.terminals.size).toBe(0); expect(peer.subscriptions.size).toBe(0)
    expect(manager.workspace(route.workspace.id)).toBe(route)
  })

  it('allocates a terminal on the authorized route and retains raw VT bytes and explicit configuration', async () => {
    const { peer, workspace, manager, route } = await setup()
    const routeShell = vi.spyOn(manager, 'routeShell')
    const terminal = await workspace.createTerminal({ cwd: workspace.cwd, cols: 91, rows: 31 })
    cleanups.push(() => terminal.terminate())
    const iterator = terminal.output[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(Buffer.from(first.value!).toString()).toContain('\x1b[32mremote$\x1b[0m ')
    await terminal.write('once\r')
    await terminal.resize(100, 40)
    await peer.waitFor(() => peer.terminalInputs.includes('once\r') && peer.terminalNotifications.some(action => action.cols === 100))
    expect(peer.terminalInputs.filter(input => input === 'once\r')).toHaveLength(1)
    expect(peer.terminalInputs[0]).toContain("'LANG=C'")
    expect(peer.terminalInputs[0]).toContain("'TERM=xterm-256color'")
    expect(peer.terminalInputs[0]).toContain("'bash' '-i'")
    await iterator.return?.()
    await terminal.write('after-detach\r')
    await peer.waitFor(() => peer.terminalInputs.includes('after-detach\r'))
    expect(peer.terminals.size).toBe(1)
    const reattached = terminal.output[Symbol.asyncIterator]()
    let observed = ''
    while (!observed.includes('after-detach\r')) {
      const next = await reattached.next()
      if (next.done) throw new Error('Detachment ended the backend output')
      observed += Buffer.from(next.value).toString('utf8')
    }
    await reattached.return?.()
    expect(peer.requests.find(request => request.method === 'createTerminal')?.params).toMatchObject({ cwd: 'file:///srv/project/sub', cols: 91, rows: 31 })
    expect(routeShell).not.toHaveBeenCalled()
    expect(workspace.git.joinPath(route.aliasPath, 'sub')).toBe('/srv/project/sub')
    expect(await workspace.git.listDirectories('/srv/project')).toEqual(['sub'])
    expect(workspace.git.pathIdentity('/srv/project/CASE')).not.toBe(workspace.git.pathIdentity('/srv/project/case'))
    await terminal.terminate()
    await terminal.quiescent
    await peer.waitFor(() => peer.subscriptions.size === 0)
    expect(peer.terminals.size).toBe(0)
    await expect(terminal.write('late')).rejects.toMatchObject({ status: 503 })
  })
})
