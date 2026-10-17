import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { absoluteFileAddress, parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { fetchCatalogState, OPEN_FILE_PATH, request } from './api.ts'
import { resolveRemoteOpenWorkspace } from './open-route.ts'

interface RemoteOpenResponse {
  kind: 'editor' | 'download'
  localPath?: string
}

/** Preserve in-app navigation for Better Sidebar's active editor; otherwise route remote files using their owning Session, with preview on native-launch failure.
 * @param ctx - Client context with Session and Sidebar controllers.
 */
export function installRemoteOpenPath(ctx: Context): void {
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
