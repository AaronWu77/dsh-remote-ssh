import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { emptyCatalog, fetchCatalogState, OPEN_FILE_PATH, request } from '../src/client/api.ts'
import { installRemoteOpenPath } from '../src/client/open-path.ts'

vi.mock('../src/client/api.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/api.ts')>(),
  request: vi.fn(),
  fetchCatalogState: vi.fn(),
}))

const remoteCatalog = { ...emptyCatalog, workspaces: [
  { id: 'dev', serverId: 'server', remotePath: '/srv/dev', aliasPath: 'D:/aliases/dev' },
] }

function fixture(withRegistry = false) {
  const ctx = new Context()
  const original = vi.fn<Context['sidebarRight']['openResource']>()
  const originalIn = vi.fn<Context['sidebarRight']['openResourceIn']>()
  const sidebar = { openResource: original, openResourceIn: originalIn }
  const completions: { release: () => void; promise: Promise<unknown> }[] = []
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      for (const completion of completions) completion.release()
      await Promise.all(completions.map(completion => completion.promise))
      await Promise.resolve()
    }
    expect(sidebar.openResource).toBe(original)
    expect(sidebar.openResourceIn).toBe(originalIn)
    expect(ctx.get('sidebarRightTabs')).toBeUndefined()
    expect(tabs.entries()).toEqual([])
  })
  Object.defineProperties(ctx, {
    sidebarRight: { value: sidebar },
    sessions: { value: { list: { getSnapshot: () => ({
      byId: { source: { id: 'source', cwd: 'D:/aliases/dev' }, selected: { id: 'selected', cwd: 'D:/local' } },
    }) } } },
  })
  const tabs = new SidebarRightTabRegistry(ctx)
  if (withRegistry) ctx.effect(() => ctx.reflect.provide('sidebarRightTabs', tabs))
  installRemoteOpenPath(ctx)
  return {
    ctx, sidebar, original, originalIn, tabs,
    hold<T>(cleanupValue: T) {
      const completion = Promise.withResolvers<T>()
      completions.push({ release: () => { completion.resolve(cleanupValue) }, promise: completion.promise.then(() => undefined, () => undefined) })
      return completion
    },
  }
}

function registerNative(tabs: SidebarRightTabRegistry, kind = 'editor') {
  return tabs.register({ id: 'dsh-better-sidebar:editor', kind, patterns: ['dsh-resource://file/**'], title: address => address })
}

