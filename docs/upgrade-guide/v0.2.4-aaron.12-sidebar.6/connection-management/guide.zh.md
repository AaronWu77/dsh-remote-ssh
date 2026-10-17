---
kind: upgrade-guide
description: "使用集成式 Remote SSH 诊断和受保护的设置保存，替代独立探针与无条件连接重置。"
---

# Remote SSH 连接管理

[English](guide.md) | 中文

## 变更

独立命令 `scripts/probe.mjs` 和 `scripts/probe-terminal.mjs` 已停用。诊断在经过认证的 Remote SSH 设置页内运行，与工作区连接共用 SSH/AHP 启动实现。报告不包含原始输出、目标、路径或连接凭据。

通过设置接口更换 SSH 配置时，如果存在受管理的远端执行或诊断，会拒绝保存；已有连接需要明确确认重置。设置写入必须携带期望版本以检测并发编辑；校验失败、版本冲突及应用结果不确定具有不同错误码。仅更改编辑器偏好不会释放 SSH 连接，也不会替换 Sidebar 应用内预览。

## 迁移

1. 构建并安装匹配的本地插件产物，保留 profile 和工作区记录。重启现有 Web 服务，然后刷新浏览器。
2. 打开 **设置 → Remote SSH → 高级设置**。编辑前读取生效设置。“恢复默认”只改草稿，保存后才生效。
3. API 客户端必须先读取 `GET /plugins/dsh-remote-ssh/settings`，再向原有 POST 接口传入 `expectedRevision`，以及在需要时传入 `confirmConnectionReset: true`。更换 SSH 配置前先结束活动任务。保存等待被中断后重新读取；取消不等于回滚。
4. 使用同页的 **连接诊断** 替代独立探针。基础检查只执行 SSH；深度检查可能创建独立 Agent Host、隧道和临时运行目录。终端验证需额外选择。任何诊断都不会安装远端软件。
5. 除连接各阶段成功外，还须确认清理成功。检查 Sidebar 文件链接仍在应用内打开，并确认取消诊断时正常工作区仍可使用。
