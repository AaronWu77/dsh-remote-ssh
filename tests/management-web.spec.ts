import { Context } from '@deepseek-ai/cordis'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { apply, REMOTE_SSH_SETTINGS_PATH, REMOTE_SSH_DIAGNOSTIC_START_PATH, REMOTE_SSH_DIAGNOSTIC_STATUS_PATH, REMOTE_SSH_DIAGNOSTIC_CANCEL_PATH } from '../src/web.ts'
import { RemoteSshManagementError } from '../src/management-error.ts'
import { RemoteSshLifecycleError } from '../src/connection-error.ts'

const paths = [REMOTE_SSH_SETTINGS_PATH, REMOTE_SSH_DIAGNOSTIC_START_PATH, REMOTE_SSH_DIAGNOSTIC_STATUS_PATH, REMOTE_SSH_DIAGNOSTIC_CANCEL_PATH]
async function fixture(rejection: 401 | 403 | undefined, run: (request: (path: string, method: string, body: object) => Promise<{ status: number; body: Record<string, unknown> }>, save: ReturnType<typeof vi.fn>, state: ReturnType<typeof vi.fn>) => Promise<void>) {
  const ctx = new Context()
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const state = vi.fn(()=>({ revision:'r1', sshConfigFile:'', openFileMode:'auto', openFileEditorPath:'', activeExecutions:0, connectionCount:0, applicationState:'applied', platform:'win32' }))
  const save = vi.fn(async()=>state())
  ctx.provide('remoteSshManager', { preferencesState:state, savePreferences:save } as never)
  ctx.provide('webServer', { register: (route: {path:string;handler:(req:IncomingMessage,res:ServerResponse)=>Promise<void>}) => {routes.set(route.path,route.handler);return()=>routes.delete(route.path)} } as never)
  ctx.provide('connection', {requestRejection:()=>rejection} as never)
  apply(ctx,{maxErrorCharacters:1024});await ctx.fiber.await()
  try {
    await run(async(path,method,body)=>{
      const req = Readable.from([JSON.stringify(body)]) as IncomingMessage
      req.method=method;req.headers={}
      let status=0, text=''
      const res = {set statusCode(code:number){status=code},writeHead:(code:number)=>{status=code},end:(value?:string)=>{text=value??''}} as ServerResponse
      await routes.get(path)!(req,res)
      return {status,body:text?JSON.parse(text):{}}
    },save,state)
  } finally {await ctx.fiber.dispose();expect(routes.size).toBe(0)}
}

describe('management HTTP admission',()=>{
  it.each([401,403] as const)('protects all settings/diagnostics methods with the browser trust fence (%s)',async status=>{
    await fixture(status,async(request,save,state)=>{
      for(const path of paths)for(const method of ['GET','POST'])expect((await request(path,method,{})).status).toBe(status)
      expect(save).not.toHaveBeenCalled();expect(state).not.toHaveBeenCalled()
    })
  })
  it('returns typed conflicts without converting them into successful persistence',async()=>{
    await fixture(undefined,async(request,save)=>{
      save.mockRejectedValue(new RemoteSshManagementError('settings_conflict',409,'Reload settings'))
      expect(await request(REMOTE_SSH_SETTINGS_PATH,'POST',{expectedRevision:'old',openFileMode:'download'})).toEqual({status:409,body:{code:'settings_conflict',error:'Reload settings'}})
    })
  })
  it.each(['connection_closed', 'candidate_startup_timeout', 'cleanup_failed'] as const)('returns actionable lifecycle identity without exposing tokens (%s)', async code => {
    await fixture(undefined, async (request, save) => {
      save.mockRejectedValue(new RemoteSshLifecycleError(code, 'Remote connection unavailable; retry after cleanup ws://localhost/?tkn=SECRET'))
      const result = await request(REMOTE_SSH_SETTINGS_PATH, 'POST', { expectedRevision: 'r1' })
      expect(result.status).toBe(503)
      expect(result.body.code).toBe(code)
      expect(result.body.error).toContain('retry after cleanup')
      expect(result.body.error).not.toContain('SECRET')
    })
  })

  it('rejects malformed ids/options before touching a host or starting SSH',async()=>{
    await fixture(undefined,async(request,save)=>{
      for(const path of paths.slice(1))expect((await request(path,'POST',{id:'../bad'})).status).toBe(400)
      expect((await request(REMOTE_SSH_SETTINGS_PATH,'POST',{confirmConnectionReset:'yes'})).status).toBe(400)
      expect((await request(REMOTE_SSH_SETTINGS_PATH,'POST',{openFileMode:'auto'})).status).toBe(400)
      expect(save).not.toHaveBeenCalled()
    })
  })
})
