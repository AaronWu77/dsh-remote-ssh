/** Session-scoped Remote SSH files, Git and persistent interactive terminals. */
import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { AhpErrorCodes, ContentEncoding, ResourceWriteMode } from '@microsoft/agent-host-protocol'
import { RpcError } from '@microsoft/agent-host-protocol/client'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { SidebarRemoteWorkspace, SidebarWorkspaceProviders } from 'dsh-better-sidebar/workspace-provider'
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'
import { fileUriFromPosixPath } from './index.ts'
import { spawnOwnedRemoteTerminal } from './router-subprocess.ts'
import { createSidebarGitBackend } from './sidebar-git.ts'
import { SidebarExecutionLifetime } from './sidebar-execution-lifetime.ts'

/** Required deployment choices; the bridge owns defaults, not this executor. */
export interface Config {
  /** Linux tools provide canonical/link metadata unless the AHP server has been verified compliant. */
  pathMetadata: 'posix' | 'ahp'
  fullReadMaxBytes: number
  uploadChunkMaxBytes: number
  writeMaxBytes: number
  /** Maximum examined rows per directory and maximum returned search matches. */
  searchMaxRows: number
  /** Maximum examined entries across the whole search. */
  searchMaxItems: number
  /** Maximum directory depth below the Session root (root is depth zero). */
  searchMaxDepth: number
  cleanupGraceMs: number
  outputChunkBytes: number
  outputPollMs: number
  terminalArgv: string[]
  terminalEnv: Record<string, string>
  terminalType: string
  gitMaxOutputBytes: number
  collectionStderrMaxBytes: number
}

/** Validated independent copies of the deployment choices. */
export interface ResolvedConfig extends Config {}

/** Validate explicit configuration before constructing a workspace.
 * @param config Required deployment values.
 * @returns A copy with independently owned argv and environment.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  if (config.pathMetadata !== 'posix' && config.pathMetadata !== 'ahp') throw new Error('dsh-remote-ssh/sidebar-workspace: pathMetadata must be posix or ahp')
  for (const name of ['fullReadMaxBytes', 'uploadChunkMaxBytes', 'writeMaxBytes', 'searchMaxRows', 'searchMaxItems', 'searchMaxDepth', 'cleanupGraceMs', 'outputChunkBytes', 'outputPollMs', 'gitMaxOutputBytes', 'collectionStderrMaxBytes'] as const) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) throw new Error(`dsh-remote-ssh/sidebar-workspace: ${name} must be a positive safe integer`)
  }
  for (const name of ['cleanupGraceMs', 'outputPollMs'] as const) {
    if (config[name] > 2_147_483_647) throw new Error(`dsh-remote-ssh/sidebar-workspace: ${name} exceeds the timer range`)
  }
  if (!Array.isArray(config.terminalArgv) || config.terminalArgv.length === 0
    || config.terminalArgv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !config.terminalArgv[0]?.trim()) {
    throw new Error('dsh-remote-ssh/sidebar-workspace: terminalArgv requires a nonempty executable and NUL-free arguments')
  }
  for (const [key, value] of Object.entries(config.terminalEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('dsh-remote-ssh/sidebar-workspace: invalid terminalEnv entry')
  }
  if (typeof config.terminalType !== 'string' || !config.terminalType.trim() || config.terminalType.includes('\0')) throw new Error('dsh-remote-ssh/sidebar-workspace: invalid terminalType')
  return { ...config, terminalArgv: [...config.terminalArgv], terminalEnv: { ...config.terminalEnv } }
}

type ErrorFactories = Pick<SidebarWorkspaceProviders, 'workspaceError' | 'gitCommandError'>
type WorkspaceContext = Awaited<ReturnType<RemoteSshManager['workspaceContext']>>
type Operation = { context: WorkspaceContext; signal: AbortSignal; check(): void; cleanupFailed(error: Error): void }

/** Noise directories excluded from filename search, matching Sidebar's local search. */
const SEARCH_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.pnpm-store', '.yarn', '.turbo', '.turbopack', '.next', '.nuxt',
  '.output', '.cache', '.parcel-cache', 'coverage', 'dist', 'build', 'out', '.umi', '.umi-production', '.dumi',
])

