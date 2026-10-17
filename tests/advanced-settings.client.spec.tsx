// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteManagement } from '../src/client/RemoteManagement.tsx'
import { loadPreferences, savePreferences } from '../src/client/management-api.ts'
import { RemoteSshRequestError } from '../src/client/api.ts'
import type { PreferencesState } from '../src/management-types.ts'
import type { Translate } from '../src/client/types.ts'
import { en, zh } from '../src/client/locales.ts'
vi.mock('../src/client/management-api.ts', async original => ({ ...await original<typeof import('../src/client/management-api.ts')>(), loadPreferences: vi.fn(), savePreferences: vi.fn() }))
const base: PreferencesState = { revision: 'r1', sshConfigFile: '', openFileMode: 'auto', openFileEditorPath: '', platform: 'win32', activeExecutions: 0, connectionCount: 0, applicationState: 'applied' }
const t: Translate = key => en[key]
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function setup(translate = t) { const onApplied = vi.fn(); const onBusyChange = vi.fn(); return { ...render(<RemoteManagement t={translate} servers={[]} busy={false} onApplied={onApplied} onBusyChange={onBusyChange} />), onApplied, onBusyChange } }
async function openSettings(container: HTMLElement) { const detail = container.querySelector('details')!; await act(async () => { detail.open = true; fireEvent(detail, new Event('toggle')) }); await waitFor(() => expect(loadPreferences).toHaveBeenCalled()); }
const save = () => screen.getByRole('button', { name: en.save })
const change = (value: string) => fireEvent.change(screen.getByLabelText(en.sshConfigLabel), { target: { value } })
beforeEach(() => { vi.mocked(loadPreferences).mockResolvedValue({ ...base }); vi.mocked(savePreferences).mockResolvedValue({ ...base, revision: 'r2' }) })
afterEach(() => { cleanup(); vi.resetAllMocks() })
describe('advanced settings safety', () => {
  it('loads only on expansion and renders localized settings snapshots', async () => {
    const view = setup()
    expect(loadPreferences).not.toHaveBeenCalled()
    await openSettings(view.container)
    await screen.findByLabelText(en.sshConfigLabel)
    expect(view.container.textContent).toMatchSnapshot('english advanced settings')
    view.unmount()
    const chinese = setup(key => zh[key]); await openSettings(chinese.container); await screen.findByLabelText(zh.sshConfigLabel)
    expect(chinese.container.textContent).toMatchSnapshot('chinese advanced settings')
  })
  it('does not enable an empty default form when loading fails', async () => {
    vi.mocked(loadPreferences).mockRejectedValueOnce(new Error('network'))
    const view = setup(); await openSettings(view.container)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toBe(en.preferencesLoadFailed)
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.preferencesReload }))
    await screen.findByLabelText(en.sshConfigLabel)
    expect(save().hasAttribute('disabled')).toBe(true)
  })
  it('locks synchronous duplicate saves, sends a revision, and reads back the authoritative state', async () => {
    const pending = deferred<PreferencesState>()
    vi.mocked(savePreferences).mockReturnValue(pending.promise)
    const view = setup(); await openSettings(view.container); await screen.findByLabelText(en.sshConfigLabel)
    change('C:/new/config')
    const submit = save(); fireEvent.click(submit); fireEvent.click(submit)
    expect(savePreferences).toHaveBeenCalledTimes(1)
    expect(savePreferences).toHaveBeenCalledWith({ expectedRevision: 'r1', sshConfigFile: 'C:/new/config', openFileMode: 'auto', openFileEditorPath: '', confirmConnectionReset: false }, expect.any(AbortSignal))
    vi.mocked(loadPreferences).mockResolvedValue({ ...base, revision: 'r2', sshConfigFile: 'C:/new/config' })
    await act(async () => { pending.resolve({ ...base, revision: 'r2', sshConfigFile: 'C:/new/config' }); await pending.promise })
    await waitFor(() => expect(view.onApplied).toHaveBeenCalledOnce())
    expect(screen.getByRole('status').textContent).toBe(en.preferencesSaved)
    expect(save().hasAttribute('disabled')).toBe(true)
  })
  it('keeps defaults in the draft and discard restores saved configuration', async () => {
    vi.mocked(loadPreferences).mockResolvedValue({ ...base, sshConfigFile: 'C:/existing/config', openFileMode: 'cursor' })
    const view = setup(); await openSettings(view.container); await screen.findByLabelText(en.sshConfigLabel)
    fireEvent.click(screen.getByRole('button', { name: en.restoreDefaults }))
    expect((screen.getByLabelText(en.sshConfigLabel) as HTMLInputElement).value).toBe('')
    expect(savePreferences).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    expect((screen.getByLabelText(en.sshConfigLabel) as HTMLInputElement).value).toBe('C:/existing/config')
    expect(save().hasAttribute('disabled')).toBe(true)
  })
  it('requires confirmation for connection resets and blocks only SSH edits during active executions', async () => {
    vi.mocked(loadPreferences).mockResolvedValue({ ...base, connectionCount: 2 })
    const view = setup(); await openSettings(view.container); await screen.findByLabelText(en.sshConfigLabel)
    change('C:/new/config'); expect(save().hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en.confirmConnectionReset })); expect(save().hasAttribute('disabled')).toBe(false)
    vi.mocked(loadPreferences).mockResolvedValue({ ...base, activeExecutions: 1, connectionCount: 2 })
    fireEvent.click(screen.getByRole('button', { name: en.preferencesReload }))
    await waitFor(() => expect((screen.getByLabelText(en.sshConfigLabel) as HTMLInputElement).value).toBe(''))
    change('C:/new/config'); expect(save().hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe(en.preferencesBusy)
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    fireEvent.change(screen.getByLabelText(en.openFileLabel), { target: { value: 'cursor' } })
    expect(save().hasAttribute('disabled')).toBe(false)
  })
  it('preserves draft on conflict and requires reload before another save', async () => {
    vi.mocked(savePreferences).mockRejectedValue(new RemoteSshRequestError('conflict', 'settings_conflict', 409))
    const view = setup(); await openSettings(view.container); await screen.findByLabelText(en.sshConfigLabel)
    change('C:/new/config'); fireEvent.click(save())
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(en.preferencesConflict))
    expect((screen.getByLabelText(en.sshConfigLabel) as HTMLInputElement).value).toBe('C:/new/config')
    expect(save().hasAttribute('disabled')).toBe(true)
  })
  it('cancels only waiting, ignores the late save response, and rereads before more writes', async () => {
    const pending = deferred<PreferencesState>(); vi.mocked(savePreferences).mockReturnValue(pending.promise)
    const view = setup(); await openSettings(view.container); await screen.findByLabelText(en.sshConfigLabel)
    change('C:/new/config'); fireEvent.click(save()); fireEvent.click(screen.getByRole('button', { name: en.cancelSaveWait }))
    expect(screen.getByRole('alert').textContent).toBe(en.preferencesUnknown)
    expect(save().hasAttribute('disabled')).toBe(true)
    await act(async () => { pending.resolve({ ...base, revision: 'r2', sshConfigFile: 'C:/new/config' }); await pending.promise })
    expect(view.onApplied).not.toHaveBeenCalled()
    expect(vi.mocked(loadPreferences)).toHaveBeenCalledTimes(1)
    vi.mocked(loadPreferences).mockResolvedValue({ ...base, revision: 'r2', sshConfigFile: 'C:/new/config' })
    fireEvent.click(screen.getByRole('button', { name: en.preferencesReload }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(savePreferences).toHaveBeenCalledTimes(1)
  })
  it('does not apply late load data after unmount and rejects unsafe paths', async () => {
    const pending = deferred<PreferencesState>(); vi.mocked(loadPreferences).mockReturnValueOnce(pending.promise)
    const first = setup(); await openSettings(first.container); const signal = vi.mocked(loadPreferences).mock.calls[0]![0]!
    first.unmount(); expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(base); await pending.promise })
    const second = setup(); await openSettings(second.container); await screen.findByLabelText(en.sshConfigLabel)
    change('relative/config'); expect(save().hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('alert').textContent).toBe(en.absolutePathRequired)
  })
  it('keeps a settings draft from launching diagnostics', async () => {
    const view = setup(); await openSettings(view.container); await screen.findByLabelText(en.sshConfigLabel)
    change('C:/draft/config')
    const diagnostics = view.container.querySelectorAll('details')[1]!
    await act(async () => { diagnostics.open = true; fireEvent(diagnostics, new Event('toggle')) })
    expect(screen.getByText(en.unsavedPreferences)).toBeDefined()
    expect(screen.getByRole('button', { name: en.diagnosticStart }).hasAttribute('disabled')).toBe(true)
    expect(savePreferences).not.toHaveBeenCalled()
  })
  it('does not label another tab’s read-back as its own verified save', async () => {
    vi.mocked(savePreferences).mockResolvedValue({ ...base, revision: 'r2', sshConfigFile: 'C:/mine/config' })
    const view = setup(); await openSettings(view.container); await screen.findByLabelText(en.sshConfigLabel)
    vi.mocked(loadPreferences).mockResolvedValue({ ...base, revision: 'r3', sshConfigFile: 'C:/other/config' })
    change('C:/mine/config'); fireEvent.click(save())
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(en.preferencesConflict))
    expect((screen.getByLabelText(en.sshConfigLabel) as HTMLInputElement).value).toBe('C:/mine/config')
    expect(screen.queryByText(en.preferencesSaved)).toBeNull()
    expect(view.onApplied).not.toHaveBeenCalled()
  })
  it('does not report success when save read-back fails and never automatically resends', async () => {
    const view = setup(); await openSettings(view.container); await screen.findByLabelText(en.sshConfigLabel)
    vi.mocked(loadPreferences).mockRejectedValueOnce(new Error('read-back lost'))
    change('C:/new/config'); fireEvent.click(save())
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(en.preferencesUnverified))
    expect(view.onApplied).not.toHaveBeenCalled()
    expect(save().hasAttribute('disabled')).toBe(true)
    expect(savePreferences).toHaveBeenCalledTimes(1)
  })
  it('unmounts a pending save without read-back or applying its late response', async () => {
    const pending = deferred<PreferencesState>(); vi.mocked(savePreferences).mockReturnValue(pending.promise)
    const view = setup(); await openSettings(view.container); await screen.findByLabelText(en.sshConfigLabel)
    change('C:/new/config'); fireEvent.click(save()); const signal = vi.mocked(savePreferences).mock.calls[0]![1]!
    view.unmount(); expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve(base); await pending.promise })
    expect(loadPreferences).toHaveBeenCalledTimes(1)
    expect(view.onApplied).not.toHaveBeenCalled()
  })
  it('keeps mutations disabled while host application state remains unconfirmed', async () => {
    vi.mocked(loadPreferences).mockResolvedValue({ ...base, applicationState: 'unconfirmed' })
    const view = setup(); await openSettings(view.container); await screen.findByLabelText(en.sshConfigLabel)
    expect(screen.getByRole('alert').textContent).toBe(en.preferencesUnconfirmed)
    expect(save().hasAttribute('disabled')).toBe(true)
    expect(view.onBusyChange).toHaveBeenLastCalledWith(true)
  })
})
