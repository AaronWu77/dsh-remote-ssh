/** Localized in-place action failure with selectable technical details. */
import type { ReactElement } from 'react'
import { error as errorStyle } from './styles.ts'
import type { Translate } from './types.ts'

/**
 * Report a failed action beside the control that failed.
 * @param props - The failure and locale dictionary.
 * @returns An in-place notice, or null when no failure is present.
 */
export function FailureNotice(props: { error: unknown; t: Translate }): ReactElement | null {
  if (!props.error) return null
  const details = props.error instanceof Error ? props.error.message : String(props.error)
  return <div role="alert">
    <p style={errorStyle}>{props.t('actionFailed')}</p>
    <details><summary>{props.t('errorDetails')}</summary>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '30vh', overflow: 'auto', fontSize: 'inherit' }}>{details}</pre>
    </details>
  </div>
}
