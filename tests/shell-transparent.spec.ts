import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import { TransparentShellExecutor } from '../src/shell-transparent.ts'

const empty: SubprocessOutputReader = { readFrom: fromByte => ({ text: '', nextOffset: fromByte, lossy: false }) }

describe('transparent shell failure observations', () => {
  it('retains the same UTF-8 note for consuming and independent background readers', async () => {
    const ctx = new Context()
    let rejectDone!: (error: Error) => void
    const done = new Promise<SubprocessOutcome>((_resolve, reject) => { rejectDone = reject })
    const handle: SubprocessHandle = {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: { stdout: empty, stderr: empty }, done,
      waitForExit: () => done.then(() => true), terminate: () => true,
    }
    ctx.provide('subprocess', { spawn: () => handle })
    ctx.provide('remoteSshManager', { routeShell: () => ({ kind: 'local' }) })
    try {
      const shell = new TransparentShellExecutor(ctx, { dialect: 'bash', timeoutMs: 1000, maxTimeoutMs: 1000, maxOutputBytes: 1000, maxSpillBytes: 1000, graceMs: 1 })
      const execution = await shell.execute(shell.resolve({ command: 'unused', workdir: process.cwd(), onExpiry: 'none' }))
      const error = new Error('无法启动 executable')
      rejectDone(error)
      await execution.done
      const note = 'spawn failed: ' + String(error)
      const first = execution.observed.stderr.readFrom(0)
      expect(first).toEqual({ text: note, nextOffset: Buffer.byteLength(note), lossy: false })
      const consuming = execution.readOutput().delta
      expect(consuming).toBe('[stderr]\n' + note)
      expect({ observedStderr: first.text, consuming, nextByte: first.nextOffset }).toMatchSnapshot()
      expect(execution.readOutput().delta).toBe('')
      expect(execution.observed.stderr.readFrom(0)).toEqual(first)
      expect(execution.observed.stderr.readFrom(first.nextOffset).text).toBe('')
      const boundary = Buffer.byteLength('spawn failed: Error: 无法')
      expect(execution.observed.stderr.readFrom(boundary).text).toBe('启动 executable')
      await expect(execution.result()).rejects.toBe(error)
    } finally { await ctx.fiber.dispose() }
  })
})
