import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, resolve } from 'node:path'
import { posix } from 'node:path'
import type { RemoteOpenFileMode, RemoteSshManager } from './manager.ts'

type KnownEditorId = Exclude<RemoteOpenFileMode, 'auto' | 'custom' | 'download'>

interface EditorDefinition {
  id: KnownEditorId
  command: string
  /** Application executable a Windows command shim launches. */
  executableName: string
  windowsLocations: (env: NodeJS.ProcessEnv) => string[]
  macLocations: string[]
}

interface EditorInvocation {
  id: KnownEditorId | 'custom'
  executable: string
  prefixArgs: string[]
  env?: NodeJS.ProcessEnv
  /** Whether the application can answer a headless extension probe without showing a window. */
  probe: boolean
}

export interface RemoteOpenFileResult {
  kind: 'editor' | 'download'
  editor?: KnownEditorId | 'custom'
  localPath?: string
  remotePath: string
  fallbackReason?: string
}

const REMOTE_SSH_EXTENSIONS = new Set([
  'ms-vscode-remote.remote-ssh',
  'jeanp413.open-remote-ssh',
])

const EDITORS: Record<KnownEditorId, EditorDefinition> = {
  vscode: {
    id: 'vscode', command: 'code', executableName: 'Code.exe',
    windowsLocations: env => compact([
      env.LOCALAPPDATA && resolve(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      env.ProgramW6432 && resolve(env.ProgramW6432, 'Microsoft VS Code', 'Code.exe'),
      env.ProgramFiles && resolve(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
      env['ProgramFiles(x86)'] && resolve(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
    ]),
    macLocations: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
  },
  cursor: {
    id: 'cursor', command: 'cursor', executableName: 'Cursor.exe',
    windowsLocations: env => compact([
      env.LOCALAPPDATA && resolve(env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe'),
      env.ProgramW6432 && resolve(env.ProgramW6432, 'Cursor', 'Cursor.exe'),
      env.ProgramFiles && resolve(env.ProgramFiles, 'Cursor', 'Cursor.exe'),
    ]),
    macLocations: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
  },
  windsurf: {
    id: 'windsurf', command: 'windsurf', executableName: 'Windsurf.exe',
    windowsLocations: env => compact([
      env.LOCALAPPDATA && resolve(env.LOCALAPPDATA, 'Programs', 'Windsurf', 'Windsurf.exe'),
      env.ProgramW6432 && resolve(env.ProgramW6432, 'Windsurf', 'Windsurf.exe'),
      env.ProgramFiles && resolve(env.ProgramFiles, 'Windsurf', 'Windsurf.exe'),
    ]),
    macLocations: ['/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf'],
  },
  vscodium: {
    id: 'vscodium', command: 'codium', executableName: 'VSCodium.exe',
    windowsLocations: env => compact([
      env.LOCALAPPDATA && resolve(env.LOCALAPPDATA, 'Programs', 'VSCodium', 'VSCodium.exe'),
      env.ProgramW6432 && resolve(env.ProgramW6432, 'VSCodium', 'VSCodium.exe'),
      env.ProgramFiles && resolve(env.ProgramFiles, 'VSCodium', 'VSCodium.exe'),
    ]),
    macLocations: ['/Applications/VSCodium.app/Contents/Resources/app/bin/codium'],
  },
}

const AUTO_ORDER: KnownEditorId[] = ['vscode', 'cursor', 'windsurf', 'vscodium']
/** How long one editor's extension probe is trusted before the next open re-reads it. */
const EDITOR_PROBE_TTL_MS = 30_000
const editorSupport = new Map<string, { at: number, value: Promise<boolean> }>()

/** Open a remote path in a native VSC Remote-SSH window, downloading only as fallback. */
export async function openRemoteFile(
  manager: RemoteSshManager,
  workspaceId: string,
  inputPath: string,
): Promise<RemoteOpenFileResult> {
  const route = manager.workspace(workspaceId)
  const remotePath = route.mapper.toRemotePath(inputPath, route.aliasPath)
  const config = manager.snapshot()
  let fallbackReason: string | undefined

  if (config.openFileMode !== 'download') {
    const candidates = await editorCandidates(config.openFileMode, config.openFileEditorPath)
    for (const candidate of candidates) {
      if (!await supportsRemoteSsh(candidate)) {
        fallbackReason = `${candidate.id} does not have a Remote SSH extension`
        continue
      }
      try {
        await launchEditor(candidate, route.server.sshTarget, remotePath)
        return { kind: 'editor', editor: candidate.id, remotePath }
      } catch (error: unknown) {
        fallbackReason = errorMessage(error)
      }
    }
    fallbackReason ??= 'no supported VS Code-compatible editor was found'
  }

  const localPath = await materializeRemoteFile(
    manager,
    workspaceId,
    remotePath,
    config.openFileDownloadMaxBytes,
  )
  return {
    kind: 'download', localPath, remotePath,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  }
}

/** VS Code-compatible CLI arguments; each value is passed without a shell. */
export function editorLaunchArgs(sshTarget: string, remotePath: string): string[] {
  if (/[/\r\n\0]/.test(sshTarget)) throw new Error('SSH Host alias contains unsupported characters')
  if (!posix.isAbsolute(remotePath)) throw new Error(`remote open path must be absolute: ${remotePath}`)
  return ['--remote', `ssh-remote+${sshTarget}`, '--reuse-window', remotePath]
}

/** Preserve a useful extension while preventing cache traversal and Windows device names. */
export function safeDownloadedName(remotePath: string): string {
  let name = basename(remotePath).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  if (name.length === 0) name = 'remote-file'
  const stem = name.split('.', 1)[0]?.toUpperCase()
  if (stem !== undefined && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) name = `_${name}`
  return name.slice(0, 180)
}

async function materializeRemoteFile(
  manager: RemoteSshManager,
  workspaceId: string,
  remotePath: string,
  maxBytes: number,
): Promise<string> {
  const route = manager.workspace(workspaceId)
  const workspace = await manager.workspaceContext(route)
  const target = await workspace.fs.resolve(remotePath)
  const info = await workspace.fs.stat(target)
  if (info === undefined) throw new Error(`remote file does not exist: ${remotePath}`)
  if (info.type !== 'file') throw new Error(`download fallback only supports files: ${remotePath}`)
  if (info.size !== undefined && info.size > maxBytes) {
    throw new Error(`remote file exceeds the download limit of ${String(maxBytes)} bytes: ${remotePath}`)
  }
  const bytes = await workspace.fs.readBytes(target, undefined, maxBytes)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const directory = resolve(tmpdir(), 'dsh-remote-ssh', 'open-file', workspaceId, digest.slice(0, 20))
  const localPath = resolve(directory, safeDownloadedName(remotePath))
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(localPath, bytes, { flag: 'wx' })
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error
  }
  return localPath
}

async function editorCandidates(
  mode: Exclude<RemoteOpenFileMode, 'download'>,
  customPath?: string,
): Promise<EditorInvocation[]> {
  if (mode === 'custom') {
    if (customPath === undefined || !isAbsolute(customPath) || !await executableExists(customPath)) return []
    return [await editorInvocation('custom', customPath)]
  }
  const ids = mode === 'auto' ? AUTO_ORDER : [mode]
  const found: EditorInvocation[] = []
  for (const id of ids) {
    const executable = await findEditorExecutable(EDITORS[id])
    if (executable !== undefined) found.push(await editorInvocation(id, executable))
  }
  return found
}

async function editorInvocation(id: KnownEditorId | 'custom', executable: string): Promise<EditorInvocation> {
  if (process.platform !== 'win32' || !executable.toLowerCase().endsWith('.exe')) {
    return { id, executable, prefixArgs: [], probe: true }
  }
  const cli = await findWindowsVscCli(executable)
  // Without the headless CLI the application executable cannot list extensions; probing it
  // would open a window, so the launch itself decides and reports a failure instead.
  if (cli === undefined) return { id, executable, prefixArgs: [], probe: false }
  return {
    id,
    executable,
    prefixArgs: [cli],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    probe: true,
  }
}

/** Resolve the versioned CLI entry used by VSC application executables on Windows. */
export async function findWindowsVscCli(executable: string): Promise<string | undefined> {
  const root = dirname(executable)
  const direct = resolve(root, 'resources', 'app', 'out', 'cli.js')
  if (await pathExists(direct)) return direct
  // An install that keeps a pending update beside the running one lists both version
  // directories; the shipped shim names the one this installation actually launches.
  for (const shim of ['code.cmd', 'code.bat']) {
    const [launched] = await shimTargets(resolve(root, 'bin', shim), /"%~dp0([^"]+?cli\.js)"/gi)
    if (launched !== undefined) return launched
  }
  let children: string[]
  try {
    children = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
      .reverse()
  } catch {
    return undefined
  }
  for (const child of children) {
    const candidate = resolve(root, child, 'resources', 'app', 'out', 'cli.js')
    if (await pathExists(candidate)) return candidate
  }
  return undefined
}

async function findEditorExecutable(editor: EditorDefinition): Promise<string | undefined> {
  const pathCandidate = await findExecutableOnPath(editor.command)
  if (pathCandidate !== undefined) {
    const resolved = process.platform === 'win32'
      ? await resolveWindowsExecutable(pathCandidate, editor.executableName)
      : pathCandidate
    if (resolved !== undefined) return resolved
  }
  const candidates = process.platform === 'win32'
    ? editor.windowsLocations(process.env)
    : process.platform === 'darwin' ? editor.macLocations : []
  for (const candidate of candidates) if (await executableExists(candidate)) return candidate
  return undefined
}

/**
 * Resolve the application executable a Windows command shim launches.
 * @param candidate - Executable or command shim found on PATH.
 * @param executableName - Application executable expected beside the shim's parent directory.
 * @returns The application executable, the candidate itself when it is one, or undefined.
 */
async function resolveWindowsExecutable(candidate: string, executableName: string): Promise<string | undefined> {
  if (!/\.(?:cmd|bat)$/i.test(candidate)) return candidate
  const [launched] = await shimTargets(candidate, /"%~dp0([^"]+?\.exe)"/gi)
  if (launched !== undefined) return launched
  const sibling = resolve(dirname(candidate), '..', executableName)
  return await executableExists(sibling) ? sibling : undefined
}

/**
 * Absolute targets an existing Windows command shim launches, expanded from its own location.
 * @param shim - Command shim path, absent for installs without one.
 * @param pattern - Global expression capturing the shim-relative argument to expand.
 * @returns Existing absolute targets in shim order; empty when the shim is absent or unreadable.
 */
async function shimTargets(shim: string, pattern: RegExp): Promise<string[]> {
  let content = ''
  try { content = await readFile(shim, 'utf8') } catch { return [] }
  const directory = dirname(shim)
  const targets: string[] = []
  for (const match of content.matchAll(pattern)) {
    const target = resolve(directory, match[1]!.replaceAll('\\', '/'))
    if (await pathExists(target)) targets.push(target)
  }
  return targets
}

async function findExecutableOnPath(command: string): Promise<string | undefined> {
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = resolve(directory, `${command}${suffix}`)
      if (await executableExists(candidate)) return candidate
    }
  }
  return undefined
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function supportsRemoteSsh(editor: EditorInvocation): Promise<boolean> {
  if (!editor.probe) return true
  const key = JSON.stringify([editor.executable, editor.prefixArgs])
  const cached = editorSupport.get(key)
  if (cached !== undefined && Date.now() - cached.at < EDITOR_PROBE_TTL_MS) return cached.value
  const value = capture(editor, ['--list-extensions'], 8_000).then((output) => {
    const extensions = output.split(/\r?\n/).map(text => text.trim().toLowerCase()).filter(Boolean)
    return extensions.some(extension => REMOTE_SSH_EXTENSIONS.has(extension) || extension.endsWith('.remote-ssh'))
  }, () => false)
  editorSupport.set(key, { at: Date.now(), value })
  return value
}

