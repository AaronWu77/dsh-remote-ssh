import { describe, expect, it } from 'vitest'
import { AgentHostConnectionError, formatConnectionDiagnostic, redactConnectionCredentials } from '../src/connection-error.ts'
import { ConnectionErrorNotice } from '../src/client/ConnectionErrorNotice.tsx'
import { RemoteSshRequestError } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'
import { renderToStaticMarkup } from 'react-dom/server'

describe('connection diagnostic presentation', () => {
  it('preserves first and final candidate failures', () => {
    const failures = ['standalone: code missing', 'embedded: ' + 'x'.repeat(1200), 'last: accepts ^0.9.0']
    const error = new AgentHostConnectionError(['0.9.0'], failures)
    expect(error.code).toBe('agent_host_unavailable')
    expect(error.message).toContain('standalone: code missing')
    expect(error.message).toContain('last: accepts ^0.9.0')
  })
  it('honors small and large configured diagnostic budgets', () => {
    const message = 'first-candidate ' + 'x'.repeat(2000) + ' final-candidate'
    for (const budget of [1, 2, 3, 4, 100, 1000]) expect(formatConnectionDiagnostic(message, budget).length).toBeLessThanOrEqual(budget)
    const full = formatConnectionDiagnostic(message, 100)
    expect(full).toContain('first-candidate')
    expect(full).toContain('final-candidate')
  })
  it('redacts query and command connection tokens', () => {
    expect(redactConnectionCredentials('ws://localhost/?tkn=secret-token&x=1 --connection-token secret-cli')).toBe('ws://localhost/?tkn=[redacted]&x=1 --connection-token [redacted]')
  })
  it('distinguishes SSH execution failures with locale-owned details, not authentication guesses', () => {
    const error = new RemoteSshRequestError('standalone CLI (ssh exit 255): no output <unsafe>', 'ssh_execution_failed')
    for (const dictionary of [en, zh]) {
      const markup = renderToStaticMarkup(ConnectionErrorNotice({ error, t: key => dictionary[key] }))
      expect(markup).toContain(dictionary.sshExecutionFailed)
      expect(markup).not.toContain(dictionary.agentHostUnavailable)
      expect(markup).toContain('ssh exit 255')
      expect(markup).toContain('&lt;unsafe&gt;')
    }
  })
  it('renders locale-owned summaries and escaped expandable diagnostics', () => {
    const error = new RemoteSshRequestError('Agent Host accepts [^0.9.0] <script>token</script>', 'agent_host_unavailable')
    for (const dictionary of [en, zh]) {
      const markup = renderToStaticMarkup(ConnectionErrorNotice({ error, t: key => dictionary[key] }))
      expect(markup).toContain(dictionary.agentHostUnavailable)
      expect(markup).toContain('<details>')
      expect(markup).toContain('&lt;script&gt;')
      expect(markup).toMatchSnapshot()
    }
  })
})
