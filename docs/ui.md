# Workspace picker UI

English | [中文](ui.zh.md)

## Summary

Add a LOCAL or SSH workspace from the conversation welcome screen, workspace sidebar, or Remote SSH settings. Each entry uses one dialog with an embedded directory browser.

## Contents

- [Choose and confirm](#choose-and-confirm)
- [Recovery and cancellation](#recovery-and-cancellation)
- [Advanced settings and diagnostics](#advanced-settings-and-diagnostics)
- [Developer reference](#developer-reference)

## Choose and confirm

The dialog starts on LOCAL. Loading the host list does not connect to an SSH host. Choose a host from the source menu to load that host's home directory; changing the source discards the previous directory, path draft, and errors.

Use Home, Up, Refresh, a directory row, or the path field and Go to browse. An empty directory remains selectable. Editing the path does not create a workspace. Add workspace is the only confirmation action: it uses the loaded directory when the field matches, or verifies the edited path first and submits the returned canonical directory.

Remote SSH settings show compact host and workspace rows, followed by Advanced settings and Connection diagnostics disclosures. Host addition and mapping removal cannot run while the workspace dialog is open or management operations own the page.

## Recovery and cancellation

A directory failure retains the loaded rows and path draft. Retry repeats the failed directory request; technical details remain selectable. A failed workspace submission retains the selection and enables another explicit attempt.

Cancel, the close button, the mask, or Escape closes browsing without creating a workspace. Closing or changing sources aborts reads and ignores late responses. While path verification or submission is in progress, source changes and cancellation are disabled; an owner that withdraws the dialog aborts its requests and receives no late picked-path callback.

The shared dialog restores the invoking focus and keeps keyboard navigation inside it. Escape closes an open source menu before the dialog. IME Enter does not browse, and IME Escape does not dismiss. Shared controls and semantic theme tokens provide the light/dark treatment; narrow windows wrap path controls and settings rows.

SSH execution failures have a separate localized summary from unavailable Agent Hosts. Details retain stage and exit code even when SSH emits nothing; exit 255 alone does not imply authentication failure. Only successful empty discovery means no installed embedded Host. Details are bounded and connection tokens are redacted. The custom SSH config setting applies to host discovery, runtime connections and probes, not just the host list; a conflicting server `-F` override is rejected. Clearing the setting restores default config selection. Changing it invalidates cached transports.

## Advanced settings and diagnostics

Preferences load only when a management section opens. A failed load cannot be saved as empty defaults. Drafts survive ordinary refreshes; discard and restore-default actions never submit. Save uses the current revision and verifies the returned preferences with a second read. Interrupted saves remain unknown until reloaded. SSH configuration changes require connection reset confirmation and reject while remote execution or filesystem operations are in flight; external editor choices do not replace Sidebar previews.

Diagnostics use a client-created id, authenticated start/status/cancel requests and a renewable server lease. Deep mode and its optional fixed-command terminal check require consent. Closing the diagnostics section or leaving the page requests cancellation. Stage results and cleanup remain separate, and reports based on previous settings are marked outdated. Copy reconstructs only allowlisted non-secret facts. No raw logs are exported.

## Developer reference

The [flow](../src/client/RemoteWorkspaceFlow.tsx) owns source selection and submission, and the [inline browser](../src/client/WorkspaceDirectoryPicker.tsx) owns directory requests and drafts. Every read receives an AbortSignal. Request generations reject old results even when the provider ignores cancellation. These components use local interaction state, not a global store, and import no runtime component from another feature plugin.

The [client regressions](../tests/client-operations.spec.tsx) exercise both confirmations, cancellation, host changes, draft validation, signals, controlled response races, recovery, IME, and shared settings entry behavior. [Entry tests](../tests/client-entry.spec.ts) check forwarding to the local directory service and registration of the shared flow. Browser theme and viewport review is separate from these jsdom checks.
