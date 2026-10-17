/** Host-wide SSH and editor preferences; draft changes never submit implicitly. */
import { useEffect, useId, useState } from 'react'
import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EditorMode } from '../management-types.ts'
import type { RemoteSshLocaleKey } from './locales.ts'
import type { Translate } from './types.ts'
import type { PreferencesController } from './use-preferences.ts'
import css from './ui.module.css'

const modes: Array<[EditorMode, RemoteSshLocaleKey]> = [['auto', 'openFileAuto'], ['vscode', 'openFileVscode'], ['cursor', 'openFileCursor'], ['windsurf', 'openFileWindsurf'], ['vscodium', 'openFileVscodium'], ['custom', 'openFileCustom'], ['download', 'openFileDownload']]
export function AdvancedSettings({ t, preferences: p, busy }: { t: Translate; preferences: PreferencesController; busy: boolean }) {
  const id = useId()
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => { setConfirmed(false) }, [p.draft?.sshConfigFile, p.saved?.revision])
  const locked = busy || p.phase !== 'idle' || p.mustReload
  const canSave = p.dirty && !p.invalid && !locked && !(p.sshChanged && (p.saved?.activeExecutions ?? 0) > 0) && !(p.sshChanged && (p.saved?.connectionCount ?? 0) > 0 && !confirmed)
  return <div className={css.stack} aria-busy={p.phase !== 'idle'}>
    <p className={css.detail}>{t('advancedScope')}</p>
    {p.phase === 'loading' ? <div className={css.loading} role="status" aria-label={t('preferencesReload')}><span className={css.spinner} /></div> : null}
    {p.problem ? <p role="alert" className={css.error}>{t(p.problem)}</p> : null}
    {p.verified ? <p role="status" className={css.notice}>{t('preferencesSaved')}</p> : null}
    {p.draft && p.saved ? <>
      <div className={css.field}>
        <label htmlFor={id + '-config'}>{t('sshConfigLabel')}</label>
        <Input id={id + '-config'} value={p.draft.sshConfigFile} placeholder={t('sshConfigPlaceholder')} disabled={locked} onChange={e => p.edit({ ...p.draft!, sshConfigFile: e.target.value })} />
        <p className={css.detail}>{t('sshConfigHelp')}</p>
      </div>
      {p.sshChanged ? <div className={css.stack}>
        <p className={css.detail}>{t('connectionWarning', { connections: p.saved.connectionCount, executions: p.saved.activeExecutions })}</p>
        {p.saved.activeExecutions > 0 ? <p role="alert" className={css.error}>{t('preferencesBusy')}</p> : null}
        {p.saved.connectionCount > 0 ? <Checkbox checked={confirmed} disabled={locked} onChange={setConfirmed} label={t('confirmConnectionReset')} /> : null}
      </div> : null}
      <div className={css.field}>
        <label htmlFor={id + '-editor-mode'}>{t('openFileLabel')}</label>
        <select id={id + '-editor-mode'} className={css.select} value={p.draft.openFileMode} disabled={locked} onChange={e => { const mode = modes.find(([value]) => value === e.target.value)?.[0]; if (mode) p.edit({ ...p.draft!, openFileMode: mode }) }}>
          {modes.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </div>
      {p.draft.openFileMode === 'custom' ? <div className={css.field}>
        <label htmlFor={id + '-editor-path'}>{t('customEditorLabel')}</label>
        <Input id={id + '-editor-path'} value={p.draft.openFileEditorPath} placeholder={t('customEditorPlaceholder')} disabled={locked} onChange={e => p.edit({ ...p.draft!, openFileEditorPath: e.target.value })} />
      </div> : null}
      {p.invalid ? <p role="alert" className={css.error}>{t('absolutePathRequired')}</p> : null}
      <p className={css.detail}>{t('embeddedPreviewHelp')}</p>
      <p className={css.detail}>{t('restoreDefaultsHelp')}</p>
      <div className={css.footer}>
        <Button size="sm" disabled={locked} onClick={p.defaults}>{t('restoreDefaults')}</Button>
        <Button size="sm" disabled={locked || !p.dirty} onClick={p.discard}>{t('discard')}</Button>
        <Button size="sm" variant="primary" disabled={!canSave} onClick={() => { void p.save(confirmed) }}>{t(p.phase === 'saving' ? 'saving' : 'save')}</Button>
        {p.phase === 'saving' ? <Button size="sm" onClick={p.cancelWait}>{t('cancelSaveWait')}</Button> : null}
      </div>
    </> : null}
    <div className={css.row}><Button size="sm" disabled={busy || p.phase !== 'idle'} onClick={() => { void p.reload() }}>{t('preferencesReload')}</Button></div>
  </div>
}
