/** Explicitly opted-in diagnostic lifecycle against a Linux target; no profile changes or workspace writes. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { RemoteSshDiagnostics, parseDiagnosticId } from '../src/diagnostics.ts'
import type { RemoteSshManager } from '../src/manager.ts'
import RemoteSshRuntime from '../src/index.ts'
import { formatConnectionDiagnostic } from '../src/connection-error.ts'

const target = process.env.DSH_DIAGNOSTIC_LIVE_SSH_TARGET

describe.skipIf(!target)('real SSH diagnostics', () => {
  it('checks a real host through terminal completion and owned cleanup', async () => {
    const originalClose = RemoteSshRuntime.prototype.close
    const originalStandalone = RemoteSshRuntime.prototype.hasUntrackedStandalone
    const closeSpy = vi.spyOn(RemoteSshRuntime.prototype, 'close').mockImplementation(async function (this: RemoteSshRuntime) {
      try { return await originalClose.call(this) } catch (error) { console.log('LIVE_CLEANUP_ERROR', formatConnectionDiagnostic(String(error), 2000)); throw error }
    })
    const standaloneSpy = vi.spyOn(RemoteSshRuntime.prototype, 'hasUntrackedStandalone').mockImplementation(function (this: RemoteSshRuntime) {
      const value = originalStandalone.call(this); console.log('LIVE_STANDALONE_UNTRACKED', value); return value
    })
    const server = { id:'live', label:'Live diagnostic', sshTarget:target! }
    let owned = 0
    const manager: Pick<RemoteSshManager, 'snapshot' | 'transportFor' | 'ownDiagnostic'> = {
      snapshot:()=>({ aliasRoot:'/unused', servers:[server], workspaces:[], retiredAliases:[], openFileMode:'auto',
        openFileDownloadMaxBytes:1024, startupTimeoutMs:90000, requestTimeoutMs:15000, shutdownTimeoutMs:3000, connectTimeoutMs:10000, protocolVersions:['1.0.0','0.9.0'] }),
      transportFor:()=>({executable:'ssh',args:['-o','BatchMode=yes','-o','ConnectTimeout=10'],multiplexed:false}),
      ownDiagnostic:()=>{owned++;return()=>{owned--}},
    }
    const diagnostics = new RemoteSshDiagnostics(manager,{timeoutMs:120000,terminalTimeoutMs:15000,leaseMs:45000,retentionMs:60000,maxConcurrent:1,maxRetained:2})
    const input={id:parseDiagnosticId(randomUUID()),expectedRevision:'live',serverId:'live',mode:'deep' as const,terminal:true,confirmDeep:true}
    try {
      diagnostics.start(input,server)
      await vi.waitFor(()=>expect(diagnostics.status(input.id).finishedAt).toBeDefined(),{timeout:150000,interval:500})
      const report = diagnostics.status(input.id)
      console.log('LIVE_DIAGNOSTIC_REPORT',JSON.stringify(report))
      expect(report.status).toBe('succeeded')
      expect(report.stages.find(stage=>stage.id==='terminal')?.status).toBe('succeeded')
      expect(report.stages.find(stage=>stage.id==='cleanup')?.status).toBe('succeeded')
      expect(owned).toBe(0)
    } finally { await diagnostics.close(); closeSpy.mockRestore(); standaloneSpy.mockRestore() }
  },180000)
})
