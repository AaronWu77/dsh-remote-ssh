import { execFile } from 'node:child_process'
import { describe, expect, it, onTestFinished } from 'vitest'
import { buildStopEmbeddedAgentHostCommand } from '../src/index.ts'

const shell = process.env.DSH_TEST_POSIX_SHELL ?? (process.platform === 'win32' ? undefined : '/bin/sh')

async function simulate(mode: string): Promise<{ code: number; stdout: string; stderr: string }> {
  if (shell === undefined) throw new Error('Set DSH_TEST_POSIX_SHELL for Windows POSIX-script tests')
  const stat = (pid: number, start: number) => pid + ' (fixture) ' + ['S', '1', '321', mode === 'wrong-session' ? '999' : '321', ...Array<string>(15).fill('0'), String(start)].join(' ')
  const script = [
    'parent=1; child=1; phase=initial',
    mode === 'empty' ? 'parent=0; child=0' : '',
    'ps() { case "$*" in',
    "'-eo pid=,pgid=,stat=') " + (mode === 'ps-fails' ? 'return 2' : '[ "$parent" = 0 ] || printf "321 321 S\\n"; [ "$child" = 0 ] || printf "322 321 S\\n"; return 0') + ';;',
    "'-o args= -p 321') [ \"$parent\" = 0 ] || printf '%s\\n' " + (mode === 'wrong-owner' ? "'/tmp/unrelated/server'" : "'/tmp/owned/server'") + ';;',
    '*) return 2;; esac; }',
    'cat() { case "$1" in',
    "'/proc/321/stat') [ \"$parent\" = 0 ] && return 1; printf '%s\\n' '" + stat(321, 100) + "';;",
    "'/proc/322/stat') [ \"$child\" = 0 ] && return 1; " + (mode === 'reused-child' ? "if [ \"$phase\" = TERM ]; then printf '%s\\n' '" + stat(322, 201) + "'; else printf '%s\\n' '" + stat(322, 200) + "'; fi" : "printf '%s\\n' '" + stat(322, 200) + "'") + ';;',
    '*) return 2;; esac; }',
    'env() { [ "$1" = kill ] || return 2; shift; kill "$@"; }',
    'kill() { phase=$2; printf "SIGNAL=%s\\n" "$phase"; case "$phase" in',
    'TERM) parent=0; ' + (mode === 'cooperative' ? 'child=0' : '') + ';;',
    'KILL) ' + (mode === 'stuck' ? ':' : 'child=0') + ';;',
    '*) return 2;; esac; }',
    'sleep() { printf "SETTLE=%s\\n" "$phase"; }',
    buildStopEmbeddedAgentHostCommand(321, '/tmp/owned', 100),
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = execFile(shell, ['-c', script], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : error.code
      if (typeof code !== 'number' || error?.killed === true || error?.signal != null) { reject(error); return }
      resolve({ code, stdout, stderr })
    })
    const closed = new Promise<void>(done => child.once('close', () => done()))
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await closed
    })
  })
}

describe.skipIf(shell === undefined)('owned remote group cleanup script', () => {
  it('kills a surviving child after the leader exits and verifies final group emptiness', async () => {
    const result = await simulate('survivor')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('SIGNAL=TERM\nSETTLE=TERM\nSIGNAL=KILL\nSETTLE=KILL\n')
  })
  it.each(['wrong-owner', 'wrong-session', 'ps-fails'])('rejects %s without sending a signal', async mode => {
    const result = await simulate(mode)
    expect(result.code).toBe(1)
    expect(result.stdout).not.toContain('SIGNAL=')
  })
  it('does not signal a replacement child whose PID has been reused', async () => {
    const result = await simulate('reused-child')
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('SIGNAL=TERM')
    expect(result.stdout).not.toContain('SIGNAL=KILL')
    expect(result.stderr).toContain('ownership cannot be verified')
  })
  it('reports failure when live members remain after KILL settling', async () => {
    const result = await simulate('stuck')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('still has live members')
  })
  it.each(['empty', 'cooperative'])('returns after %s group exit without KILL', async mode => {
    const result = await simulate(mode)
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('SIGNAL=KILL')
  })
})
