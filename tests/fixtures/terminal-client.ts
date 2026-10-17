import { resolve } from 'node:path'
import { ActionType } from '@microsoft/agent-host-protocol'
import type { AhpClient, Subscription, SubscriptionEvent } from '@microsoft/agent-host-protocol/client'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteSshRuntime } from '../../src/index.ts'
import { WorkspacePathMapper } from '../../src/index.ts'
import RemoteSshShellExecutor from '../../src/shell.ts'

class FakeSubscription implements AsyncIterableIterator<SubscriptionEvent> {
  private readonly events: SubscriptionEvent[] = []
  private closed = false
  private wake: (() => void) | undefined
  push(action: object): void {
    this.events.push({ type: 'action', params: { channel: 'ahp-terminal:/test', serverSeq: this.events.length + 1, action } } as SubscriptionEvent)
    this.wake?.()
    this.wake = undefined
  }
  async next(): Promise<IteratorResult<SubscriptionEvent>> {
    while (this.events.length === 0 && !this.closed) await new Promise<void>(resolvePromise => { this.wake = resolvePromise })
    if (this.events.length === 0) return { value: undefined, done: true }
    return { value: this.events.shift()!, done: false }
  }
  async return(): Promise<IteratorResult<SubscriptionEvent>> { return { value: undefined, done: true } }
  [Symbol.asyncIterator](): this { return this }
  async close(): Promise<void> { this.closed = true; this.wake?.(); this.wake = undefined }
}

class FakeTerminalAhp {
  readonly subscription = new FakeSubscription()
  readonly writes: string[] = []
  disposed = false
  unsubscribed = false
  unsubscribeError: Error | undefined
  dispatched = 0
  abortAt: 'write' | 'create' | 'subscribe' | 'dispatch' | undefined
  disposeError: Error | undefined
  createError: Error | undefined
  exitedWithoutMarker = false
  controller: AbortController | undefined

  async resourceWrite({ uri }: { uri: string }) { this.writes.push(uri); if (this.abortAt === 'write') this.controller?.abort(); return {} }
  async resourceDelete() { return {} }
  async request(method: string) {
    if (method === 'disposeTerminal') { if (this.disposeError) throw this.disposeError; this.disposed = true }
    if (method === 'createTerminal' && this.createError) throw this.createError
    if (method === 'createTerminal' && this.abortAt === 'create') this.controller?.abort()
    return {}
  }
  async unsubscribe(_channel: string) {
    if (this.unsubscribeError) throw this.unsubscribeError
    this.unsubscribed = true
    await this.subscription.close()
  }
  async subscribe() {
    if (this.abortAt === 'subscribe') this.controller?.abort()
    return { result: { snapshot: { resource: 'ahp-terminal:/test', state: {} } }, subscription: this.subscription as unknown as Subscription }
  }
  dispatch(_channel: string, action: { data: string }) {
    this.dispatched += 1
    if (this.abortAt === 'dispatch') { this.controller?.abort(); return { clientSeq: 1 } }
    if (this.exitedWithoutMarker) { this.subscription.push({ type: ActionType.TerminalExited, exitCode: 3 }); return { clientSeq: 1 } }
    const token = /DSH:([0-9a-f-]+):BEGIN/.exec(action.data)?.[1]
    if (token === undefined) throw new Error('missing output marker')
    this.subscription.push({ type: ActionType.TerminalData, data: `echoed input\r\n\x1eDSH:${token}:BE` })
    this.subscription.push({ type: ActionType.TerminalData, data: `GIN\x1fremote-output\r\n\x1eDSH:${token}:END:` })
    this.subscription.push({ type: ActionType.TerminalData, data: '7\x1ftrailing prompt' })
    this.subscription.push({ type: ActionType.TerminalExited, exitCode: 7 })
    return { clientSeq: 1 }
  }
}

export async function setup(ctx = new Context(), alias?: string, artifact = false) {
  const client = new FakeTerminalAhp()
  const local = alias ?? resolve('tests', 'shell-alias')
  const runtime = {
    mapper: new WorkspacePathMapper(local, '/srv/project'),
    runtimeRoot: '/tmp/dsh/test',
    clientId: 'test-client',
    getClient: async () => client as unknown as AhpClient,
  } as unknown as RemoteSshRuntime
  ctx.provide('remoteSsh', runtime)
  const provider = artifact ? (await import('../../lib/shell.js')).default : RemoteSshShellExecutor
  await ctx.plugin(provider, {
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 2000,
    outputMaxBytes: 1024,
    maxOutputMaxBytes: 4096,
    shellCommand: 'bash',
  })
  return { ctx, client, local, runtime }
}
