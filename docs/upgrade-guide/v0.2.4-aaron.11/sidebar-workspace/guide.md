---
kind: upgrade-guide
description: "Better Sidebar workspaces require a matched host capability bridge for Remote SSH file, Git and terminal access."
---

# Pair Remote SSH with the Sidebar workspace bridge

English | [中文](guide.zh.md)

## Change

Remote SSH adds the `dsh-remote-ssh/sidebar-bridge` composition row. It registers an execution router through the host-owned `sidebarWorkspaceProviders` service. The bridge has no runtime dependency on Better Sidebar; its published declarations use the type-only `dsh-better-sidebar/workspace-provider` entry. It remains inactive when Better Sidebar is absent.

With the matching Sidebar candidate, a configured Remote SSH manager without the bridge returns HTTP 503 for workspace requests instead of choosing a local filesystem. The authoritative Session header selects the host and directory. Disabling the bridge revokes retained adapters, cancels pending effects, and waits for upload, Git and terminal cleanup without retiring shared manager routes. Removing the manager preserves fail-closed routing in the current Sidebar instance. Removing a remote mapping makes old aliases unavailable; browser `cwd` fields cannot restore execution. Disabling the workspace fence permits paths outside the Session directory on the same host, not another execution host.

Bridge `pathMetadata` defaults to `posix`: remote GNU `realpath`, `stat` and `base64` provide canonical paths and lexical link metadata. Set `ahp` only after verifying that the server honors `followSymlinks` and returns canonical URIs; protocol version alone does not establish that behavior. A deployed 0.9.0 server can return the requested URI after following a link.

Remote reads require the complete resource to fit `fullReadMaxBytes`; the AHP resource API does not support a bounded partial preview request. Git requires complete stdout and stderr, separate byte limits, and acknowledged cleanup. A successful process exit with an expired output drain is not a successful Git result. Search budget exhaustion is an explicit error, not a partial successful search. Uploads publish only after complete bounded writes and refuse existing destinations. Uncertain metadata-shell or publication cleanup remains owned and prevents successful bridge disposal or route retirement.

## Migration

1. Stop the Web service before installing both matched candidate archives. The live-reload profile can activate a replacement immediately; merely planning to restart later does not prevent that. Retain the previous archives and profile manifest/lock backups for rollback.
2. Keep the `remote-ssh-sidebar-workspace` row from the Remote SSH bundle patch. Custom compositions mount `dsh-remote-ssh/sidebar-bridge` with `remoteSshManager` and `sidebarWorkspaceProviders` in the same service realm. Do not import the Sidebar type leaf at runtime.
3. Configure bridge `fullReadMaxBytes`, `writeMaxBytes`, upload chunk limits, search budgets, Git byte limits, cleanup grace, output transport limits, and `terminalArgv`, `terminalEnv`, `terminalType` as required by the deployment. The Loader schema supplies explicit defaults. Remote terminals use these values, not local Sidebar shell overrides or the host process environment.
4. Start the service and confirm that file reads, uploads, Git status and terminal input use a private directory on the selected SSH host. Remove the mapping and confirm that new requests fail instead of accessing the local alias directory. Session logs and remote business files are not migrated.
