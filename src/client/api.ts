export const STATE_PATH = '/plugins/dsh-remote-ssh/state'
export const WORKSPACE_PATH = '/plugins/dsh-remote-ssh/workspace'
export const WORKSPACE_REMOVE_PATH = '/plugins/dsh-remote-ssh/workspace/remove'
export const LOCAL_WORKSPACE_PATH = '/plugins/dsh-remote-ssh/local-workspace'
export const PROBE_PATH = '/plugins/dsh-remote-ssh/probe'
export const CONFIG_HOST_PATH = '/plugins/dsh-remote-ssh/ssh-config/host'
export const SETTINGS_PATH = '/plugins/dsh-remote-ssh/settings'
export const DIRECTORY_PATH = '/plugins/dsh-remote-ssh/directory'
export const OPEN_FILE_PATH = '/plugins/dsh-remote-ssh/open-file'

export type OpenFileMode = 'auto' | 'vscode' | 'cursor' | 'windsurf' | 'vscodium' | 'custom' | 'download'

export interface Server {
  id: string
  label: string
  sshTarget: string
  source: 'ssh-config' | 'saved'
  configPath?: string
  hostName?: string
  user?: string
  port?: number
}

export interface Workspace {
  id: string
  serverId: string
  remotePath: string
  aliasPath: string
  /** Title the Workspace surface holds, absent until the user names it. */
  title?: string
}

export interface RemoteDirectoryListing {
  path: string
  home: string
  parent?: string
  entries: Array<{ name: string; path: string }>
}

export interface CatalogState {
  servers: Server[]
  workspaces: Workspace[]
  serverCount: number
  discoveredServerCount: number
  workspaceCount: number
  configFiles: string[]
  loadedConfigFiles: string[]
  configErrors: string[]
  customConfigFile?: string
  openFileMode: OpenFileMode
  openFileEditorPath?: string
}

export const emptyCatalog: CatalogState = {
  servers: [],
  workspaces: [],
  serverCount: 0,
  discoveredServerCount: 0,
  workspaceCount: 0,
  configFiles: [],
  loadedConfigFiles: [],
  configErrors: [],
  openFileMode: 'auto',
}

/** A classified same-origin failure with bounded technical diagnostics. */
export class RemoteSshRequestError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly status?: number) { super(message); this.name = 'RemoteSshRequestError' }
}

export async function request<T = unknown>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, options?: { keepalive?: boolean }): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(options?.keepalive === undefined ? {} : { keepalive: options.keepalive }),
    ...(signal === undefined ? {} : { signal }),
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value
      ? String(value.error)
      : `HTTP ${response.status}`
    const code = typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string' ? value.code : undefined
    throw new RemoteSshRequestError(message, code, response.status)
  }
  return value as T
}

/** Fetch and validate the catalog snapshot the settings and flow surfaces render. */
export async function fetchCatalogState(signal?: AbortSignal): Promise<CatalogState> {
  return parseCatalogState(await request(STATE_PATH, 'GET', undefined, signal))
}

/** Browse one remote directory through the validated listing response. */
export async function fetchDirectoryListing(body: Record<string, unknown>, signal?: AbortSignal): Promise<RemoteDirectoryListing> {
  return parseDirectoryListing(await request(DIRECTORY_PATH, 'POST', body, signal))
}

function malformed(endpoint: string): RemoteSshRequestError {
  return new RemoteSshRequestError(`the Remote SSH ${endpoint} response is malformed`, undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value : undefined
}

function parseServer(value: unknown): Server | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string' || typeof value.sshTarget !== 'string') return undefined
  if (value.source !== 'saved' && value.source !== 'ssh-config') return undefined
  return {
    id: value.id,
    label: value.label,
    sshTarget: value.sshTarget,
    source: value.source,
    ...(typeof value.configPath === 'string' ? { configPath: value.configPath } : {}),
    ...(typeof value.hostName === 'string' ? { hostName: value.hostName } : {}),
    ...(typeof value.user === 'string' ? { user: value.user } : {}),
    ...(typeof value.port === 'number' ? { port: value.port } : {}),
  }
}

function parseWorkspace(value: unknown): Workspace | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.serverId !== 'string') return undefined
  if (typeof value.remotePath !== 'string' || typeof value.aliasPath !== 'string') return undefined
  return {
    id: value.id,
    serverId: value.serverId,
    remotePath: value.remotePath,
    aliasPath: value.aliasPath,
    ...(typeof value.title === 'string' && value.title.length > 0 ? { title: value.title } : {}),
  }
}

function parseOpenFileMode(value: unknown): OpenFileMode | undefined {
  return value === 'auto' || value === 'vscode' || value === 'cursor' || value === 'windsurf'
    || value === 'vscodium' || value === 'custom' || value === 'download' ? value : undefined
}

function parseList<T>(value: unknown, parse: (entry: unknown) => T | undefined, endpoint: string): T[] {
  if (!Array.isArray(value)) throw malformed(endpoint)
  const parsed = value.map(entry => parse(entry))
  if (parsed.some(entry => entry === undefined)) throw malformed(endpoint)
  return parsed.filter((entry): entry is T => entry !== undefined)
}

/** Validate the host's catalog payload before any component renders it. */
export function parseCatalogState(value: unknown): CatalogState {
  if (!isRecord(value)) throw malformed('state')
  const servers = parseList(value.servers, parseServer, 'state')
  const workspaces = parseList(value.workspaces, parseWorkspace, 'state')
  const configFiles = stringList(value.configFiles)
  const loadedConfigFiles = stringList(value.loadedConfigFiles)
  const configErrors = stringList(value.configErrors)
  const openFileMode = parseOpenFileMode(value.openFileMode)
  if (configFiles === undefined || loadedConfigFiles === undefined || configErrors === undefined || openFileMode === undefined) throw malformed('state')
  if (typeof value.serverCount !== 'number' || typeof value.discoveredServerCount !== 'number' || typeof value.workspaceCount !== 'number') throw malformed('state')
  return {
    servers,
    workspaces,
    serverCount: value.serverCount,
    discoveredServerCount: value.discoveredServerCount,
    workspaceCount: value.workspaceCount,
    configFiles,
    loadedConfigFiles,
    configErrors,
    ...(typeof value.customConfigFile === 'string' ? { customConfigFile: value.customConfigFile } : {}),
    openFileMode,
    ...(typeof value.openFileEditorPath === 'string' ? { openFileEditorPath: value.openFileEditorPath } : {}),
  }
}

/** Validate one directory listing before the picker renders it. */
export function parseDirectoryListing(value: unknown): RemoteDirectoryListing {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.home !== 'string') throw malformed('directory')
  const entries = parseList(value.entries, entry => isRecord(entry) && typeof entry.name === 'string' && typeof entry.path === 'string'
    ? { name: entry.name, path: entry.path }
    : undefined, 'directory')
  return {
    path: value.path,
    home: value.home,
    ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
    entries,
  }
}