async function launchEditor(editor: EditorInvocation, sshTarget: string, remotePath: string): Promise<void> {
  const child = spawn(editor.executable, [...editor.prefixArgs, ...editorLaunchArgs(sshTarget, remotePath)], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    ...(editor.env === undefined ? {} : { env: editor.env }),
  })
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolvePromise()
      else reject(error)
    }
    const timer = setTimeout(() => {
      child.unref()
      finish()
    }, 1_500)
    child.once('error', error => { finish(error) })
    child.once('close', code => {
      if (code === 0) finish()
      else finish(new Error(`editor exited with code ${String(code)}`))
    })
  })
}

async function capture(editor: EditorInvocation, args: string[], timeoutMs: number): Promise<string> {
  const child = spawn(editor.executable, [...editor.prefixArgs, ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(editor.env === undefined ? {} : { env: editor.env }),
  })
  const chunks: Buffer[] = []
  let size = 0
  child.stdout.on('data', (chunk: Buffer) => {
    if (size >= 1024 * 1024) return
    chunks.push(chunk.subarray(0, 1024 * 1024 - size))
    size += chunk.length
  })
  const timer = setTimeout(() => { child.kill() }, timeoutMs)
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', resolvePromise)
  }).finally(() => { clearTimeout(timer) })
  if (code !== 0) throw new Error(`editor probe exited with code ${String(code)}`)
  return Buffer.concat(chunks).toString('utf8')
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => value !== undefined)
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
