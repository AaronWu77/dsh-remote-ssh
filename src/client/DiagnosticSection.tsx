/** Explicit, lease-renewing diagnostic control; each component owns only its own diagnostic id. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DiagnosticId, DiagnosticReport, PreferencesState } from '../management-types.ts'
import type { Server } from './api.ts'
import { RemoteSshRequestError } from './api.ts'
import { cancelDiagnostic, diagnosticRunning, parseDiagnosticId, parseDiagnosticReport, pollDiagnostic, releaseDiagnostic, startDiagnostic } from './management-api.ts'
import { DiagnosticReportView } from './DiagnosticReportView.tsx'
import type { Translate } from './types.ts'
import type { RemoteSshLocaleKey } from './locales.ts'
import css from './ui.module.css'

interface OwnedDiagnostic { id: DiagnosticId; controller: AbortController; timer?: ReturnType<typeof setTimeout>; cancelled: boolean; starting: boolean }
function errorKey(error: unknown): RemoteSshLocaleKey {
  if (error instanceof RemoteSshRequestError) {
    if (error.status === 404) return 'diagnosticExpired'
    if (error.status === 429) return 'diagnosticCapacity'
    if (error.status === 409) return 'diagnosticConflict'
    if (error.code === 'management_invalid_response') return 'managementInvalidResponse'
  }
  return 'diagnosticUnknown'
}
export function DiagnosticSection({ t, servers, preferences, blocked, unsaved, onBusyChange }: { t: Translate; servers: Server[]; preferences: PreferencesState | undefined; blocked: boolean; unsaved: boolean; onBusyChange: (busy: boolean) => void }) {
  const id = useId()
  const [serverId, setServerId] = useState('')
  const [mode, setMode] = useState<'basic' | 'deep'>('basic')
  const [terminal, setTerminal] = useState(false)
  const [path, setPath] = useState('')
  const invalidPath = mode === 'deep' && path.trim() !== '' && (!path.trim().startsWith('/') || /[\r\n\0]/.test(path))
  const [confirmed, setConfirmed] = useState(false)
  const [report, setReport] = useState<DiagnosticReport>()
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running' | 'cancelling'>('idle')
  const [problem, setProblem] = useState<RemoteSshLocaleKey>()
  const [copyFailed, setCopyFailed] = useState(false)
  const active = useRef(false)
  const run = useRef<OwnedDiagnostic>()
  const notify = useRef(onBusyChange); notify.current = onBusyChange
  const finish = (owned: OwnedDiagnostic) => {
    clearTimeout(owned.timer); owned.controller.abort()
    if (run.current === owned) { run.current = undefined; if (active.current) { setPhase('idle'); notify.current(false) } }
  }
  const fail = (owned: OwnedDiagnostic, error: unknown) => {
    if (!active.current || run.current !== owned) return
    releaseDiagnostic(owned.id); setProblem(errorKey(error)); finish(owned)
  }
  const accept = (owned: OwnedDiagnostic, next: DiagnosticReport) => {
    if (!active.current || run.current !== owned) return
    if (next.id !== owned.id) { fail(owned, new RemoteSshRequestError('Diagnostic id mismatch', 'management_invalid_response')); return }
    setReport(next)
    if (!diagnosticRunning(next)) { finish(owned); return }
    setPhase(owned.cancelled || next.status === 'cancelling' ? 'cancelling' : 'running')
    clearTimeout(owned.timer)
    owned.timer = setTimeout(() => { void pollDiagnostic(owned.id, owned.controller.signal).then(value => accept(owned, value), error => fail(owned, error)) }, 1_000)
  }
  const stop = async (owned: OwnedDiagnostic) => {
    if (run.current !== owned) return
    owned.cancelled = true; clearTimeout(owned.timer); setPhase('cancelling')
    try {
      const next = await cancelDiagnostic(owned.id)
      if (!active.current || run.current !== owned) return
      if (next) accept(owned, next)
      else { setProblem(owned.starting ? 'diagnosticCancelled' : 'diagnosticUnknown'); finish(owned) }
    } catch (error) { fail(owned, error) }
  }
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      const owned = run.current; run.current = undefined
      if (owned) { clearTimeout(owned.timer); owned.controller.abort(); releaseDiagnostic(owned.id) }
      notify.current(false)
    }
  }, [])
  const start = async () => {
    if (run.current || blocked || unsaved || invalidPath || !preferences || preferences.applicationState !== 'applied' || !servers.some(s => s.id === serverId) || (mode === 'deep' && !confirmed)) return
    let diagnosticId: DiagnosticId
    try { diagnosticId = parseDiagnosticId(crypto.randomUUID()) } catch { setProblem('diagnosticFailed'); return }
    const owned: OwnedDiagnostic = { id: diagnosticId, controller: new AbortController(), cancelled: false, starting: true }
    run.current = owned; setPhase('starting'); setProblem(undefined); setReport(undefined); setCopyFailed(false); notify.current(true)
    try {
      const next = await startDiagnostic({ id: owned.id, expectedRevision: preferences.revision, serverId, mode, terminal: mode === 'deep' && terminal, confirmDeep: mode === 'deep' && confirmed, ...(mode === 'deep' && path.trim() ? { path: path.trim() } : {}) }, owned.controller.signal)
      owned.starting = false
      if (!active.current || run.current !== owned) { releaseDiagnostic(owned.id); return }
      if (owned.cancelled) { await stop(owned); return }
      accept(owned, next)
    } catch (error) { owned.starting = false; fail(owned, error) }
  }
  const copy = async () => {
    if (!report) return
    setCopyFailed(false)
    try { await navigator.clipboard.writeText(JSON.stringify(parseDiagnosticReport(report), null, 2)) }
    catch { if (active.current) setCopyFailed(true) }
  }
  const running = phase !== 'idle'
  const locked = blocked || running
  return <div className={css.stack}>
    {unsaved ? <p role="note" className={css.notice}>{t('unsavedPreferences')}</p> : null}
    {!preferences || preferences.applicationState !== 'applied' ? <p role="note" className={css.notice}>{t('preferencesRequired')}</p> : null}
    <div className={css.field}><label htmlFor={id + '-host'}>{t('diagnosticTarget')}</label>
      <select id={id + '-host'} className={css.select} value={serverId} disabled={locked} onChange={e => { setServerId(e.target.value); setConfirmed(false) }}>
        <option value="">{t('diagnosticChooseHost')}</option>{servers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
    </div>
    <fieldset className={css.options} disabled={locked}><legend>{t('diagnosticMode')}</legend>
      <label className={css.row}><input type="radio" name={id + '-mode'} checked={mode === 'basic'} onChange={() => { setMode('basic'); setConfirmed(false); setTerminal(false) }} />{t('diagnosticBasic')}</label>
      <label className={css.row}><input type="radio" name={id + '-mode'} checked={mode === 'deep'} onChange={() => { setMode('deep'); setConfirmed(false) }} />{t('diagnosticDeep')}</label>
    </fieldset>
    <p className={css.detail}>{t(mode === 'basic' ? 'diagnosticBasicHelp' : 'diagnosticDeepHelp')}</p>
    {mode === 'deep' ? <>
      <div className={css.field}><label htmlFor={id + '-path'}>{t('diagnosticPath')}</label><Input id={id + '-path'} disabled={locked} value={path} onChange={e => setPath(e.target.value)} /><p className={css.detail}>{t('diagnosticPathHelp')}</p></div>
      {invalidPath ? <p role="alert" className={css.error}>{t('absolutePathRequired')}</p> : null}
      <Checkbox checked={terminal} disabled={locked} onChange={setTerminal} label={t('diagnosticTerminal')} />
      <Checkbox checked={confirmed} disabled={locked} onChange={setConfirmed} label={t('diagnosticConfirm')} />
    </> : null}
    <div className={css.row}>
      <Button size="sm" variant="primary" disabled={locked || unsaved || invalidPath || !preferences || preferences.applicationState !== 'applied' || !servers.some(s => s.id === serverId) || (mode === 'deep' && !confirmed)} onClick={() => { void start() }}>{t('diagnosticStart')}</Button>
      {running ? <Button size="sm" disabled={phase === 'cancelling'} onClick={() => { if (run.current) void stop(run.current) }}>{t('diagnosticStop')}</Button> : null}
      {phase === 'starting' ? <span role="status" className={css.detail}>{t('diagnosticStarting')}</span> : phase === 'cancelling' ? <span role="status" className={css.detail}>{t('diagnosticCancelPending')}</span> : null}
    </div>
    {problem ? <p role="alert" className={css.error}>{t(problem)}</p> : null}
    {report ? <>
      <DiagnosticReportView t={t} report={report} revision={preferences?.revision} />
      <p className={css.detail}>{t('diagnosticExportHelp')}</p>
      <div className={css.row}><Button size="sm" onClick={() => { void copy() }}>{t('diagnosticCopy')}</Button></div>
      {copyFailed ? <p role="alert" className={css.error}>{t('diagnosticCopyFailed')}</p> : null}
    </> : null}
  </div>
}
