# Upgrade this Remote SSH fork

The Sidebar `.5` candidate must be installed with Better Sidebar `0.19.3-remote.5`. Its search returns relative filename matches and partial-result status, with caller cancellation; see the [Sidebar search migration](docs/upgrade-guide/v0.2.4-aaron.12-sidebar.3/sidebar-search/guide.md) / [中文](docs/upgrade-guide/v0.2.4-aaron.12-sidebar.3/sidebar-search/guide.zh.md). The installation and rollback safety rules below still apply.

This fork targets DSH 0.2.0-rc.2. Install the immutable local archive, not the upstream npm package. Preserve the previous archive and profile manifest/lockfile/patch before installation; start a verification profile without the live Web listener before activating the update. Restart the live Web profile only during an agreed maintenance window, then refresh the existing GUI URL.

## Offline installation

Stop the Web service before changing installed packages or profile patches. Profile patch watching can reconcile plugins even when no process restart was requested; replacing loaded artifacts while that watcher runs can mix module generations. Stage and test the archive separately, install only after the old listener is stopped, then start the service manually.

## Native local confinement and remote session policy

The bundle no longer overrides `sandbox-policy.config.mode` to `danger-full-access` or `approval.config.policy` to `never`. Existing profile-level overrides remain effective; remove those overrides yourself if they are not intended. Local shells use the official sandbox executors. Remote restricted shell calls now reject in their remote world instead of weakening local policy or executing on the host. Set the remote Session to `danger-full-access` only after reviewing its SSH account, container, or VM isolation.

Shell budgets and `pwshPath` are volatile configuration fields. The legacy PowerShell `executable` override remains supported; custom Bash executable paths now reject at load. Remove Bash `executable` and place the required Bash on PATH. Explicit Session-owned shell and subprocess calls now require a live world binding; callers outside a live Agent must omit Session ids rather than reuse a disposed id. Native subprocess rejection notes use the official wording `subprocess failed before reporting an outcome:` while retaining independent and consuming UTF-8 reads. No Session data migration is required.

## Trusted Web routes, connection bounds, and mappings

Every `/plugins/dsh-remote-ssh/*` route now asks the composition's `connection` service for a rejection before any handler work: the Host/Origin fence plus browser-token authentication answer 401/403, and the routes register only where `connection` exists. A deployment without that service loses the Web surface instead of exposing unauthenticated SSH-config, catalog, and filesystem writes.

SSH transports add `-o BatchMode=yes` and `-o ConnectTimeout=<seconds>` from the new manager `connectTimeoutMs` (default 10000); interfaces such as `sshExecutable` still apply, and `probeServer` uses the server's configured executable. A workspace that maps the remote root `/` is rejected at validation, because on a POSIX host it would claim every POSIX-absolute path; register a subdirectory instead. Failed sidebar deletions restore both the configured and the canonical alias spelling of a mapping. Alias-root containment no longer claims the `aliasRoot` itself or non-alias entries below it, so project-root discovery that probes `<aliasRoot>/.git` stays in the local world; unknown id-named alias directories below `aliasRoot` remain reserved and fail closed.

## Remote editing, output, and stdin

`editText` writes its replacement literally on both branches, so `$$`, `$&`, `` $` ``, and `$'` in model-supplied text survive. Remote subprocess drains are bounded by `graceMs` after the command exits: a descendant that inherits stdout cannot hold the outcome open, and an expired drain settles with the command's own status. Live stdin is split into 2048-byte base64 records so one record stays inside a PTY canonical input buffer. `canUseAhpSubprocess` was removed; `remotePath` mapping rules above apply.

## AHP protocol policy

The official SDK dependency is exactly 1.0.0. Its offered protocols are 1.0.0 and 0.9.0. Remove explicit 0.8.0 or 0.7.x overrides from profile configuration; unsupported lists now fail at configuration validation. Protocol 0.10.0 remains unsupported in this artifact; a host with only that version requires a separate validated adapter, while candidate discovery can select an installed 0.9.x Agent Host.

## Remote runtime data and teardown

Embedded Agent Host data and token lookup use the same per-connection remoteRuntimeRoot. The plugin does not install remote software or delete historical VS Code caches. Remote Linux cleanup requires readable /proc, ps, awk and an external kill executable. Failed candidates and disposed connections verify the live leader data directory and capture member PID/start-time identities before TERM. A surviving verified member permits KILL even after the leader exits; cleanup waits and rejects any remaining live members or unverifiable ownership. Local SSH children are stopped and awaited in finally, after remote cleanup. The cleanup command budget includes requestTimeoutMs plus twice shutdownTimeoutMs so the settling phases cannot be cut short by a shorter request timeout. Remote cleanup failure is reported rather than claiming teardown completed. Standalone detached CLI startup retains its existing idle timeout.

## Startup and background failures

Candidate and tunnel startup check the shared deadline and disposal signal before spawning. Expiry or cancellation ends fallback immediately. A rejected local subprocess publishes one persistent UTF-8 failure note for both independent observed streams and consuming readOutput calls; consuming the note does not remove it from background-job observers.

## Configuration and error responses

Manager protocolVersions and connection timeouts are connection policy; changing them invalidates cached host/workspace runtimes. The runtime shutdownTimeoutMs defaults to 3000. Web maxErrorCharacters defaults to 16384 and must be a positive integer. Candidate exhaustion has the stable agent_host_unavailable error code; diagnostics preserve the first and final failure when truncated and redact connection tokens.

## Workspace deletion and output

Sidebar deletion removes the Remote SSH mapping before deleting its Workspace registration. Directories and Session logs are retained; Settings removal still removes only the execution mapping. Keep the manager’s `retiredAliases` field in profile configuration: these durable tombstones stop old custom aliases from executing locally. Unknown aliases under `aliasRoot` are also reserved. Do not hand-delete those identity directories or trim tombstones to make old Sessions executable. Failed, unconfirmed helper cleanup rejects deletion and keeps execution blocked; investigate its retained resource URI before retrying or restarting. Existing duplicate mapping identities are retained, while future selections reuse a same-server normalized directory.

Remote subprocesses require `dd` and `mv` in addition to the existing POSIX tools. The router settings `outputChunkBytes` and `outputPollMs` default to 65536 and 40. Output uses bounded immutable chunk slots, with the retained-file/read payload and escaped-descendant limits in the [README](README.md#subprocess-output-limits). Ordinary cancellation can stop shared-connection readiness waits without disrupting other workspaces.

When paired with Review-Gated alpha.3, the role-aware Node interpreter uses preserved local providers automatically; retain existing explicit local isolation entries for compatibility. Managed Review-Gated remote workspaces remain unsupported.

## Rollback

Reinstall the retained previous local archive using the same pnpm store, restore the backed-up profile manifest/lockfile/patch, and restart only in a maintenance window. The update does not migrate persisted Session data. The preserved-local-provider PTC selection is described above.
