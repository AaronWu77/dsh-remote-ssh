/** Localized connection summary with selectable technical details. */
import type { ReactElement } from 'react'
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
  const classified = props.error instanceof RemoteSshRequestError && props.error.code === 'agent_host_unavailable'
  return <div role="alert">
    <p>{classified ? props.t('agentHostUnavailable') : props.t('directoryFailed')}</p>
    <details><summary>{props.t('connectionDetails')}</summary>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '30vh', overflow: 'auto', fontSize: 'inherit' }}>{details}</pre>
    </details>
  </div>
}
