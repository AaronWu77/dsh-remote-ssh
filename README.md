---
kind: "package-bundle"
description: "Use SSH hosts as workspaces with file, search, and shell integration."
---

# dsh Remote SSH

<a id="plugin-information"></a>
## Plugin information

Use SSH hosts as workspaces with file, search, and shell integration.

| Field | Value |
|---|---|
| Package | `dsh-remote-ssh` |
| Checkout version | `0.2.4-aaron.12-sidebar.6` |
| Maintained repository | [AaronWu77/dsh-remote-ssh](https://github.com/AaronWu77/dsh-remote-ssh) |
| Package license | Apache-2.0 |

Package identity, license and upstream declarations are maintained in [package.json](package.json). A checkout version does not establish a published release or verified compatibility; retain the existing qualification and deployment limits below.

<a id="source-and-attribution"></a>
## Source and attribution

- [dsh-remote-ssh](https://github.com/Yan-Zero/dsh-remote-ssh) — adapted implementation; Apache-2.0; exact upstream baseline not recorded. Local DSH compatibility, Remote SSH workspace routing, and diagnostics. [Detailed record](https://github.com/AaronWu77/dsh-remote-ssh/blob/HEAD/UPGRADE.md).

The maintained fork and the upstream project are different repositories. Original author, copyright, license and notice statements remain in force. A missing upstream baseline is left unrecorded rather than inferred from the local version.

## Isolated 0.2.1-rc.2 candidate qualification (2026-10-17)

This qualifies the current fork candidate only; historical Linux/AHP evidence below is not an rc.2 canary. The baseline already includes explicit schema declarations at `b9c5f53`. Remote `0.2.4-aaron.12-sidebar.6` targets Host `0.2.1-rc.2 / 687f282`. The Better Sidebar bridge this section qualified has since been removed. Actual links resolve Cordis `4.0.5` and Schemastery `3.18.5`. DSH dev pins target rc.2; peers/engines retain alpha.2 and add rc.2, **without claiming older versions were revalidated**. The candidate root owns the final dependency freeze; this package did not run install.

- Focused `--maxWorkers=1`: main lane 19 files, **162 passed**; mocked Git route group **10 passed / 7 not selected** (real local-output scripts excluded); bounded/redacted diagnostic presentation **5 passed**. Distinct total: 21 files, **177 passed / 7 unverified**. Three real in-memory Connection cases are included in the main lane. No live SSH suite ran; a live suite's self-skip must never count as a pass.
- Covers Sidebar bridge/workspace POSIX/alias/Session symlink containment, byte reads/uploads, PTY input/resize/final output, revocation/cleanup ACK and uncertain cleanup, Git deadline/stream ownership; expectedRevision, active-run/diagnostic safety, reset confirmation and editor-only non-disconnection; mocked startup deadline/fallback/retry and successful-cleanup requirements; diagnostic bounds/token redaction. Arbitrary remote shell still requires `danger-full-access` and rejects restricted modes; no local fallback or automatic replay. Cancellation does not guarantee rollback.
- rc.2 raw `requestRejection` accepts live API Peers; it is **not** Connection exact-fetch's owner authorization. When `admit` is present, these routes additionally require an owner. Current Host API exchange itself mints owners; no default non-owner escalation was reproduced. Anonymous/bad-Origin/released-cookie/future-non-owner cases are rejected before body/resource work. Older hosts without `admit` retain their existing fence.
- Ordered Sidebar build → Remote build (includes typecheck) → standalone Remote typecheck passed. Earlier missing Sidebar types during concurrent lib cleanup were an ordering issue, not a product defect. No snapshot expected values, third-party features or appearance changed. **No DSH service, real SSH/provider, profile/browser or real remote/native process cleanup was verified.** Real Loader/browser/SSH/AHP canaries remain qualification gaps. No deployment/commit/push; replace both packages together only after stopping the service.


English | [中文](README.zh.md)

Use SSH hosts as transparent workspaces in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Choose `LOCAL > project` and ordinary file, search, shell, and background-task tools run locally. Choose `<Server> > project` and those same tools run on that SSH host. There is no second set of `remote_*` tools, and a remote failure never falls back to the local machine.

Host-owned bootstrap and attachment paths map through the preserved local filesystem. Remote workspace aliases are not mapped as local host assets. PTC interpreters use the local filesystem/subprocess realm; a replacement PTC provider must retain both isolation entries from the stock runtime row.

## Features

- discovers concrete hosts from the user and system OpenSSH configuration, including recursive `Include` files;
- manages multiple SSH hosts and multiple workspaces per host from Settings;
- provides the same editable directory browser for local and remote folders;
- labels workspaces and terminal calls as `LOCAL > ...` or `<Server> > ...`;
- routes filesystem access, search, subprocesses, background jobs, and terminals by the active workspace;
- exposes binary workspace writes for artifact plugins such as `dsh-codex` image generation; raw bytes are base64-encoded only inside AHP `resourceWrite` transport;
- keeps remote search results in POSIX path space and stores oversized tool results in a private runtime directory on the corresponding SSH host for follow-up `read`/`grep` access;
- exposes `bash` for POSIX remote workspaces and `pwsh` for local Windows workspaces;
- routes conversation file links for remote workspaces through Remote SSH's open-file flow, which uses an installed VS Code-compatible editor, with a local downloaded snapshot as fallback and a composer notice naming why the editor path was skipped;
- reuses one persistent SSH/AHP host connection while each Bash call opens its own terminal channel, like a new VS Code terminal tab;
- shares one host-scoped SSH/AHP connection across workspaces on the same server;
- preserves readable Workspace and Session history after a remote mapping is removed, while rejecting new tool calls from the old session;
- keeps a workspace name set in the Workspace list across restarts and catalog changes.

Remote workspaces currently support Linux hosts with readable `/proc`, `ps`, `awk`, and an external `kill` executable. Windows and non-Linux POSIX SSH hosts are not supported.

Windows drive and UNC file addresses select the local host unless they match an explicitly registered remote alias. On a Windows host, a collapsed WSL share address remains local as well; it is not interpreted as a POSIX path on the current SSH server. Local WSL opening is delegated to the client's built-in navigation handler, which keeps its path canonicalization and permissions. A genuine Linux `/wsl.localhost/…` path in a POSIX host namespace retains its remote meaning.

## Agent Host compatibility

This fork pins the official AHP SDK 1.0.0 and offers its supported protocols, `1.0.0` and `0.9.0`. It does not advertise `0.10.0`, `0.8.0`, or legacy `0.7.x`. An incompatible embedded candidate is stopped before the next candidate starts; a successful host connection remains active until transport loss or disposal. A real Linux Agent Host negotiated `0.9.0` and passed UTF-8 writes, binary byte-range reads, and terminal execution.

Set manager `protocolVersions: ["0.9.0"]` to restrict negotiation. Changing this list or connection timeouts invalidates host/workspace connection caches. Every SSH transport runs `-o BatchMode=yes` with `connectTimeoutMs` (default 10000, seconds-rounded on the command line), because no channel can answer an interactive prompt. Each startup attempt uses one deadline across all its candidates; expiry or disposal prevents further candidate and tunnel spawns in that attempt. Runtime `shutdownTimeoutMs` controls TERM grace and post-KILL settling. Embedded data is beneath `remoteRuntimeRoot`; cleanup validates the leader data directory and retains group-member birth identities through leader exit. Live group members must be gone before cleanup succeeds. A workspace may map any remote directory except the remote root `/`, which would claim every POSIX-absolute path on a POSIX host and is rejected at configuration validation.

The directory picker shows a localized failure summary and expandable diagnostics. Runtime lifecycle failures retain `connection_closed`, `candidate_startup_timeout` or `cleanup_failed` as a Web response code with HTTP 503; technical details remain bounded and token-redacted. The Web provider accepts `maxErrorCharacters` (default 16384) and registers only where the composition provides `connection`: every route asks that service's browser-trust fence for a rejection first (401/403), so an unauthenticated or rebinding-shaped caller never reaches a handler. URL/CLI connection tokens are redacted. See [the fork upgrade guide](UPGRADE.md) before replacing the previous archive.

## SSH execution diagnostics and custom configuration

A silent nonzero startup exit retains its stage and SSH exit code. Failed embedded discovery reports `ssh_execution_failed`, not a missing Agent Host; only exit 0 with no candidates means no installed embedded host. Candidate compatibility failures remain `agent_host_unavailable`. Exit 255 alone is not an authentication diagnosis: inspect the bounded, token-redacted details and the local SSH launch environment first (including Windows `ProgramData`). The plugin does not repair launcher environment variables or automatically switch to Git SSH. A failed attempt leaves the connection retryable: once its owned cleanup succeeds, the next explicit request starts a new attempt with a fresh deadline, and requests already waiting share the attempt in flight. A failed cleanup keeps the failure visible and starts no further attempt. No file, search or terminal operation is replayed.

A closed SSH tunnel, owned Agent Host process or AHP connection invalidates the successful client. After verified cleanup, the next explicit directory refresh or connection request shares one new attempt across concurrent callers; there is no background retry loop. Late close events from an old attempt cannot invalidate its successor. If cleanup cannot be confirmed, subsequent explicit requests may recheck cleanup but cannot start a replacement until ownership is resolved. Interrupted writes and commands remain failed or outcome-unknown; a new connection does not restore their terminal channels.

Manager `sshConfigFile` controls both discovery and connections: runtime startup, tunnels, cleanup and the Web probe receive exactly one `-F <selected absolute path>`. With no selected file, no `-F` is injected and normal OpenSSH defaults apply. Existing server arguments (user, ProxyJump, identity) remain intact. When a custom file is selected, any server `sshArgs` config override (split, attached or grouped `-F`) is rejected, even if it names the same file; remove it and use the manager setting. Without a manager override, explicit server arguments remain supported. Changing the setting retires cached host/workspace transports and changes the multiplexing key. Runtime connect timeout remains 10 seconds by default; the Web probe retains 5 seconds.

## Install

This editable candidate checkout declares DSH `0.2.1-alpha.2 || 0.2.1-rc.2` peers/engines, with exact rc.2 development pins (see the qualification scope above). Build and install its local archive; the npm registry package is the upstream release, not this fork:

```sh
pnpm install --ignore-scripts
pnpm run build
pnpm pack --pack-destination ./artifacts
# Stop the Web service before replacing installed bundles.
dsh plugin --profile web add file:./artifacts/dsh-remote-ssh-0.2.4-aaron.12-sidebar.6.tgz --ignore-scripts
dsh web
```

For the optional dsh-tui adapter, install the same bundle into that profile:

```sh
dsh plugin --profile dsh-tui add dsh-remote-ssh
dsh-tui
```

Inside the TUI, `/workspace remote` (or `/workspace connect`) opens an SSH
device picker and then a remote directory browser. Existing workspaces are
listed by `/workspace resume`. A target can also be opened directly:

In the directory browser, Enter selects the current directory. Press Tab on
the first row to edit or paste an absolute remote path, then Enter to load it.

```text
/workspace open ssh://server-id/srv/project
/workspace open ssh://user@example.com:2222/home/user/project
```

The launcher accepts the same URI (`dsh-tui ssh://server-id/srv/project`). A
previously unknown direct target is saved to Remote SSH settings. Relative
paths such as `/workspace open ../other-project` are resolved in the current remote
POSIX path space, and `!command` executes through that workspace's remote shell.
The adapter is optional: dsh-tui contains no SSH-specific protocol or UI code
and continues to operate locally when this package is absent.

From a DeepSeek Harness source checkout, use `pnpm dsh` in place of `dsh`. For local plugin development:

```sh
pnpm install
pnpm run check
pnpm dsh plugin --profile web add link:E:/absolute/path/to/dsh-remote-ssh
pnpm dsh --profile web
```

Codex, Claude Code, and other automation agents should follow [INSTALL.md](INSTALL.md). It is a complete, idempotent runbook.

## Set up a host

1. Configure and verify the host with ordinary OpenSSH first. Key or SSH Agent authentication is recommended.
2. Open **Settings → Remote SSH**. The row uses the link glyph in the Settings navigation. The page reads the platform's default user and system SSH configuration automatically.
3. Test basic SSH access, then select **Add workspace**, choose the SSH host, and confirm a folder after its directory listing loads.
4. Start or open a session in `<Server> > <folder>`.

Open **Settings → Remote SSH → Advanced settings** to choose an absolute custom SSH configuration path or leave it blank for platform defaults. Preferences apply across this manager, not to one server. Restore defaults changes only the draft; Save validates the host file and reads back the saved revision. Active remote executions or diagnostics block SSH configuration changes, and existing connections require reset confirmation. Editor-only changes do not reset SSH connections. An interrupted save has an unknown outcome until settings are reloaded; no automatic resend or rollback is claimed.

Remote file links route through Remote SSH's open-file flow: an installed VS Code-compatible editor opens them through Remote SSH by default, with a local downloaded snapshot as fallback and a composer notice naming why the editor path was skipped. The host configuration fields `remote-ssh-manager.openFileMode` and `openFileEditorPath` select that external mode and optional custom executable; local file links still use the in-app sidebar behavior.

The remote host needs:

- a POSIX shell and non-interactive OpenSSH access;
- `bash`, `base64`, `mkfifo`, `dd`, and `mv` for shell and subprocess execution;
- `rg` for glob and grep tools;
- a VS Code Agent Host supplied by the official VS Code CLI or an existing VS Code Server installation.

With the default `remoteCodeCommand: code`, the plugin first probes installed VS Code Server candidates newest-first and uses the first successful AHP negotiation. Only after installed candidates fail does it try `code` on PATH, or `~/.dsh-remote-ssh/cli/bin/code` when PATH has no `code`. An explicit custom command remains authoritative and does not select an installed substitute. The standalone CLI may download Agent Host; the plugin does not install remote system packages.

Manager and runtime `embeddedStartupTimeoutMs` (15000) and `standaloneStartupTimeoutMs` (30000) bound each candidate through startup, tunneling and negotiation. Each phase also respects the remaining `startupTimeoutMs` (600000) total. All budgets must be positive safe integers; cleanup has its own bounded shutdown and request budgets. Changing a manager budget retires its cached host connections. See [the recovery upgrade guide](docs/upgrade-guide/v0.2.4-aaron.12-sidebar.6/connection-recovery/guide.md).

## Connection diagnostics

Use **Connection diagnostics** on the same settings page after saving or discarding preference drafts. Basic checks execute SSH and report available commands. Deep checks create an independent foreground Agent Host, negotiate AHP and read the selected directory; terminal verification is optional and uses a fixed command. Missing search tools are reported without blocking unrelated directory checks. Deep diagnostics may create remote temporary files and processes, but never install software or alter workspace contents.

Cancel stops only diagnostic-owned resources. A lost browser cancellation is covered by the task lease. Cleanup is reported separately from connection success; missing remote process ownership or unverifiable termination is a visible failure, never a clean result. Exported reports omit raw SSH output, addresses, account names, paths, argv and tokens. Reports retain the configuration revision and are marked outdated after preferences change. They are held in memory only and expire or disappear on restart.

The Web provider exposes `diagnosticTimeoutMs` (120000), `diagnosticTerminalTimeoutMs` (15000), `diagnosticLeaseMs` (45000), `diagnosticRetentionMs` (600000), `diagnosticMaxConcurrent` (2), and `diagnosticMaxRetained` (20). The retired standalone probes are replaced by this authenticated workflow; see [the connection-management upgrade guide](docs/upgrade-guide/v0.2.4-aaron.12-sidebar.6/connection-management/guide.md).

## How workspaces behave

The active workspace is the execution boundary. A remote session resolves absolute paths, executables, shell state, and search tools on its SSH host—even when a local file or executable has the same name.

Remote filesystem results expose POSIX paths only. The local Workspace identity directory is never presented to the model or emitted by cooperating plugins as a file path.

When a tool result exceeds the inline budget, a remote session writes the complete result through AHP into that SSH host's private runtime directory and returns a remote POSIX locator. The local spill backend is used only for local sessions; an unknown or stale session never falls back to host storage. Stock `glob`/`grep` results are also normalized back into remote POSIX path space, preventing a Windows host from presenting `/root/...` as `E:\root\...`.

**Delete workspace** removes both its Workspace registration and Remote SSH mapping. Neither the remote directory nor the local identity directory, Session logs, or message history is deleted. The mapping is retired durably before registration deletion; a failed registration deletion restores it or reports a rollback error. **Remove execution mapping** in Settings retains the Workspace registration and history. Both operations leave stale aliases non-local across restarts; old sessions remain readable but cannot execute.

Repeated selection of the same server and normalized remote directory reuses its existing mapping. Existing duplicate mappings retain their separate aliases and history; raw remote paths on the same server use the first matching mapping, while equally specific paths on different servers are rejected. Workspace creation disables repeated submissions and cancellation until the request finishes; a closed flow ignores late selection callbacks, and errors remain visible in the flow or Settings.

Local and remote folder selection use the same in-app browser. This avoids native picker dependencies and also works around the Windows path issue described in [DeepSeek Harness discussion #396](https://github.com/deepseek-ai/deepseek-harness/discussions/396).

## Agent Host updates

The plugin does not maintain or redistribute VS Code Server archives. The official standalone VS Code CLI downloads, caches, starts, and updates Agent Host. The CLI itself supports:

```sh
code update --check
code update
```

AHP negotiation is independent from binary updates. If a newly cached Agent Host is newer than the protocol surface validated by this plugin, Remote SSH tries another compatible cached Host and otherwise reports the offered and accepted protocol versions clearly.

## Security

Remote commands have the permissions of the SSH account. AHP permissions are not an operating-system sandbox, and one SSH account can normally reach paths outside the selected workspace when the active dsh policy grants full access.

The bundle preserves the profile’s sandbox and approval defaults. The filesystem router advertises its local provider’s confinement, so write and edit receive the calling Session’s sandbox policy rather than an agentless deployment fallback. Local shell calls use the official sandbox Bash or PowerShell executor, including per-call confinement, denial details, runner failures, cancellation, and managed-process cleanup. Remote shell calls reject `read-only` and `workspace-write` after selecting the remote execution world; they never fall back to the local host. Explicitly select `danger-full-access` for a remote session only when the SSH account’s access is acceptable. Use a dedicated Unix account, container, or VM when stronger remote isolation is required.

Shell rows retain live `cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`, and `pwshPath` configuration. PowerShell also accepts the legacy `executable` override. Bash accepts only an omitted `executable` or the literal `bash`; a custom executable rejects at load because the official executor uses Bash from PATH. Calls carrying a Session id require its live execution-world binding; a disposed or unknown Session never selects a host from path text.

Passwords, MFA prompts, and first-use host-key confirmation are not bridged into the Web UI. Complete those steps with OpenSSH before using the host in dsh.

## Compatibility

- DeepSeek Harness `0.2.1-alpha.2` declared peer dependencies;
- POSIX/Linux SSH hosts;
- `@microsoft/agent-host-protocol` 1.0.0 client offering AHP 1.0.0 and 0.9.0;
- system OpenSSH configuration, SSH Agent, `known_hosts`, and `ProxyJump`.
- local Visual Studio Code, Cursor, Windsurf, or VSCodium with a compatible Remote SSH extension for native remote file opening.

### Local 0.2 Web profile

The enclosing local-plugin workspace pins pnpm 11.28.5; this checkout declares DSH 0.2.1-alpha.2 peers. Settings are stored through the manager’s volatile profile configuration and `settings.replace`, without replacing the running manager or its Session bindings. Local directory selection uses `uiWorkspace.listDirectory`. File resources use the address-owning Session; remote addresses route through the Remote SSH open-file flow, with built-in preview on failure.

The PTC interpreter uses preserved local filesystem and subprocess providers. Its control pipe and bootstrap paths cannot run through AHP. Calls made through `tools` still use the routed providers; direct Node filesystem or process imports remain local. Restart the existing Web service after installation; refreshing a page alone does not load a new profile bundle.

### Subprocess output limits

The `remote-ssh-subprocess` router exposes `outputChunkBytes` (65536 bytes by default) and `outputPollMs` (40 ms by default). Each process has independent stdout/stderr FIFO pumps and one immutable chunk slot per stream. The remote output files occupy at most twice the chunk size, including temporary files. Each output resource read contains at most `4 * ceil(chunkBytes / 3)` base64 characters plus AHP metadata; each output byte is read once. Consumer backpressure delays acknowledgement instead of accumulating growing output files. Pipes retain bounded Node stream buffers and one pending chunk; collected output uses the requested tail and spill limits. Spill paths refer to the preserved local managed-output collector.

Cancellation stops only the caller’s wait for a shared connection. Ordinary shell executions require a terminal disposal acknowledgement or observed terminal exit before releasing workspace ownership. Subprocess preparation and main execution require the same cleanup confirmation; a dispatched wrapper must also publish its stopped marker within `graceMs`. Unknown termination rejects deletion, blocks the workspace route and retains its private resource URI for inspection. AHP cannot observe arbitrary escaped descendants or unrecorded MSYS auxiliary fork children; stdin terminal dispatch and in-flight data RPC deadlines are separate limits. Repeated unobservable failures can retain multiple private directories.

## Known Limitations and Deferred Work

- No real SSH target was provided for this adaptation. SSH deployment, remote interactive GUI terminals, native-editor launch, and the optional TUI adapter require target-specific validation. Automatic terminal-environment discovery currently follows the local host; remote terminals require POSIX shell arguments.
- AHP 1.0 reads whole resources. Byte-range reads therefore download the complete resource under `maxReadBytes` (64 MiB by default), then slice it.
- Remote control pipes are unsupported. Remote workspaces currently require POSIX/Linux hosts.
- Source checks and non-listening profile startup do not validate the rendered GUI or a remote connection.

See [the design document](docs/design.md) for routing, protocol, permissions, and lifecycle details.

## Development

```sh
pnpm install
pnpm run check
node scripts/integration-ssh.mjs my-host /tmp/dsh-remote-ssh-integration/workspace
node scripts/integration-transparent.mjs my-host /tmp/dsh-remote-ssh-integration/workspace
```

The live integration scripts modify only the explicitly supplied remote test workspace and plugin-owned runtime paths.

## License

Apache-2.0. The plugin calls the user's official VS Code CLI/Server installation and does not redistribute VS Code Server. Use of the official Server remains subject to the Microsoft VS Code Server License Terms.
