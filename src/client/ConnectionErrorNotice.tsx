/** Localized connection summary with selectable technical details. */
import type { ReactElement } from 'react'
import css from './ui.module.css'
import { RemoteSshRequestError } from './api.ts'
import type { Translate } from './types.ts'

/**
 * Display a query failure without hiding the previously loaded directory.
 * @param props - The failure and locale dictionary.
 * @returns An in-place notice, or null when no error is present.
 */
export function ConnectionErrorNotice(props: { error: unknown; t: Translate }): ReactElement | null {
  if (!props.error) return null
  const details = props.error instanceof Error ? props.error.message : String(props.error)
  const code = props.error instanceof RemoteSshRequestError ? props.error.code : undefined
  const summary = code === 'ssh_execution_failed' ? 'sshExecutionFailed' : code === 'agent_host_unavailable' ? 'agentHostUnavailable' : 'directoryFailed'
  return <div role="alert">
    <p className={css.error}>{props.t(summary)}</p>
    <details><summary>{props.t('connectionDetails')}</summary>
      <pre className={css.details}>{details}</pre>
    </details>
  </div>
}
