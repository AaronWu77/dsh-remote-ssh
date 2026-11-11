// Shared test double for the settings service: publish a new volatile config the way the
// Loader does — commit into the reference the plugin actually received, then announce it.

import type { Fiber } from '@deepseek-ai/cordis'
import { createVolatile, isVolatile, updateVolatile, volatileEntries, type Volatile } from '@deepseek-ai/cosmokit'

/**
 * Commit one whole config object into the owning fiber's live volatile reference.
 * The Loader derives the reference from `fiber.effectiveConfig`; the raw `fiber.config`
 * input holds plain data, so a double that writes it has no reference to update.
 * @param owner - fiber whose plugin received the volatile config reference.
 * @param next - complete replacement config object.
 * @returns the event paths a real Loader announces for this commit.
 */
export function commitVolatileConfig(owner: Fiber, next: Record<string, unknown>): readonly (readonly string[])[] {
  const candidate = createVolatile(structuredClone(next)) as Volatile<unknown>
  const effective: unknown = owner.effectiveConfig
  if (isVolatile(effective)) {
    updateVolatile(effective, candidate)
    return [[]]
  }
  // Nested reference (the usual case): commit each volatile field the schema kept.
  return volatileEntries(effective).map(({ path, ref }) => {
    const source = path.reduce((value: unknown, key) => (value as Record<string, unknown>)[key], candidate) as Volatile<unknown>
    updateVolatile(ref, source)
    return path
  })
}
