// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteWorkspaceFlow } from '../src/client/RemoteWorkspaceFlow.tsx'
import { RemoteSshSettings } from '../src/client/RemoteSshSettings.tsx'
import { emptyCatalog, fetchCatalogState, fetchDirectoryListing, request, LOCAL_WORKSPACE_PATH, WORKSPACE_PATH, WORKSPACE_REMOVE_PATH } from '../src/client/api.ts'
import type { RemoteDirectoryListing } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
vi.mock('../src/client/api.ts', async () => ({
  ...await vi.importActual('../src/client/api.ts'), request: vi.fn(), fetchCatalogState: vi.fn(), fetchDirectoryListing: vi.fn(),
}))
const catalog = {
  ...emptyCatalog,
  servers: [
    { id: 'test', label: 'Test', sshTarget: 'never-connect', source: 'saved' as const },
    { id: 'other', label: 'Other', sshTarget: 'never-connect-either', source: 'saved' as const },
  ],
  workspaces: [{ id: 'project', serverId: 'test', remotePath: '/srv/project', aliasPath: '/test-owned/alias' }],
}
const t = (key: string) => key
const listing = (path = '/home/test'): RemoteDirectoryListing => ({ path, home: '/home/test', parent: '/', entries: [{ name: 'project', path: path + '/project' }] })
const local = () => vi.fn(async (_path?: string, _signal?: AbortSignal) => listing('D:/projects'))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function props(): DirectoryFlowOwnerProps { return { open: true, busy: false, onError: vi.fn(), onPicked: vi.fn(), onCancel: vi.fn() } }
async function selectHost(label = 'Test') {
  fireEvent.click(screen.getByRole('button', { name: 'server' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
}
async function loaded(path: string) { await waitFor(() => { expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(path) }) }
const submit = () => screen.getByRole('button', { name: 'addWorkspace' })
afterEach(() => { cleanup(); vi.resetAllMocks() })
beforeEach(() => {
  vi.mocked(fetchCatalogState).mockResolvedValue(catalog)
  vi.mocked(fetchDirectoryListing).mockImplementation(async body => listing(typeof body.path === 'string' ? body.path : '/home/' + body.serverId))
  vi.mocked(request).mockImplementation(async path => { throw new Error('Unexpected UI request: ' + path) })
})

describe('one-modal LOCAL and SSH workspace confirmation', () => {
  it('defaults to LOCAL, browses inline, and creates exactly once only after explicit confirmation', async () => {
    const pending = deferred<{ path: string }>()
    const owner = props()
    const listLocal = local()
    vi.mocked(request).mockImplementation(async () => pending.promise)
    render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={listLocal} />)
    await loaded('D:/projects')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(vi.mocked(fetchDirectoryListing)).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(listLocal.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    fireEvent.click(submit()); fireEvent.click(submit())
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(LOCAL_WORKSPACE_PATH, 'POST', { path: 'D:/projects' }, expect.any(AbortSignal))
    expect(screen.getByRole('button', { name: 'cancel' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'close' }))
    expect(owner.onCancel).not.toHaveBeenCalled()
    await act(async () => { pending.resolve({ path: 'D:/projects' }); await pending.promise })
    expect(owner.onPicked).toHaveBeenCalledExactlyOnceWith('D:/projects')
    fireEvent.click(submit())
    expect(request).toHaveBeenCalledOnce()
  })

  it('loads SSH only after explicit host selection and confirms the host with its loaded path once', async () => {
    const pending = deferred<{ aliasPath: string }>()
    const owner = props()
    vi.mocked(request).mockImplementation(async () => pending.promise)
    render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={local()} />)
    await loaded('D:/projects')
    await selectHost()
    await loaded('/home/test')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(fetchDirectoryListing).toHaveBeenCalledWith({ serverId: 'test' }, expect.any(AbortSignal))
    expect(request).not.toHaveBeenCalled()
    fireEvent.click(submit()); fireEvent.click(submit())
    expect(request).toHaveBeenCalledExactlyOnceWith(WORKSPACE_PATH, 'POST', { serverId: 'test', remotePath: '/home/test' }, expect.any(AbortSignal))
    expect(screen.getByRole('button', { name: 'server' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { pending.resolve({ aliasPath: '/test-owned/alias' }); await pending.promise })
    expect(owner.onPicked).toHaveBeenCalledExactlyOnceWith('/test-owned/alias')
  })

  it('validates an edited draft instead of submitting the previously loaded directory', async () => {
    const verify = deferred<RemoteDirectoryListing>()
    vi.mocked(fetchDirectoryListing).mockImplementation(async body => body.path ? verify.promise : listing())
    vi.mocked(request).mockResolvedValue({ aliasPath: '/verified-alias' })
    render(<RemoteWorkspaceFlow {...props()} t={t} listLocal={local()} />)
    await selectHost(); await loaded('/home/test')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/typed/project' } })
    fireEvent.click(submit()); fireEvent.click(submit())
    expect(request).not.toHaveBeenCalled()
    expect(fetchDirectoryListing).toHaveBeenLastCalledWith({ serverId: 'test', path: '/typed/project' }, expect.any(AbortSignal))
    await act(async () => { verify.resolve(listing('/canonical/project')); await verify.promise })
    await waitFor(() => { expect(request).toHaveBeenCalledWith(WORKSPACE_PATH, 'POST', { serverId: 'test', remotePath: '/canonical/project' }, expect.any(AbortSignal)) })
    expect(request).toHaveBeenCalledOnce()
  })

  it('validates a LOCAL draft and honors owner conflicts that arrive during verification', async () => {
    const verify = deferred<RemoteDirectoryListing>()
    const listLocal = vi.fn(async (path?: string, _signal?: AbortSignal) => path === undefined ? listing('D:/projects') : verify.promise)
    const owner = props()
    vi.mocked(request).mockResolvedValue({ path: 'D:/canonical' })
    const view = render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={listLocal} />)
    await loaded('D:/projects')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'D:/draft' } })
    fireEvent.click(submit())
    expect(listLocal).toHaveBeenLastCalledWith('D:/draft', expect.any(AbortSignal))
    view.rerender(<RemoteWorkspaceFlow {...owner} busy t={t} listLocal={listLocal} />)
    await act(async () => { verify.resolve(listing('D:/canonical')); await verify.promise })
    await screen.findByText('workspaceConflict')
    expect(request).not.toHaveBeenCalled()
    view.rerender(<RemoteWorkspaceFlow {...owner} t={t} listLocal={listLocal} />)
    fireEvent.click(submit())
    await waitFor(() => { expect(request).toHaveBeenCalledExactlyOnceWith(LOCAL_WORKSPACE_PATH, 'POST', { path: 'D:/canonical' }, expect.any(AbortSignal)) })
    expect(owner.onPicked).toHaveBeenCalledExactlyOnceWith('D:/canonical')
  })

  it('keeps invalid drafts visible, retries the failed path, and creates nothing on validation failure', async () => {
    vi.mocked(fetchDirectoryListing).mockImplementation(async body => { if (body.path) throw new Error('not a directory'); return listing() })
    const owner = props()
    render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={local()} />)
    await selectHost(); await loaded('/home/test')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/missing' } })
    fireEvent.click(submit())
    await screen.findByText('not a directory')
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('/missing')
    expect(request).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await waitFor(() => { expect(fetchDirectoryListing).toHaveBeenCalledTimes(3) })
    expect(fetchDirectoryListing).toHaveBeenLastCalledWith({ serverId: 'test', path: '/missing' }, expect.any(AbortSignal))
    expect(owner.onPicked).not.toHaveBeenCalled()
  })

  it('aborts reads and discards directory, draft, and errors on host changes without mixing host/path', async () => {
    const old = deferred<RemoteDirectoryListing>()
    vi.mocked(fetchDirectoryListing).mockImplementation(async body => body.serverId === 'test' ? old.promise : listing('/other/home'))
    vi.mocked(request).mockResolvedValue({ aliasPath: '/other-alias' })
    render(<RemoteWorkspaceFlow {...props()} t={t} listLocal={local()} />)
    await loaded('D:/projects'); await selectHost()
    const oldSignal = vi.mocked(fetchDirectoryListing).mock.calls[0]?.[1]
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/old/draft' } })
    await selectHost('Other')
    expect(oldSignal?.aborted).toBe(true)
    await loaded('/other/home')
    await act(async () => { old.resolve(listing('/stale/home')); await old.promise })
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('/other/home')
    fireEvent.click(submit())
    await waitFor(() => { expect(request).toHaveBeenCalledWith(WORKSPACE_PATH, 'POST', { serverId: 'other', remotePath: '/other/home' }, expect.any(AbortSignal)) })
  })

  it('clears a failed host query and draft when selecting LOCAL', async () => {
    vi.mocked(fetchDirectoryListing).mockRejectedValue(new Error('host unavailable'))
    render(<RemoteWorkspaceFlow {...props()} t={t} listLocal={local()} />)
    await selectHost(); await screen.findByText('host unavailable')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/old/draft' } })
    await selectHost('localSource'); await loaded('D:/projects')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('cancels pending browsing and ignores its late response without creating or picking', async () => {
    const old = deferred<RemoteDirectoryListing>()
    const listLocal = vi.fn((_path?: string, _signal?: AbortSignal) => old.promise)
    const owner = props()
    render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={listLocal} />)
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(listLocal.mock.calls[0]?.[1]?.aborted).toBe(true)
    expect(owner.onCancel).toHaveBeenCalledOnce()
    await act(async () => { old.resolve(listing()); await old.promise })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(request).not.toHaveBeenCalled()
    expect(owner.onPicked).not.toHaveBeenCalled()
  })

  it('never picks after external withdrawal during submission', async () => {
    const pending = deferred<{ path: string }>()
    const owner = props()
    const listLocal = local()
    vi.mocked(request).mockImplementation(async () => pending.promise)
    const view = render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={listLocal} />)
    await loaded('D:/projects'); fireEvent.click(submit())
    const signal = vi.mocked(request).mock.calls[0]?.[3]
    view.rerender(<RemoteWorkspaceFlow {...owner} open={false} t={t} listLocal={listLocal} />)
    expect(signal?.aborted).toBe(true)
    await act(async () => { pending.resolve({ path: 'D:/projects' }); await pending.promise })
    expect(owner.onPicked).not.toHaveBeenCalled()
  })

  it('retains data and restores controls after a failed submit', async () => {
    vi.mocked(request).mockRejectedValue(new Error('mapping save failed'))
    const owner = props()
    render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={local()} />)
    await loaded('D:/projects'); fireEvent.click(submit())
    await screen.findByText('mapping save failed')
    expect(screen.getByRole('alert').textContent).toContain('actionFailed')
    expect(submit().hasAttribute('disabled')).toBe(false)
    expect(owner.onPicked).not.toHaveBeenCalled()
  })

  it('ignores old catalog failures after close and aborts the catalog read', async () => {
    const old = deferred<typeof catalog>()
    const owner = props()
    vi.mocked(fetchCatalogState).mockImplementation(() => old.promise)
    const view = render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={local()} />)
    const signal = vi.mocked(fetchCatalogState).mock.calls[0]?.[0]
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { old.reject(new Error('old catalog failed')); await old.promise.catch(() => {}) })
    expect(owner.onError).not.toHaveBeenCalled()
  })

  it('restores invoking focus, keeps menu Escape local, and ignores IME Escape', async () => {
    const owner = props()
    const trigger = document.createElement('button')
    document.body.append(trigger); trigger.focus()
    const view = render(<RemoteWorkspaceFlow {...owner} t={t} listLocal={local()} />)
    await loaded('D:/projects')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'server' }))
    const close = screen.getByRole('button', { name: 'close' })
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).not.toBe(close)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.click(screen.getByRole('button', { name: 'server' }))
    await screen.findByRole('menuitem', { name: 'Test' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(owner.onCancel).not.toHaveBeenCalled()
    fireEvent.compositionStart(screen.getByRole('textbox'))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', isComposing: true })
    expect(owner.onCancel).not.toHaveBeenCalled()
    fireEvent.compositionEnd(screen.getByRole('textbox'))
    fireEvent.keyUp(screen.getByRole('textbox'), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(owner.onCancel).toHaveBeenCalledOnce()
    view.unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})

describe('locale-owned workspace chrome', () => {
  it('renders matched English and Chinese picker labels', async () => {
    const visible: string[][] = []
    for (const dictionary of [en, zh]) {
      const view = render(<RemoteWorkspaceFlow {...props()} t={key => dictionary[key]} listLocal={local()} />)
      await loaded('D:/projects')
      visible.push([
        screen.getByRole('dialog').getAttribute('aria-label')!,
        ...within(screen.getByRole('dialog')).getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent ?? ''),
        screen.getByRole('textbox').getAttribute('aria-label')!,
      ])
      view.unmount()
    }
    expect(visible).toMatchInlineSnapshot(`
[
  [
    "Add workspace",
    "Close",
    "Server",
    "Go",
    "Home",
    "Up",
    "Refresh",
    "project",
    "Cancel",
    "Add workspace",
    "{title} path",
  ],
  [
    "添加工作区",
    "关闭",
    "服务器",
    "转到",
    "主目录",
    "上一级",
    "刷新",
    "project",
    "取消",
    "添加工作区",
    "{title}路径",
  ],
]
`)
  })
})

