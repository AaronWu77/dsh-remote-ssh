// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteWorkspaceFlow } from '../src/client/RemoteWorkspaceFlow.tsx'
import { RemoteSshSettings } from '../src/client/RemoteSshSettings.tsx'
import {
  emptyCatalog, fetchCatalogState, request, WORKSPACE_PATH, WORKSPACE_REMOVE_PATH,
} from '../src/client/api.ts'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
vi.mock('../src/client/api.ts', async () => ({
  ...await vi.importActual('../src/client/api.ts'),
  request: vi.fn(),
  fetchCatalogState: vi.fn(),
  fetchDirectoryListing: vi.fn(),
}))
const catalog = {
  ...emptyCatalog,
  servers: [{ id: 'test', label: 'Test', sshTarget: 'never-connect', source: 'saved' as const }],
  workspaces: [{ id: 'project', serverId: 'test', remotePath: '/srv/project', aliasPath: '/test-owned/alias' }],
}
const t = (key: string) => key
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function props(): DirectoryFlowOwnerProps { return { open: true, busy: false, onError: vi.fn(), onPicked: vi.fn(), onCancel: vi.fn() } }
afterEach(() => { cleanup(); vi.resetAllMocks() })
beforeEach(() => {
  vi.mocked(fetchCatalogState).mockResolvedValue(catalog)
  vi.mocked(request).mockImplementation(async path => { throw new Error('Unexpected UI request: ' + path) })
})

describe('Remote SSH workspace operation feedback', () => {
  it('locks duplicate creation and cancellation until the outstanding remote creation finishes', async () => {
    const pending = deferred<{ aliasPath: string }>()
    const owner = props()
    vi.mocked(request).mockImplementation(async path => path === WORKSPACE_PATH ? pending.promise : Promise.reject(new Error('Unexpected path')))
    render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={vi.fn()} />)
    const add = screen.getByRole('button', { name: 'addWorkspace' })
    fireEvent.change(screen.getByPlaceholderText('remotePathPlaceholder'), { target: { value: '/srv/project' } })
    await waitFor(() => { expect(add.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(add); fireEvent.click(add)
    expect(add.hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'cancel' }).hasAttribute('disabled')).toBe(true)
    expect(vi.mocked(request).mock.calls.filter(([path]) => path === WORKSPACE_PATH)).toHaveLength(1)
    await act(async () => { pending.resolve({ aliasPath: '/test-owned/alias' }); await pending.promise })
    expect(owner.onPicked).toHaveBeenCalledOnce()
    expect(owner.onPicked).toHaveBeenCalledWith('/test-owned/alias')
  })

  it('does not pick after an externally closed or unmounted flow finishes its request', async () => {
    const pending = deferred<{ aliasPath: string }>()
    const owner = props()
    vi.mocked(request).mockImplementation(async () => pending.promise)
    const view = render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('remotePathPlaceholder'), { target: { value: '/srv/project' } })
    const add = screen.getByRole('button', { name: 'addWorkspace' })
    await waitFor(() => { expect(add.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(add)
    view.unmount()
    await act(async () => { pending.resolve({ aliasPath: '/committed-but-not-picked' }); await pending.promise })
    expect(owner.onPicked).not.toHaveBeenCalled()
  })

  it('displays create errors and restores the usable controls without picking a workspace', async () => {
    const owner = props()
    vi.mocked(request).mockImplementation(async () => { throw new Error('mapping save failed') })
    render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('remotePathPlaceholder'), { target: { value: '/srv/project' } })
    const add = screen.getByRole('button', { name: 'addWorkspace' })
    await waitFor(() => { expect(add.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(add)
    await waitFor(() => { expect(screen.getByText('mapping save failed')).toBeDefined() })
    expect(screen.getByRole('alert').textContent).toContain('actionFailed')
    expect(add.hasAttribute('disabled')).toBe(false)
    expect(owner.onPicked).not.toHaveBeenCalled()
  })

  it('ignores a failed old catalog read after the flow closes and aborts its fetch', async () => {
    const pending = deferred<typeof catalog>()
    const owner = props()
    vi.mocked(fetchCatalogState).mockImplementation(() => pending.promise)
    const view = render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={vi.fn()} />)
    const signal = vi.mocked(fetchCatalogState).mock.calls[0]?.[0]
    view.rerender(<RemoteWorkspaceFlow {...owner} open={false} t={t} listLocal={vi.fn()} />)
    expect(signal?.aborted).toBe(true)
    await act(async () => { pending.reject(new Error('old request failed')); await pending.promise.catch(() => {}) })
    expect(owner.onError).not.toHaveBeenCalled()
  })

  it('does not repaint a removed mapping when an older reload finishes last', async () => {
    const old = deferred<typeof catalog>()
    let reads = 0
    vi.mocked(fetchCatalogState).mockImplementation(async () => {
      reads++
      return reads === 1 ? old.promise : { ...catalog, workspaces: [] }
    })
    vi.mocked(request).mockImplementation(async path => {
      if (path === WORKSPACE_REMOVE_PATH) return undefined
      throw new Error('Unexpected request')
    })
    render(<RemoteSshSettings t={t} />)
    // A successful newer reload invalidates the initial read before it returns.
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('configReloaded') })
    await act(async () => { old.resolve(catalog); await old.promise })
    expect(screen.queryByRole('button', { name: 'removeMapping' })).toBeNull()
  })

  it('asks for confirmation before removing a mapping and reports removal failures', async () => {
    const pending = deferred<void>()
    vi.mocked(request).mockImplementation(async path => path === WORKSPACE_REMOVE_PATH ? pending.promise : Promise.reject(new Error('Unexpected path')))
    render(<RemoteSshSettings t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: 'removeMapping' }))
    expect(screen.getByText('removeMappingConfirm')).toBeDefined()
    expect(vi.mocked(request).mock.calls.filter(([path]) => path === WORKSPACE_REMOVE_PATH)).toHaveLength(0)
    const confirm = screen.getByRole('button', { name: 'removeMapping' })
    fireEvent.click(confirm); fireEvent.click(confirm)
    expect(vi.mocked(request).mock.calls.filter(([path]) => path === WORKSPACE_REMOVE_PATH)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'refresh' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { pending.reject(new Error('removal failed')); await pending.promise.catch(() => {}) })
    expect(screen.getByRole('alert').textContent).toContain('removal failed')
    expect(screen.getByRole('button', { name: 'refresh' }).hasAttribute('disabled')).toBe(false)
  })

  it('closes the dialog on Escape and keeps focus inside it', async () => {
    const owner = props()
    render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    await waitFor(() => { expect(document.activeElement).toBe(dialog) })
    fireEvent.keyDown(dialog, { key: 'Tab' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(owner.onCancel).toHaveBeenCalledOnce()
  })
})
