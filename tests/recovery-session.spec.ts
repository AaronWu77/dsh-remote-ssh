/** Owner-local assembled Session evidence; this is not the shipped-profile recorded-session tier. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { InMemoryTransport } from '@microsoft/agent-host-protocol/client'
import { dump } from 'js-yaml'
import { expect, it, vi } from 'vitest'
import { RemoteSshRuntime } from '../src/index.ts'
import RemoteSshFileSystem from '../src/fs.ts'
import RemoteSshShellExecutor from '../src/shell.ts'

const wire = vi.hoisted(() => ({
  connections: 0,
  reads: 0,
  commands: 0,
  terminals: [] as string[],
  dropRead: false,
  tasks: [] as Promise<void>[],
  close: [] as (() => void)[],
}))

// Only the external transport is replaced. The SDK, runtime, providers and stock tools remain real.
vi.mock('../src/ssh-lifecycle.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../src/ssh-lifecycle.ts')>()
  return { ...real, connectOwnedWebSocket: async () => {
    const [client, server] = InMemoryTransport.pair()
    wire.connections += 1
    wire.close.push(() => server.close())
    wire.tasks.push((async () => {
      for (;;) {
        const frame = await server.recv()
        if (frame === null) return
        if (frame.kind !== 'text') continue
        const request = JSON.parse(frame.text)
        if (request.method === 'dispatchAction') {
          wire.commands += 1
          server.close()
          return
        }
        if (request.id === undefined) continue
        if (request.method === 'createTerminal') wire.terminals.push(request.params.channel)
        let result: object = {}
        if (request.method === 'initialize') result = { protocolVersion: '0.9.0', serverSeq: 0, snapshots: [] }
        if (request.method === 'resourceResolve') result = { uri: request.params.uri, type: request.params.uri === 'file:///srv/project' ? 'directory' : 'file', size: 6, etag: 'readme-v1' }
        if (request.method === 'resourceRead') {
          wire.reads += 1
          if (wire.dropRead) { wire.dropRead = false; server.close(); return }
          result = { data: 'aGVsbG8K', encoding: 'base64' }
        }
        if (request.method === 'subscribe') result = { snapshot: { resource: request.params.channel, state: {} } }
        server.send({ jsonrpc: '2.0', id: request.id, result })
      }
    })())
    return client
  } }
})

type ScriptRow = { type: 'user'; text: string } | { type: 'call'; id: string; name: string; arguments: Record<string, string>; disconnect?: 'read' } | { type: 'assistant'; text: string }

/** The committed JSONL provides the user input and each explicit model request. */
class RecoveryModel extends LlmAdapter {
  private index = 0
  constructor(private readonly script: ScriptRow[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const row = this.script.filter(row => row.type !== 'user')[this.index++]
    if (row === undefined) throw new Error('recovery script exhausted')
    if (row.type === 'call') {
      if (row.disconnect === 'read') wire.dropRead = true
      const id = ToolCallId(row.id)
      const args = JSON.stringify(row.arguments)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: row.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: row.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: row.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: row.text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('persists failed dispatched operations and subsequent explicit recovery without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-recovery-session-'))
  let ctx: Context | undefined
  try {
    const script = (await readFile(new URL('./fixtures/recovery-session/script.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as ScriptRow)
    const rows = [
      ...['session', 'session-projection', 'llm', 'agent', 'tools', 'system-prompt', 'tool-fs', 'tool-bash'].map(name => ({ id: name, name: import.meta.resolve('@deepseek-ai/dsh-' + name) })),
      // The executor is a separate plugin since the native/PTC split; tools alone cannot dispatch.
      { id: 'tool-executor-native', name: import.meta.resolve('@deepseek-ai/dsh-tool-executor-native') },
      { id: 'shell-env', name: new URL('../../../../packages/shell/shell-env/lib/index.js', import.meta.url).href },
      { id: 'working-directory', name: import.meta.resolve('@deepseek-ai/dsh-working-directory'), config: { defaultDirectory: root } },
      { id: 'persistence', name: import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'), config: { root: join(root, 'sessions'), compression: 'none' } },
      { id: 'runtime', name: 'cordis:recovery-runtime', config: { sshTarget: 'fixture.invalid', directUrl: 'ws://fixture.invalid', localWorkspace: root, remoteWorkspace: '/srv/project', protocolVersions: ['0.9.0'] } },
      { id: 'remote-fs', name: 'cordis:recovery-fs' },
      { id: 'remote-shell', name: 'cordis:recovery-shell' },
      { id: 'loop', name: import.meta.resolve('@deepseek-ai/dsh-agent-loop'), config: { agents: [] } },
    ]
    const path = join(root, 'cordis.yml')
    await writeFile(path, dump(rows))
    ctx = await boot('recovery-session-test', path, [], ctx => {
      Object.assign(ctx.loader.builtins, { 'recovery-runtime': RemoteSshRuntime, 'recovery-fs': RemoteSshFileSystem, 'recovery-shell': RemoteSshShellExecutor })
    }, new URL('../', import.meta.url).href)
    ctx.effect(() => ctx!.llm.registerAdapter(['recovery-scripted'], new RecoveryModel(script)))
    const handle = await ctx.agents.create({ sessionId: SessionId('recovery-session'), meta: { cwd: root }, agentOptions: { provider: 'recovery-scripted', model: 'recovery-scripted' } })
    const agent = handle.agent
    const idle = new Promise<void>(resolve => {
      ctx!.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') resolve() })
    })
    const input = script.find(row => row.type === 'user')!
    if (input.type !== 'user') throw new Error('missing user input')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: input.text }] }))
    await idle
    await handle.dispose()
    const stored = await ctx.sessionPersistence.open(agent.session.id, 'read')
    const { events } = await stored.read()
    await stored.close()
    const calls = events.filter(event => event.type === 'tool/call')
    const results = events.filter(event => event.type === 'tool/result')
    expect(calls.map(event => event.data.callId)).toEqual(['first-read', 'lost-read', 'explicit-read', 'lost-command', 'after-command-read'])
    expect(results.map(event => event.data.message.isError)).toEqual([false, true, false, true, false])
    // Each failed operation reached the wire exactly once. Recovery requires a later logged call.
    expect(wire.reads).toBe(4)
    expect(wire.commands).toBe(1)
    expect(wire.connections).toBe(3)
    for (const result of results) expect(result.sourceEventSeqs).toEqual([calls.find(call => call.data.callId === result.data.message.toolCallId)!.seq])
    const transcript: object[] = []
    for (const event of events) {
      if (event.type === 'user/message' && event.data.source.kind === 'user') transcript.push({ type: event.type, content: event.data.content })
      if (event.type === 'assistant/message' && event.data.message.content.every(block => block.type === 'text')) transcript.push({ type: event.type, content: event.data.message.content })
      if (event.type === 'tool/call') transcript.push({ type: event.type, callId: event.data.callId, name: event.data.name, arguments: event.data.arguments })
      if (event.type === 'tool/result') transcript.push({ type: event.type, callId: event.data.message.toolCallId, isError: event.data.message.isError, content: event.data.message.content })
    }
    // Only the fixture-owned terminal identifier is variable; preserve complete tool error text.
    let normalized = transcript.map(row => JSON.stringify(row)).join('\n') + '\n'
    for (const terminal of wire.terminals) normalized = normalized.replaceAll(terminal, 'ahp-terminal:/{{terminal}}')
    await expect(normalized).toMatchFileSnapshot('./expected/recovery-session/transcript.expected.jsonl')
  } finally {
    await ctx?.fiber.dispose()
    for (const close of wire.close) close()
    await Promise.all(wire.tasks)
    wire.tasks = []; wire.close = []; wire.terminals = []
    Object.assign(wire, { connections: 0, reads: 0, commands: 0, dropRead: false })
    await rm(root, { recursive: true, force: true })
  }
})
