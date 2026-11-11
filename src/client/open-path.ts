import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { absoluteFileAddress, parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { fetchCatalogState, OPEN_FILE_PATH, request } from './api.ts'
import { resolveRemoteOpenWorkspace } from './open-route.ts'
import type { Translate } from './types.ts'

interface RemoteOpenResponse {
  kind: 'editor' | 'download'
  localPath?: string
  fallbackReason?: string
}

/** Composer notice channel the conversation service exposes for one retained Session scope. */
interface ComposerNotice {
  notify(level: 'info' | 'error', text: string): void
}

interface ComposerNoticeSource {
  input: { for(scope: Context): ComposerNotice }
}

/**
 * Tell the reader where the click happened why the native editor path was skipped.
 * @param ctx - Client context providing Sessions and the conversation service.
 * @param sessionId - Session the file address belongs to, absent for bare filesystem addresses; the
 * address parser carries it untyped, so this is the one place that brands it.
 * @param text - Localized explanation of the fallback.
 */
function announceFallback(ctx: Context, sessionId: string | undefined, text: string): void {
  const scope = sessionId === undefined ? undefined : ctx.sessions.scope(sessionId as SessionId)
  const conversation = scope?.get('conversation') as ComposerNoticeSource | undefined
  if (scope !== undefined && conversation !== undefined) {
    conversation.input.for(scope).notify('info', text)
    return
  }
  ctx.logger.warn(text)
}

/** Preserve in-app navigation for Better Sidebar's active editor; otherwise route remote files using their owning Session, with preview on native-launch failure.
 * @param ctx - Client context with Session and Sidebar controllers.
 * @param t - Localizer for the fallback explanation.
 */
export function installRemoteOpenPath(ctx: Context, t: Translate): void {
  ctx.effect(() => {
    const controller = new AbortController()
    const sidebar = ctx.sidebarRight
    const previous = sidebar.openResource
    const routed: typeof previous = (...args) => {
      if (controller.signal.aborted) return previous.apply(sidebar, args)
      if (ctx.get('sidebarRightTabs')?.get('editor')?.id === 'dsh-better-sidebar:editor') return previous.apply(sidebar, args)
      const parsed = parseFileAddress(args[0])
      if (parsed === undefined) return previous.apply(sidebar, args)
      const open = async (): Promise<void> => {
        const state = await fetchCatalogState(controller.signal)
        controller.signal.throwIfAborted()
        const cwd = parsed.scope === 'session'
          ? Object.values(ctx.sessions.list.getSnapshot().byId).find(row => row.id === parsed.sessionId)?.cwd
          : undefined
        const workspace = resolveRemoteOpenWorkspace(state.workspaces, parsed.path, cwd)
        if (workspace === undefined) return previous.apply(sidebar, args)
        const result = await request<RemoteOpenResponse>(OPEN_FILE_PATH, 'POST', { workspaceId: workspace.id, path: parsed.path }, controller.signal)
        controller.signal.throwIfAborted()
        if (result.kind === 'editor') return
        if (result.localPath === undefined) throw new Error('remote download did not return a local path')
        if (result.fallbackReason !== undefined) {
          announceFallback(ctx, parsed.scope === 'session' ? parsed.sessionId : undefined, t('openFallback', { reason: result.fallbackReason }))
        }
        previous.call(sidebar, absoluteFileAddress(result.localPath), args[1])
      }
      void open().catch(() => { if (!controller.signal.aborted) previous.apply(sidebar, args) })
    }
    sidebar.openResource = routed
    return () => {
      controller.abort('remote file navigator disposed')
      if (sidebar.openResource === routed) sidebar.openResource = previous
    }
  }, 'dsh-remote-ssh: remote file resource navigation')
}
