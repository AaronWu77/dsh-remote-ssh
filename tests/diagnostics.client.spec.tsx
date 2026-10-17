// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticReport, PreferencesState, DiagnosticStageStatus } from '../src/management-types.ts'
import { DiagnosticSection } from '../src/client/DiagnosticSection.tsx'
import { DiagnosticReportView } from '../src/client/DiagnosticReportView.tsx'
import { cancelDiagnostic, parseDiagnosticId, pollDiagnostic, releaseDiagnostic, startDiagnostic } from '../src/client/management-api.ts'
import { RemoteSshRequestError } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'
import type { Translate } from '../src/client/types.ts'
vi.mock('../src/client/management-api.ts', async original => ({ ...await original<typeof import('../src/client/management-api.ts')>(), startDiagnostic: vi.fn(), pollDiagnostic: vi.fn(), cancelDiagnostic: vi.fn(), releaseDiagnostic: vi.fn() }))
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const id = parseDiagnosticId('5a168fc1-14fe-4f87-8a31-c78b0e0be341')
const prefs: PreferencesState = { revision: 'r1', sshConfigFile: '', openFileMode: 'auto', openFileEditorPath: '', platform: 'win32', activeExecutions: 0, connectionCount: 0, applicationState: 'applied' }
const t: Translate = (key, params) => en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? name))
function report(status: DiagnosticReport['status'] = 'running', cleanupStatus: DiagnosticStageStatus = 'pending'): DiagnosticReport { return { id, revision: 'r1', mode: 'basic', terminal: false, status, startedAt: 1, stages: [{ id: 'config', status: 'succeeded', elapsedMs: 1, code: 'configuration_valid' }, { id: 'ssh', status: 'succeeded', elapsedMs: 2 }, { id: 'cleanup', status: cleanupStatus, elapsedMs: 3 }] } }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function setup(unsaved = false) { const onBusyChange = vi.fn(); return { ...render(<DiagnosticSection t={t} servers={[{ id: 'host', label: 'Dev server', sshTarget: 'example', source: 'saved' }]} preferences={prefs} blocked={false} unsaved={unsaved} onBusyChange={onBusyChange} />), onBusyChange } }
function select() { fireEvent.change(screen.getByLabelText(en.diagnosticTarget), { target: { value: 'host' } }) }
function start() { fireEvent.click(screen.getByRole('button', { name: en.diagnosticStart })) }
beforeEach(() => { vi.spyOn(crypto, 'randomUUID').mockReturnValue('5a168fc1-14fe-4f87-8a31-c78b0e0be341'); vi.mocked(startDiagnostic).mockResolvedValue(report()); vi.mocked(pollDiagnostic).mockResolvedValue(report('succeeded', 'succeeded')); vi.mocked(cancelDiagnostic).mockResolvedValue(report('cancelled', 'succeeded')) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard); else Reflect.deleteProperty(navigator, 'clipboard') })
describe('diagnostic lifecycle and report presentation', () => {
  it('requires saved settings and explicit deep-check consent, never sends an arbitrary command', async () => {
    const view = setup(true); select()
    expect(screen.getByRole('button', { name: en.diagnosticStart }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('note').textContent).toBe(en.unsavedPreferences)
    view.unmount(); setup(); select()
    fireEvent.click(screen.getByLabelText(en.diagnosticDeep))
    fireEvent.click(screen.getByRole('checkbox', { name: en.diagnosticTerminal }))
    expect(screen.getByRole('button', { name: en.diagnosticStart }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en.diagnosticConfirm }))
    fireEvent.change(screen.getByLabelText(en.diagnosticPath), { target: { value: 'relative/path' } })
    expect(screen.getByRole('button', { name: en.diagnosticStart }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText(en.diagnosticPath), { target: { value: '/srv/project' } })
    await act(async () => { start() })
    expect(startDiagnostic).toHaveBeenCalledExactlyOnceWith({ id, expectedRevision: 'r1', serverId: 'host', mode: 'deep', terminal: true, confirmDeep: true, path: '/srv/project' }, expect.any(AbortSignal))
  })
  it('shares no overlapping start and renews its lease only on bounded polling intervals', async () => {
    vi.useFakeTimers(); const pending = deferred<DiagnosticReport>(); vi.mocked(startDiagnostic).mockReturnValue(pending.promise)
    setup(); select(); start(); start(); expect(startDiagnostic).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(report()); await pending.promise })
    expect(pollDiagnostic).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(999) }); expect(pollDiagnostic).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) }); expect(pollDiagnostic).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal))
    expect(screen.getByText(en.diagnosticSuccess)).toBeDefined()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); expect(pollDiagnostic).toHaveBeenCalledTimes(1)
  })
  it('cancels an allocated id even when the start response has not arrived', async () => {
    const pending = deferred<DiagnosticReport>(); vi.mocked(startDiagnostic).mockReturnValue(pending.promise); vi.mocked(cancelDiagnostic).mockResolvedValue(undefined)
    setup(); select(); start()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.diagnosticStop })) })
    expect(cancelDiagnostic).toHaveBeenCalledWith(id)
    expect(screen.queryByRole('button', { name: en.diagnosticStop })).toBeNull()
    expect(vi.mocked(startDiagnostic).mock.calls[0]![1]!.aborted).toBe(true)
    await act(async () => { pending.resolve(report()); await pending.promise })
    expect(cancelDiagnostic).toHaveBeenCalledTimes(1)
    expect(releaseDiagnostic).toHaveBeenCalledWith(id)
    expect(screen.getByText(en.diagnosticCancelled)).toBeDefined()
    expect(screen.queryByText(en.diagnosticSuccess)).toBeNull()
  })
  it('unmount aborts start and sends best-effort cancellation for the preallocated id', async () => {
    const pending = deferred<DiagnosticReport>(); vi.mocked(startDiagnostic).mockReturnValue(pending.promise)
    const view = setup(); select(); start(); const signal = vi.mocked(startDiagnostic).mock.calls[0]![1]!
    view.unmount(); expect(signal.aborted).toBe(true); expect(releaseDiagnostic).toHaveBeenCalledWith(id)
    await act(async () => { pending.resolve(report()); await pending.promise })
    expect(pollDiagnostic).not.toHaveBeenCalled()
  })
  it.each([404, 429, 409])('shows localized management failures without raw logs (HTTP %s)', async status => {
    vi.mocked(startDiagnostic).mockRejectedValue(new RemoteSshRequestError('secret stdout token', undefined, status))
    const view = setup(); select(); await act(async () => { start() })
    expect(screen.getByRole('alert').textContent).toBe(en[status === 404 ? 'diagnosticExpired' : status === 429 ? 'diagnosticCapacity' : 'diagnosticConflict'])
    expect(view.container.textContent).not.toContain('secret')
    expect(releaseDiagnostic).toHaveBeenCalledWith(id)
  })
  it('handles expired polling and stops further lease requests', async () => {
    vi.useFakeTimers(); vi.mocked(pollDiagnostic).mockRejectedValue(new RemoteSshRequestError('expired', undefined, 404))
    setup(); select(); await act(async () => { start() }); await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByRole('alert').textContent).toBe(en.diagnosticExpired)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); expect(pollDiagnostic).toHaveBeenCalledTimes(1)
  })
  it('keeps cleanup failure independent and marks reports from old settings', () => {
    const failed = report('succeeded', 'failed')
    const view = render(<DiagnosticReportView report={failed} revision="r2" t={t} />)
    expect(screen.queryByText(en.diagnosticSuccess)).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(en.diagnosticCleanupUnconfirmed)
    expect(screen.getByRole('note').textContent).toBe(en.diagnosticOutdated)
    expect(view.container.textContent).toMatchSnapshot('cleanup failed report')
    view.rerender(<DiagnosticReportView report={report('cancelled', 'succeeded')} revision="r1" t={(key, params) => zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? name))} />)
    expect(view.container.textContent).toMatchSnapshot('cancelled chinese report')
  })
  it('copies only the validated export report on explicit clipboard action', async () => {
    const writeText = vi.fn(async (_value: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.mocked(startDiagnostic).mockResolvedValue(report('succeeded', 'succeeded'))
    setup(); select(); await act(async () => { start() })
    expect(writeText).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.diagnosticCopy })) })
    const exported = JSON.parse(writeText.mock.calls[0]![0] as string)
    expect(exported).toEqual(report('succeeded', 'succeeded'))
    expect(JSON.stringify(exported)).not.toContain('Dev server')
  })
})
