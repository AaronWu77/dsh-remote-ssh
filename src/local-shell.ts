/** Native PowerShell discovery for the transparent local provider. */
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * Resolve the configured path or a native Windows installation.
 * @param configured - Explicit executable, including the stock pwshPath setting.
 * @param env - Local environment used for installation and PATH locations.
 * @param platform - Local subprocess platform.
 * @returns A native executable path, or pwsh for PATH resolution.
 */
export function resolveLocalPwsh(configured?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (configured !== undefined && configured.length > 0) return configured
  if (platform !== 'win32') return 'pwsh'
  const candidates = [
    win32.join(env.ProgramFiles ?? 'C:/Program Files', 'PowerShell', '7', 'pwsh.exe'),
    ...(env.PATH ?? '').split(win32.delimiter).filter(Boolean).map(path => win32.join(path.trim().replace(/^"|"$/g, ''), 'pwsh.exe')),
    win32.join(env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  return candidates.find(path => existsSync(path)) ?? 'pwsh'
}
