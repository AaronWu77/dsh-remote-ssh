import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { resolveLocalPwsh } from '../src/local-shell.ts'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
const env = { ProgramFiles: 'C:/Program Files', SystemRoot: 'C:/Windows', PATH: 'D:/PS7' }
const normalized = (value: string) => value.replaceAll(String.fromCharCode(92), '/')

describe('native PowerShell executable selection', () => {
  it('preserves an explicitly configured executable', () => {
    expect(resolveLocalPwsh('D:/custom/pwsh.exe', env, 'win32')).toBe('D:/custom/pwsh.exe')
  })
  it('prefers a standard PowerShell 7 installation', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    expect(normalized(resolveLocalPwsh(undefined, env, 'win32'))).toBe('C:/Program Files/PowerShell/7/pwsh.exe')
  })
  it('uses a PowerShell executable in PATH before Windows PowerShell', () => {
    vi.mocked(existsSync).mockImplementation(path => normalized(String(path)) === 'D:/PS7/pwsh.exe')
    expect(normalized(resolveLocalPwsh(undefined, env, 'win32'))).toBe('D:/PS7/pwsh.exe')
  })
  it('uses Windows PowerShell when PowerShell 7 is absent and the override is cleared', () => {
    vi.mocked(existsSync).mockImplementation(path => normalized(String(path)).endsWith('/powershell.exe'))
    expect(normalized(resolveLocalPwsh('', env, 'win32'))).toBe('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
  })
  it('leaves non-Windows executable lookup to PATH', () => {
    expect(resolveLocalPwsh(undefined, {}, 'linux')).toBe('pwsh')
  })
})
