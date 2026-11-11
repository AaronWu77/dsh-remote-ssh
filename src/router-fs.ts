import { Context } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import { FileSystem, FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type {
  FsDeleteOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsMoveOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { RemoteSshManager, RemoteWorkspaceContext, RemoteWorkspaceRoute } from './manager.ts'
import { binaryWriter } from './binary-fs.ts'
import type { FsBytesWriteOutcome } from './binary-fs.ts'
import { fileUriFromPosixPath } from './index.ts'

interface RemoteTargetEnvelope {
  workspaceId: string
  targetKey: string
}

const PREFIX = 'dsh-remote-ssh:'

/** Filesystem router that keeps ordinary fs tools unchanged across execution worlds.
 * Remote operations reserve the connection through context allocation and RPC settlement.
 */
export class TransparentFileSystem extends FileSystem {
  static inject = ['localFs', 'remoteSshManager']

  private readonly local: FileSystem
  private readonly manager: RemoteSshManager

  constructor(ctx: Context) {
    super(ctx)
    this.local = ctx.localFs
    this.manager = ctx.remoteSshManager
  }

  /** Preserve confinement advertisement so tools stamp session-owned policy onto local mutations. */
  override get sandboxMode() { return this.local.sandboxMode }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const route = this.manager.route(path, opts?.cwd)
    if (route.kind === 'local') return this.local.resolve(path, opts)
    return this.withRemote(route, async remote => wrapTarget(route, await remote.fs.resolve(path, opts)))
  }

  override processPath(target: FsTarget): string {
    const decoded = decodeTarget(target)
    return decoded === undefined ? this.local.processPath(target) : target.displayPath
  }

  /** Map host assets only through the local execution world; remote aliases are not host files.
   * @param hostPath Absolute path to a host-owned asset.
   * @returns Local process path, or undefined for a remote alias or an unmapped asset.
   */
  override processPathFromHostPath(hostPath: string): string | undefined {
    if (this.manager.route(hostPath).kind === 'remote') return undefined
    return this.local.processPathFromHostPath(hostPath)
  }

  override fileUrl(target: FsTarget): string {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return this.local.fileUrl(target)
    // The seam promises the canonical `file:` URI of the target's execution
    // world; a remote target's world is the remote filesystem, so its display
    // path is what the URI names.
    this.manager.workspace(decoded.workspaceId)
    return fileUriFromPosixPath(target.displayPath)
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentRemote = decodeTarget(parent)
    const childRemote = decodeTarget(child)
    if (parentRemote === undefined || childRemote === undefined) {
      return parentRemote === undefined && childRemote === undefined && this.local.contains(parent, child)
    }
    if (parentRemote.workspaceId !== childRemote.workspaceId) return false
    const route = this.manager.workspace(parentRemote.workspaceId)
    const parentPath = route.mapper.toRemotePath(parent.displayPath)
    const childPath = route.mapper.toRemotePath(child.displayPath)
    const rel = posix.relative(parentPath, childPath)
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.withBackend(target, (fs, unwrapped) => fs.stat(unwrapped, signal))
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const route = this.manager.route(path, opts?.cwd)
    if (route.kind === 'local') return this.local.lstat(path, opts, signal)
    return this.withRemote(route, remote => remote.fs.lstat(path, opts, signal))
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.withBackend(target, (fs, unwrapped) => fs.readText(unwrapped, signal))
  }

  // The remote provider completes its RPC read before returning the in-memory text iterable.
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.withBackend(target, (fs, unwrapped) => fs.streamText(unwrapped, signal))
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.withBackend(target, (fs, unwrapped) => fs.readBytes(unwrapped, signal, maxBytes))
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    return this.withBackend(target, (fs, unwrapped) => fs.readByteRange(unwrapped, range, signal))
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return this.local.listDir(target, signal)
    const route = this.manager.workspace(decoded.workspaceId)
    return this.withRemote(route, async remote => {
      const entries = await remote.fs.listDir(unwrapTarget(target, decoded), signal)
      return entries.map(entry => ({ ...entry, target: wrapTarget(route, entry.target) }))
    })
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return this.withBackend(target, (fs, unwrapped) => fs.writeText(unwrapped, content, expected, signal, sandboxPolicy))
  }

  async writeBytes(
    target: FsTarget,
    content: Uint8Array,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsBytesWriteOutcome> {
    return this.withBackend(target, (fs, unwrapped) => binaryWriter(fs).writeBytes(unwrapped, content, expected, signal, sandboxPolicy))
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return this.withBackend(target, (fs, unwrapped) => fs.editText(unwrapped, edit, expected, signal, sandboxPolicy))
  }

  override async patchText(
    target: FsTarget,
    hunks: readonly PatchHunk[],
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return this.withBackend(target, (fs, unwrapped) => fs.patchText(unwrapped, hunks, expected, signal, sandboxPolicy))
  }

  override async deleteFile(
    target: FsTarget,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsDeleteOutcome> {
    return this.withBackend(target, (fs, unwrapped) => fs.deleteFile(unwrapped, expected, signal, sandboxPolicy))
  }

  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: Parameters<FileSystem['moveFile']>[2],
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsMoveOutcome> {
    // Both endpoints must live in the same execution world: one backend performs the whole move.
    const sourceDecoded = decodeTarget(source)
    const destinationDecoded = decodeTarget(destination)
    if (sourceDecoded?.workspaceId !== destinationDecoded?.workspaceId) {
      throw new FsError('cannot move across execution worlds', 'FS_SAME_TARGET')
    }
    return this.withBackend(source, (fs, unwrappedSource) =>
      fs.moveFile(unwrappedSource, decodeTarget(destination) === undefined ? destination : unwrapTarget(destination, destinationDecoded!), options, signal, sandboxPolicy))
  }

  private async withBackend<T>(target: FsTarget, operation: (fs: FileSystem, target: FsTarget) => Promise<T>): Promise<T> {
    const decoded = decodeTarget(target)
    if (decoded === undefined) return operation(this.local, target)
    const route = this.manager.workspace(decoded.workspaceId)
    return this.withRemote(route, remote => operation(remote.fs, unwrapTarget(target, decoded)))
  }

  private async withRemote<T>(route: RemoteWorkspaceRoute, operation: (remote: RemoteWorkspaceContext) => Promise<T>): Promise<T> {
    const release = this.manager.ownConnectionUse()
    try {
      const remote = await this.manager.workspaceContext(route)
      return await operation(remote)
    } finally { release() }
  }
}

function wrapTarget(route: RemoteWorkspaceRoute, target: FsTarget): FsTarget {
  const envelope: RemoteTargetEnvelope = { workspaceId: route.workspace.id, targetKey: String(target.targetKey) }
  return {
    targetKey: FsTargetKey(PREFIX + Buffer.from(JSON.stringify(envelope)).toString('base64url')),
    displayPath: target.displayPath,
  }
}

function decodeTarget(target: FsTarget): RemoteTargetEnvelope | undefined {
  const key = String(target.targetKey)
  if (!key.startsWith(PREFIX)) return undefined
  try {
    const value = JSON.parse(Buffer.from(key.slice(PREFIX.length), 'base64url').toString('utf8')) as Partial<RemoteTargetEnvelope>
    if (typeof value.workspaceId !== 'string' || typeof value.targetKey !== 'string') throw new Error('invalid fields')
    return value as RemoteTargetEnvelope
  } catch (error) {
    throw new Error(`dsh-remote-ssh: invalid remote filesystem target '${key}'`, { cause: error })
  }
}

function unwrapTarget(target: FsTarget, decoded: RemoteTargetEnvelope): FsTarget {
  return { targetKey: FsTargetKey(decoded.targetKey), displayPath: target.displayPath }
}

export default TransparentFileSystem
