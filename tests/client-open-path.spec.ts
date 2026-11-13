import { Context } from '@deepseek-ai/cordis'
import { absoluteFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { emptyCatalog, fetchCatalogState, OPEN_FILE_PATH, request } from '../src/client/api.ts'
import { installRemoteOpenPath } from '../src/client/open-path.ts'
import type { Translate } from '../src/client/types.ts'

vi.mock('../src/client/api.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/api.ts')>(),
  request: vi.fn(),
  fetchCatalogState: vi.fn(),
}))

const remoteCatalog = { ...emptyCatalog, workspaces: [
  { id: 'dev', serverId: 'server', remotePath: '/srv/dev', aliasPath: 'D:/aliases/dev' },
] }

function fixture() {
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
  })
  const scopes = new Map<string, Context>()
  const notify = vi.fn<(level: 'info' | 'error', text: string) => void>()
  Object.defineProperties(ctx, {
    sidebarRight: { value: sidebar },
    sessions: { value: {
      list: { getSnapshot: () => ({
        byId: { source: { id: 'source', cwd: 'D:/aliases/dev' }, selected: { id: 'selected', cwd: 'D:/local' } },
      }) },
      scope: (id: string) => scopes.get(id),
    } },
  })
  const t: Translate = (key, params) => String(params?.reason ?? key)
  installRemoteOpenPath(ctx, t)
  return {
    ctx, sidebar, original, originalIn, notify, scopes,
    hold<T>(cleanupValue: T) {
      const completion = Promise.withResolvers<T>()
      completions.push({ release: () => { completion.resolve(cleanupValue) }, promise: completion.promise.then(() => undefined, () => undefined) })
      return completion
    },
  }
}

describe('remote file resource navigation', () => {
  beforeEach(() => {
    vi.mocked(request).mockReset()
    vi.mocked(fetchCatalogState).mockReset()
    vi.mocked(fetchCatalogState).mockResolvedValue(remoteCatalog)
    vi.mocked(request).mockResolvedValue({ kind: 'editor' })
  })

  it('leaves openResourceIn and its logical identity untouched', () => {
    const { sidebar, original, originalIn } = fixture()
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

  it('explains a local-copy fallback through the owning Session composer notice', async () => {
    const { sidebar, original, notify, scopes } = fixture()
    scopes.set('source', { get: (name: string) => name === 'conversation' ? { input: { for: () => ({ notify }) } } : undefined } as never)
    const opened = Promise.withResolvers<void>()
    original.mockImplementation(() => { opened.resolve() })
    vi.mocked(request).mockResolvedValue({
      kind: 'download',
      localPath: 'C:/Temp/dsh-remote-ssh/open-file/dev/digest/README.md',
      fallbackReason: 'no supported VS Code-compatible editor was found',
    })
    sidebar.openResource(sessionFileAddress('source', 'README.md'))
    await opened.promise
    expect(notify).toHaveBeenCalledExactlyOnceWith('info', 'no supported VS Code-compatible editor was found')
  })

  it('uses the built-in preview when the remote open request fails', async () => {
    const { sidebar, original } = fixture()
    const fallback = Promise.withResolvers<void>()
    original.mockImplementation(() => { fallback.resolve() })
    vi.mocked(fetchCatalogState).mockRejectedValue(new Error('remote open unavailable'))
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
