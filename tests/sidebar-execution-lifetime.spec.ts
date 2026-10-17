/** Revocation owns pending effects through successful or unknown cleanup without retiring shared routes. */
import { describe, expect, it, vi } from 'vitest'
import { SidebarExecutionLifetime } from '../src/sidebar-execution-lifetime.ts'

function fixture() {
  const release = vi.fn()
  const manager = { ownExecution: vi.fn(() => release) }
  const route = { kind: 'remote', workspace: { id: 'shared' } }
  const failure = Object.assign(new Error('bridge removed'), { status: 503 })
  const lifetime = new SidebarExecutionLifetime(manager as never, route as never, () => failure)
  return { lifetime, release, manager, failure }
}

describe('Sidebar bridge execution lifetime', () => {
  it('revokes before cancellation and drains both pending terminate and cleanup promises', async () => {
    const f = fixture()
    const terminated = Promise.withResolvers<void>(); const cleanup = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const execution = { terminate: vi.fn(() => { entered.resolve(); return terminated.promise }), done: cleanup.promise }
    f.lifetime.ownExecution(execution)
    let disposed = false
    const disposal = f.lifetime.dispose().then(() => { disposed = true })
    expect(() => f.lifetime.check()).toThrow(f.failure)
    expect(() => f.lifetime.ownExecution(execution)).toThrow(f.failure)
    await entered.promise
    cleanup.resolve(); await cleanup.promise
    expect(disposed).toBe(false)
    terminated.resolve(); await disposal
    expect(execution.terminate).toHaveBeenCalledTimes(1)
    expect(f.manager.ownExecution).toHaveBeenCalledTimes(1)
    await f.lifetime.dispose()
  })
  it('retains failed cleanup and returns the same rejected disposal instead of claiming quiescence', async () => {
    const f = fixture()
    const cleanup = Promise.withResolvers<void>()
    const execution = { terminate: vi.fn(async () => {}), done: cleanup.promise }
    f.lifetime.ownExecution(execution)
    const failure = new Error('unsubscribe acknowledgment missing')
    cleanup.reject(failure)
    const disposal = f.lifetime.dispose()
    await expect(disposal).rejects.toMatchObject({ errors: [failure] })
    expect(f.lifetime.dispose()).toBe(disposal)
    expect(execution.terminate).toHaveBeenCalledTimes(1)
    expect(() => f.lifetime.check()).toThrow(f.failure)
  })
})
