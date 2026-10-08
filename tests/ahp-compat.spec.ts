import { AhpErrorCodes, SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol'
import { AhpClient, InMemoryTransport, RpcError } from '@microsoft/agent-host-protocol/client'
import { describe, expect, it } from 'vitest'
import {
  ahpProtocolMismatch,
  DSH_AHP_PROTOCOL_VERSIONS,
  formatAhpProtocolMismatch,
  validateProtocolVersions,
} from '../src/ahp-compat.ts'

describe('AHP compatibility policy', () => {
  it('offers SDK-supported protocols without retaining unimplemented legacy or forward declarations', () => {
    expect(DSH_AHP_PROTOCOL_VERSIONS).toContain('0.9.0')
    expect(DSH_AHP_PROTOCOL_VERSIONS).not.toContain('0.8.0')
    expect(DSH_AHP_PROTOCOL_VERSIONS).not.toContain('0.10.0')
    expect(DSH_AHP_PROTOCOL_VERSIONS).toEqual([...new Set(DSH_AHP_PROTOCOL_VERSIONS)])
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) expect(DSH_AHP_PROTOCOL_VERSIONS).toContain(version)
  })

  it('rejects empty and unimplemented protocol overrides', () => {
    expect(() => validateProtocolVersions([])).toThrow('non-empty subset')
    expect(() => validateProtocolVersions(['0.10.0'])).toThrow('non-empty subset')
    expect(() => validateProtocolVersions(['0.9.0'])).not.toThrow()
  })

  it('negotiates 0.9.0 through the actual SDK codec', async () => {
    expect(await negotiate(DSH_AHP_PROTOCOL_VERSIONS)).toBe('0.9.0')
  })

  it('reproduces rejection of the previous 0.8/0.7 client offers', async () => {
    const outcome = await negotiate(['0.8.0', '0.7.0', '0.6.0', '0.5.2', '0.5.1'])
    expect(outcome).toBeInstanceOf(RpcError)
    expect(ahpProtocolMismatch(outcome)?.serverVersions).toEqual(['^0.9.0'])
  })

  it('extracts the server compatibility range from a negotiation rejection', () => {
    const error = new RpcError(AhpErrorCodes.UnsupportedProtocolVersion, 'incompatible', {
      supportedVersions: ['^0.9.0'],
    })
    const mismatch = ahpProtocolMismatch(error)
    expect(mismatch?.serverVersions).toEqual(['^0.9.0'])
    expect(formatAhpProtocolMismatch(mismatch!)).toContain('^0.9.0')
  })
})

async function negotiate(versions: readonly string[]): Promise<unknown> {
  const [transport, remote] = InMemoryTransport.pair()
  const client = new AhpClient(transport)
  client.connect()
  const outcome = client.initialize({ clientId: 'compatibility-test', protocolVersions: [...versions] }).then(result => result.protocolVersion, (error: unknown) => error)
  try {
    const frame = await remote.recv()
    if (frame === null || frame.kind !== 'text') throw new Error('initialize request missing')
    const request: { method: string; id: number; params: { protocolVersions: string[] } } = JSON.parse(frame.text)
    expect(request.params.protocolVersions).toEqual(versions)
    if (!('method' in request) || !('id' in request) || request.method !== 'initialize') throw new Error('initialize request missing')
    if (versions.includes('0.9.0')) {
      remote.send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '0.9.0', serverSeq: 0, snapshots: [] } })
    } else {
      remote.send({ jsonrpc: '2.0', id: request.id, error: { code: AhpErrorCodes.UnsupportedProtocolVersion, message: 'incompatible', data: { supportedVersions: ['^0.9.0'] } } })
    }
    return await outcome
  } finally {
    client.shutdown()
    remote.close()
    await outcome
  }
}
