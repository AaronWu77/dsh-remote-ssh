---
kind: upgrade-guide
description: "Better Sidebar 预览保留远端资源地址，不调用外部编辑器或下载路由。"
---

# 分开侧栏预览与外部远端文件打开

[English](guide.md) | 中文

## 变更

Remote SSH `0.2.4-aaron.12-sidebar.6` 与 Better Sidebar `0.19.3-remote.6` 配套。当 Better Sidebar 是当前原生编辑器实现时，Remote SSH 原样委派应用内文件导航。所属会话、路径和导航选项保留在原资源上，不会被下载缓存路径替换。当前显示与未显示会话的侧栏打开都保留应用内行为。

没有该原生编辑器时，Remote SSH 保留配置的 `openFileMode` 编辑器与下载行为。显式 `/plugins/dsh-remote-ssh/open-file` 端点保持不变。导航器释放后，仍在等待的目录信息或下载回复不能再打开标签。

不要为了打开本地快照而关闭远端别名校验。远端文件系统错误、失效路由和别名外 Windows 路径仍会拒绝，不会切换读取本地文件。搜索上限和大型工作区的搜索性能保持不变。

## 迁移

1. 停止 Web 并备份当前 profile。先安装 Better Sidebar `0.19.3-remote.6`，再安装 Remote SSH `0.2.4-aaron.12-sidebar.6`；两个归档属于同一配套版本。
2. 保留当前 SSH 映射和 `openFileMode` 设置。启用 Better Sidebar 原生编辑器以使用应用内远端预览；不需要清理缓存或会话数据。
3. 按原有方式启动 Web 并刷新现有页面。从文件树和对话链接分别打开同一个远端 README。两者都应显示远端内容，不应显示 Windows 临时缓存路径。
4. 如使用单独的 Remote SSH 或显式外部打开，应分别验收。这些模式的编辑器启动与下载结果不是侧栏预览。
5. 如需回退，先停止 Web，重装两个 `.5` 归档，恢复本次维护前备份，再启动并刷新。保留别名、失效别名记录和会话历史。
