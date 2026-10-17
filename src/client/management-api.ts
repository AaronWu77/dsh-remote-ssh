/** Validated management responses; exportable diagnostics contain only explicitly allowed fields. */
import type { DiagnosticId, DiagnosticReport, DiagnosticStage, DiagnosticStageId, DiagnosticStageStatus, DiagnosticStatus, EditorMode, PreferencesState, SavePreferencesRequest, StartDiagnosticRequest } from '../management-types.ts'
import { request, RemoteSshRequestError, SETTINGS_PATH } from './api.ts'

export const DIAGNOSTIC_START = '/plugins/dsh-remote-ssh/diagnostics/start'
export const DIAGNOSTIC_STATUS = '/plugins/dsh-remote-ssh/diagnostics/status'
export const DIAGNOSTIC_CANCEL = '/plugins/dsh-remote-ssh/diagnostics/cancel'
export const stageIds: readonly DiagnosticStageId[] = ['config', 'ssh', 'agentHost', 'tunnel', 'protocol', 'directory', 'terminal', 'cleanup']
const stageStatuses: readonly DiagnosticStageStatus[] = ['pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']
const statuses: readonly DiagnosticStatus[] = ['running', 'cancelling', 'succeeded', 'failed', 'cancelled']
const editorModes: readonly EditorMode[] = ['auto', 'vscode', 'cursor', 'windsurf', 'vscodium', 'custom', 'download']
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function malformed(): never { throw new RemoteSshRequestError('Invalid management response', 'management_invalid_response') }
/** Validate a UUID before giving it the diagnostic capability type. */
export function parseDiagnosticId(value: unknown): DiagnosticId {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return malformed()
  return value as DiagnosticId
}
/** Validate settings before enabling edits; unknown defaults must never become writes. */
export function parsePreferences(value: unknown): PreferencesState {
  if (!record(value) || typeof value.revision !== 'string' || !value.revision || typeof value.sshConfigFile !== 'string' || typeof value.openFileEditorPath !== 'string' || typeof value.platform !== 'string') return malformed()
  if (!editorModes.includes(value.openFileMode as EditorMode) || !finite(value.activeExecutions) || !Number.isInteger(value.activeExecutions) || !finite(value.connectionCount) || !Number.isInteger(value.connectionCount)) return malformed()
  if (value.applicationState !== 'applied' && value.applicationState !== 'unconfirmed') return malformed()
  return { revision: value.revision, sshConfigFile: value.sshConfigFile, openFileEditorPath: value.openFileEditorPath, platform: value.platform, openFileMode: value.openFileMode as EditorMode, activeExecutions: value.activeExecutions, connectionCount: value.connectionCount, applicationState: value.applicationState }
}
/** Reconstruct the report rather than forwarding arbitrary server properties to the clipboard. */
export function parseDiagnosticReport(value: unknown): DiagnosticReport {
  if (!record(value) || typeof value.revision !== 'string' || !value.revision || !statuses.includes(value.status as DiagnosticStatus) || !finite(value.startedAt) || typeof value.terminal !== 'boolean' || (value.mode !== 'basic' && value.mode !== 'deep') || !Array.isArray(value.stages)) return malformed()
  const seen = new Set<string>()
  const stages: DiagnosticStage[] = value.stages.map(stage => {
    if (!record(stage) || !stageIds.includes(stage.id as DiagnosticStageId) || seen.has(String(stage.id)) || !stageStatuses.includes(stage.status as DiagnosticStageStatus) || !finite(stage.elapsedMs)) return malformed()
    seen.add(String(stage.id))
    if (stage.code !== undefined && (typeof stage.code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(stage.code))) return malformed()
    return { id: stage.id as DiagnosticStageId, status: stage.status as DiagnosticStageStatus, elapsedMs: stage.elapsedMs, ...(typeof stage.code === 'string' ? { code: stage.code } : {}) }
  })
  if (value.finishedAt !== undefined && !finite(value.finishedAt)) return malformed()
  if (value.protocolVersion !== undefined && (typeof value.protocolVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.protocolVersion))) return malformed()
  if (value.directoryCount !== undefined && (!finite(value.directoryCount) || !Number.isInteger(value.directoryCount))) return malformed()
  const prerequisites: Record<string, boolean> = {}
  if (value.prerequisites !== undefined) {
    if (!record(value.prerequisites)) return malformed()
    for (const key of ['bash', 'pwsh', 'rg', 'code', 'base64', 'mkfifo', 'dd', 'mv', 'ps', 'awk', 'kill', 'realpath', 'stat']) {
      if (value.prerequisites[key] !== undefined) { if (typeof value.prerequisites[key] !== 'boolean') return malformed(); prerequisites[key] = value.prerequisites[key] }
    }
  }
  return { id: parseDiagnosticId(value.id), revision: value.revision, mode: value.mode, terminal: value.terminal, status: value.status as DiagnosticStatus, startedAt: value.startedAt, stages,
    ...(typeof value.finishedAt === 'number' ? { finishedAt: value.finishedAt } : {}), ...(typeof value.protocolVersion === 'string' ? { protocolVersion: value.protocolVersion } : {}), ...(typeof value.directoryCount === 'number' ? { directoryCount: value.directoryCount } : {}), ...(value.prerequisites === undefined ? {} : { prerequisites }) }
}
export async function loadPreferences(signal?: AbortSignal): Promise<PreferencesState> { return parsePreferences(await request(SETTINGS_PATH, 'GET', undefined, signal)) }
export async function savePreferences(body: SavePreferencesRequest, signal?: AbortSignal): Promise<PreferencesState> { return parsePreferences(await request(SETTINGS_PATH, 'POST', body, signal)) }
export async function startDiagnostic(body: StartDiagnosticRequest, signal?: AbortSignal): Promise<DiagnosticReport> { return parseDiagnosticReport(await request(DIAGNOSTIC_START, 'POST', body, signal)) }
export async function pollDiagnostic(id: DiagnosticId, signal?: AbortSignal): Promise<DiagnosticReport> { return parseDiagnosticReport(await request(DIAGNOSTIC_STATUS, 'POST', { id }, signal)) }
export async function cancelDiagnostic(id: DiagnosticId, keepalive = false): Promise<DiagnosticReport | undefined> {
  const result = await request(DIAGNOSTIC_CANCEL, 'POST', { id }, undefined, { keepalive })
  return result === undefined ? undefined : parseDiagnosticReport(result)
}
/** Best effort only: a lost cancellation request is covered by the host's diagnostic lease. */
export function releaseDiagnostic(id: DiagnosticId): void { void cancelDiagnostic(id, true).catch(() => { /* The host lease remains the cleanup owner if the transport is gone. */ }) }
export function diagnosticRunning(report: DiagnosticReport): boolean { return report.status === 'running' || report.status === 'cancelling' }
/** Do not present a successful run before the independent cleanup stage has settled successfully. */
export function diagnosticSucceeded(report: DiagnosticReport): boolean { return report.status === 'succeeded' && report.stages.some(s => s.id === 'cleanup' && s.status === 'succeeded') && report.stages.every(s => s.status === 'succeeded' || s.status === 'skipped') }
