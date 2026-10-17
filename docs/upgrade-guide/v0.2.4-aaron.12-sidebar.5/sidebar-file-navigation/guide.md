---
kind: upgrade-guide
description: "Better Sidebar previews keep remote resource addresses rather than invoking external editor or download routing."
---

# Separate Sidebar preview from external remote-file opening

English | [中文](guide.zh.md)

## Change

Remote SSH `0.2.4-aaron.12-sidebar.6`, paired with Better Sidebar `0.19.3-remote.6`, delegates in-app file navigation unchanged when Better Sidebar is the active native editor implementation. The owning Session, path and navigation options stay on the original resource; a download-cache path does not replace them. Active and offscreen Sidebar opens retain their in-app behavior.

Without this native editor, Remote SSH retains its configured `openFileMode` editor/download behavior. The explicit `/plugins/dsh-remote-ssh/open-file` endpoint is unchanged. Disposing the navigator prevents pending catalog or download replies from opening a tab.

Do not disable remote alias validation to open a local snapshot. Remote filesystem errors, retired routes and outside-alias Windows paths still reject without switching to local files. Search limits and large-workspace search performance are unchanged.

## Migration

1. Stop Web and back up the current profile. Install Better Sidebar `0.19.3-remote.6` first, then Remote SSH `0.2.4-aaron.12-sidebar.6`; both archives belong to the same pair.
2. Keep the current SSH mapping and `openFileMode` setting. Enable Better Sidebar's native editor to use in-app remote previews; no cache or Session-data cleanup is required.
3. Start Web normally and refresh the existing page. Open the same remote README from the file tree and its conversation link. Both must show remote content and must not display a Windows temporary-cache path.
4. Verify standalone Remote SSH or explicit external opening separately if those modes are used. Their editor launch/download result is not a Sidebar preview.
5. For rollback, stop Web, reinstall both `.5` archives, restore the backup taken for this maintenance, then restart and refresh. Preserve aliases, retired-alias records and Session history.
