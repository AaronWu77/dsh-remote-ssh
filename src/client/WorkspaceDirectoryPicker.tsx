/** Inline directory browsing; only the explicit confirm action submits a verified path. */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input, IconFolderCloseRegular, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteDirectoryListing } from './api.ts'
import type { Translate } from './types.ts'
import { ConnectionErrorNotice } from './ConnectionErrorNotice.tsx'
import { FailureNotice } from './FailureNotice.tsx'
import css from './ui.module.css'

export interface WorkspaceDirectoryPickerProps {
  t: Translate
  title: string
  busy: boolean
  list: (path?: string, signal?: AbortSignal) => Promise<RemoteDirectoryListing>
  onPick: (path: string) => Promise<void>
  onWorking: (working: boolean) => void
  onCancel: () => void
}

/**
 * Browse within the owning modal. Unmount aborts reads and invalidates late responses.
 * @param props - Directory source and explicit commit callbacks; remount when the source changes.
 * @returns The path field, listing, recovery actions, and confirmation controls.
 */
export function WorkspaceDirectoryPicker(props: WorkspaceDirectoryPickerProps): ReactElement {
  const [listing, setListing] = useState<RemoteDirectoryListing>()
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>('')
  const [commitError, setCommitError] = useState<unknown>('')
  const generation = useRef(0)
  const draftRevision = useRef(0)
  const controller = useRef<AbortController>()
  const attemptedPath = useRef<string>()
  const pending = useRef(false)
  const composition = useRef<ReturnType<typeof observeComposition>>()

  const browse = async (path?: string): Promise<RemoteDirectoryListing | undefined> => {
    const revision = ++generation.current
    const editRevision = draftRevision.current
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    attemptedPath.current = path
    setLoading(true)
    setError('')
    setCommitError('')
    try {
      const next = await props.list(path, current.signal)
      if (current.signal.aborted || revision !== generation.current) return undefined
      setListing(next)
      if (editRevision === draftRevision.current) setDraft(next.path)
      return next
    } catch (reason) {
      if (!current.signal.aborted && revision === generation.current) setError(reason)
      return undefined
    } finally {
      if (!current.signal.aborted && revision === generation.current) setLoading(false)
    }
  }

  useEffect(() => {
    composition.current = observeComposition(document)
    void browse()
    return () => {
      generation.current += 1
      controller.current?.abort()
      composition.current?.dispose()
    }
  }, [])

  const confirm = async (): Promise<void> => {
    if (pending.current || props.busy || loading || !draft.trim()) return
    pending.current = true
    props.onWorking(true)
    setCommitError('')
    const next = listing !== undefined && !error && draft.trim() === listing.path
      ? listing : await browse(draft.trim())
    if (controller.current?.signal.aborted) return
    if (next === undefined) {
      pending.current = false
      props.onWorking(false)
      return
    }
    try { await props.onPick(next.path) }
    catch (reason) {
      if (!controller.current?.signal.aborted) {
        setCommitError(reason)
        pending.current = false
        props.onWorking(false)
      }
    }
  }

  return <div className={css.stack}>
    <div className={css.row}>
      <Input className={css.pathInput} disabled={props.busy} aria-label={props.t('directoryPath', { title: props.title })}
        value={draft} onChange={event => { draftRevision.current += 1; setDraft(event.target.value); setCommitError('') }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !composition.current?.guards(event.nativeEvent) && !props.busy && draft.trim()) {
            event.preventDefault(); void browse(draft.trim())
          }
        }} />
      <Button size="sm" disabled={props.busy || !draft.trim()} onClick={() => { void browse(draft.trim()) }}>{props.t('go')}</Button>
    </div>
    <div className={css.toolbar}>
      <Button size="sm" disabled={props.busy} onClick={() => { void browse(listing?.home) }}>{props.t('home')}</Button>
      <Button size="sm" disabled={props.busy || listing?.parent === undefined} onClick={() => { void browse(listing?.parent) }}>{props.t('parent')}</Button>
      <Button size="sm" disabled={props.busy} onClick={() => { void browse(listing?.path) }}>{props.t('refresh')}</Button>
      <span className={css.path}>{listing?.path}</span>
    </div>
    <div className={css.list} aria-busy={loading}>
      {listing?.entries.map(entry => <Button key={entry.path} size="sm" className={css.entry}
        icon={<IconFolderCloseRegular size={16} />} disabled={props.busy}
        onClick={() => { void browse(entry.path) }}>{entry.name}</Button>)}
      {!loading && listing?.entries.length === 0 ? <p className={css.empty}>{props.t('directoryEmpty')}</p> : null}
      {loading ? <p role="status" className={css.empty}>{props.t('directoryLoading')}</p> : null}
    </div>
    <ConnectionErrorNotice error={error} t={props.t} />
    {error ? <Button size="sm" disabled={props.busy} onClick={() => { void browse(attemptedPath.current) }}>{props.t('retry')}</Button> : null}
    <FailureNotice error={commitError} t={props.t} />
    <div className={css.footer}>
      <Button disabled={props.busy} onClick={props.onCancel}>{props.t('cancel')}</Button>
      <Button variant="primary" disabled={props.busy || loading || !draft.trim()} onClick={() => { void confirm() }}>{props.t('addWorkspace')}</Button>
    </div>
  </div>
}
