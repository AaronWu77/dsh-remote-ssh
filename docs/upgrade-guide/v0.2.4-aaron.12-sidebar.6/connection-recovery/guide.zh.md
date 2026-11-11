---
kind: upgrade-guide
description: "Remote SSH 自动启动优先使用已安装服务端，并限制 standalone CLI 的等待时间。"
---

# Remote SSH 启动与连接恢复

[English](guide.md) | 中文

## 变更

自动 `remoteCodeCommand: code` 启动按新到旧尝试已安装的 VS Code Server 候选，再尝试 standalone CLI。选择仍要求 AHP 协商成功；自定义命令保持权威。原先依赖 CLI 优先选择的部署现在可能使用已安装的兼容服务端。

manager 与 runtime 的 `embeddedStartupTimeoutMs` 和 `standaloneStartupTimeoutMs` 默认分别为 15000 与 30000 毫秒。候选启动、隧道和协议协商受这些预算及既有 `startupTimeoutMs` 总预算共同限制。standalone 下载需要更长时间时须显式配置。清理仍另有有界预算，完成后才启动下一候选。

传输断开后已连接的客户端失效。下一次显式请求仅在清理确认完成后重连，并发调用共享一次尝试。不会重放操作，也不恢复中断的终端。清理未确认时阻止替代连接，并保持错误可见。

## 迁移

1. 保留 profile、工作区目录记录和远端安装。结束活动远端任务后，在现有 Web 服务中重新构建并加载已安装插件。
2. CLI 下载较慢时，在 `remote-ssh-manager` 将 `standaloneStartupTimeoutMs` 设置为所需的正整数，并保留足够的 `startupTimeoutMs` 总预算。已安装候选需要超过 15 秒时设置 `embeddedStartupTimeoutMs`。自定义 runtime 条目接受相同字段。
3. 必须保持命令特定选择时，将服务器的 `remoteCodeCommand` 配置为显式 CLI 路径；不要仅为影响自动发现而移除已安装服务端。
4. 刷新浏览器并列出已有远端目录。使用隔离测试连接验证重连，不中断共享任务。断线时的命令或写入须经操作者核对后再决定是否重新提交。
