import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { apply, REMOTE_SSH_STATE_PATH } from '../src/web.ts'

interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

async function setup(rejection: 401 | 403 | undefined, method: string) {
  const ctx = new Context()
  const routes: RegisteredRoute[] = []
  const handler = vi.fn()
  const manager = { snapshot: () => ({ servers: [], workspaces: [], openFileMode: 'auto' }), workspace: handler }
  ctx.provide('remoteSshManager', manager as never)
  ctx.provide('webServer', { register: (route: RegisteredRoute) => { routes.push(route); return () => {} } } as never)
  const requestRejection = vi.fn(() => rejection)
  ctx.provide('connection', { requestRejection } as never)
  apply(ctx, { maxErrorCharacters: 1024 })
  await ctx.fiber.await()
  const route = routes.find(candidate => candidate.path === REMOTE_SSH_STATE_PATH)
  if (route === undefined) throw new Error('state route was not registered')
  const response = {
    statusCode: 0,
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse
  await route.handler({ method, headers: { host: 'evil.example', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' } } as IncomingMessage, response)
  await ctx.fiber.dispose()
  return { response, requestRejection, workspaceCalls: handler.mock.calls.length }
}

describe('Remote SSH Web route trust fence', () => {
  it('rejects a rebinding-shaped request before any handler work', async () => {
    const { response, requestRejection, workspaceCalls } = await setup(403, 'GET')
    expect(requestRejection).toHaveBeenCalledOnce()
    expect(response.statusCode).toBe(403)
    expect(workspaceCalls).toBe(0)
  })

  it('answers an unauthenticated caller with the fence status', async () => {
    const { response } = await setup(401, 'GET')
    expect(response.statusCode).toBe(401)
  })

  it('reaches the method check only after the fence admits the request', async () => {
    const { response, requestRejection } = await setup(undefined, 'POST')
    expect(requestRejection).toHaveBeenCalledOnce()
    expect(response.writeHead).toHaveBeenCalledWith(405, expect.anything())
    expect(response.end).toHaveBeenCalled()
  })
})
