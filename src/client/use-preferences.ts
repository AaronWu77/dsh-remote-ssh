/** Component-owned preference drafts and guarded async operations; save cancellation never claims rollback. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PreferencesState, SavePreferencesRequest } from '../management-types.ts'
import { RemoteSshRequestError } from './api.ts'
import { loadPreferences, savePreferences } from './management-api.ts'
import type { RemoteSshLocaleKey } from './locales.ts'

export type PreferenceDraft = Pick<PreferencesState, 'sshConfigFile' | 'openFileMode' | 'openFileEditorPath'>
export function preferenceDraft(state: PreferencesState): PreferenceDraft { return { sshConfigFile: state.sshConfigFile, openFileMode: state.openFileMode, openFileEditorPath: state.openFileEditorPath } }
export function samePreferences(a: PreferenceDraft, b: PreferenceDraft): boolean { return a.sshConfigFile === b.sshConfigFile && a.openFileMode === b.openFileMode && a.openFileEditorPath === b.openFileEditorPath }
/** Paths name files on the host, not on the browser's device. */
export function absoluteHostPath(value: string, platform: string): boolean {
  if (/[\r\n\0]/.test(value)) return false
  return platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value) : value.startsWith('/')
}
const errorKeys: Record<string, RemoteSshLocaleKey> = { settings_conflict: 'preferencesConflict', settings_busy: 'preferencesBusy', settings_confirmation_required: 'preferencesConfirm', settings_invalid_path: 'preferencesInvalidPath', settings_apply_unconfirmed: 'preferencesUnconfirmed', settings_unavailable: 'preferencesUnavailable', management_invalid_response: 'managementInvalidResponse' }
export function preferenceError(error: unknown): RemoteSshLocaleKey { return error instanceof RemoteSshRequestError ? errorKeys[error.code ?? ''] ?? 'preferencesUnknown' : 'preferencesUnknown' }

export function usePreferences(enabled: boolean, onApplied: () => void) {
  const [saved, setSaved] = useState<PreferencesState>()
  const [draft, setDraft] = useState<PreferenceDraft>()
  const [phase, setPhase] = useState<'idle' | 'loading' | 'saving'>('idle')
  const [problem, setProblem] = useState<RemoteSshLocaleKey>()
  const [mustReload, setMustReload] = useState(false)
  const [verified, setVerified] = useState(false)
  const active = useRef(false)
  const operation = useRef<{ controller: AbortController; kind: 'loading' | 'saving' }>()
  const applied = useRef(onApplied); applied.current = onApplied
  const reload = useCallback(async () => {
    if (operation.current?.kind === 'saving') return
    operation.current?.controller.abort()
    const current = { controller: new AbortController(), kind: 'loading' as const }
    operation.current = current; setPhase('loading'); setVerified(false)
    try {
      const next = await loadPreferences(current.controller.signal)
      if (!active.current || operation.current !== current) return
      setSaved(next); setDraft(preferenceDraft(next)); setMustReload(next.applicationState !== 'applied')
      setProblem(next.applicationState === 'applied' ? undefined : 'preferencesUnconfirmed')
    } catch (error) {
      if (!active.current || operation.current !== current || current.controller.signal.aborted) return
      setProblem(error instanceof RemoteSshRequestError && error.code === 'settings_apply_unconfirmed' ? 'preferencesUnconfirmed' : 'preferencesLoadFailed')
      setMustReload(true)
    } finally { if (active.current && operation.current === current) { operation.current = undefined; setPhase('idle') } }
  }, [])
  useEffect(() => { active.current = true; return () => { active.current = false; operation.current?.controller.abort(); operation.current = undefined } }, [])
  useEffect(() => { if (enabled) void reload() }, [enabled, reload])
  const dirty = saved !== undefined && draft !== undefined && !samePreferences(saved, draft)
  const sshChanged = saved !== undefined && draft !== undefined && saved.sshConfigFile !== draft.sshConfigFile.trim()
  const invalid = draft !== undefined && saved !== undefined && ((draft.sshConfigFile.trim() !== '' && !absoluteHostPath(draft.sshConfigFile.trim(), saved.platform)) || (draft.openFileMode === 'custom' && !absoluteHostPath(draft.openFileEditorPath.trim(), saved.platform)))
  const save = async (confirmConnectionReset: boolean) => {
    if (operation.current || !saved || !draft || !dirty || invalid || mustReload || saved.applicationState !== 'applied' || (sshChanged && saved.activeExecutions > 0) || (sshChanged && saved.connectionCount > 0 && !confirmConnectionReset)) return
    const current = { controller: new AbortController(), kind: 'saving' as const }
    operation.current = current; setPhase('saving'); setProblem(undefined); setVerified(false)
    const body: SavePreferencesRequest = { ...draft, sshConfigFile: draft.sshConfigFile.trim(), openFileEditorPath: draft.openFileEditorPath.trim(), expectedRevision: saved.revision, confirmConnectionReset }
    let written = false
    try {
      const committed = await savePreferences(body, current.controller.signal); written = true
      if (!active.current || operation.current !== current) return
      const next = await loadPreferences(current.controller.signal)
      if (!active.current || operation.current !== current) return
      if (!samePreferences(committed, body) || next.revision !== committed.revision || !samePreferences(next, committed)) { setProblem('preferencesConflict'); setMustReload(true); return }
      setSaved(next); setDraft(preferenceDraft(next)); setMustReload(next.applicationState !== 'applied')
      setProblem(next.applicationState === 'applied' ? undefined : 'preferencesUnconfirmed'); setVerified(next.applicationState === 'applied')
      applied.current()
    } catch (error) {
      if (!active.current || operation.current !== current) return
      const key = written ? 'preferencesUnverified' : preferenceError(error)
      setProblem(key)
      setMustReload(!['preferencesInvalidPath', 'preferencesBusy', 'preferencesConfirm'].includes(key))
    } finally { if (active.current && operation.current === current) { operation.current = undefined; setPhase('idle') } }
  }
  const cancelWait = () => {
    if (operation.current?.kind !== 'saving') return
    operation.current.controller.abort(); operation.current = undefined
    setPhase('idle'); setProblem('preferencesUnknown'); setMustReload(true); setVerified(false)
  }
  const edit = (next: PreferenceDraft) => { if (operation.current || mustReload) return; setDraft(next); setVerified(false); setProblem(undefined) }
  const discard = () => { if (saved && !operation.current && !mustReload) { setDraft(preferenceDraft(saved)); setProblem(undefined); setVerified(false) } }
  const defaults = () => { if (saved && !operation.current && !mustReload) edit({ sshConfigFile: '', openFileMode: 'auto', openFileEditorPath: '' }) }
  return { saved, draft, phase, problem, mustReload, verified, dirty, sshChanged, invalid, save, cancelWait, reload, edit, discard, defaults }
}
export type PreferencesController = ReturnType<typeof usePreferences>
