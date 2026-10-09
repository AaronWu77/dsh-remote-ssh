import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import TransparentFileSystem from '../src/router-fs.ts'

describe('host assets through the filesystem router', () => {
  it('maps a local PTC bootstrap through the local provider without opening SSH', async () => {
    const ctx = new Context()
    const asset = resolve('node_modules', 'ptc-runtime-node', 'lib', 'process.js')
    const mapping = vi.fn((path: string) => path === asset ? asset : undefined)
    const workspaceContext = vi.fn(() => { throw new Error('must not open SSH for a host asset') })
    ctx.provide('localFs', { processPathFromHostPath: mapping } as never)
    ctx.provide('remoteSshManager', { route: () => ({ kind: 'local' }), workspaceContext } as never)
    await ctx.plugin(TransparentFileSystem)
    try {
      expect(ctx.fs.processPathFromHostPath(asset)).toBe(asset)
      expect(ctx.fs.processPathFromHostPath('relative.js')).toBeUndefined()
      expect(mapping.mock.calls).toEqual([[asset], ['relative.js']])
      expect(workspaceContext).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses remote aliases instead of claiming the local placeholder is a process asset', async () => {
    const ctx = new Context()
    const alias = resolve('remote-workspace', 'process.js')
    const mapping = vi.fn((path: string) => path)
    ctx.provide('localFs', { processPathFromHostPath: mapping } as never)
    ctx.provide('remoteSshManager', { route: () => ({ kind: 'remote' }) } as never)
    await ctx.plugin(TransparentFileSystem)
    try {
      expect(ctx.fs.processPathFromHostPath(alias)).toBeUndefined()
      expect(mapping).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })
})
