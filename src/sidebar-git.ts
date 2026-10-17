/** Complete, byte-bounded Git operations on one authoritative Remote SSH route. */
import { posix } from 'node:path'
import type { Readable } from 'node:stream'
import type { SidebarRemoteWorkspace, SidebarWorkspaceProviders } from 'dsh-better-sidebar/workspace-provider'
import type { RemoteSshManager, RemoteWorkspaceRoute } from './manager.ts'
import { spawnOwnedRemoteProcess } from './router-subprocess.ts'
import type { SidebarExecutionLifetime } from './sidebar-execution-lifetime.ts'

/** Explicit deployment limits; each value must be a positive safe integer. */
export interface SidebarGitConfig {
  gitMaxOutputBytes: number
  collectionStderrMaxBytes: number
  cleanupGraceMs: number
  outputChunkBytes: number
  outputPollMs: number
}

/**
 * Keep Git execution, directory discovery and path identity on the selected host.
 * Completion requires both output EOFs and authoritative process cleanup.
 * @param manager - Manager owning the route and process lifetime.
 * @param route - Authoritative route; replaced and removed routes are rejected.
 * @param config - Required byte limits, cleanup window and transport settings.
 * @param errors - Sidebar-owned constructors for recognized caller-visible failures.
 * @param lifetime - Optional bridge-local revocation and ownership in addition to the shared manager.
 * @returns A backend with complete UTF-8 output and case-sensitive POSIX paths.
 */
export function createSidebarGitBackend(
  manager: RemoteSshManager,
  route: RemoteWorkspaceRoute,
  config: SidebarGitConfig,
  errors: Pick<SidebarWorkspaceProviders, 'workspaceError' | 'gitCommandError'>,
  lifetime?: Pick<SidebarExecutionLifetime, 'check' | 'ownExecution'>,
): SidebarRemoteWorkspace['git'] {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`dsh-remote-ssh/sidebar-git: ${name} must be a positive safe integer`)
  }
  for (const name of ['cleanupGraceMs', 'outputPollMs'] as const) {
    if (config[name] > 2_147_483_647) throw new Error(`dsh-remote-ssh/sidebar-git: ${name} exceeds the Node timer range`)
  }
  const failure = (message: string, status = 503) => errors.workspaceError('git-error', message, status)
  const selectedPath = (path: string): string => {
    try {
      lifetime?.check()
      if (manager.workspace(route.workspace.id) !== route) throw new Error('Remote SSH workspace route has been replaced')
      return route.mapper.toRemotePath(path)
    } catch (error) {
      throw failure(message(error))
    }
  }
  return {
    async run(cwd, args, timeoutMs) {
      const remoteCwd = selectedPath(cwd)
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw failure('Git timeoutMs must be a positive integer within the Node timer range')
      }
      const argv = ['git', '-C', remoteCwd, '--no-pager', '-c', 'color.ui=false', ...args]
      let handle: ReturnType<typeof spawnOwnedRemoteProcess>
      try {
        handle = spawnOwnedRemoteProcess(manager, route, {
          argv, cwd: remoteCwd,
          env: { LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs: config.cleanupGraceMs,
        }, { outputChunkBytes: config.outputChunkBytes, outputPollMs: config.outputPollMs }, lifetime?.ownExecution)
      } catch (error) {
        throw failure(message(error))
      }
      let interrupted: Error | undefined
      const interrupt = (error: Error): void => {
        interrupted ??= error
        handle.terminate()
      }
      const timer = setTimeout(() => interrupt(failure(`Git command timed out after ${timeoutMs} ms`)), timeoutMs)
      const collect = async (stream: Readable | undefined, limit: number, label: string): Promise<Buffer> => {
        if (stream === undefined) {
          const error = failure(`Git ${label} pipe is unavailable`)
          interrupt(error)
          throw error
        }
        const chunks: Buffer[] = []
        let size = 0
        try {
          for await (const chunk of stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            if (bytes.length > limit - size) {
              interrupt(failure(`Git ${label} exceeds ${limit} bytes`, 413))
              continue
            }
            if (interrupted !== undefined) continue
            size += bytes.length
            chunks.push(bytes)
          }
          return Buffer.concat(chunks, size)
        } catch (error) {
          interrupt(failure(`Git ${label} transport failed: ${message(error)}`))
          throw error
        }
      }
      const [outcome, stdout, stderr, complete, cleanup] = await Promise.allSettled([
        handle.done,
        collect(handle.stdout, config.gitMaxOutputBytes, 'stdout'),
        collect(handle.stderr, config.collectionStderrMaxBytes, 'stderr'),
        handle.outputComplete,
        handle.quiescent,
      ]).finally(() => clearTimeout(timer))
      if (interrupted !== undefined) throw interrupted
      for (const result of [outcome, stdout, stderr, complete, cleanup]) {
        if (result.status === 'rejected') throw failure(`Git execution failed: ${message(result.reason)}`)
      }
      // Keep narrowing local: no status or stderr is interpreted before all five settle.
      if (outcome.status !== 'fulfilled' || stdout.status !== 'fulfilled' || stderr.status !== 'fulfilled'
        || complete.status !== 'fulfilled' || cleanup.status !== 'fulfilled') throw failure('Git execution did not settle')
      if (!complete.value) throw failure('Git output is incomplete: bounded output drain expired before EOF')
      if (outcome.value.signal !== null || outcome.value.exitCode === null) throw failure(`Git command terminated (${outcome.value.signal ?? 'no exit status'})`)
      const diagnostic = stderr.value.toString('utf8')
      if ((outcome.value.exitCode === 126 || outcome.value.exitCode === 127) && diagnostic.startsWith('env:')) {
        throw failure(`Git executable could not start: ${diagnostic}`)
      }
      if (outcome.value.exitCode !== 0) throw errors.gitCommandError(diagnostic, argv.join(' '), outcome.value.exitCode)
      return stdout.value.toString('utf8')
    },
    async listDirectories(cwd) {
      const remoteCwd = selectedPath(cwd)
      const controller = new AbortController()
      const operation = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted()
        const { fs } = await manager.workspaceContext(route)
        controller.signal.throwIfAborted()
        selectedPath(remoteCwd)
        const target = await fs.resolve(remoteCwd, { signal: controller.signal })
        controller.signal.throwIfAborted()
        return (await fs.listDir(target, controller.signal)).filter(entry => entry.type === 'directory').map(entry => entry.name)
      })
      const quiescent = operation.then(() => {}, () => {})
      let release = () => {}
      try {
        const execution = { terminate: () => { controller.abort(new Error('Remote Git directory discovery removed')) }, done: quiescent }
        release = lifetime === undefined ? manager.ownExecution(route, execution) : lifetime.ownExecution(execution)
        return await operation
      } catch (error) {
        controller.abort(error)
        await quiescent
        throw failure(`Git directory discovery failed: ${message(error)}`)
      } finally {
        release()
      }
    },
    joinPath(base, name) { return posix.join(selectedPath(base), name) },
    pathIdentity(path) { return posix.normalize(selectedPath(path)) },
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