describe('directory navigation and races', () => {
  it('supports home/up/refresh, empty folders, and discards older responses while preserving a newer draft', async () => {
    const old = deferred<RemoteDirectoryListing>()
    const listLocal = vi.fn(async (path?: string, _signal?: AbortSignal) => path === '/slow' ? old.promise : { ...listing(path ?? '/home/test'), entries: [] })
    render(<RemoteWorkspaceFlow {...props()} t={t} listLocal={listLocal} />)
    await loaded('/home/test')
    expect(screen.getByText('directoryEmpty')).toBeDefined()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/slow' } })
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    const oldSignal = listLocal.mock.calls[1]?.[1]
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/fast' } })
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    expect(oldSignal?.aborted).toBe(true)
    await loaded('/fast')
    await act(async () => { old.resolve(listing('/slow')); await old.promise })
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('/fast')
    fireEvent.click(screen.getByRole('button', { name: 'parent' })); await loaded('/')
    fireEvent.click(screen.getByRole('button', { name: 'home' })); await loaded('/home/test')
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
    await waitFor(() => { expect(listLocal).toHaveBeenCalledTimes(6) })
    expect(listLocal).toHaveBeenLastCalledWith('/home/test', expect.any(AbortSignal))
    expect(request).not.toHaveBeenCalled()
  })

  it('does not overwrite text edited during loading or browse for IME Enter', async () => {
    const old = deferred<RemoteDirectoryListing>()
    const listLocal = vi.fn((_path?: string, _signal?: AbortSignal) => old.promise)
    render(<RemoteWorkspaceFlow {...props()} t={t} listLocal={listLocal} />)
    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: '/draft' } })
    fireEvent.compositionStart(field)
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.compositionEnd(field)
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    expect(listLocal).toHaveBeenCalledOnce()
    await act(async () => { old.resolve(listing('/loaded')); await old.promise })
    expect((field as HTMLInputElement).value).toBe('/draft')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('settings use the shared confirmation flow', () => {
  it('opens one LOCAL/SSH modal without a misleading custom configuration action', async () => {
    render(<RemoteSshSettings t={t} listLocal={local()} />)
    fireEvent.click(screen.getByRole('button', { name: 'addWorkspace' }))
    await loaded('D:/projects')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'server' }).textContent).toContain('localSource')
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(request).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'addSshHost' }))
    expect(screen.queryByRole('button', { name: 'customConfigAction' })).toBeNull()
    expect(screen.getByText('customConfigGuidance')).toBeDefined()
  })

  it('does not repaint mappings when an older settings reload finishes last', async () => {
    const old = deferred<typeof catalog>()
    let reads = 0
    vi.mocked(fetchCatalogState).mockImplementation(async () => ++reads === 1 ? old.promise : { ...catalog, workspaces: [] })
    render(<RemoteSshSettings t={t} listLocal={local()} />)
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('configReloaded') })
    await act(async () => { old.resolve(catalog); await old.promise })
    expect(screen.queryByRole('button', { name: 'removeMapping' })).toBeNull()
  })

  it('confirms mapping removal and prevents duplicate or conflicting operations', async () => {
    const pending = deferred<void>()
    vi.mocked(request).mockImplementation(async path => path === WORKSPACE_REMOVE_PATH ? pending.promise : Promise.reject(new Error('Unexpected path')))
    render(<RemoteSshSettings t={t} listLocal={local()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'removeMapping' }))
    expect(screen.getByText('removeMappingConfirm')).toBeDefined()
    expect(request).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'removeMapping' })); fireEvent.click(screen.getByRole('button', { name: 'removeMapping' }))
    expect(request).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'refresh' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'addWorkspace' }).hasAttribute('disabled')).toBe(true)
    await act(async () => { pending.reject(new Error('removal failed')); await pending.promise.catch(() => {}) })
    expect(screen.getByRole('alert').textContent).toContain('removal failed')
    expect(screen.getByRole('button', { name: 'refresh' }).hasAttribute('disabled')).toBe(false)
  })
})
