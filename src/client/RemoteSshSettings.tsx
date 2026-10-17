/** Compact SSH host and mapping management, sharing the workspace confirmation flow. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { CONFIG_HOST_PATH, emptyCatalog, fetchCatalogState, PROBE_PATH, request, WORKSPACE_REMOVE_PATH } from './api.ts'
import type { CatalogState } from './api.ts'
import { FailureNotice } from './FailureNotice.tsx'
import { RemoteManagement } from './RemoteManagement.tsx'
import { RemoteWorkspaceFlow } from './RemoteWorkspaceFlow.tsx'
import type { RemoteWorkspaceFlowInjected } from './RemoteWorkspaceFlow.tsx'
import css from './ui.module.css'

/**
 * Manage hosts and mappings; adding any workspace uses the same LOCAL/SSH modal.
 * @param props - Localized directory access supplied by the settings registration.
 * @returns Settings content with compact host and workspace rows.
 */
export function RemoteSshSettings({ t, listLocal }: RemoteWorkspaceFlowInjected): ReactElement {
  const [state, setState] = useState<CatalogState>(emptyCatalog)
  const [showWorkspaceFlow, setShowWorkspaceFlow] = useState(false)
  const [showAddHost, setShowAddHost] = useState(false)
  const [hostCommand, setHostCommand] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<unknown>('')
  const [pendingRemoval, setPendingRemoval] = useState('')
  const [busy, setBusy] = useState(false)
  const [managementBusy, setManagementBusy] = useState(false)
  const pending = useRef(false)
  const refreshRevision = useRef(0)
  const controller = useRef<AbortController>()
  const active = useRef(true)
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pending.current || showWorkspaceFlow || managementBusy) return
    pending.current = true
    refreshRevision.current += 1
    setBusy(true)
    setMessage('')
    setError('')
    try { await operation() } catch (reason) { if (active.current) setError(reason) }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }

  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    const next = await fetchCatalogState(current.signal).catch(reason => {
      if (!current.signal.aborted && revision === refreshRevision.current) throw reason
      return undefined
    })
    if (next === undefined || current.signal.aborted || revision !== refreshRevision.current) return
    setState(next)
    setConfigPath(value => next.configFiles.includes(value) ? value : next.configFiles[0] ?? '')
  }, [])
  useEffect(() => {
    active.current = true
    void refresh().catch(reason => { if (active.current) setError(reason) })
    return () => { active.current = false; refreshRevision.current += 1; controller.current?.abort() }
  }, [refresh])

  const addHost = async (): Promise<void> => {
    await request(CONFIG_HOST_PATH, 'POST', { command: hostCommand, configPath })
    if (!active.current) return
    setHostCommand('')
    setShowAddHost(false)
    setMessage(t('hostAdded'))
    await refresh()
  }
  const removeWorkspace = async (id: string): Promise<void> => {
    await request(WORKSPACE_REMOVE_PATH, 'POST', { id })
    if (!active.current) return
    setPendingRemoval('')
    await refresh()
  }
  const probe = async (id: string): Promise<void> => {
    const result = await request<{ reachable: boolean; hostname?: string; commands?: Record<string, boolean>; error?: string }>(PROBE_PATH, 'POST', { id })
    if (!active.current) return
    const commands = Object.entries(result.commands ?? {}).map(([name, yes]) => name + ' ' + (yes ? '✓' : '×')).join(', ')
    setMessage(result.reachable ? t('probeSuccess', { hostname: result.hostname ?? id, commands }) : t('probeFailure', { error: result.error ?? t('unknownError') }))
  }
  const locked = busy || showWorkspaceFlow || managementBusy
  const onPreferencesApplied = useCallback(() => { void refresh().catch(reason => { if (active.current) setError(reason) }) }, [refresh])
  return <section className={css.page}>
    <div>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.detail}>{t('summary', { servers: state.discoveredServerCount, workspaces: state.workspaceCount })}</p>
    </div>
    {message ? <p role="status" className={css.notice}>{message}</p> : null}
    <FailureNotice error={error} t={t} />
    <div className={css.section}>
      <h3 className={css.sectionTitle}>{t('servers')}</h3>
      {state.servers.map(server => <div key={server.id} className={css.record}>
        <div className={css.recordText}>
          <span className={css.recordTitle}>{server.label}</span>
          {server.hostName ? <span> · {server.user ? server.user + '@' : ''}{server.hostName}{server.port ? ':' + server.port : ''}</span> : null}
          <p className={css.detail}>{server.configPath ?? t('savedServer')}</p>
        </div>
        <Button size="sm" disabled={locked} onClick={() => { void run(() => probe(server.id)) }}>{t('test')}</Button>
      </div>)}
      {state.servers.length === 0 ? <p className={css.detail}>{t('noHosts')}</p> : null}
      <div className={css.row}>
        <Button size="sm" disabled={locked} onClick={() => { setShowAddHost(value => !value) }}>{t('addSshHost')}</Button>
        <Button size="sm" disabled={locked} onClick={() => { void run(async () => { await refresh(); if (active.current) setMessage(t('configReloaded')) }) }}>{t('refresh')}</Button>
      </div>
      {showAddHost ? <div className={css.stack}>
        <Input disabled={locked} aria-label={t('sshCommand')} placeholder={t('sshCommandPlaceholder')} value={hostCommand} onChange={event => { setHostCommand(event.target.value) }} />
        <h4 className={css.sectionTitle}>{t('chooseSshConfig')}</h4>
        {state.configFiles.map(path => <label key={path} className={css.row}>
          <input disabled={locked} type="radio" name="ssh-config-file" checked={configPath === path} onChange={() => { setConfigPath(path) }} />
          <span className={css.detail}>{path}</span>
        </label>)}
        <p className={css.detail}>{t('customConfigGuidance')}</p>
        <div className={css.footer}>
          <Button size="sm" disabled={locked} onClick={() => { setShowAddHost(false) }}>{t('cancel')}</Button>
          <Button size="sm" variant="primary" disabled={locked || !hostCommand.trim() || !configPath} onClick={() => { void run(addHost) }}>{t('add')}</Button>
        </div>
      </div> : null}
      {state.configErrors.map(configError => <p key={configError} className={css.detail}>{configError}</p>)}
    </div>
    <div className={css.section}>
      <h3 className={css.sectionTitle}>{t('remoteWorkspaces')}</h3>
      {state.workspaces.map(workspace => <div key={workspace.id} className={css.record}>
        <div className={css.recordText}>
          <span className={css.recordTitle}>{state.servers.find(server => server.id === workspace.serverId)?.label ?? workspace.serverId}</span>
          <p className={css.detail}>{workspace.remotePath}</p>
        </div>
        {pendingRemoval === workspace.id ? <div className={css.stack}>
          <p className={css.detail}>{t('removeMappingConfirm')}</p>
          <div className={css.row}>
            <Button size="sm" disabled={locked} onClick={() => { void run(() => removeWorkspace(workspace.id)) }}>{t('removeMapping')}</Button>
            <Button size="sm" disabled={locked} onClick={() => { setPendingRemoval('') }}>{t('cancel')}</Button>
          </div>
        </div> : <Button size="sm" disabled={locked} onClick={() => { setPendingRemoval(workspace.id) }}>{t('removeMapping')}</Button>}
      </div>)}
      <Button size="sm" disabled={locked || showAddHost} onClick={() => { if (!pending.current) setShowWorkspaceFlow(true) }}>{t('addWorkspace')}</Button>
      <p className={css.detail}>{t('tombstoneHelp')}</p>
    </div>
    <RemoteManagement t={t} servers={state.servers} busy={busy || showWorkspaceFlow} onApplied={onPreferencesApplied} onBusyChange={setManagementBusy} />
    <RemoteWorkspaceFlow t={t} listLocal={listLocal} open={showWorkspaceFlow} busy={busy || managementBusy}
      onCancel={() => { setShowWorkspaceFlow(false) }} onError={setError}
      onPicked={() => { setShowWorkspaceFlow(false); void refresh().catch(setError) }} />
  </section>
}
