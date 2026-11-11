---
kind: upgrade-guide
description: "Automatic Remote SSH startup prefers installed servers and limits standalone CLI waiting before reporting failure."
---

# Remote SSH startup and connection recovery

English | [中文](guide.zh.md)

## Change

Automatic `remoteCodeCommand: code` startup tries installed VS Code Server candidates newest-first before the standalone CLI. Selection still requires successful AHP negotiation; a custom command remains authoritative. Deployments that depended on CLI-first selection may now use an installed compatible server.

Manager and runtime `embeddedStartupTimeoutMs` and `standaloneStartupTimeoutMs` default to 15000 and 30000 milliseconds. These budgets cover candidate startup, tunnel and protocol negotiation within the existing total `startupTimeoutMs`. A standalone download that needs longer must be configured explicitly. Cleanup remains separately bounded and must finish before another candidate starts.

Transport loss invalidates the connected client. The next explicit request reconnects only after verified cleanup; concurrent callers share one attempt. Operations are never replayed, and interrupted terminals are not restored. Unconfirmed cleanup blocks replacement and remains visible.

## Migration

1. Retain the profile, workspace catalog and remote installations. Finish active remote tasks before rebuilding and reloading the installed plugin in the existing Web service.
2. For a slower CLI download, set `standaloneStartupTimeoutMs` on `remote-ssh-manager` to the required positive integer and retain sufficient total `startupTimeoutMs`. Set `embeddedStartupTimeoutMs` when an installed candidate needs more than 15 seconds. Custom runtime rows accept the same fields.
3. If selection must remain command-specific, configure the server's `remoteCodeCommand` with an explicit CLI path; do not remove installed servers merely to influence automatic discovery.
4. Refresh the browser and list the existing remote directory. Verify reconnection using an isolated test connection, not by interrupting shared tasks. A disconnected command or write needs operator review before being submitted again.
