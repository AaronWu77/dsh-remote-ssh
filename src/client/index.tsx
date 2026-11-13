/** Browser entry: locale registration, transparent openPath routing, and slots. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh } from './locales.ts'
import type { RemoteSshLocaleKey } from './locales.ts'
import type { RemoteDirectoryListing } from './api.ts'
import { RemoteSshSettings } from './RemoteSshSettings.tsx'
import { RemoteSshSettingsIcon } from './RemoteSshSettingsIcon.tsx'
import { RemoteWorkspaceFlow } from './RemoteWorkspaceFlow.tsx'
import type { RemoteWorkspaceFlowInjected } from './RemoteWorkspaceFlow.tsx'
import { installRemoteOpenPath } from './open-path.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Remote SSH settings, picker, and file-opening copy. */
    'settings.remote-ssh': RemoteSshLocaleKey
  }
}

export const name = 'dsh-remote-ssh-client'
export const inject = ['slots', 'workspaces', 'sessions', 'locale', 'uiWorkspace', 'sidebarRight']

/** Register the localized settings, workspace flow, and transparent file opener. */
export function apply(ctx: ClientContext): void {
  const namespace = 'settings.remote-ssh'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-remote-ssh: client copy')
  const t = ctx.locale.bind(namespace) as RemoteWorkspaceFlowInjected['t']
  installRemoteOpenPath(ctx, t)

  const injected = (): RemoteWorkspaceFlowInjected => ({
    t,
    listLocal: async (path?: string, signal?: AbortSignal): Promise<RemoteDirectoryListing> => {
      const listing = await ctx.uiWorkspace.listDirectory(path, signal)
      const parent = listing.crumbs.length > 1 ? listing.crumbs[listing.crumbs.length - 2]?.path : undefined
      return {
        path: listing.path,
        home: listing.home,
        ...(parent === undefined ? {} : { parent }),
        entries: listing.entries.map(entry => ({ name: entry.name, path: entry.path })),
      }
    },
  })
  ctx.slots.inject('settings.section', function* () {
    // The glyph shares its settings page's lifetime, so a collapsed section takes it down too.
    yield ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
      name: 'settings.section.icon', id: 'remote-ssh', label: () => t('nav'),
    }, RemoteSshSettingsIcon))
    yield ctx.slots.register({
      name: 'settings.section', id: 'remote-ssh', order: 16, label: () => t('nav'), inject: injected,
    }, RemoteSshSettings)
  })

  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({ name: 'conversation.hero.workspace.directoryFlow', inject: injected }, RemoteWorkspaceFlow)
      yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', inject: injected }, RemoteWorkspaceFlow)
    }))

}
