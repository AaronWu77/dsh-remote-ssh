import { describe, expect, it } from 'vitest'
import { parsePreferences, parseDiagnosticId, parseDiagnosticReport, diagnosticSucceeded } from '../src/client/management-api.ts'
import { absoluteHostPath } from '../src/client/use-preferences.ts'
const id = '5a168fc1-14fe-4f87-8a31-c78b0e0be341'
const preferences = { revision: '1', sshConfigFile: '', openFileMode: 'auto', openFileEditorPath: '', platform: 'win32', activeExecutions: 0, connectionCount: 0, applicationState: 'applied' }
describe('management response validation', () => {
  it('does not manufacture writable defaults from incomplete settings', () => {
    expect(() => parsePreferences({})).toThrow('Invalid management response')
    expect(() => parsePreferences({ ...preferences, activeExecutions: -1 })).toThrow()
    expect(parsePreferences(preferences)).toEqual(preferences)
  })
  it('validates client-allocated diagnostic identifiers', () => {
    expect(parseDiagnosticId(id)).toBe(id)
    expect(() => parseDiagnosticId('../../anything')).toThrow()
  })
  it('exports only report fields and recognized prerequisite facts', () => {
    const report = parseDiagnosticReport({ id, revision: 'r1', mode: 'deep', terminal: false, status: 'succeeded', startedAt: 1, stages: [{ id: 'cleanup', status: 'succeeded', elapsedMs: 2, stdout: 'secret' }], rawLogs: 'secret', path: '/private', prerequisites: { bash: true, secret_token: true } })
    expect(JSON.stringify(report)).not.toMatch(/secret|private|stdout|rawLogs/)
    expect(report.prerequisites).toEqual({ bash: true })
    expect(diagnosticSucceeded(report)).toBe(true)
    expect(diagnosticSucceeded({ ...report, stages: [{ id: 'cleanup', status: 'failed', elapsedMs: 2 }] })).toBe(false)
    expect(diagnosticSucceeded({ ...report, stages: [] })).toBe(false)
  })
  it('rejects duplicate stages and credential-like protocol facts', () => {
    const report = { id, revision: 'r1', mode: 'basic', terminal: false, status: 'running', startedAt: 1, stages: [{ id: 'ssh', status: 'running', elapsedMs: 0 }] }
    expect(() => parseDiagnosticReport({ ...report, stages: [...report.stages, ...report.stages] })).toThrow()
    expect(() => parseDiagnosticReport({ ...report, protocolVersion: 'token=secret' })).toThrow()
  })
  it('validates absolute paths against the host platform including UNC', () => {
    expect(absoluteHostPath('C:/Users/test/config', 'win32')).toBe(true)
    expect(absoluteHostPath('//server/share/config', 'win32')).toBe(true)
    expect(absoluteHostPath('C:relative', 'win32')).toBe(false)
    expect(absoluteHostPath('/home/test/config', 'linux')).toBe(true)
    expect(absoluteHostPath('~/config', 'linux')).toBe(false)
  })
})
