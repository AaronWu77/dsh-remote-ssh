/** Safe diagnostic facts and independent resource cleanup status. */
import type { DiagnosticReport, DiagnosticStageId, DiagnosticStageStatus } from '../management-types.ts'
import type { RemoteSshLocaleKey } from './locales.ts'
import type { Translate } from './types.ts'
import { diagnosticRunning, diagnosticSucceeded } from './management-api.ts'
import css from './ui.module.css'
const stageKeys: Record<DiagnosticStageId, RemoteSshLocaleKey> = { config: 'stageConfig', ssh: 'stageSsh', agentHost: 'stageAgentHost', tunnel: 'stageTunnel', protocol: 'stageProtocol', directory: 'stageDirectory', terminal: 'stageTerminal', cleanup: 'stageCleanup' }
const statusKeys: Record<DiagnosticStageStatus, RemoteSshLocaleKey> = { pending: 'statusPending', running: 'statusRunning', succeeded: 'statusSucceeded', failed: 'statusFailed', skipped: 'statusSkipped', cancelled: 'statusCancelled' }
const codeKeys: Record<string, RemoteSshLocaleKey> = { configuration_valid: 'codeConfigurationValid', config_failed: 'preferencesInvalidPath', ssh_failed: 'codeSshFailed', prerequisites_missing: 'codePrerequisitesMissing', agent_host_failed: 'codeAgentHostFailed', tunnel_failed: 'codeTunnelFailed', protocol_failed: 'codeProtocolFailed', directory_failed: 'codeDirectoryFailed', terminal_failed: 'codeTerminalFailed', cleanup_failed: 'codeCleanupFailed', cancelled: 'statusCancelled', timeout: 'codeTimeout', diagnostic_failed: 'codeDiagnosticFailed' }
export function DiagnosticReportView({ report, revision, t }: { report: DiagnosticReport; revision: string | undefined; t: Translate }) {
  const cleanup = report.stages.find(stage => stage.id === 'cleanup')
  const summary: RemoteSshLocaleKey = diagnosticSucceeded(report) ? 'diagnosticSuccess' : report.status === 'failed' ? 'diagnosticFailure' : report.status === 'cancelled' ? 'diagnosticCancelled' : report.status === 'cancelling' ? 'diagnosticCancelPending' : report.status === 'succeeded' ? 'diagnosticCleanupUnconfirmed' : 'statusRunning'
  return <div className={css.stack} aria-label={t('diagnosticReport')}>
    <p role={summary === 'diagnosticCleanupUnconfirmed' ? 'alert' : 'status'} className={css.notice}>{t(summary)}</p>
    {revision !== undefined && report.revision !== revision ? <p role="note" className={css.notice}>{t('diagnosticOutdated')}</p> : null}
    {!diagnosticRunning(report) && cleanup?.status !== 'succeeded' && summary !== 'diagnosticCleanupUnconfirmed' ? <p role="alert" className={css.error}>{t('diagnosticCleanupUnconfirmed')}</p> : null}
    <ol className={css.stages}>
      {report.stages.map(stage => <li key={stage.id} className={css.stage}>
        <div className={css.row}><span className={css.recordTitle}>{t(stageKeys[stage.id])}</span><span className={stage.status === 'failed' ? css.error : css.detail}>{t(statusKeys[stage.status])}</span><span className={css.elapsed}>{t('diagnosticElapsed', { milliseconds: Math.round(stage.elapsedMs) })}</span></div>
        {stage.code ? <p className={css.detail}>{t(codeKeys[stage.code] ?? (stage.status === 'succeeded' ? 'statusSucceeded' : 'codeDiagnosticFailed'))}</p> : null}
      </li>)}
    </ol>
    {report.prerequisites ? <div className={css.row}>{Object.entries(report.prerequisites).map(([command, available]) =>
      <span key={command} className={css.detail}><code>{command}</code>: {t(available ? 'statusSucceeded' : 'statusFailed')}</span>)}</div> : null}
    {report.protocolVersion ? <p className={css.detail}>{t('diagnosticProtocol', { version: report.protocolVersion })}</p> : null}
    {report.directoryCount !== undefined ? <p className={css.detail}>{t('diagnosticDirectoryCount', { count: report.directoryCount })}</p> : null}
  </div>
}
