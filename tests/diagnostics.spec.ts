import { randomUUID } from 'node:crypto'
import { InMemoryTransport } from '@microsoft/agent-host-protocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteSshDiagnostics, parseDiagnosticId, parseDiagnosticRequest, type DiagnosticPolicy } from '../src/diagnostics.ts'
import type { RemoteSshManager } from '../src/manager.ts'
import type { StartDiagnosticRequest } from '../src/management-types.ts'

const state = vi.hoisted(() => ({ commands: [] as string[][], active: new Set<object>(), tasks: [] as Promise<void>[], sshFails: false, hangSsh: false, cleanupFails: false, missingRg: false, dedicatedEndpoint: false, hangOwned: false, endpoints: [] as string[] }))
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return { spawn: (_exe: string, args: string[]) => {
    class Child extends EventEmitter {
      stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough()
      exitCode: number | null = null
      close(code: number | null) { if (!state.active.delete(this)) return; this.exitCode = code; this.emit('close', code) }
      kill() { queueMicrotask(() => this.close(null)); return true }
    }
    const child = new Child(); state.active.add(child); state.commands.push(args)
    const command = args.at(-1)!
    queueMicrotask(() => {
      if (args.includes('-N')) return
      if (command.startsWith('printf "DSH_SSH_READY')) {
        if (state.hangSsh) return
        if (state.sshFails) { child.stderr.write('ProxyCommand password=SECRET /home/private ws://localhost/?tkn=TOKEN'); child.close(255); return }
        child.stdout.write('DSH_SSH_READY\nlinux=Linux\n' + ['bash','base64','mkfifo','dd','mv','ps','awk','kill','rg'].map(x=>x+'='+(x==='rg'&&state.missingRg?'0':'1')).join('\n')); child.close(0)
      } else if (command.includes('find "$HOME/.vscode-server')) {
        if (!state.dedicatedEndpoint && !state.hangOwned) child.stdout.write('/private/cache/server/bin/code-server\n')
        child.close(0)
      } else if (command.includes('exec "$dsh_code_server"')) {
        child.stdout.write('DSH_AGENT_HOST_PID=12345\nAgent host server listening on 127.0.0.1:45678\n')
      } else if (command.startsWith('cat ')) { child.stdout.write('SECRET-TOKEN'); child.close(0) }
      else if (command.startsWith('dsh_pid=') || command.startsWith('rm -rf -- ')) child.close(state.cleanupFails ? 1 : 0)
      else {
        if (command.includes('--new-instance --foreground')) {
          if (state.hangOwned) return
          child.stdout.write('DSH_AGENT_HOST_PID=23456\n')
          if (state.dedicatedEndpoint) {
            child.stdout.write('ws://localhost:45678?tkn=abc')
            queueMicrotask(() => child.stdout.write('def\n'))
            return
          }
        }
        child.close(127)
      }
    })
    return child
  } }
})
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    createServer: () => Object.assign(new EventEmitter(), { listen(_p: number, _h: string, ready: () => void) { queueMicrotask(ready) }, address: () => ({ port: 54321 }), close(done?: () => void) { done?.() } }),
    createConnection: () => { const socket = Object.assign(new EventEmitter(), { destroy() {} }); queueMicrotask(()=>socket.emit('connect')); return socket },
  }
})
vi.mock('../src/ssh-lifecycle.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../src/ssh-lifecycle.ts')>()
  return { ...real, connectOwnedWebSocket: async (url: string) => {
    state.endpoints.push(url)
    const [client, server] = InMemoryTransport.pair()
    state.tasks.push((async()=>{
      for (;;) {
        const frame = await server.recv(); if (frame === null) return
        if (frame.kind !== 'text') continue
        const request = JSON.parse(frame.text)
        if (request.id === undefined) continue
        const result = request.method === 'initialize' ? { protocolVersion: '0.9.0', serverSeq: 0, snapshots: [], defaultDirectory: 'file:///home/private' }
          : request.method === 'resourceList' ? { entries: [{ name: 'private-file', type: 'directory' }] } : {}
        server.send({ jsonrpc: '2.0', id: request.id, result })
      }
    })())
    return client
  } }
})
const policy: DiagnosticPolicy = { timeoutMs: 10000, terminalTimeoutMs: 1000, leaseMs: 5000, retentionMs: 20000, maxConcurrent: 2, maxRetained: 3 }
const server = { id: 'fixture', label: 'Secret server', sshTarget: 'private@fixture.invalid' }
function fixture(overrides: Partial<DiagnosticPolicy> = {}) {
  const release = vi.fn()
  const manager: Pick<RemoteSshManager, 'snapshot' | 'transportFor' | 'ownDiagnostic'> = {
    snapshot: () => ({ aliasRoot: '/unused', servers: [server], workspaces: [], retiredAliases: [], openFileMode: 'auto',
      openFileDownloadMaxBytes: 1024, startupTimeoutMs: 10000, embeddedStartupTimeoutMs:15000, standaloneStartupTimeoutMs:30000, requestTimeoutMs: 1000, shutdownTimeoutMs: 1, connectTimeoutMs: 1000, protocolVersions: ['0.9.0'] }),
    transportFor: () => ({ executable: 'fixture-ssh', args: ['-o','BatchMode=yes'], multiplexed: false }),
    ownDiagnostic: revision => { if (revision !== 'revision') throw new Error('conflict'); return release },
  }
  return { diagnostics: new RemoteSshDiagnostics(manager, { ...policy, ...overrides }), release }
}
function request(extra: Partial<StartDiagnosticRequest> = {}): StartDiagnosticRequest {
  return { id: parseDiagnosticId(randomUUID()), expectedRevision: 'revision', serverId: 'fixture', mode: 'basic', terminal: false, confirmDeep: false, ...extra }
}
async function finished(diagnostics: RemoteSshDiagnostics, input: StartDiagnosticRequest) {
  await vi.waitFor(() => expect(diagnostics.status(input.id).finishedAt).toBeDefined())
  return diagnostics.status(input.id)
}
afterEach(async () => {
  vi.useRealTimers(); await Promise.all(state.tasks); state.tasks = []
  expect(state.active.size).toBe(0)
  Object.assign(state, { commands: [], sshFails: false, hangSsh: false, cleanupFails: false, missingRg: false, dedicatedEndpoint: false, hangOwned: false, endpoints: [] as string[] })
})

