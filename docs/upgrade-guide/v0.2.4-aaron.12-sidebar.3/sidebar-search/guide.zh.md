---
kind: upgrade-guide
description: "侧栏搜索改为返回受限的相对文件名匹配，不再返回远端目录项数组或预算溢出错误。"
---
# 远端侧栏文件名搜索

[English](guide.md) | 中文

## 变更

启用侧栏联动时，Remote SSH `0.2.4-aaron.12-sidebar.5` 须配套 Better Sidebar `0.19.3-remote.5`。其文件系统 provider 返回 `{ matches: string[], truncated: boolean }`；匹配项是相对于会话根目录的 `/` 路径，不是 `{ name, path }` 记录或 POSIX 绝对路径。

达到行数、已检查目录项、匹配数或深度上限时，保留已收集匹配并设置 `truncated: true`。现有默认值继续是每目录 200 行和最多 200 个返回匹配、每次搜索检查 10000 个目录项、深度 32。空的部分结果不等于完整搜索没有匹配。跳过版本控制、依赖及构建缓存目录，不进入链接目录。真正的传输、权限、已撤销路由和规范路径错误仍会拒绝，不回退本机。

搜索接受可选 `AbortSignal`。取消后停止后续遍历；进行中且不可中断的 AHP 目录请求仍须结束。这些上限不对 AHP 目录传输本身进行分页。

## 迁移

1. 保留两个 `.3` 归档以及 Web profile 的清单、锁文件和 patch。安装任何候选包前停止服务，否则 patch watcher 可能加载混合代的模块。
2. 先安装 `dsh-better-sidebar-0.19.3-remote.5.tgz`，再安装 `dsh-remote-ssh-0.2.4-aaron.12-sidebar.5.tgz`。自定义 `createSidebarWorkspace().fs.search` 消费者须读取 `result.matches` 并检查 `result.truncated`；调用者有取消信号时应传入，释放资源前等待操作结束。
3. 此迁移不需要更改 SSH 映射、会话根目录或搜索上限。自行启动服务并刷新现有 GUI，然后由操作者验证搜索匹配可打开远端文件、受限结果显示部分搜索提示。自定义 provider 更改须通过类型检查与行为回归，正式环境确认在安装之后执行。
4. 回退时先停止服务，恢复两个 `.3` 包与备份 profile 文件，再启动并刷新。会话数据无需迁移。
