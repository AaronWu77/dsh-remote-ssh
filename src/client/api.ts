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
  constructor(message: string, readonly code: string | undefined) { super(message); this.name = 'RemoteSshRequestError' }
}

export async function request<T = unknown>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
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
    throw new RemoteSshRequestError(message, code)
  }
  return value as T
}
