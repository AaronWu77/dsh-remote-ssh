/** Artifact-plane smoke: build before this test. Shared identities come from the browser module table. */
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'
it('loads the packed shared-module factory and its CSS without relative browser imports', async () => {
  const code = await readFile(join(process.env.DSH_REMOTE_SSH_TEST_LIB ?? 'lib', 'client.js'), 'utf8')
  expect(code).not.toMatch(/^import /m)
  const requests: string[] = []
  const modules: Record<string, object> = { react: React, 'react/jsx-runtime': jsx, '@deepseek-ai/dsh-client-ui-primitives': {} }
  let factory: ((require: (id: string) => object) => Record<string, unknown>) | undefined
  const window = { __ModuleLoader__: { load: (row: { id: string; factory: typeof factory }) => { expect(row.id).toBe('dsh-remote-ssh'); factory = row.factory } } }
  const styles: {dataset:Record<string,string>;textContent:string}[] = []
  // Only stylesheet publication runs here; UI interactions have their own DOM tests.
  const document = {
    querySelector: () => styles[0] ?? null,
    createElement: (name:string) => { expect(name).toBe('style'); return {dataset:{},textContent:''} },
    head: {appendChild: (style:typeof styles[number]) => styles.push(style)},
  }
  runInNewContext(code,{window,document})
  const require = (id: string) => { requests.push(id); const module = modules[id]; if (!module) throw new Error('Unseeded browser request: ' + id); return module }
  expect(factory).toBeTypeOf('function')
  expect(factory!(require).apply).toBeTypeOf('function')
  expect(factory!(require).apply).toBeTypeOf('function')
  expect(new Set(requests)).toEqual(new Set(Object.keys(modules)))
  expect(styles).toHaveLength(1)
  expect(styles[0]!.dataset).toEqual({plugin:'dsh-remote-ssh',pluginCss:'dsh-remote-ssh/style.css'})
  expect(styles[0]!.textContent).toContain('--dsw-alias-label-primary')
  expect(styles[0]!.textContent).toContain('100vw')
})
