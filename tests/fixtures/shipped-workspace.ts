/** Shipped Web workspace declaration and the plugin's own replacement patches. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'

export function shippedWorkspace(): EntryOptions {
  const patches = load(readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml')), 'utf8'), { schema: entryListSchema }) as PatchOptions[]
  const rows = applyEntryPatches([], patches.filter(patch => patch.insert !== undefined), (message, ...args) => {
    throw new Error(`shipped Web bundle patch did not apply: ${[message, ...args].join(' ')}`)
  })
  const matches = rows.filter(row => row.name === '@deepseek-ai/dsh-workspace')
  if (matches.length !== 1) throw new Error('Shipped Web workspace provider must be unique')
  return matches[0]!
}

export function workspaceReplacement(): PatchOptions[] {
  const patches = load(readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema }) as PatchOptions[]
  const replacements = patches.filter(patch => patch.name === '@deepseek-ai/dsh-workspace')
  const providers = patches.flatMap(patch => patch.insert ?? []).filter(row => row.name === 'dsh-remote-ssh/workspace-registry')
  if (replacements.length !== 1 || providers.length !== 1) throw new Error('Workspace replacement must disable one shipped provider and insert one adapter')
  return [...replacements, { insert: providers }]
}
