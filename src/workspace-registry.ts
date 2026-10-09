/** Coordinate sidebar deletion with durable Remote SSH route retirement without removing directories or Session logs. */
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from './manager.ts'

export default class RemoteWorkspaceRegistry extends WorkspaceRegistry {
  static override inject = [...WorkspaceRegistry.inject, 'remoteSshManager']
  override delete(id: WorkspaceId): Promise<boolean> {
    return this.ctx.remoteSshManager.removeRegisteredWorkspace(this.get(id)?.path, () => super.delete(id))
  }
}
