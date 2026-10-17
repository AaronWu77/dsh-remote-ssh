/** Opt-in Linux SSH check; all remote writes belong to an exclusively allocated test directory. */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SidebarWorkspaceProviders } from 'dsh-better-sidebar/workspace-provider'
import RemoteSshManager from '../src/manager.ts'
import RemoteSshRuntime, { quotePosix } from '../src/index.ts'
import RemoteSshFileSystem from '../src/fs.ts'
import RemoteSshShellExecutor from '../src/shell.ts'
import { createSidebarRemoteWorkspace } from '../src/sidebar-workspace.ts'
import { Config } from '../src/sidebar-bridge.ts'

const target = process.env.DSH_SIDEBAR_LIVE_SSH_TARGET

async function ssh(command: string): Promise<string> {
  if (!target) throw new Error('Explicit opt-in SSH target is required')
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, command], { stdio: ['ignore', 'pipe', 'pipe'] })
  const out: Buffer[] = []; const err: Buffer[] = []
  child.stdout.on('data', chunk => out.push(chunk))
  child.stderr.on('data', chunk => err.push(chunk))
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  if (exit.signal !== null || exit.code !== 0) throw new Error(`SSH command failed (${exit.signal ?? exit.code}): ${Buffer.concat(err).toString('utf8')}`)
  return Buffer.concat(out).toString('utf8').trim()
}

function checkedPrivateRoot(path: string): string {
  if (!/^\/tmp\/dsh-sidebar-live-[A-Za-z0-9]+$/.test(path)) throw new Error('Unexpected remote cleanup target: ' + path)
  return path
}

const errors: Pick<SidebarWorkspaceProviders, 'workspaceError' | 'gitCommandError'> = {
  workspaceError: (code, message, status) => Object.assign(new Error(message), { code, status }),
  gitCommandError: (message, command, exitCode) => Object.assign(new Error(message), { code: 'git-error', command, exitCode }),
}

