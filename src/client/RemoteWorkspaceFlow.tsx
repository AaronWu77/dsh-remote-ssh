import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  emptyCatalog, fetchCatalogState, fetchDirectoryListing, LOCAL_WORKSPACE_PATH, request, WORKSPACE_PATH,
} from './api.ts'
import type { CatalogState, RemoteDirectoryListing } from './api.ts'
import { button, card, input, primary, row } from './styles.ts'
import type { Translate } from './types.ts'
import { FailureNotice } from './FailureNotice.tsx'
import { useDialogFocus } from './use-dialog.ts'
import { WorkspaceDirectoryPicker } from './WorkspaceDirectoryPicker.tsx'

export interface RemoteWorkspaceFlowInjected {
  t: Translate
  listLocal: (path?: string, signal?: AbortSignal) => Promise<RemoteDirectoryListing>
}

/** Combined LOCAL and Remote SSH workspace creation flow. */
export function RemoteWorkspaceFlow(props: DirectoryFlowOwnerProps & RemoteWorkspaceFlowInjected): ReactElement | null {
  const [state, setState] = useState<CatalogState>(emptyCatalog)
  const [serverId, setServerId] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false)
  const [showLocalPicker, setShowLocalPicker] = useState(false)
  const [error, setError] = useState<unknown>('')
  const [adding, setAdding] = useState(false)
  const pending = useRef(false)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const onError = useRef(props.onError)
  onError.current = props.onError
  const busy = props.busy || adding
  const dialog = useDialogFocus(props.open, () => { if (!busy) props.onCancel() })

  useEffect(() => {
    if (!props.open) {
      setShowDirectoryPicker(false)
      setShowLocalPicker(false)
      return
    }
    const controller = new AbortController()
    lifetime.current = controller
    setError('')
    void fetchCatalogState(controller.signal).then(next => {
      if (controller.signal.aborted) return
      setState(next)
      setServerId(next.servers[0]?.id ?? '')
    }, reason => { if (!controller.signal.aborted) onError.current(String(reason)) })
    return () => { controller.abort() }
  }, [props.open])
  if (!props.open) return null

  const pick = async (load: (signal: AbortSignal | undefined) => Promise<string>): Promise<void> => {
    if (pending.current || props.busy) return
    pending.current = true
    setAdding(true)
    setError('')
    const signal = lifetime.current?.signal
    try { const path = await load(signal); if (!signal?.aborted) props.onPicked(path) }
    catch (reason) { if (!signal?.aborted) setError(reason) }
    finally { pending.current = false; setAdding(false) }
  }
  const chooseLocal = (path: string) => pick(signal => request<{ path: string }>(LOCAL_WORKSPACE_PATH, 'POST', { path }, signal).then(result => result.path))
  const chooseRemote = () => pick(signal => request<{ aliasPath: string }>(WORKSPACE_PATH, 'POST', { serverId, remotePath }, signal).then(result => result.aliasPath))

  return <div ref={dialog} tabIndex={-1} style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: 'rgba(0,0,0,.35)', outline: 'none' }} role="dialog" aria-modal="true" aria-label={props.t('addWorkspaceTitle')}>
    <div style={{ ...card, width: 'min(520px, calc(100vw - 32px))' }}>
      <strong>{props.t('addWorkspaceTitle')}</strong>
      <button style={button} disabled={busy} onClick={() => { setShowLocalPicker(true) }}>{props.t('chooseLocalFolder')}</button>
      <WorkspaceDirectoryPicker
        t={props.t}
        open={showLocalPicker}
        title={props.t('selectLocalFolder')}
        sourceKey="local"
        initialPath=""
        list={props.listLocal}
        onCancel={() => { setShowLocalPicker(false) }}
        onPick={path => { setShowLocalPicker(false); void chooseLocal(path) }}
      />
      <div style={row}>
        <select style={input} disabled={busy} value={serverId} onChange={event => { setServerId(event.target.value); setRemotePath(''); setShowDirectoryPicker(false) }}>
          <option value="">{props.t('selectRemoteSsh')}</option>
          {state.servers.map(server => <option key={server.id} value={server.id}>{server.label}</option>)}
        </select>
        <input style={input} disabled={busy} placeholder={props.t('remotePathPlaceholder')} value={remotePath} onChange={event => { setRemotePath(event.target.value) }} />
        <button style={button} disabled={!serverId || busy} onClick={() => { setShowDirectoryPicker(true) }}>{props.t('browseRemote')}</button>
      </div>
      <WorkspaceDirectoryPicker
        t={props.t}
        open={showDirectoryPicker}
        title={props.t('selectRemoteFolder')}
        sourceKey={`remote:${serverId}`}
        initialPath={remotePath}
        list={(path, signal) => fetchDirectoryListing({ serverId, ...(path === undefined ? {} : { path }) }, signal)}
        onCancel={() => { setShowDirectoryPicker(false) }}
        onPick={path => { setRemotePath(path); setShowDirectoryPicker(false) }}
      />
      <FailureNotice error={error} t={props.t} />
      <div style={{ ...row, justifyContent: 'flex-end' }}>
        <button style={button} disabled={busy} onClick={props.onCancel}>{props.t('cancel')}</button>
        <button style={primary} disabled={busy || !serverId || !remotePath.trim()} onClick={() => { void chooseRemote() }}>{props.t('addWorkspace')}</button>
      </div>
    </div>
  </div>
}
