/** Advanced preferences and diagnostics share one authoritative saved configuration. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Server } from './api.ts'
import { AdvancedSettings } from './AdvancedSettings.tsx'
import { DiagnosticSection } from './DiagnosticSection.tsx'
import { usePreferences } from './use-preferences.ts'
import type { Translate } from './types.ts'
import css from './ui.module.css'

export function RemoteManagement({ t, servers, busy, onApplied, onBusyChange }: { t: Translate; servers: Server[]; busy: boolean; onApplied: () => void; onBusyChange: (busy: boolean) => void }) {
  const [enabled, setEnabled] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [diagnosticBusy, setDiagnosticBusy] = useState(false)
  const p = usePreferences(enabled, onApplied)
  const blocked = p.phase === 'saving' || p.mustReload || p.saved?.applicationState === 'unconfirmed' || diagnosticBusy
  useEffect(() => { onBusyChange(blocked) }, [blocked, onBusyChange])
  return <>
    <details className={css.disclosure} open={advancedOpen} onToggle={e => { setAdvancedOpen(e.currentTarget.open); if (e.currentTarget.open) setEnabled(true) }}>
      <summary className={css.disclosureTitle}><span>{t('advancedTitle')}</span><span className={css.detail}>{t('advancedSummary')}</span></summary>
      {advancedOpen ? <AdvancedSettings t={t} preferences={p} busy={busy || diagnosticBusy} /> : null}
    </details>
    <details className={css.disclosure} open={diagnosticsOpen} onToggle={e => { setDiagnosticsOpen(e.currentTarget.open); if (e.currentTarget.open) setEnabled(true) }}>
      <summary className={css.disclosureTitle}><span>{t('diagnosticsTitle')}</span><span className={css.detail}>{t('diagnosticsSummary')}</span></summary>
      {diagnosticsOpen && !advancedOpen && (p.problem || !p.saved) ? <div className={css.stack}>{p.problem ? <p role="alert" className={css.error}>{t(p.problem)}</p> : null}<Button size="sm" disabled={busy || p.phase !== 'idle'} onClick={() => { void p.reload() }}>{t('preferencesReload')}</Button></div> : null}
      {diagnosticsOpen ? <DiagnosticSection t={t} servers={servers} preferences={p.saved} blocked={busy || p.phase !== 'idle' || p.mustReload} unsaved={p.dirty} onBusyChange={setDiagnosticBusy} /> : null}
    </details>
  </>
}