/** Select one authorized host with a fence rooted in the authoritative Session directory.
 * @param manager Owner of route generation, pending operations and retirement.
 * @param authorizedRoute Previously selected remote route, never an inferred fallback.
 * @param authoritativeCwd Live or persisted Session header directory.
 * @param validatedConfig Explicit values returned by resolveConfig.
 * @param errors Sidebar-owned constructors; no runtime Sidebar import is needed.
 * @returns Stable host-scoped capabilities plus disposal that revokes effects and awaits owned cleanup.
 */
export function createSidebarRemoteWorkspace(manager: RemoteSshManager, authorizedRoute: RemoteWorkspaceRoute, authoritativeCwd: string, validatedConfig: ResolvedConfig, errors: ErrorFactories): SidebarRemoteWorkspace & Pick<SidebarExecutionLifetime, 'dispose'> {
  const config = { ...validatedConfig, terminalArgv: [...validatedConfig.terminalArgv], terminalEnv: { ...validatedConfig.terminalEnv } }
  const recognized = new WeakSet<Error>()
  const fail = (message: string, status = 400, code: Parameters<ErrorFactories['workspaceError']>[0] = 'fs-error'): Error => {
    const error = errors.workspaceError(code, message, status)
    recognized.add(error)
    return error
  }
  const lifetime = new SidebarExecutionLifetime(manager, authorizedRoute, () => fail('Remote Sidebar workspace bridge has been removed', 503, 'workspace-unavailable'))
  const assertRoute = (): void => {
    lifetime.check()
    try {
      if (manager.workspace(authorizedRoute.workspace.id) !== authorizedRoute) throw new Error('Remote SSH workspace route has been replaced')
    } catch (error) { throw fail(messageOf(error), 503, 'workspace-unavailable') }
  }
  const absolute = (path: string): string => {
    assertRoute()
    if (!path.trim() || path.includes('\0') || path.startsWith('file:')) throw fail('Expected a NUL-free filesystem path', 400, 'bad-request')
    try {
      if (win32.isAbsolute(path) && !posix.isAbsolute(path)) {
        if (posix.isAbsolute(authorizedRoute.aliasPath) || !win32.isAbsolute(authorizedRoute.aliasPath)) throw new Error('Windows path is not a mapped alias on this host')
        const relative = win32.relative(authorizedRoute.aliasPath, path)
        if (relative === '..' || relative.startsWith('..\\') || win32.isAbsolute(relative)) throw new Error('Windows path is outside the selected remote alias')
        return posix.resolve(authorizedRoute.workspace.remotePath, relative.split(win32.sep).join('/'))
      }
      if (!posix.isAbsolute(path)) throw new Error('Expected an absolute path on the selected remote host')
      return authorizedRoute.mapper.toRemotePath(path)
    } catch (error) { throw fail(messageOf(error), 400, 'bad-request') }
  }
  const cwd = absolute(authoritativeCwd)
  const normalize = (path: string): string => {
    if (posix.isAbsolute(path) || win32.isAbsolute(path)) return absolute(path)
    if (!path.trim() || path.includes('\0') || path.includes('\\') || /^[A-Za-z]:/.test(path) || path.startsWith('file:')) throw fail('Expected a POSIX relative path', 400, 'bad-request')
    return absolute(posix.resolve(cwd, path))
  }
  const checkFence = (root: string, target: string, enabled: boolean): void => {
    if (enabled && !contains(root, target)) throw fail(`Path is outside the Session workspace: ${target}`, 403, 'forbidden')
  }
  const owned = async <T>(work: (operation: Operation) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted()
    assertRoute()
    const controller = new AbortController()
    const cancel = () => { controller.abort(signal?.reason) }
    let cleanupFailure: Error | undefined
    const check = () => { controller.signal.throwIfAborted(); assertRoute() }
    const pending = Promise.resolve().then(async () => {
      check()
      const context = await manager.workspaceContext(authorizedRoute)
      check()
      return work({ context, signal: controller.signal, check, cleanupFailed: error => { cleanupFailure ??= error } })
    })
    const done = pending.then(() => {}, () => {}).then(() => { if (cleanupFailure !== undefined) throw cleanupFailure })
    void done.catch(() => { /* The manager retains unobservable cleanup for retirement. */ })
    let release = () => {}
    try {
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      release = lifetime.ownExecution({ terminate: () => { controller.abort(fail('Remote workspace operation retired', 503, 'workspace-unavailable')) }, done })
      return await pending
    } catch (error) {
      controller.abort(error)
      await pending.then(() => {}, () => {})
      if (signal?.aborted && error === signal.reason) throw error
      if (error instanceof Error && recognized.has(error)) throw error
      const tooLarge = error instanceof FsError && error.code === 'FS_TOO_LARGE'
      const missing = error instanceof FsError && error.code === 'FS_NOT_FOUND' || error instanceof RpcError && error.code === AhpErrorCodes.NotFound
      const denied = error instanceof FsError && error.code === 'FS_PERMISSION_DENIED' || error instanceof RpcError && error.code === AhpErrorCodes.PermissionDenied
      const conflict = error instanceof RpcError && (error.code === AhpErrorCodes.AlreadyExists || error.code === AhpErrorCodes.Conflict)
      throw fail(messageOf(error), tooLarge ? 413 : missing ? 404 : denied ? 403 : conflict ? 409 : 503, tooLarge ? 'too-large' : denied ? 'forbidden' : 'fs-error')
    } finally {
      signal?.removeEventListener('abort', cancel)
      if (cleanupFailure === undefined) release()
    }
  }
  const metadataCommand = async (op: Operation, command: string) => {
    op.check()
    const shell = await manager.workspaceShell(authorizedRoute, 'bash')
    op.check()
    const execution = await shell.execute(shell.resolve({
      command, workdir: cwd, signal: op.signal,
      timeoutMs: config.cleanupGraceMs, stdoutMaxBytes: config.collectionStderrMaxBytes,
      env: { LANG: 'C', LC_ALL: 'C' },
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: authorizedRoute.aliasPath },
    }))
    const [outcome, cleanup] = await Promise.allSettled([execution.result(), execution.quiescent])
    if (cleanup.status === 'rejected') {
      const failure = fail(`Remote path metadata cleanup unobservable: ${messageOf(cleanup.reason)}`, 503, 'workspace-unavailable')
      op.cleanupFailed(failure)
      throw failure
    }
    if (outcome.status === 'rejected') throw outcome.reason
    const result = outcome.value
    op.check()
    if (result.timedOut || result.aborted || result.signal !== null || result.stdout.truncated) throw fail('Remote path metadata execution did not complete', 503)
    return result
  }
  const canonicalOf = async (op: Operation, path: string): Promise<string> => {
    if (config.pathMetadata === 'ahp') return path
    // Some deployed AHP 0.9.0 servers return the requested URI despite followSymlinks=true.
    const result = await metadataCommand(op, `set -o pipefail; realpath -z -m -- ${quote(path)} | base64 -w0`)
    if (result.exitCode !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.stdout.text)) throw fail('Remote canonical path metadata failed: ' + result.stdout.text, 503)
    const canonical = Buffer.from(result.stdout.text, 'base64').toString('utf8')
    if (!canonical.endsWith('\0') || canonical.slice(0, -1).includes('\0') || !posix.isAbsolute(canonical)) throw fail('Invalid canonical path returned by remote host', 503)
    return canonical.slice(0, -1)
  }
  const lstatOf = async (op: Operation, path: string): Promise<{ type: 'file' | 'directory' | 'symlink' | 'other' } | undefined> => {
    if (config.pathMetadata === 'ahp') return op.context.fs.lstat(path, undefined, op.signal)
    const result = await metadataCommand(op, `stat --printf='%F' -- ${quote(path)}`)
    if (result.exitCode !== 0) {
      if (result.exitCode === 1 && /: No such file or directory\r?\n?$/.test(result.stdout.text)) return undefined
      throw fail('Remote lexical path metadata failed: ' + result.stdout.text, 503)
    }
    const kind = result.stdout.text
    return { type: kind === 'symbolic link' ? 'symlink' : kind === 'directory' ? 'directory' : kind === 'regular file' || kind === 'regular empty file' ? 'file' : 'other' }
  }
  const lstatsOf = async (op: Operation, paths: readonly string[]) => {
    const metadata = new Map<string, { type: 'file' | 'directory' | 'symlink' | 'other' } | undefined>()
    if (config.pathMetadata === 'ahp') {
      for (const path of paths) metadata.set(path, await lstatOf(op, path))
      return metadata
    }
    if (!paths.length) return metadata
    // One bounded request for a directory page instead of allocating one terminal per row.
    const result = await metadataCommand(op, `set -o pipefail; stat --printf='%n\\0%F\\0' -- ${paths.map(quote).join(' ')} | base64 -w0`)
    if (result.exitCode !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.stdout.text)) throw fail('Remote directory link metadata failed: ' + result.stdout.text, 503)
    const values = Buffer.from(result.stdout.text, 'base64').toString('utf8').split('\0')
    if (values.pop() !== '' || values.length !== paths.length * 2) throw fail('Incomplete remote directory link metadata', 503)
    for (let index = 0; index < paths.length; index++) {
      const path = values[index * 2]!
      const kind = values[index * 2 + 1]!
      if (path !== paths[index]) throw fail('Unexpected remote directory link metadata path', 503)
      metadata.set(path, { type: kind === 'symbolic link' ? 'symlink' : kind === 'directory' ? 'directory' : kind === 'regular file' || kind === 'regular empty file' ? 'file' : 'other' })
    }
    return metadata
  }
  const rootOf = async (op: Operation): Promise<FsTarget> => {
    op.check()
    const root = await op.context.fs.resolve(await canonicalOf(op, cwd), { signal: op.signal })
    op.check()
    const info = await op.context.fs.stat(root, op.signal)
    op.check()
    if (info?.type !== 'directory') throw fail('Session workspace is unavailable or is not a directory', 404)
    return root
  }
  const targetOf = async (op: Operation, raw: string, fence: boolean, requireExisting = true): Promise<FsTarget> => {
    const path = normalize(raw)
    const root = await rootOf(op)
    op.check()
    const target = await op.context.fs.resolve(await canonicalOf(op, path), { signal: op.signal })
    op.check()
    checkFence(op.context.fs.processPath(root), op.context.fs.processPath(target), fence)
    if (requireExisting && await op.context.fs.stat(target, op.signal) === undefined) throw fail(`Path does not exist: ${path}`, 404)
    op.check()
    return target
  }
  const lexicalOf = async (op: Operation, raw: string, fence: boolean): Promise<string> => {
    const path = normalize(raw)
    const parent = await targetOf(op, posix.dirname(path), fence)
    return posix.join(op.context.fs.processPath(parent), posix.basename(path))
  }
  const readWhole = async (op: Operation, raw: string, limit: number, fence: boolean): Promise<Uint8Array> => {
    positiveLimit(limit)
    const target = await targetOf(op, raw, fence)
    const bound = Math.min(limit, config.fullReadMaxBytes)
    op.check()
    const before = await op.context.fs.stat(target, op.signal)
    op.check()
    if (before?.type !== 'file') throw fail('Not a regular file', 400)
    if (before.size !== undefined && before.size > bound) throw fail(`Whole-resource read exceeds ${bound} bytes`, 413, 'too-large')
    const bytes = await op.context.fs.readBytes(target, op.signal, bound)
    op.check()
    const after = await op.context.fs.stat(target, op.signal)
    op.check()
    if (bytes.byteLength > bound || after?.size !== undefined && after.size > bound) throw fail(`Whole-resource read exceeds ${bound} bytes`, 413, 'too-large')
    if (after?.type !== 'file' || before.version !== after.version || after.size !== undefined && after.size !== bytes.byteLength) throw fail('File changed during whole-resource read', 409)
    return bytes
  }
  const privatePublish = async (op: Operation, raw: string, chunks: AsyncIterable<string | Uint8Array>, limit: number, fence: boolean, noOverwrite: boolean): Promise<{ path: string; size: number }> => {
    positiveLimit(limit)
    const destination = await targetOf(op, raw, fence, false)
    const path = op.context.fs.processPath(destination)
    if (path === op.context.fs.processPath(await rootOf(op)) || path === '/') throw fail('Cannot replace the workspace root', 403)
    op.check()
    const existing = await lstatOf(op, path)
    op.check()
    if (existing !== undefined && (noOverwrite || existing.type !== 'file')) throw fail('Destination already exists or is not a regular file', 409)
    const parent = posix.dirname(path)
    const shell = await manager.workspaceShell(authorizedRoute, 'bash')
    op.check()
    const client = await op.context.remote.getClient(op.signal)
    op.check()
    await client.resourceMkdir({ uri: fileUriFromPosixPath(parent) })
    op.check()
    const checked = await targetOf(op, path, fence, false)
    if (op.context.fs.processPath(checked) !== path) throw fail('Publication directory changed', 409)
    const privateDir = posix.join(parent, `.dsh-sidebar-${randomUUID()}`)
    const privateUri = fileUriFromPosixPath(privateDir)
    const tempUri = fileUriFromPosixPath(posix.join(privateDir, 'content'))
    let ownedDirectory = false
    let attempted = false
    let size = 0
    let failure: unknown
    try {
      op.check()
      attempted = true
      const execution = await shell.execute(shell.resolve({
        command: `umask 077; mkdir -- ${quote(privateDir)}`, workdir: cwd, signal: op.signal,
        timeoutMs: config.cleanupGraceMs, stdoutMaxBytes: config.collectionStderrMaxBytes, env: {},
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: authorizedRoute.aliasPath },
      }))
      const result = await execution.result().finally(() => execution.quiescent)
      if (result.timedOut || result.aborted || result.signal !== null || result.exitCode !== 0) throw fail('Private staging directory allocation failed', 503)
      ownedDirectory = true
      op.check()
      await client.resourceWrite({ uri: tempUri, data: '', encoding: ContentEncoding.Base64, createOnly: true })
      op.check()
      for await (const chunk of chunks) {
        op.check()
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
        if (bytes.byteLength > limit - size) throw fail(`Publication exceeds ${limit} bytes`, 413, 'too-large')
        for (let offset = 0; offset < bytes.byteLength; offset += config.uploadChunkMaxBytes) {
          op.check()
          const part = bytes.subarray(offset, offset + config.uploadChunkMaxBytes)
          await client.resourceWrite({ uri: tempUri, data: Buffer.from(part).toString('base64'), encoding: ContentEncoding.Base64, mode: ResourceWriteMode.Append })
          op.check()
        }
        size += bytes.byteLength
      }
      op.check()
      const latest = await targetOf(op, path, fence, false)
      if (op.context.fs.processPath(latest) !== path) throw fail('Publication target changed', 409)
      const info = await lstatOf(op, path)
      if (info !== undefined && (noOverwrite || info.type !== 'file')) throw fail('Destination already exists or is not a regular file', 409)
      op.check()
      await client.resourceMove({ source: tempUri, destination: fileUriFromPosixPath(path), failIfExists: noOverwrite })
      op.check()
    } catch (error) { failure = error } finally {
      // Cleanup requires the definitive server reply even after route retirement.
      if (ownedDirectory) {
        try { await client.resourceDelete({ uri: privateUri, recursive: true }) } catch (error) {
          const failure = fail(`Private staging cleanup unobservable at ${privateDir}: ${messageOf(error)}`, 503)
          op.cleanupFailed(failure)
          throw failure
        }
      } else if (attempted && failure !== undefined) {
        const unknown = fail(`Private staging allocation/cleanup unobservable at ${privateDir}: ${messageOf(failure)}`, 503)
        op.cleanupFailed(unknown)
        throw unknown
      }
    }
    if (failure !== undefined) throw failure
    return { path, size }
  }
  const fs: SidebarRemoteWorkspace['fs'] = {
    resolve: (path, fence) => owned(async op => op.context.fs.processPath(await targetOf(op, path, fence))),
    exists: path => owned(async op => {
      const target = await targetOf(op, path, false, false)
      op.check()
      const info = await op.context.fs.stat(target, op.signal)
      op.check()
      return info !== undefined
    }),
    list: (path, limit, fence) => owned(async op => {
      positiveLimit(limit)
      const target = await targetOf(op, path, fence)
      const canonical = op.context.fs.processPath(target)
      op.check()
      const client = await op.context.remote.getClient(op.signal)
      op.check()
      const listing = await client.resourceList({ uri: op.context.fs.fileUrl(target) })
      op.check()
      const rows: Awaited<ReturnType<SidebarRemoteWorkspace['fs']['list']>>['entries'] = []
      const page = listing.entries.slice(0, Math.min(limit, config.searchMaxRows))
      const paths = page.map(row => { singleName(row.name); return posix.join(canonical, row.name) })
      const metadata = await lstatsOf(op, paths)
      for (const row of page) {
        const lexical = posix.join(canonical, row.name)
        const info = metadata.get(lexical)
        op.check()
        let isDir = info?.type === 'directory'
        let broken = info === undefined
        if (info?.type === 'symlink') {
          const child = await op.context.fs.resolve(lexical, { signal: op.signal })
          op.check()
          const follow = await op.context.fs.stat(child, op.signal)
          op.check()
          isDir = follow?.type === 'directory'
          broken = follow === undefined
        }
        rows.push({ name: row.name, path: lexical, isDir, hidden: row.name.startsWith('.'), isSymlink: info?.type === 'symlink', broken })
      }
      rows.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      return { path: canonical, entries: rows, truncated: listing.entries.length > rows.length }
    }),
    read: (path, limit, fence) => owned(async op => {
      positiveLimit(limit)
      const bytes = await readWhole(op, path, config.fullReadMaxBytes, fence)
      const preview = bytes.subarray(0, limit)
      const binary = preview.includes(0)
      const content = binary ? '' : new TextDecoder().decode(preview, { stream: bytes.byteLength > limit })
      return { content, binary, truncated: bytes.byteLength > limit, size: bytes.byteLength, ...(binary ? { head: Buffer.from(preview.subarray(0, 4096)).toString('base64') } : {}) }
    }),
    readBytes: (path, limit, fence) => owned(op => readWhole(op, path, limit, fence)),
    write: (path, content, fence) => owned(async op => {
      const bytes = Buffer.from(content, 'utf8')
      if (bytes.byteLength > config.writeMaxBytes) throw fail(`Write exceeds ${config.writeMaxBytes} bytes`, 413, 'too-large')
      await privatePublish(op, path, (async function* () { yield bytes })(), config.writeMaxBytes, fence, false)
    }),
    upload: input => owned(async op => {
      if (posix.isAbsolute(input.relativePath) || input.relativePath.includes('\\') || input.relativePath.includes('\0')
        || input.relativePath.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(input.relativePath)) throw fail('Upload requires a confined POSIX relative path', 400, 'bad-request')
      const dir = await targetOf(op, input.dir, input.fence)
      return privatePublish(op, posix.join(op.context.fs.processPath(dir), input.relativePath), input.chunks, input.limit, input.fence, true)
    }),
    rename: (raw, name, fence) => owned(async op => {
      singleName(name)
      const path = await lexicalOf(op, raw, fence)
      const root = op.context.fs.processPath(await rootOf(op))
      if (normalize(raw) === cwd || path === root || path === '/') throw fail('Cannot rename the workspace root', 403)
      const info = await lstatOf(op, path)
      op.check()
      if (info === undefined) throw fail('Rename source does not exist', 404)
      const destination = posix.join(posix.dirname(path), name)
      if (await lstatOf(op, destination) !== undefined) throw fail('Rename destination already exists', 409)
      op.check()
      const client = await op.context.remote.getClient(op.signal)
      op.check()
      await client.resourceMove({ source: fileUriFromPosixPath(path), destination: fileUriFromPosixPath(destination), failIfExists: true })
      op.check()
      return { path: destination }
    }),
    remove: (raw, fence) => owned(async op => {
      const path = await lexicalOf(op, raw, fence)
      const root = op.context.fs.processPath(await rootOf(op))
      if (normalize(raw) === cwd || path === root || path === '/') throw fail('Cannot remove the workspace root', 403)
      const info = await lstatOf(op, path)
      op.check()
      if (info === undefined) throw fail('Remove target does not exist', 404)
      const client = await op.context.remote.getClient(op.signal)
      op.check()
      await client.resourceDelete({ uri: fileUriFromPosixPath(path), recursive: info.type === 'directory' })
      op.check()
      return { path }
    }),
    search: async (query, signal) => {
      signal?.throwIfAborted()
      assertRoute()
      const needle = query.trim().toLowerCase()
      if (needle === '') return { matches: [], truncated: false }
      return owned(async op => {
        const root = await rootOf(op)
        const rootPath = op.context.fs.processPath(root)
        op.check()
        const client = await op.context.remote.getClient(op.signal)
        const matches: string[] = []
        const queue = [{ path: rootPath, depth: 0 }]
        let examined = 0
        let truncated = false
        for (let index = 0; index < queue.length; index++) {
          op.check()
          if (examined >= config.searchMaxItems) { truncated = true; break }
          const directory = queue[index]!
          const target = await targetOf(op, directory.path, true)
          if (op.context.fs.processPath(target) !== directory.path) throw fail('Search directory changed during traversal', 409)
          op.check()
          // AHP supplies a complete listing; only this bounded page is inspected or queued.
          const listing = await client.resourceList({ uri: op.context.fs.fileUrl(target) })
          op.check()
          const page = listing.entries.slice(0, Math.min(config.searchMaxRows, config.searchMaxItems - examined))
          truncated ||= listing.entries.length > page.length
          examined += page.length
          const paths = page.map(row => { singleName(row.name); return posix.join(directory.path, row.name) })
          const metadata = await lstatsOf(op, paths)
          for (const row of page) {
            op.check()
            const path = posix.join(directory.path, row.name)
            const info = metadata.get(path)
            if (info === undefined || info.type === 'other') continue
            if (info.type === 'directory' && SEARCH_SKIP_DIRS.has(row.name.toLowerCase())) continue
            if (row.name.toLowerCase().includes(needle)) {
              matches.push(posix.relative(rootPath, path))
              if (matches.length >= config.searchMaxRows) return { matches: matches.sort(), truncated: true }
            }
            if (info.type === 'directory') {
              if (directory.depth >= config.searchMaxDepth) truncated = true
              else queue.push({ path, depth: directory.depth + 1 })
            }
          }
        }
        op.check()
        return { matches: matches.sort(), truncated }
      }, signal)
    },
  }
  function positiveLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw fail('Byte/row limit must be a positive safe integer', 400, 'bad-request')
  }
  function singleName(name: string): void {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) throw fail('Expected a single POSIX filename', 400, 'bad-request')
  }
  return {
    kind: 'remote', cwd, fs, terminalExecutable: config.terminalArgv[0]!,
    dispose: () => lifetime.dispose(),
    paths: {
      absolute,
      join: (base, path) => {
        if (win32.isAbsolute(path) && !posix.isAbsolute(path)) return absolute(path)
        if (path.includes('\0') || path.includes('\\') || /^[A-Za-z]:/.test(path)) throw fail('Expected a POSIX path', 400, 'bad-request')
        return absolute(posix.resolve(absolute(base), path))
      },
      dirname: path => posix.dirname(absolute(path)), basename: path => posix.basename(absolute(path)),
      isAbsolute: path => posix.isAbsolute(path) || win32.isAbsolute(path),
    },
    git: createSidebarGitBackend(manager, authorizedRoute, { gitMaxOutputBytes: config.gitMaxOutputBytes, collectionStderrMaxBytes: config.collectionStderrMaxBytes, cleanupGraceMs: config.cleanupGraceMs, outputChunkBytes: config.outputChunkBytes, outputPollMs: config.outputPollMs }, errors, lifetime),
    async createTerminal(spec) {
      assertRoute()
      if (!Number.isSafeInteger(spec.cols) || spec.cols <= 0 || !Number.isSafeInteger(spec.rows) || spec.rows <= 0) throw fail('Invalid terminal dimensions', 400, 'bad-request')
      if (spec.signal?.aborted) throw fail('Terminal allocation aborted', 503, 'workspace-unavailable')
      const target = await owned(async op => {
        const target = await targetOf(op, spec.cwd, true)
        op.check()
        const info = await op.context.fs.stat(target, op.signal)
        op.check()
        if (info?.type !== 'directory') throw fail('Terminal cwd is not a directory', 400, 'bad-request')
        return target
      })
      assertRoute()
      try {
        const handle = await spawnOwnedRemoteTerminal(manager, authorizedRoute, {
          argv: [...config.terminalArgv], env: { ...config.terminalEnv, TERM: config.terminalType }, cwd: target.displayPath,
          cols: spec.cols, rows: spec.rows, graceMs: config.cleanupGraceMs, terminalType: config.terminalType,
          ...(spec.signal === undefined ? {} : { signal: spec.signal }),
        }, lifetime.ownExecution)
        const done = handle.done.catch(error => { throw fail(messageOf(error), 503, 'workspace-unavailable') })
        const quiescent = handle.quiescent.catch(error => { throw fail(messageOf(error), 503, 'workspace-unavailable') })
        void done.catch(() => { /* The registry consumes command outcome independently. */ })
        void quiescent.catch(() => { /* The owner consumes authoritative cleanup independently. */ })
        return {
          output: {
            async *[Symbol.asyncIterator]() {
              try {
                for await (const chunk of handle.output.iterator({ destroyOnReturn: false })) yield chunk
              } catch (error) { throw fail(messageOf(error), 503, 'workspace-unavailable') }
            },
          }, done, quiescent,
          async write(data) { assertRoute(); try { await handle.write(data) } catch (error) { throw fail(messageOf(error), 503, 'workspace-unavailable') } },
          async resize(cols, rows) {
            assertRoute()
            if (!Number.isSafeInteger(cols) || cols <= 0 || !Number.isSafeInteger(rows) || rows <= 0) throw fail('Invalid terminal dimensions', 400, 'bad-request')
            try { await handle.resize(cols, rows) } catch (error) { throw fail(messageOf(error), 503, 'workspace-unavailable') }
          },
          async terminate() {
            try { await handle.terminate(); await handle.quiescent } catch (error) { throw fail(messageOf(error), 503, 'workspace-unavailable') }
          },
        }
      } catch (error) { throw fail(messageOf(error), 503, 'workspace-unavailable') }
    },
  }
}

function contains(root: string, path: string): boolean {
  const relative = posix.relative(root, path)
  return relative === '' || relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative)
}
function quote(text: string): string { return `'${text.replaceAll("'", "'\\''")}'` }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
