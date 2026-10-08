import { Context } from '@deepseek-ai/cordis'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { emptyCatalog, OPEN_FILE_PATH, request, STATE_PATH } from '../src/client/api.ts'
import { installRemoteOpenPath } from '../src/client/open-path.ts'

vi.mock('../src/client/api.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/api.ts')>(), request: vi.fn(),
}))

function fixture() {
  const ctx = new Context()
  const original = vi.fn<(address: string) => void>()
  const sidebar = { openResource: original }
  Object.defineProperties(ctx, {
    sidebarRight: { value: sidebar },
    sessions: { value: { list: { getSnapshot: () => ({
      byId: { source: { id: 'source', cwd: 'D:/aliases/dev' }, selected: { id: 'selected', cwd: 'D:/local' } },
    }) } } },
  })
  installRemoteOpenPath(ctx)
  onTestFinished(async () => { await ctx.fiber.dispose(); expect(sidebar.openResource).toBe(original) })
  return { ctx, sidebar, original }
}

describe('remote file resource navigation', () => {
  beforeEach(() => { vi.mocked(request).mockReset() })
  it('routes a relative path through the address owning Session, not the selected Session', async () => {
    const { sidebar, original } = fixture()
    const posted = Promise.withResolvers<void>()
    vi.mocked(request).mockImplementation(async (path, _method, body) => {
      if (path === STATE_PATH) return { ...emptyCatalog, workspaces: [
        { id: 'dev', serverId: 'server', remotePath: '/srv/dev', aliasPath: 'D:/aliases/dev' },
      ] }
      expect(path).toBe(OPEN_FILE_PATH)
      expect(body).toEqual({ workspaceId: 'dev', path: 'src/file.ts' })
      posted.resolve()
      return { kind: 'editor' }
    })
    sidebar.openResource(sessionFileAddress('source', 'src/file.ts'))
    await posted.promise
    expect(original).not.toHaveBeenCalled()
  })

  it('uses the built-in preview when the native file request fails', async () => {
    const { sidebar, original } = fixture()
    const fallback = Promise.withResolvers<void>()
    original.mockImplementation(() => { fallback.resolve() })
    vi.mocked(request).mockRejectedValue(new Error('native editor unavailable'))
    const address = sessionFileAddress('source', 'src/file.ts')
    sidebar.openResource(address)
    await fallback.promise
    expect(original).toHaveBeenCalledWith(address)
  })

  it('does not post or navigate when its scope is disposed during catalog loading', async () => {
    const { ctx, sidebar, original } = fixture()
    const catalog = Promise.withResolvers<unknown>()
    let signal: AbortSignal | undefined
    vi.mocked(request).mockImplementation((_path, _method, _body, ownedSignal) => {
      signal = ownedSignal
      return catalog.promise
    })
    sidebar.openResource(sessionFileAddress('source', 'src/file.ts'))
    await ctx.fiber.dispose()
    expect(signal?.aborted).toBe(true)
    catalog.resolve(emptyCatalog)
    await catalog.promise
    expect(original).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)
  })
})
