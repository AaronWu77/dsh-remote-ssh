import { describe, expect, it } from 'vitest'
import { emptyCatalog, parseCatalogState, parseDirectoryListing } from '../src/client/api.ts'

describe('Remote SSH client wire validation', () => {
  it('accepts the host catalog payload', () => {
    const catalog = {
      ...emptyCatalog,
      servers: [{ id: 'dev', label: 'Devbox', sshTarget: 'devbox', source: 'ssh-config' as const, port: 22 }],
      workspaces: [{ id: 'project', serverId: 'dev', remotePath: '/srv/project', aliasPath: 'D:/aliases/project' }],
      serverCount: 1,
      discoveredServerCount: 1,
      workspaceCount: 1,
    }
    expect(parseCatalogState(catalog)).toEqual(catalog)
  })

  it('carries the workspace title the catalog supplies', () => {
    const workspace = { id: 'project', serverId: 'dev', remotePath: '/srv/project', aliasPath: 'D:/aliases/project', title: '后端项目' }
    expect(parseCatalogState({ ...emptyCatalog, workspaces: [workspace] }).workspaces).toEqual([workspace])
    expect(parseCatalogState({ ...emptyCatalog, workspaces: [{ ...workspace, title: '' }] }).workspaces[0]).not.toHaveProperty('title')
  })

  it('rejects a catalog whose entries are incomplete', () => {
    expect(() => parseCatalogState(null)).toThrow('malformed')
    expect(() => parseCatalogState({ ...emptyCatalog, servers: [{ id: 'dev', label: 'Devbox', sshTarget: 'devbox' }] })).toThrow('malformed')
    expect(() => parseCatalogState({ ...emptyCatalog, workspaces: [{ id: 'project', serverId: 'dev', remotePath: '/srv' }] })).toThrow('malformed')
    expect(() => parseCatalogState({ ...emptyCatalog, openFileMode: 'nonsense' })).toThrow('malformed')
  })

  it('validates directory listings before the picker renders them', () => {
    expect(parseDirectoryListing({ path: '/srv', home: '/home/dev', entries: [{ name: 'project', path: '/srv/project' }] }))
      .toEqual({ path: '/srv', home: '/home/dev', entries: [{ name: 'project', path: '/srv/project' }] })
    expect(parseDirectoryListing({ path: '/srv', home: '/home/dev', parent: '/', entries: [] }).parent).toBe('/')
    expect(() => parseDirectoryListing({ path: '/srv', home: '/home/dev', entries: [{ name: 'project' }] })).toThrow('malformed')
    expect(() => parseDirectoryListing({ path: '/srv', entries: [] })).toThrow('malformed')
  })
})
