/** Shared settings and diagnostic responses; no credentials or raw SSH output cross this API. */
export type EditorMode = 'auto' | 'vscode' | 'cursor' | 'windsurf' | 'vscodium' | 'custom' | 'download'

/** Effective preferences and optimistic-concurrency token for one manager instance. */
export interface PreferencesState {
  revision: string
  sshConfigFile: string
  openFileMode: EditorMode
  openFileEditorPath: string
  platform: string
  activeExecutions: number
  connectionCount: number
  applicationState: 'applied' | 'unconfirmed'
}

/** Preferences only; unrelated servers and workspaces are never replaced by this request. */
export interface SavePreferencesRequest {
  expectedRevision: string
  sshConfigFile: string
  openFileMode: EditorMode
  openFileEditorPath: string
  confirmConnectionReset: boolean
}

/** Random capability identifying a short-lived, authenticated diagnostic. */
export type DiagnosticId = string & { readonly __diagnosticId: unique symbol }
export type DiagnosticStageId = 'config' | 'ssh' | 'agentHost' | 'tunnel' | 'protocol' | 'directory' | 'terminal' | 'cleanup'
export type DiagnosticStageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type DiagnosticStatus = 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'

/** Stable codes are translated by clients; detail is limited to non-secret measured facts. */
export interface DiagnosticStage {
  id: DiagnosticStageId
  status: DiagnosticStageStatus
  elapsedMs: number
  code?: string
}

/** Safe to export: deliberately omits target names, account names, paths, argv and stdout. */
export interface DiagnosticReport {
  id: DiagnosticId
  revision: string
  mode: 'basic' | 'deep'
  terminal: boolean
  status: DiagnosticStatus
  startedAt: number
  finishedAt?: number
  stages: DiagnosticStage[]
  protocolVersion?: string
  directoryCount?: number
  prerequisites?: Record<string, boolean>
}

/** Client creates the id before dispatch, so a cancelled/ambiguous start can still be cancelled by id. */
export interface StartDiagnosticRequest {
  id: DiagnosticId
  expectedRevision: string
  serverId: string
  mode: 'basic' | 'deep'
  terminal: boolean
  confirmDeep: boolean
  path?: string
}