describe('remote file resource navigation', () => {
  beforeEach(() => {
    vi.mocked(request).mockReset()
    vi.mocked(fetchCatalogState).mockReset()
    vi.mocked(fetchCatalogState).mockResolvedValue(remoteCatalog)
    vi.mocked(request).mockResolvedValue({ kind: 'editor' })
  })

  it.each([
    ['relative Session path', sessionFileAddress('source', 'README.md')],
    ['remote Session path', sessionFileAddress('source', '/srv/dev/README.md')],
    ['Session alias path', sessionFileAddress('source', 'D:/aliases/dev/README.md')],
    ['absolute alias path', absoluteFileAddress('D:/aliases/dev/README.md')],
  ])('synchronously retains the %s and options for the native editor', (_name, address) => {
    const { ctx, sidebar, original, tabs } = fixture(true)
    registerNative(tabs)
    expect(ctx.get('sidebarRightTabs')).toBe(tabs)
    const options = { kind: 'editor', preferNewPane: true, revealIfOpened: false }
    sidebar.openResource(address, options)
    expect(original).toHaveBeenCalledExactlyOnceWith(address, options)
    expect(original.mock.calls[0]?.[1]).toBe(options)
    expect(original.mock.contexts[0]).toBe(sidebar)
    expect(fetchCatalogState).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([false, true])('leaves openResourceIn and its logical identity untouched (native provider: %s)', native => {
    const { sidebar, original, originalIn, tabs } = fixture(native)
    if (native) registerNative(tabs)
    const address = sessionFileAddress('source', 'README.md')
    const options = { kind: 'editor', revealIfOpened: false }
    expect(sidebar.openResourceIn).toBe(originalIn)
    sidebar.openResourceIn('source' as Parameters<Context['sidebarRight']['openResourceIn']>[0], address, options)
    expect(originalIn).toHaveBeenCalledExactlyOnceWith('source', address, options)
    expect(originalIn.mock.calls[0]?.[2]).toBe(options)
    expect(original).not.toHaveBeenCalled()
    expect(fetchCatalogState).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('routes a relative path through the address owning Session, not the selected Session', async () => {
    const { sidebar, original } = fixture()
    const posted = Promise.withResolvers<void>()
    vi.mocked(request).mockImplementation(async () => {
      posted.resolve()
      return { kind: 'editor' }
    })
    sidebar.openResource(sessionFileAddress('source', 'src/file.ts'))
    await posted.promise
    await Promise.resolve()
    expect(request).toHaveBeenCalledExactlyOnceWith(OPEN_FILE_PATH, 'POST', { workspaceId: 'dev', path: 'src/file.ts' }, expect.any(AbortSignal))
    expect(original).not.toHaveBeenCalled()
  })

  it('keeps standalone alias downloads opening their local address with the original options', async () => {
    const { sidebar, original } = fixture()
    const opened = Promise.withResolvers<void>()
    original.mockImplementation(() => { opened.resolve() })
    const localPath = 'C:/Temp/dsh-remote-ssh/open-file/dev/digest/README.md'
    vi.mocked(request).mockResolvedValue({ kind: 'download', localPath })
    const options = { kind: 'editor', preferNewPane: true }
    sidebar.openResource(absoluteFileAddress('D:/aliases/dev/README.md'), options)
    await opened.promise
    expect(request).toHaveBeenCalledWith(OPEN_FILE_PATH, 'POST', { workspaceId: 'dev', path: 'D:/aliases/dev/README.md' }, expect.any(AbortSignal))
    expect(original).toHaveBeenCalledExactlyOnceWith(absoluteFileAddress(localPath), options)
    expect(original.mock.calls[0]?.[1]).toBe(options)
  })

  it.each(['disabled', 'different editor', 'different role'])('keeps external routing when the native editor is %s', async mode => {
    const { sidebar, original, tabs } = fixture(true)
    if (mode === 'disabled') registerNative(tabs)()
    if (mode === 'different editor') tabs.register({ id: 'other:editor', kind: 'editor', title: address => address })
    if (mode === 'different role') registerNative(tabs, 'native-preview')
    sidebar.openResource(sessionFileAddress('source', 'README.md'))
    expect(original).not.toHaveBeenCalled()
    expect(fetchCatalogState).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(request).toHaveBeenCalledExactlyOnceWith(OPEN_FILE_PATH, 'POST', { workspaceId: 'dev', path: 'README.md' }, expect.any(AbortSignal))
    expect(original).not.toHaveBeenCalled()
  })

  it('checks the effective editor at each open rather than retaining a disposed native registration', async () => {
    const { sidebar, original, tabs } = fixture(true)
    tabs.register({ id: 'builtin:editor', kind: 'editor', priority: 'builtin', title: address => address })
    const disposeNative = registerNative(tabs)
    const address = sessionFileAddress('source', 'README.md')
    sidebar.openResource(address)
    expect(original).toHaveBeenCalledExactlyOnceWith(address)
    expect(fetchCatalogState).not.toHaveBeenCalled()
    disposeNative()
    expect(tabs.get('editor')?.id).toBe('builtin:editor')
    sidebar.openResource(address)
    await Promise.resolve()
    expect(request).toHaveBeenCalledWith(OPEN_FILE_PATH, 'POST', { workspaceId: 'dev', path: 'README.md' }, expect.any(AbortSignal))
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('uses the built-in preview when the native file request fails', async () => {
    const { sidebar, original } = fixture()
    const fallback = Promise.withResolvers<void>()
    original.mockImplementation(() => { fallback.resolve() })
    vi.mocked(fetchCatalogState).mockRejectedValue(new Error('native editor unavailable'))
    const address = sessionFileAddress('source', 'src/file.ts')
    sidebar.openResource(address)
    await fallback.promise
    expect(original).toHaveBeenCalledWith(address)
  })

  it.each(['/wsl.localhost/Ubuntu-22.04/home/aaronwu/SuperPlus/README.md', '//wsl.localhost/Ubuntu-22.04/home/aaronwu/SuperPlus/README.md'])('delegates the Windows-local WSL address %s without an SSH request', async path => {
    const { sidebar, original } = fixture()
    const address = sessionFileAddress('source', path)
    sidebar.openResource(address)
    await vi.waitFor(() => expect(original).toHaveBeenCalledWith(address))
    expect(request).not.toHaveBeenCalled()
  })

  it('does not post or navigate when its scope is disposed during catalog loading', async () => {
    const { ctx, sidebar, original, hold } = fixture()
    const catalog = hold(emptyCatalog)
    let signal: AbortSignal | undefined
    vi.mocked(fetchCatalogState).mockImplementation(ownedSignal => {
      signal = ownedSignal
      return catalog.promise
    })
    sidebar.openResource(sessionFileAddress('source', 'src/file.ts'))
    await ctx.fiber.dispose()
    expect(signal?.aborted).toBe(true)
    catalog.resolve(remoteCatalog)
    await catalog.promise
    await Promise.resolve()
    expect(original).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    expect(fetchCatalogState).toHaveBeenCalledTimes(1)
  })

  it.each(['download', 'failure'])('ignores a late open-file %s after disposal', async outcome => {
    const { ctx, sidebar, original, hold } = fixture()
    const response = hold<{ kind: 'editor' | 'download'; localPath?: string }>({ kind: 'editor' })
    const posted = Promise.withResolvers<AbortSignal | undefined>()
    vi.mocked(request).mockImplementation((_path, _method, _body, signal) => {
      posted.resolve(signal)
      return response.promise
    })
    const routed = sidebar.openResource
    sidebar.openResource(sessionFileAddress('source', 'README.md'))
    const signal = await posted.promise
    await ctx.fiber.dispose()
    expect(signal?.aborted).toBe(true)
    if (outcome === 'failure') {
      response.reject(new Error('late editor failure'))
      await expect(response.promise).rejects.toThrow('late editor failure')
    } else {
      response.resolve({ kind: 'download', localPath: 'C:/Temp/README.md' })
      await response.promise
    }
    await Promise.resolve()
    expect(original).not.toHaveBeenCalled()
    expect(sidebar.openResource).toBe(original)
    const address = sessionFileAddress('source', 'next.md')
    routed(address)
    expect(original).toHaveBeenCalledExactlyOnceWith(address)
    expect(fetchCatalogState).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
