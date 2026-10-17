---
kind: upgrade-guide
description: "Sidebar search returns bounded relative filename matches instead of remote entry arrays or budget-overflow errors."
---
# Remote Sidebar filename search

English | [中文](guide.zh.md)

## Change

Remote SSH `0.2.4-aaron.12-sidebar.5` requires Better Sidebar `0.19.3-remote.5` when the Sidebar integration is installed. Its filesystem provider returns `{ matches: string[], truncated: boolean }`; matches are Session-root-relative `/` paths, not `{ name, path }` records or absolute POSIX paths.

Reaching a row, examined-entry, match or depth limit preserves collected matches and sets `truncated: true`. Existing defaults remain 200 rows per directory and returned matches, 10000 examined entries per search, and depth 32. A partial empty result is not a completed no-match search. VCS, dependency and build-cache directories are skipped; symlinks are not descended. Actual transport, permission, revoked-route and canonical-path failures still reject, without local fallback.

Search accepts an optional `AbortSignal`. Cancellation stops subsequent traversal; an in-flight non-abortable AHP directory listing still has to settle. AHP directory transfers themselves are not paginated by these limits.

## Migration

1. Retain both `.3` archives and the Web profile manifest, lockfile and patch. Stop the service before installing either candidate; patch watching can otherwise load mixed generations.
2. Install `dsh-better-sidebar-0.19.3-remote.5.tgz` first and `dsh-remote-ssh-0.2.4-aaron.12-sidebar.5.tgz` second. Custom consumers of `createSidebarWorkspace().fs.search` must use `result.matches` and check `result.truncated`; pass a caller signal when available and await settlement before releasing resources.
3. Do not change SSH mappings, Session roots or search limits for this migration. Start the service yourself and refresh the existing GUI. The operator then verifies filename matches open the remote file and bounded results show the partial-search notice. Typecheck and behavioral regressions cover custom-provider changes; production confirmation follows installation.
4. To roll back, stop the service, restore both `.3` packages and the backed-up profile files, then start and refresh. Session data does not require migration.
