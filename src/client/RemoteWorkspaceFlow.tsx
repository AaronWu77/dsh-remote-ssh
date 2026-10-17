/** One modal owns LOCAL/SSH source selection and inline directory confirmation. */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Menu, Modal, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { emptyCatalog, fetchCatalogState, fetchDirectoryListing, LOCAL_WORKSPACE_PATH, request, WORKSPACE_PATH } from './api.ts'
import type { CatalogState, RemoteDirectoryListing } from './api.ts'
import type { Translate } from './types.ts'
import { FailureNotice } from './FailureNotice.tsx'
import { WorkspaceDirectoryPicker } from './WorkspaceDirectoryPicker.tsx'
import css from './ui.module.css'

export interface RemoteWorkspaceFlowInjected {
  t: Translate
  listLocal: (path?: string, signal?: AbortSignal) => Promise<RemoteDirectoryListing>
}

/**
 * Report one confirmed path to the owner; browsing and cancellation create nothing.
 * @param props - Owner lifecycle and localized directory access.
 * @returns A shared modal while open, otherwise null.
 */
export function RemoteWorkspaceFlow(props: DirectoryFlowOwnerProps & RemoteWorkspaceFlowInjected): ReactElement | null {
  return props.open ? <OpenWorkspaceFlow {...props} /> : null
}

function OpenWorkspaceFlow(props: DirectoryFlowOwnerProps & RemoteWorkspaceFlowInjected): ReactElement | null {
  const [catalog, setCatalog] = useState<CatalogState>(emptyCatalog)
  const [source, setSource] = useState('local')
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<unknown>('')
  const [working, setWorking] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const pending = useRef(false)
  const owner = useRef(props)
  owner.current = props
  const lifetime = useRef(new AbortController())
  const catalogGeneration = useRef(0)
  const catalogController = useRef<AbortController>()
  const busy = props.busy || working
  const refreshCatalog = async (): Promise<void> => {
    const generation = ++catalogGeneration.current
    catalogController.current?.abort()
    const controller = new AbortController()
    catalogController.current = controller
    setError('')
    try {
      const next = await fetchCatalogState(controller.signal)
      if (!controller.signal.aborted && generation === catalogGeneration.current) setCatalog(next)
    } catch (reason) {
      if (!controller.signal.aborted && generation === catalogGeneration.current) setError(reason)
    }
  }
  useEffect(() => {
    lifetime.current = new AbortController()
    void refreshCatalog()
    return () => { lifetime.current.abort(); catalogController.current?.abort() }
  }, [])

  const cancel = (): void => {
    if (busy || pending.current) return
    lifetime.current.abort()
    catalogController.current?.abort()
    setCancelled(true)
    props.onCancel()
  }
  const confirm = async (path: string): Promise<void> => {
    if (pending.current || lifetime.current.signal.aborted) return
    if (owner.current.busy) throw new Error(props.t('workspaceConflict'))
    pending.current = true
    try {
      const signal = lifetime.current.signal
      const result = source === 'local'
        ? await request<{ path: string }>(LOCAL_WORKSPACE_PATH, 'POST', { path }, signal).then(value => value.path)
        : await request<{ aliasPath: string }>(WORKSPACE_PATH, 'POST', { serverId: source.slice(7), remotePath: path }, signal).then(value => value.aliasPath)
      if (!signal.aborted) owner.current.onPicked(result)
    } catch (reason) { pending.current = false; throw reason }
  }
  if (cancelled) return null
  const title = source === 'local' ? props.t('selectLocalFolder') : props.t('selectRemoteFolder')
  const label = source === 'local' ? props.t('localSource') : catalog.servers.find(server => 'remote:' + server.id === source)?.label
  return <Modal open onClose={cancel} title={props.t('addWorkspaceTitle')} closeLabel={props.t('close')} className={css.modal}>
    <div className={css.stack}>
      <Menu open={menuOpen} portal autoFocus selectedId={source} onClose={() => { setMenuOpen(false) }}
        anchor={<Button data-modal-autofocus aria-label={props.t('server')} aria-haspopup="menu" aria-expanded={menuOpen}
          disabled={busy} icon={<IconChevronDownOutlineRegular size={14} />} onClick={() => { setMenuOpen(value => !value) }}>{label}</Button>}
        items={[{ id: 'local', label: props.t('localSource') }, ...catalog.servers.map(server => ({ id: 'remote:' + server.id, label: server.label }))]}
        onSelect={id => { if (!busy) { setSource(id); setMenuOpen(false); setError('') } }} />
      <FailureNotice error={error} t={props.t} />
      {error ? <Button size="sm" disabled={busy} onClick={() => { void refreshCatalog() }}>{props.t('retry')}</Button> : null}
      <WorkspaceDirectoryPicker key={source} t={props.t} title={title} busy={busy}
        list={source === 'local' ? props.listLocal : (path, signal) => fetchDirectoryListing({ serverId: source.slice(7), ...(path === undefined ? {} : { path }) }, signal)}
        onWorking={setWorking} onCancel={cancel} onPick={confirm} />
    </div>
  </Modal>
}
