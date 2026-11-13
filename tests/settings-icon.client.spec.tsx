// @vitest-environment jsdom
/** The Remote SSH navigation glyph follows the real registry's declaration and plugin lifetimes. */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'
import { RemoteSshSettingsIcon } from '../src/client/RemoteSshSettingsIcon.tsx'

const roots: Context[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose()
  cleanup()
})

function Shell({ renderSlot }: PropsRenderSlots<'settings.section' | 'settings.section.icon'>) {
  return <>{renderSlot('settings.section', { close: () => {} })}{renderSlot('settings.section.icon', { size: 16, active: false })}</>
}

/** Install the real slot service and the unrelated services read by the client entry. */
function bench(): Context {
  const ctx = new Context()
  roots.push(ctx)
  new SlotRegistry(ctx)
  Object.defineProperties(ctx, {
    locale: { value: { register: () => () => {}, bind: () => (key: string) => key } },
    uiWorkspace: { value: { listDirectory: vi.fn() } },
    workspaces: { value: {} },
    sidebarRight: { value: { openResource: () => {} } },
    sessions: { value: { list: { getSnapshot: () => ({ byId: {} }) }, scope: () => undefined } },
  })
  return ctx
}

describe('settings navigation glyph', () => {
  it('registers the link glyph with its page and removes both on declaration collapse or plugin unload', async () => {
    const ctx = bench()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(ctx.slots.entries('settings.section')).toHaveLength(0)
    expect(ctx.slots.entries('settings.section.icon')).toHaveLength(0)

    const declare = () => ctx.slots.register({ name: 'root', children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.section.icon': { kind: 'list', scope: 'root', inline: true },
    } }, Shell)
    const release = declare()
    expect(ctx.slots.entries('settings.section').map(row => row.options.id)).toEqual(['remote-ssh'])
    const [icon] = ctx.slots.entries('settings.section.icon')
    expect(icon?.options.id).toBe('remote-ssh')
    expect(icon?.component).toBe(RemoteSshSettingsIcon)

    release()
    expect(ctx.slots.entries('settings.section')).toHaveLength(0)
    expect(ctx.slots.entries('settings.section.icon')).toHaveLength(0)
    const releaseRestored = declare()
    expect(ctx.slots.entries('settings.section.icon').map(row => row.options.id)).toEqual(['remote-ssh'])

    await fiber.dispose()
    expect(ctx.slots.entries('settings.section')).toHaveLength(0)
    expect(ctx.slots.entries('settings.section.icon')).toHaveLength(0)
    releaseRestored()
    declare()
    expect(ctx.slots.entries('settings.section.icon')).toHaveLength(0)
  })

  it('renders the shared Medium link glyph at the shell size', () => {
    const view = render(<RemoteSshSettingsIcon size={16} active={false} />)
    const glyph = view.container.querySelector('svg')
    expect(glyph?.getAttribute('data-icon')).toBe('dsw-icon-link-outline-medium')
    expect(glyph?.getAttribute('width')).toBe('16')
    expect(glyph?.getAttribute('height')).toBe('16')
    expect(glyph?.getAttribute('aria-hidden')).toBe('true')
    view.rerender(<RemoteSshSettingsIcon size={16} active />)
    expect(view.container.querySelector('svg')?.getAttribute('data-icon')).toBe('dsw-icon-link-outline-medium')
  })
})