describe('owned diagnostics', () => {
  it('validates confirmation, opaque ids and absolute directory input', () => {
    expect(() => parseDiagnosticId('../bad')).toThrow()
    expect(() => parseDiagnosticRequest({ ...request(), mode: 'deep' })).toThrow('Confirm')
    expect(() => parseDiagnosticRequest({ ...request(), terminal: true })).toThrow('Confirm')
    expect(() => parseDiagnosticRequest({ ...request(), path: 'relative' })).toThrow('Invalid')
  })

  it('basic checks use SSH only, return allowlisted facts and skip deeper stages', async () => {
    const { diagnostics, release } = fixture(); const input = request()
    try {
      diagnostics.start(input, server)
      const report = await finished(diagnostics, input)
      expect(report.status).toBe('succeeded')
      expect(report.stages.find(x=>x.id==='agentHost')?.status).toBe('skipped')
      expect(report.stages.find(x=>x.id==='cleanup')?.status).toBe('succeeded')
      expect(report.prerequisites?.bash).toBe(true)
      expect(state.commands).toHaveLength(1)
      expect(JSON.stringify(report)).not.toMatch(/private|SECRET|TOKEN|fixture[.]invalid/)
      expect(release).toHaveBeenCalledOnce()
    } finally { await diagnostics.close() }
  })

  it('returns a stage failure without leaking proxy credentials or raw SSH stderr', async () => {
    state.sshFails = true
    const { diagnostics } = fixture(); const input = request()
    try {
      diagnostics.start(input, server)
      const report = await finished(diagnostics, input)
      expect(report).toMatchObject({ status: 'failed', stages: expect.arrayContaining([{ id:'ssh', status:'failed', elapsedMs:expect.any(Number), code:'ssh_failed' }]) })
      expect(JSON.stringify(report)).not.toMatch(/SECRET|TOKEN|private|password/)
    } finally { await diagnostics.close() }
  })

  it('deep checks use an isolated runtime, negotiate, list and clean only owned resources', async () => {
    state.missingRg = true
    const { diagnostics } = fixture(); const input = request({ mode:'deep', confirmDeep:true })
    try {
      diagnostics.start(input, server)
      const report = await finished(diagnostics, input)
      expect(report).toMatchObject({ status:'succeeded', protocolVersion:'0.9.0', directoryCount:1, prerequisites: { rg: false } })
      for (const id of ['agentHost','tunnel','protocol','directory','cleanup']) expect(report.stages.find(x=>x.id===id)?.status).toBe('succeeded')
      expect(state.commands.every(args=>args.includes('ControlMaster=no')&&args.includes('ControlPath=none'))).toBe(true)
      expect(state.commands.some(args=>args.at(-1)?.startsWith('rm -rf -- '))).toBe(true)
      expect(JSON.stringify(report)).not.toMatch(/SECRET|private|fixture[.]invalid/)
    } finally { await diagnostics.close() }
  })

  it('waits for a full standalone endpoint line when the token arrives across chunks', async () => {
    state.dedicatedEndpoint = true
    const { diagnostics } = fixture(); const input = request({mode:'deep',confirmDeep:true})
    try {
      diagnostics.start(input,server)
      const report=await finished(diagnostics,input)
      expect(report.status).toBe('succeeded')
      expect(state.endpoints).toHaveLength(1)
      expect(new URL(state.endpoints[0]!).searchParams.get('tkn')).toBe('abcdef')
      expect(report.stages.some(stage=>stage.status==='running'||stage.status==='pending')).toBe(false)
    } finally {await diagnostics.close()}
  })

  it('does not claim cleanup when cancellation loses the remote PID acknowledgement', async () => {
    state.hangOwned = true
    const {diagnostics}=fixture();const input=request({mode:'deep',confirmDeep:true})
    try {
      diagnostics.start(input,server)
      await vi.waitFor(()=>expect(state.commands.some(args=>args.at(-1)?.includes('--new-instance --foreground'))).toBe(true))
      diagnostics.cancel(input.id)
      const report=await finished(diagnostics,input)
      expect(report.status).toBe('failed')
      expect(report.stages.find(stage=>stage.id==='cleanup')?.status).toBe('failed')
      expect(state.commands.some(args=>args.at(-1)?.startsWith('rm -rf -- '))).toBe(false)
    } finally {await diagnostics.close()}
  })

  it('never reports overall success when owned cleanup failed', async () => {
    state.cleanupFails = true
    const { diagnostics } = fixture(); const input = request({ mode:'deep', confirmDeep:true })
    try {
      diagnostics.start(input, server)
      const report = await finished(diagnostics, input)
      expect(report.status).toBe('failed')
      expect(report.stages.find(x=>x.id==='cleanup')).toMatchObject({ status:'failed', code:'cleanup_failed' })
      expect(state.commands.some(args=>args.at(-1)?.startsWith('rm -rf -- '))).toBe(false)
    } finally { await diagnostics.close() }
  })

  it('cancels a pending SSH process, joins close and refuses duplicate execution for the same id', async () => {
    state.hangSsh = true
    const { diagnostics, release } = fixture(); const input = request()
    try {
      diagnostics.start(input, server)
      await vi.waitFor(()=>expect(state.commands).toHaveLength(1))
      diagnostics.start(input, server)
      diagnostics.cancel(input.id)
      const report = await finished(diagnostics,input)
      expect(report.status).toBe('cancelled')
      expect(state.active.size).toBe(0); expect(release).toHaveBeenCalledOnce()
      diagnostics.start(input,server); expect(state.commands).toHaveLength(1)
    } finally { await diagnostics.close() }
  })

  it('remembers cancellation arriving before a start and bounds concurrent work', async () => {
    state.hangSsh = true
    const { diagnostics } = fixture({ maxConcurrent:1 }); const first = request(); const second = request()
    try {
      diagnostics.cancel(first.id)
      expect(()=>diagnostics.start(first,server)).toThrow('cancelled before')
      diagnostics.start(second,server)
      expect(()=>diagnostics.start(request(),server)).toThrow('Wait for another')
    } finally { await diagnostics.close() }
    expect(state.active.size).toBe(0)
  })

  it('expires an abandoned task lease and removes its retained report', async () => {
    vi.useFakeTimers(); state.hangSsh = true
    const { diagnostics } = fixture({ leaseMs:100, retentionMs:200 }); const input = request()
    try {
      diagnostics.start(input,server)
      await vi.advanceTimersByTimeAsync(101)
      expect(diagnostics.status(input.id).status).toBe('cancelled')
      expect(state.active.size).toBe(0)
      await vi.advanceTimersByTimeAsync(201)
      expect(()=>diagnostics.status(input.id)).toThrow('expired')
    } finally { await diagnostics.close() }
  })
})
