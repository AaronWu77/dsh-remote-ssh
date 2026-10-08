import { AhpErrorCodes, SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol'
import { RpcError } from '@microsoft/agent-host-protocol/client'

/** Protocols implemented by the installed SDK, most preferred first. */
export const DSH_AHP_PROTOCOL_VERSIONS = Object.freeze([...SUPPORTED_PROTOCOL_VERSIONS])

/**
 * Reject unsupported protocol declarations at the configuration entry point.
 * @param versions - Protocols offered by this connection.
 */
export function validateProtocolVersions(versions: readonly string[]): void {
  if (versions.length === 0 || versions.some(version => !DSH_AHP_PROTOCOL_VERSIONS.includes(version))) {
    throw new Error('dsh-remote-ssh: protocolVersions must be a non-empty subset of [' + DSH_AHP_PROTOCOL_VERSIONS.join(', ') + ']')
  }
}

export interface AhpProtocolMismatch {
  offeredVersions: readonly string[]
  serverVersions: string[]
}

/** Extract a negotiated-version rejection without coupling callers to RPC internals. */
export function ahpProtocolMismatch(
  error: unknown,
  offeredVersions: readonly string[] = DSH_AHP_PROTOCOL_VERSIONS,
): AhpProtocolMismatch | undefined {
  if (!(error instanceof RpcError) || error.code !== AhpErrorCodes.UnsupportedProtocolVersion) return undefined
  const data = typeof error.data === 'object' && error.data !== null
    ? error.data as { supportedVersions?: unknown }
    : undefined
  const serverVersions = Array.isArray(data?.supportedVersions)
    ? data.supportedVersions.filter((value): value is string => typeof value === 'string')
    : []
  return { offeredVersions, serverVersions }
}

export function formatAhpProtocolMismatch(mismatch: AhpProtocolMismatch): string {
  const offered = mismatch.offeredVersions.join(', ') || 'none'
  const server = mismatch.serverVersions.join(', ') || 'unknown'
  return `client offered [${offered}], Agent Host accepts [${server}]`
}
