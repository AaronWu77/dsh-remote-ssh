import { describe, expect, it } from 'vitest'
import { resolveRemoteOpenWorkspace } from '../src/client/open-route.ts'

const remote = { id: 'dev', serverId: 'server', remotePath: '/srv/dev', aliasPath: 'D:/aliases/dev' }
const file = '/wsl.localhost/Ubuntu-22.04/home/aaronwu/SuperPlus/README.md'

describe('Windows host paths are not SSH POSIX paths', () => {
  it.each([file, '/' + file, "\\\\wsl.localhost\\Ubuntu-22.04\\home\\aaronwu\\SuperPlus\\README.md", '//server/share/file.md', 'C:/outside/file.md'])('does not route %s into the current SSH world', path => {
    expect(resolveRemoteOpenWorkspace([remote], path, remote.aliasPath)).toBeUndefined()
  })

  it('keeps a Linux path with that directory name in its POSIX Session', () => {
    const posix = { ...remote, aliasPath: '/aliases/dev' }
    expect(resolveRemoteOpenWorkspace([posix], file, posix.aliasPath)).toBe(posix)
  })

  it('preserves an explicitly mapped Windows alias and ordinary remote paths', () => {
    expect(resolveRemoteOpenWorkspace([remote], 'D:/aliases/dev/README.md', remote.aliasPath)).toBe(remote)
    expect(resolveRemoteOpenWorkspace([remote], '/srv/dev/README.md', remote.aliasPath)).toBe(remote)
    expect(resolveRemoteOpenWorkspace([remote], 'README.md', remote.aliasPath)).toBe(remote)
  })
})
