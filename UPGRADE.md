# Upgrade to 0.2.4-aaron.3

This fork targets DSH 0.2.0-rc.2. Install the immutable local archive, not the upstream npm package. Preserve the previous archive and profile manifest/lockfile/patch before installation; start a verification profile without the live Web listener before activating the update. Restart the live Web profile only during an agreed maintenance window, then refresh the existing GUI URL.

## AHP protocol policy

The official SDK dependency is exactly 1.0.0. Its offered protocols are 1.0.0 and 0.9.0. Remove explicit 0.8.0 or 0.7.x overrides from profile configuration; unsupported lists now fail at configuration validation. Protocol 0.10.0 remains unsupported in this artifact; a host with only that version requires a separate validated adapter, while candidate discovery can select an installed 0.9.x Agent Host.

## Remote runtime data and teardown

Embedded Agent Host data and token lookup use the same per-connection remoteRuntimeRoot. The plugin does not install remote software or delete historical VS Code caches. Failed candidates and disposed connections stop their owned local SSH children and verify the live remote bootstrap PID, unique data directory and process group before stopping the remote group. Remote cleanup failure is reported rather than claiming teardown completed. Standalone detached CLI startup retains its existing idle timeout.

## Configuration and error responses

Manager protocolVersions and connection timeouts are connection policy; changing them invalidates cached host/workspace runtimes. The runtime shutdownTimeoutMs defaults to 3000. Web maxErrorCharacters defaults to 16384 and must be a positive integer. Candidate exhaustion has the stable agent_host_unavailable error code; diagnostics preserve the first and final failure when truncated and redact connection tokens.

## Rollback

Reinstall the retained previous local archive using the same pnpm store, restore the backed-up profile manifest/lockfile/patch, and restart only in a maintenance window. The update does not migrate persisted Session data or change local PTC routing.
