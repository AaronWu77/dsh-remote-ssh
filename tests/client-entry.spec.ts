import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.tsx'
import type { RemoteWorkspaceFlowInjected } from '../src/client/RemoteWorkspaceFlow.tsx'

describe('current client directory navigation', () => {
  it('lists local folders through uiWorkspace rather than the workspace controller', async () => {
    const ctx = new Context()
    const listDirectory = vi.fn(async () => ({
      path: 'D:/projects/demo', home: 'D:/projects',
      crumbs: [{ name: 'projects', path: 'D:/projects' }, { name: 'demo', path: 'D:/projects/demo' }],
      entries: [{ name: 'src', path: 'D:/projects/demo/src' }],
    }))
    const registrations: { name: string; inject?: () => RemoteWorkspaceFlowInjected }[] = []
    Object.defineProperties(ctx, {
      effect: { value: () => () => {} },
      locale: { value: { bind: () => (key: string) => key } },
      uiWorkspace: { value: { listDirectory } },
      workspaces: { value: { openPath: vi.fn() } },
      slots: { value: {
        inject: (_name: string, callback: () => unknown) => {
          const result = callback()
          if (result && typeof result === 'object' && Symbol.iterator in result) {
            Array.from(result as Iterable<unknown>)
          }
          return () => {}
        },
        register: (registration: { name: string; inject?: () => RemoteWorkspaceFlowInjected }) => {
          registrations.push(registration)
          return () => {}
        },
      } },
    })
    apply(ctx)
    const registration = registrations.find(row => row.name === 'conversation.hero.workspace.directoryFlow')
    expect(registration?.inject).toBeTypeOf('function')
    const signal = new AbortController().signal
    const result = await registration!.inject!().listLocal('D:/projects/demo', signal)
    expect(listDirectory).toHaveBeenCalledWith('D:/projects/demo', signal)
    expect(registrations.find(row => row.name === 'settings.section')?.inject).toBeTypeOf('function')
    expect(result).toEqual({
      path: 'D:/projects/demo', home: 'D:/projects', parent: 'D:/projects',
      entries: [{ name: 'src', path: 'D:/projects/demo/src' }],
    })
    expect(inject).toContain('uiWorkspace')
  })
})
