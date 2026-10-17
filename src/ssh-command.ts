/** Bounded SSH execution shared by connection startup and diagnostics. */
import { spawn } from 'node:child_process'
import { ownSshProcess } from './ssh-lifecycle.ts'

export interface CapturedProcess {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** Run one owned SSH command, settling only after close.
 * @param command - SSH executable.
 * @param args - Raw argv without shell interpolation.
 * @param timeoutMs - Total command deadline.
 * @param signal - Owner cancellation.
 * @param graceMs - TERM grace before KILL.
 * @returns Bounded output and exit status.
 */
export async function runCaptured(command: string, args: string[], timeoutMs: number, signal: AbortSignal, graceMs: number): Promise<CapturedProcess> {
  signal.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = ownSshProcess(child)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let failure: unknown
    const fail = (error: unknown): void => {
      failure ??= error
      void stop(graceMs)
    }
    const append = (bucket: Buffer[], chunk: Buffer): void => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) { fail(new Error('dsh-remote-ssh: SSH startup output exceeded 4 MiB')); return }
      if (failure === undefined) bucket.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => { append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { append(stderr, chunk) })
    child.once('error', fail)
    const abort = (): void => { fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => fail(new Error('dsh-remote-ssh: SSH startup timed out after ' + timeoutMs + 'ms')), timeoutMs)
    child.once('close', exitCode => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (failure !== undefined) reject(failure)
      else resolvePromise({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    if (signal.aborted) abort()
  })
}
