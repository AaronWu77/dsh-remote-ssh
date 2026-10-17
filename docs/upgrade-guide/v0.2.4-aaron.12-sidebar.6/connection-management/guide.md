---
kind: upgrade-guide
description: "Use integrated Remote SSH diagnostics and guarded preference saves instead of standalone probes and unconditional connection resets."
---

# Remote SSH connection management

English | [中文](guide.zh.md)

## Change

The standalone `scripts/probe.mjs` and `scripts/probe-terminal.mjs` commands are retired. Diagnostics run inside the authenticated Remote SSH settings page and use the same SSH/AHP startup implementation as workspace connections. Reports exclude raw output, targets, paths and connection credentials.

Changing the SSH configuration through the settings endpoint rejects while managed remote executions or diagnostics are active. Existing connections require explicit reset confirmation. Preference writes require an expected revision to detect concurrent edits; validation failures, conflicts and uncertain application have distinct error codes. Editor-only preference changes preserve SSH connections and Sidebar in-app previews.

## Migration

1. Build and install the matched local plugin artifact, retaining the profile and workspace catalog. Restart the existing Web service, then refresh the browser.
2. Open **Settings → Remote SSH → Advanced settings**. Read the effective preferences before editing. Restore defaults changes only the draft until saved.
3. API clients must read `GET /plugins/dsh-remote-ssh/settings`, then pass `expectedRevision` and, when requested, `confirmConnectionReset: true` to the existing POST endpoint. Finish active tasks before changing SSH configuration. Reload after an interrupted save; cancellation does not imply rollback.
4. Replace standalone probes with **Connection diagnostics** in the same page. Basic checks execute SSH only; deep checks may create an isolated Agent Host, tunnel and temporary runtime directory. Terminal verification is an explicit additional choice. No diagnostic installs remote software.
5. Require successful cleanup as well as successful connection stages. Confirm that Sidebar file links still open in-app and that a normal workspace remains usable while a diagnostic is cancelled.
