---
kind: upgrade-guide
description: "Better Sidebar 工作区要求配套宿主能力桥接，才能访问 Remote SSH 的文件、Git 和终端。"
---

# 配套安装 Remote SSH 与侧栏工作区桥接

[English](guide.md) | 中文

## 变更

Remote SSH 增加了 `dsh-remote-ssh/sidebar-bridge` 组合条目，通过宿主提供的 `sidebarWorkspaceProviders` 服务注册执行路由。桥接没有对 Better Sidebar 的运行时依赖；发布声明使用只供类型导入的 `dsh-better-sidebar/workspace-provider` 出口。没有 Better Sidebar 时，该条目保持未激活状态。

使用配套侧栏候选包时，配置了 Remote SSH manager 却没有桥接的工作区请求会返回 HTTP 503，而不是选择本机文件系统。权威会话头选择执行宿主和目录。禁用桥接会撤销保留的适配器、取消尚未完成的操作，并等待上传、Git 与终端清理，而不退役共享 manager 路由。移除 manager 后，当前侧栏实例仍会拒绝缺少路由的执行。移除远端映射会使旧别名不可用；浏览器 `cwd` 字段不能恢复执行。关闭工作区围栏只允许访问同一宿主上会话目录之外的路径，不能改选执行宿主。

桥接 `pathMetadata` 默认为 `posix`：远端 GNU `realpath`、`stat` 和 `base64` 提供规范路径和链接本身的元数据。只有验证服务端遵守 `followSymlinks` 并返回规范 URI 后，才能设置为 `ahp`；仅凭协议版本不能确定该行为。已部署的 0.9.0 服务端可能跟随链接后仍返回请求 URI。

远端读取要求完整资源不超过 `fullReadMaxBytes`；AHP 资源 API 不支持有界局部预览请求。Git 要求 stdout 和 stderr 完整、各自有字节上限，并确认清理完成。进程成功退出但输出排空超时不属于成功 Git 结果。搜索耗尽预算会明确报错，不会将部分搜索当作成功。上传只在完整有界写入后发布，并拒绝已有目标。元数据 shell 或发布清理的结果不确定时，会保留所有权，并阻止桥接成功释放或路由退役。

## 迁移

1. 安装两份配套候选归档前，先停止 Web 服务。实时重载 profile 可能立即激活替换内容；仅计划稍后重启并不能防止这种更新。保留旧归档以及 profile manifest/lock 备份用于回滚。
2. 保留 Remote SSH bundle patch 中的 `remote-ssh-sidebar-workspace` 条目。自定义组合须在同一服务域内挂载 `dsh-remote-ssh/sidebar-bridge`、`remoteSshManager` 和 `sidebarWorkspaceProviders`。不要在运行时导入侧栏类型出口。
3. 根据部署需求配置桥接 `fullReadMaxBytes`、`writeMaxBytes`、上传分块上限、搜索预算、Git 字节上限、清理宽限、输出传输上限，以及 `terminalArgv`、`terminalEnv`、`terminalType`。Loader schema 提供明确默认值。远端终端使用这些配置，不使用本机侧栏 shell 覆盖值或宿主进程环境。
4. 启动服务后，确认文件读取、上传、Git 状态和终端输入都使用所选 SSH 宿主上的私有目录。移除映射后，确认新请求失败，而不是访问本机别名目录。会话日志和远端业务文件不需要迁移。
