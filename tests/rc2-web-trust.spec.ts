import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply, REMOTE_SSH_STATE_PATH } from '../src/web.ts'
import { connectionFixture, hostRoot } from './rc2-connection-fixture.ts'

describe.skipIf(!hostRoot)('rc.2 built Connection with Remote raw routes', () => {
  async function fixture() {
    const f = await connectionFixture()
    const routes: Array<{ path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }> = []
    const handler = vi.fn()
    // Register only: no listener and no connection/diagnostic operation is run.
    f.ctx.provide('remoteSshManager', { workspace: handler } as never)
    const web = f.ctx.get('webServer') as unknown as { register(route: typeof routes[number]): () => void }
    web.register = route => { routes.push(route); return () => {} }
    apply(f.ctx, { maxErrorCharacters: 1024 })
    await f.ctx.fiber.await()
    return { ...f, routes, handler }
  }
  const response = () => ({ statusCode: 0, writeHead: vi.fn(), end: vi.fn() })
  it('accepts browser and live owner API credentials at raw routes, not just exact-fetch', async () => {
    const f = await fixture()
    try {
      const route = f.routes.find(row => row.path === REMOTE_SSH_STATE_PATH)!
      for (const headers of [f.browser(), f.api()]) {
        expect(f.connection.admit({ headers })).toMatchObject({ peer: { principal: { kind: 'owner' } } })
        const res = response()
        await route.handler({ method: 'POST', headers } as IncomingMessage, res as unknown as ServerResponse)
        expect(res.writeHead).toHaveBeenCalledWith(405, expect.anything())
      }
      expect(f.handler).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('rejects anonymous and hostile Origin across every raw route before reading any body', async () => {
    const f = await fixture()
    try {
      expect(f.routes.length).toBeGreaterThan(10)
      for (const [headers, status] of [[f.headers(), 401], [{ ...f.browser(), origin: 'http://evil.invalid' }, 403]] as const) {
        for (const route of f.routes) {
          const consume = vi.fn(); const res = response()
          const req = { method: 'POST', headers, async *[Symbol.asyncIterator]() { consume(); yield '{}' } }
          await route.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
          expect(res.statusCode, route.path).toBe(status)
          expect(consume).not.toHaveBeenCalled()
        }
      }
      expect(f.handler).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('rejects a released API Peer on every raw route even while its cookie is signed', async () => {
    const f = await fixture()
    try {
      const headers = f.api()
      const socket = f.connection.admitConnection({ headers })
      if ('rejection' in socket) throw new Error('fixture API socket rejected')
      await socket.release()
      for (const route of f.routes) {
        const res = response()
        await route.handler({ method: 'POST', headers } as IncomingMessage, res as unknown as ServerResponse)
        expect(res.statusCode, route.path).toBe(401)
      }
    } finally { await f.dispose() }
  })
})