describe.skipIf(!target)('Sidebar provider against an exclusively owned Linux SSH workspace', () => {
  it('reads writes uploads renames Git and an interactive terminal on the selected remote host', async () => {
    const root = checkedPrivateRoot(await ssh('umask 077; mktemp -d /tmp/dsh-sidebar-live-XXXXXXXXXX'))
    const local = await mkdtemp(join(tmpdir(), 'dsh-sidebar-live-'))
    const ctx = new Context()
    const runtimeCtx = new Context()
    let terminal: Awaited<ReturnType<ReturnType<typeof createSidebarRemoteWorkspace>['createTerminal']>> | undefined
    let failure: unknown
    try {
      await ssh(`mkdir -- ${quotePosix(root + '/workspace')}; printf 'private-root=%s\n' ${quotePosix(root)}`)
      ctx.provide('settings', { configure: () => () => {}, describe: () => [] } as never)
      await ctx.plugin(RemoteSshManager, {
        aliasRoot: local, servers: [{ id: 'private-server', label: 'Private Linux', sshTarget: target! }],
        workspaces: [{ id: 'private-workspace', serverId: 'private-server', remotePath: root + '/workspace' }],
      }).await()
      const manager = ctx.remoteSshManager
      const route = manager.workspace('private-workspace')
      await runtimeCtx.plugin(RemoteSshRuntime, {
        sshTarget: target!, remoteWorkspace: root + '/workspace', localWorkspace: route.aliasPath,
        remoteAccessRoot: root, remoteRuntimeRoot: root + '/runtime',
        startupTimeoutMs: 90_000, requestTimeoutMs: 15_000, shutdownTimeoutMs: 5_000,
      }).await()
      await runtimeCtx.plugin(RemoteSshFileSystem, { maxReadBytes: 1024 * 1024, diffBasisMaxBytes: 1024 * 1024 }).await()
      await runtimeCtx.plugin(RemoteSshShellExecutor, {
        localWorkspace: route.aliasPath, remoteWorkspace: root + '/workspace', shellCommand: 'bash',
        defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000,
      }).await()
      // Route generation and ownership stay real; only this test's runtime root replaces connection composition.
      vi.spyOn(manager, 'workspaceContext').mockResolvedValue({ ctx: runtimeCtx, fs: runtimeCtx.fs, remote: runtimeCtx.remoteSsh })
      vi.spyOn(manager, 'workspaceShell').mockResolvedValue(runtimeCtx.shell as RemoteSshShellExecutor)
      const workspace = createSidebarRemoteWorkspace(manager, route, route.aliasPath, Config({ cleanupGraceMs: 5000 }), errors)
      const connection = await runtimeCtx.remoteSsh.getConnection()
      const client = connection.client
      console.log('LIVE_SIDEBAR_PROTOCOL', connection.protocolVersion)
      const realWrite = client.resourceWrite.bind(client)
      let verifiedPrivateDirectories = 0
      vi.spyOn(client, 'resourceWrite').mockImplementation(async params => {
        if (params.createOnly && String(params.uri).includes('/.dsh-sidebar-')) {
          const parent = decodeURIComponent(new URL(params.uri).pathname).replace(/\/content$/, '')
          if (!parent.startsWith(root + '/workspace/.dsh-sidebar-') || !/^\/tmp\/dsh-sidebar-live-[A-Za-z0-9]+\/workspace\/\.dsh-sidebar-[a-f0-9-]+$/.test(parent)) throw new Error('Unexpected private staging directory')
          expect(await ssh('stat -c %a -- ' + quotePosix(parent))).toBe('700')
          verifiedPrivateDirectories++
        }
        return realWrite(params)
      })
      await workspace.fs.write(workspace.cwd + '/seed.txt', 'remote 中文 😀\n', true)
      expect(await ssh('cat -- ' + quotePosix(workspace.cwd + '/seed.txt'))).toBe('remote 中文 😀')
      expect(await workspace.fs.read('seed.txt', 4096, true)).toMatchObject({ content: 'remote 中文 😀\n', binary: false, truncated: false })
      const bytes = new Uint8Array([0, 1, 255, 80, 68, 70])
      await workspace.fs.upload({ dir: workspace.cwd, relativePath: 'binary.dat', chunks: (async function* () { yield bytes })(), limit: 4096, fence: true })
      expect(Buffer.from(await workspace.fs.readBytes('binary.dat', 4096, true))).toEqual(Buffer.from(bytes))
      await expect(workspace.fs.upload({ dir: workspace.cwd, relativePath: 'binary.dat', chunks: (async function* () { yield bytes })(), limit: 4096, fence: true })).rejects.toMatchObject({ status: 409 })
      const realMove = client.resourceMove.bind(client)
      const race = vi.spyOn(client, 'resourceMove').mockImplementationOnce(async params => {
        await ssh('printf competitor > ' + quotePosix(workspace.cwd + '/raced.txt'))
        return realMove(params)
      })
      await expect(workspace.fs.upload({ dir: workspace.cwd, relativePath: 'raced.txt', chunks: (async function* () { yield 'candidate' })(), limit: 4096, fence: true })).rejects.toMatchObject({ status: 409 })
      race.mockRestore()
      expect(await ssh('cat -- ' + quotePosix(workspace.cwd + '/raced.txt'))).toBe('competitor')
      await workspace.fs.rename('seed.txt', 'renamed.txt', true)
      expect((await workspace.fs.list(workspace.cwd, 200, true)).entries.map(row => row.name)).toEqual(expect.arrayContaining(['renamed.txt', 'binary.dat']))
      expect(await workspace.fs.search('renamed')).toEqual({ matches: ['renamed.txt'], truncated: false })
      await ssh(`printf 'outside\n' > ${quotePosix(root + '/outside.txt')}; ln -s -- ${quotePosix(root + '/outside.txt')} ${quotePosix(workspace.cwd + '/link.txt')}`)
      expect((await workspace.fs.list(workspace.cwd, 200, true)).entries.find(row => row.name === 'link.txt')).toMatchObject({ isSymlink: true, isDir: false })
      await expect(workspace.fs.read('link.txt', 4096, true)).rejects.toMatchObject({ status: 403 })
      await workspace.fs.rename('link.txt', 'moved-link.txt', true)
      await workspace.fs.remove('moved-link.txt', true)
      expect(await ssh('cat -- ' + quotePosix(root + '/outside.txt'))).toBe('outside')
      await workspace.git.run(workspace.cwd, ['init'], 30_000)
      await workspace.git.run(workspace.cwd, ['add', '--', 'renamed.txt'], 30_000)
      const status = await workspace.git.run(workspace.cwd, ['status', '--porcelain=v1', '-z'], 30_000)
      expect(status).toContain('A  renamed.txt\0')
      await workspace.git.run(workspace.cwd, ['-c', 'user.name=Private Smoke', '-c', 'user.email=private@example.invalid', 'commit', '-m', 'private fixture'], 30_000)
      expect(await workspace.git.run(workspace.cwd, ['log', '-1', '--format=%s'], 30_000)).toBe('private fixture\n')
      terminal = await workspace.createTerminal({ cwd: workspace.cwd, cols: 80, rows: 24 })
      let output = ''
      const marker = '__DSH_PRIVATE_TERMINAL_READY__'
      const ready = Promise.withResolvers<void>()
      const reading = (async () => {
        const decoder = new TextDecoder()
        for await (const part of terminal!.output) {
          output += decoder.decode(part, { stream: true })
          if (output.includes(marker + workspace.cwd)) ready.resolve()
        }
        output += decoder.decode()
      })()
      void reading.catch(ready.reject)
      await terminal.write(`printf '${marker}%s\\n' "$PWD"\r`)
      await ready.promise
      await terminal.resize(100, 30)
      await terminal.write('exit 0\r')
      await terminal.done
      await terminal.quiescent
      await reading
      expect(output).toContain(marker + workspace.cwd)
      expect(await ssh(`test -z "$(find ${quotePosix(workspace.cwd)} -maxdepth 1 -name '.dsh-sidebar-*' -print)" && stat -c %a ${quotePosix(root)}`)).toBe('700')
      expect(verifiedPrivateDirectories).toBeGreaterThanOrEqual(3)
      console.log('LIVE_SIDEBAR_ROOT', root, 'file/Git/terminal checks complete; private publication directories verified:', verifiedPrivateDirectories)
    } catch (error) { failure = error } finally {
      const stopped = await Promise.allSettled([...(terminal ? [terminal.terminate()] : []), ctx.fiber.dispose(), runtimeCtx.fiber.dispose()])
      const unknown = stopped.find(result => result.status === 'rejected')
      if (unknown?.status === 'rejected') {
        console.error('LIVE_SIDEBAR_RETAINED_PRIVATE_ROOT', root)
        failure ??= unknown.reason
      } else {
        // The server allocated this exact checked path for this case; no business directory is accepted.
        await ssh('rm -rf -- ' + quotePosix(checkedPrivateRoot(root)))
      }
      // mkdtemp returned this local fixture's exact owned directory.
      await rm(local, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
    if (failure !== undefined) throw failure
  }, 180_000)
})
