/** Agent Host candidate failures exposed without transport credentials. */

/** SSH could not execute a startup/discovery operation; this is not evidence of a missing installation. */
export class SshExecutionError extends Error {
  readonly code = 'ssh_execution_failed'
  constructor(readonly stage: string, readonly exitCode: number | null, diagnostics: readonly string[]) {
    super(formatConnectionDiagnostic('dsh-remote-ssh: SSH execution failed at ' + stage + ' (ssh exit ' + (exitCode ?? 'unknown') + ')\n' + diagnostics.join('\n'), 16_384))
    this.name = 'SshExecutionError'
  }
}

/**
 * An exhausted candidate list; diagnostics retain each attempted entry.
 * @param versions - Protocol versions offered by the client.
 * @param diagnostics - Ordered candidate failures.
 */
export class AgentHostConnectionError extends Error {
  readonly code = 'agent_host_unavailable'
  constructor(readonly versions: readonly string[], readonly diagnostics: readonly string[]) {
    super(formatConnectionDiagnostic('dsh-remote-ssh: no compatible VS Code Agent Host found. Client protocols: [' + versions.join(', ') + ']\n' + diagnostics.join('\n'), 16_384))
    this.name = 'AgentHostConnectionError'
  }
}

/**
 * Limit a redacted diagnostic to its configured character budget.
 * @param message - Startup or transport failure text.
 * @param maxCharacters - Validated positive integer budget.
 * @returns A redacted diagnostic retaining both ends when the budget allows.
 */
export function formatConnectionDiagnostic(message: string, maxCharacters: number): string {
  const redacted = redactConnectionCredentials(message)
  if (redacted.length <= maxCharacters) return redacted
  const separator = '\n…\n'
  if (maxCharacters <= separator.length) return redacted.slice(0, maxCharacters)
  const available = maxCharacters - separator.length
  const head = Math.ceil(available / 2)
  const tail = available - head
  return redacted.slice(0, head) + separator + (tail === 0 ? '' : redacted.slice(-tail))
}

/**
 * Remove bearer-like URL parameters and CLI connection tokens from diagnostics.
 * @param message - Raw transport or startup diagnostic.
 * @returns Text safe for the same-origin diagnostic response.
 */
export function redactConnectionCredentials(message: string): string {
  return message.replace(/([?&](?:tkn|token|connectionToken|connection-token)=)[^\s&#]+/gi, '$1[redacted]')
    .replace(/(--connection-token(?:=|\s+))[^\s]+/gi, '$1[redacted]')
}
