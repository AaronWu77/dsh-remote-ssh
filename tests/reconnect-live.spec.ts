/** Opt-in artifact-plane recovery; interrupts only this test's SSH tunnel and never replays a resource operation. */
import { Context } from '@deepseek-ai/cordis'
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
const target = process.env.DSH_RECONNECT_LIVE_SSH_TARGET
const path = process.env.DSH_RECONNECT_LIVE_PATH

describe.skipIf(!target || !path)('built Remote SSH connection recovery on an owned Linux connection', () => {
  it('lists the selected directory through a new shared client after its own tunnel exits', async () => {
    const { RemoteSshRuntime, fileUriFromPosixPath } = await import('../lib/index.js')
    const ctx = new Context()
    try {
      await ctx.plugin(RemoteSshRuntime, {
        sshTarget: target!, sshArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'],
        remoteAccessRoot: path!, startupTimeoutMs: 60000,
        embeddedStartupTimeoutMs: 15000, standaloneStartupTimeoutMs: 30000,
        requestTimeoutMs: 10000, shutdownTimeoutMs: 3000,
      }).await()
      const runtime = ctx.remoteSsh
      const first = await runtime.getConnection()
      const before = await first.client.resourceList({ uri: fileUriFromPosixPath(path!) })
      expect(before.entries.length).toBeGreaterThan(0)
      const owner = Reflect.get(runtime, 'owner') as { tunnel?: ChildProcess }
      const tunnel = owner.tunnel
      if (!tunnel) throw new Error('Owned runtime tunnel is unavailable for the recovery probe')
      const exited = once(tunnel, 'close')
      expect(tunnel.kill()).toBe(true)
      await exited
      const [second, concurrent] = await Promise.all([runtime.getConnection(), runtime.getConnection()])
      expect(second).not.toBe(first)
      expect(second.client).not.toBe(first.client)
      expect(second).toBe(concurrent)
      const after = await second.client.resourceList({ uri: fileUriFromPosixPath(path!) })
      expect(after.entries.length).toBeGreaterThan(0)
      console.log('LIVE_RECONNECT_REPORT', JSON.stringify({
        protocolVersion: second.protocolVersion, beforeCount: before.entries.length,
        afterCount: after.entries.length, newClient: second.client !== first.client,
        sharedAttempt: second === concurrent,
      }))
    } finally { await ctx.fiber.dispose() }
  }, 150000)
})
