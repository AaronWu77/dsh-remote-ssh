---
kind: "package-bundle"
description: "将 SSH 主机作为工作区使用，集成文件、搜索与 Shell。"
---

# dsh Remote SSH

<a id="plugin-information"></a>
## 插件信息

将 SSH 主机作为工作区使用，集成文件、搜索与 Shell。

| 字段 | 内容 |
|---|---|
| 包名 | `dsh-remote-ssh` |
| 当前 checkout 版本 | `0.2.4-aaron.12-sidebar.6` |
| 维护仓库 | [AaronWu77/dsh-remote-ssh](https://github.com/AaronWu77/dsh-remote-ssh) |
| 包许可证 | Apache-2.0 |

包身份、许可证和上游声明以 [package.json](package.json) 为准。checkout 版本不代表已发布版本或经过验证的兼容性；下文已有的验证范围与部署限制仍然适用。

<a id="source-and-attribution"></a>
## 来源与归属

- [dsh-remote-ssh](https://github.com/Yan-Zero/dsh-remote-ssh) — 基于上游改造; Apache-2.0; 未记录精确上游基准。 本地 DSH 兼容、远程工作区路由与连接诊断。 [详细记录](https://github.com/AaronWu77/dsh-remote-ssh/blob/HEAD/UPGRADE.md)。

维护中的 fork 与上游项目属于不同仓库。原作者、版权、许可证与通知声明继续保留；缺失的上游基准不根据本地版本推断。

## 0.2.1-rc.2 隔离候选资格（2026-10-17）

本节覆盖当前 fork 候选，后文历史真实 Linux/AHP 记录不是本轮 rc.2 的 canary。基线已是显式 schema 声明修复 `b9c5f53`；Remote `0.2.4-aaron.12-sidebar.6` 面向 Host `0.2.1-rc.2 / 687f282`。本节所限定的 Better Sidebar 桥接已移除。实际链接为 Cordis `4.0.5`、Schemastery `3.18.5`；DSH dev pin 为 rc.2，peer/engines 保留 alpha.2 并加入 rc.2，**不宣称旧版已重验**。候选根统一冻结依赖，本包没有另行 install。

- focused `--maxWorkers=1`：主 lane 19 文件 **162 通过**；Git 仅 mock route 组 **10 通过、7 未选**（不执行真实 local output scripts）；有界脱敏诊断展示 **5 通过**。合计 21 文件 **177 通过、7 未验证**。真实内存 Connection 的 3 个用例已计入主 lane；真实 SSH/live suites 没有运行，更不能把它们的 self-skip 当通过。
- 覆盖 Sidebar bridge/workspace 的 POSIX/alias/会话 symlink containment、字节读取/上传/PTY 输入 resize 与最终输出、撤销/cleanup ACK 与不确定清理、Git deadline/流结束所有权；expectedRevision、active-run/diagnostic 拒绝危险配置、reset 确认、editor-only 不断连；mock startup deadline/fallback/retry、cleanup 必须成功、诊断长度/令牌脱敏。任意远端 shell 的 `danger-full-access` 要求及受限模式拒绝保持不变，不回退本地、不自动重放操作；cancel 不保证 rollback。
- rc.2 的 raw `requestRejection` 可接受 live API Peer，**不是** Connection exact-fetch 的 owner 授权。新 Host 提供 `admit` 时本插件另验 owner；当前 Host 交换的 API credential 本身即为 owner，没有复现默认非 owner 越权。匿名/坏 Origin、释放后的 cookie、未来非 owner 负例在处理请求体/资源前拒绝；旧 Host 无 `admit` 时维持原栅栏。
- 顺序 Sidebar build → Remote build（含 typecheck）→ Remote 独立 typecheck 通过；此前并发清空 Sidebar lib 造成的缺类型错误不算产品缺陷。未改 snapshot expected；没有升级第三方功能或修改外观。**未启动 DSH 服务、真实 SSH/provider，未验证真实 profile/browser/远端或原生进程清理**；真实 Loader/浏览器/SSH/AHP canary 仍缺资格。未部署/commit/push，必须双包停服后一起更换。


[English](README.md) | 中文

把 SSH 主机作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中的透明工作区使用。

选择 `LOCAL > project` 时，普通文件、搜索、shell 和后台任务工具在本机运行；选择 `<服务器> > project` 时，同一批工具改在对应 SSH 主机上运行。插件不会增加另一套 `remote_*` 工具，远端失败也绝不会回退本机。

宿主拥有的 bootstrap 和附件路径通过保留的本地文件系统映射。远程工作区别名不会被映射成本地宿主资源。PTC 解释器使用本地文件系统和子进程隔离域；替换 PTC 提供器时须保留原运行时条目的这两个隔离配置。

## 功能

- 自动读取用户与系统 OpenSSH 配置，包括递归 `Include`，并发现其中的具体主机；
- 在设置页面管理多台 SSH 主机，以及每台主机上的多个工作区；
- 本机和远端使用同一个可编辑目录浏览器；
- 工作区与终端调用显示为 `LOCAL > ...` 或 `<服务器> > ...`；
- 文件系统、搜索、子进程、后台任务和终端都根据当前工作区透明路由；
- 为 `dsh-codex` 生图等制品插件提供二进制工作区写入；原始字节只在 AHP `resourceWrite` 传输内部编码为 base64；
- 远端搜索结果始终使用 POSIX 路径；超长工具结果保存在对应 SSH 主机的私有运行目录，可继续用 `read`/`grep` 分页读取；
- POSIX 远端工作区只显示 `bash`，Windows 本机工作区只显示 `pwsh`；
- 远端工作区的对话文件链接通过 Remote SSH 的打开文件流程处理：使用本机 VSC 兼容编辑器，不可用时下载本地快照，并在输入区说明为何没有打开编辑器；
- 每台服务器复用一条 SSH/AHP 长连接；每次 Bash 调用像 VS Code 新建终端标签页一样打开独立 channel，不会重新进行 SSH 握手；
- 同一服务器上的多个工作区共享一个 host 级 SSH/AHP 连接；
- 删除远端映射后保留可阅读的 Workspace 与 Session 历史，但旧会话不能继续调用工具；
- 在工作区列表里起的名字在重启和配置变更后仍然保留。

远端工作区目前支持具有可读 `/proc`、`ps`、`awk` 及外部 `kill` 可执行文件的 Linux 主机。不支持 Windows 或其他非 Linux POSIX SSH 主机。

Windows 盘符与 UNC 文件地址属于本地主机，除非明确匹配已登记的远程别名。在 Windows 主机上，丢失一个前导分隔符的 WSL share 地址也保持本地含义，不会被解释为当前 SSH 服务器上的 POSIX 路径。本地 WSL 文件打开委托给客户端内置导航处理器，继续进行路径规范化和权限检查。POSIX 主机命名空间里的真实 Linux `/wsl.localhost/…` 路径仍保留远端含义。

## Agent Host 兼容性

此 fork 固定使用官方 AHP SDK 1.0.0，声明该 SDK 支持的 `1.0.0` 和 `0.9.0` 协议；不声明 `0.10.0`、`0.8.0` 或旧 `0.7.x`。不兼容的嵌入式候选会先停止，再尝试下一候选；成功连接会保留到传输断开或插件释放。真实 Linux Agent Host 已协商 `0.9.0`，并通过 UTF-8 写入、二进制字节范围读取及终端执行测试。

manager 的 `protocolVersions: ["0.9.0"]` 可限制协商版本。修改版本列表或连接超时会清空 host/workspace 连接缓存。所有 SSH 传输都带 `-o BatchMode=yes` 与 `connectTimeoutMs`（默认 10000，按秒取整写入命令行），因为没有任何通道能回答交互式提示。每一轮启动尝试为自己的全部候选共用一次启动期限；超时或释放后不会再启动该轮的候选或隧道。runtime 的 `shutdownTimeoutMs` 控制 TERM 宽限及 KILL 后等待时间。嵌入式数据位于 `remoteRuntimeRoot` 下；清理会验证组长的数据目录，并在组长退出后保留成员的启动身份。仅在进程组不再有存活成员时报告清理成功。工作区可映射远端任意目录，但不能映射远端根 `/`：在 POSIX 主机上它会认领所有 POSIX 绝对路径，因此在配置校验阶段即被拒绝。

目录选择器显示本地化错误摘要和可展开详情。运行时生命周期失败在 Web 响应中保留 `connection_closed`、`candidate_startup_timeout` 或 `cleanup_failed` 错误码，并使用 HTTP 503；技术详情仍有长度上限且连接令牌已遮盖。Web provider 的 `maxErrorCharacters` 默认值为 16384，且只在组合提供了 `connection` 时注册路由：每个路由先向该服务的浏览器信任栅栏要一个拒绝（401/403），未认证或形似 DNS rebinding 的调用者无法进入任何处理函数。URL/CLI 连接令牌会被遮盖。替换旧安装包前，请阅读 [fork 升级指南](UPGRADE.md)。

## SSH 执行诊断与自定义配置

启动进程无输出但非零退出时，仍保留阶段和 SSH 退出码。嵌入式发现执行失败返回 `ssh_execution_failed`，不能解释为未安装 Agent Host；仅退出码 0 且候选列表为空才代表没有已安装的嵌入式 Host。候选协议兼容性失败仍为 `agent_host_unavailable`。仅凭退出码 255 不能认定认证失败：应先检查有长度上限且连接令牌已遮盖的详情，以及本机 SSH 启动环境（包括 Windows 的 `ProgramData`）。插件不会修复启动器环境变量，也不会自动切换到 Git SSH。一次失败不会让连接永久失效：本次清理成功后，下一次显式请求会以新的期限启动新一轮尝试，已在等待的请求共享进行中的那一轮。清理失败时该失败保持可见，且不会开始新的尝试。不会重放任何文件、搜索或终端操作。

SSH 隧道、自有 Agent Host 进程或 AHP 连接关闭后，已成功连接的客户端即失效。清理确认完成后，下一次显式目录刷新或连接请求启动新一轮尝试，并发请求共享该轮连接；没有后台重试循环。旧尝试迟到的关闭事件不会影响后继连接。无法确认清理时，后续显式请求可重新检查清理，但在资源身份得到确认前不能启动替代连接。中断的写入和命令仍按失败或结果未知处理；新连接不会恢复其终端通道。

manager 的 `sshConfigFile` 同时控制发现和实际连接：runtime 启动、隧道、清理及 Web 测试统一传入一个 `-F <所选绝对路径>`。未设置时不额外传入 `-F`，沿用 OpenSSH 默认配置。服务器现有的用户、ProxyJump、身份文件参数保持不变。选择自定义文件后，服务器 `sshArgs` 中分离、紧连或组合形式的 `-F` 均被拒绝，即使文件相同；请移除该参数，改用 manager 设置。未选择 manager 覆盖时，仍支持显式服务器参数。更改该设置会释放缓存的 host/workspace 传输并更换复用连接键。runtime 连接超时默认仍为 10 秒，Web 测试仍为 5 秒。

## 安装

此可编辑候选 checkout 声明 DSH `0.2.1-alpha.2 || 0.2.1-rc.2` peer/engines，开发依赖精确钉 rc.2（验证范围以上方资格说明为准）。请构建并安装本地归档；npm registry 中的是上游版本，不包含此 fork 的适配：

```sh
pnpm install --ignore-scripts
pnpm run build
pnpm pack --pack-destination ./artifacts
# 替换已安装 bundle 前，先停止 Web 服务。
dsh plugin --profile web add file:./artifacts/dsh-remote-ssh-0.2.4-aaron.12-sidebar.6.tgz --ignore-scripts
dsh web
```

如需启用可选的 dsh-tui 适配器，把同一个 bundle 安装到该 profile：

```sh
dsh plugin --profile dsh-tui add dsh-remote-ssh
dsh-tui
```

进入 TUI 后，`/workspace remote`（或 `/workspace connect`）会先显示 SSH 设备列表，
再浏览并选择远端目录；`/workspace resume` 列出已有工作区。也可以直接打开：

目录浏览器中，Enter 选择当前目录；在第一行按 Tab 可以编辑或粘贴远端绝对路径，
再按 Enter 读取该目录。

```text
/workspace open ssh://server-id/srv/project
/workspace open ssh://user@example.com:2222/home/user/project
```

启动器也接受同一 URI（`dsh-tui ssh://server-id/srv/project`）。首次出现的直连
目标会写入 Remote SSH 设置。`/workspace open ../other-project` 等相对路径在当前远端
POSIX 路径空间内解析，`!command` 则通过当前工作区的远端 shell 执行。该适配器
完全可选：dsh-tui 内没有 SSH 专属协议或界面代码，未安装本包时仍完整支持本地工作。

从 DeepSeek Harness 源码 checkout 运行时，用 `pnpm dsh` 代替 `dsh`。本地开发插件时：

```sh
pnpm install
pnpm run check
pnpm dsh plugin --profile web add link:E:/absolute/path/to/dsh-remote-ssh
pnpm dsh --profile web
```

Codex、Claude Code 及其他自动化 Agent 应直接遵循 [INSTALL.md](INSTALL.md)。它是一份完整且可重复执行的安装 runbook。

## 设置主机

1. 先用普通 OpenSSH 配置并验证主机，推荐使用 SSH Key 或 SSH Agent 认证。
2. 打开 **设置 → Remote SSH**。该行在设置导航中使用链环图标。页面会自动读取平台默认的用户与系统 SSH 配置。
3. 测试基本 SSH 访问，然后点击 **添加工作区**、选择 SSH 主机，等待目录列表加载后确认文件夹。
4. 在 `<服务器> > <目录>` 中新建或打开会话。

打开 **设置 → Remote SSH → 高级设置**，选择自定义 SSH 配置的绝对路径，或留空使用平台默认配置。这些偏好作用于整个 manager，不限于单台服务器。“恢复默认”只改草稿；保存时验证宿主文件并回读保存版本。存在活动远端执行或诊断时会阻止 SSH 配置变更，已有连接需要确认重置。仅修改编辑器偏好不会重置 SSH 连接。中断保存后的结果须重新读取才能确认，不会自动重发或声称已经回滚。

远端文件链接通过 Remote SSH 的打开文件流程处理：默认使用本机 VSC 兼容编辑器并通过 Remote SSH 打开，不可用时下载本地快照，并在输入区说明为何没有打开编辑器。外部模式及可选的自定义可执行文件通过宿主配置字段 `remote-ssh-manager.openFileMode` 和 `openFileEditorPath` 指定；本机文件链接仍使用应用内侧栏行为。

远端主机需要：

- POSIX shell，以及可非交互使用的 OpenSSH 连接；
- 用于 shell 和子进程执行的 `bash`、`base64`、`mkfifo`、`dd` 与 `mv`；
- 为 glob 和 grep 工具提供的 `rg`；
- 由官方 VS Code CLI 或已有 VS Code Server 提供的 VS Code Agent Host。

默认使用 `remoteCodeCommand: code` 时，插件先按新到旧探测已安装的 VS Code Server 候选，以实际 AHP 协商成功的首个候选建立连接。已安装候选全部失败后才尝试 PATH 中的 `code`；PATH 没有 `code` 时使用 `~/.dsh-remote-ssh/cli/bin/code`。显式自定义命令保持权威，不会被已安装候选替换。standalone CLI 可能下载 Agent Host；插件不会安装远端系统软件包。

manager 与 runtime 的 `embeddedStartupTimeoutMs`（15000）和 `standaloneStartupTimeoutMs`（30000）限制每个候选的启动、隧道及协商阶段；各阶段也受 `startupTimeoutMs`（600000）剩余总预算限制。所有预算必须是正安全整数；清理另受有界的关闭及请求预算限制。修改 manager 预算会释放缓存的主机连接。详见[连接恢复升级指南](docs/upgrade-guide/v0.2.4-aaron.12-sidebar.6/connection-recovery/guide.zh.md)。

## 连接诊断

在同一设置页保存或放弃偏好草稿后，使用 **连接诊断**。基础检查执行 SSH 并报告可用命令。深度检查创建独立前台 Agent Host、协商 AHP 并读取所选目录；终端验证为可选项，使用固定命令。缺少搜索工具时会提示，但不会阻止无关的目录检查。深度诊断可能创建远端临时文件和进程，但不会安装软件或修改工作区内容。

取消仅停止诊断自身拥有的资源。浏览器取消请求丢失时，由任务租约兜底。清理结果独立于连接成功报告；缺少远端进程身份或无法确认退出时，必须显示失败，不能报告已清理。导出报告不包含原始 SSH 输出、地址、账号、路径、参数或令牌。报告保留配置版本，偏好变更后标记过期。报告只保存在内存中，到期或服务重启后消失。

Web 提供器开放 `diagnosticTimeoutMs`（120000）、`diagnosticTerminalTimeoutMs`（15000）、`diagnosticLeaseMs`（45000）、`diagnosticRetentionMs`（600000）、`diagnosticMaxConcurrent`（2）及 `diagnosticMaxRetained`（20）。已退休的独立探针由这套经过认证的流程替代，详见[连接管理升级指南](docs/upgrade-guide/v0.2.4-aaron.12-sidebar.6/connection-management/guide.zh.md)。

## 工作区行为

当前工作区就是执行边界。远端会话中的绝对路径、可执行文件、shell 状态和搜索工具都在对应 SSH 主机上解析；即使本机存在同名文件或命令，也不会混用。

远端文件系统结果只显示 POSIX 路径。本机 Workspace 身份目录不会作为文件路径展示给模型，也不会经由联动插件输出。

工具结果超过内联上限时，远端会话的完整结果通过 AHP 写入该 SSH 主机的私有 runtime 目录，提示中的 locator 也是远端 POSIX 路径。本机 spill 后端仅供本机会话使用；未知或失效的会话不会回退到本机保存。`glob`/`grep` 的结果也会在官方工具执行后校正到远端 POSIX 路径，避免 Windows 宿主把 `/root/...` 显示成 `E:\root\...`。

**删除工作区**会同时移除 Workspace 注册记录和 Remote SSH 映射，不会删除远端目录、本地身份目录、Session 日志或消息历史。映射会先持久停用，再删除注册记录；注册删除失败时会恢复映射，或明确报告回滚错误。设置中的**移除执行映射**保留 Workspace 注册记录和历史。两种操作都使旧别名在重启后仍不能回退本机；旧会话仍可读取，但不能执行。

重复选择相同服务器和规范化后的远端目录会复用已有映射。已有重复映射保留各自的别名和历史；同一服务器的原始远端路径使用首个匹配映射，不同服务器上同等具体的路径会被拒绝。工作区创建请求完成前会禁用重复提交和取消；关闭后的流程忽略迟到的选择回调，错误在选择流程或设置页内显示。

本机和远端目录都使用相同的应用内浏览器，不依赖原生目录选择器，也避开了 [DeepSeek Harness discussion #396](https://github.com/deepseek-ai/deepseek-harness/discussions/396) 中的 Windows 路径问题。

## Agent Host 更新

插件不会自行维护或重新分发 VS Code Server 压缩包。官方 standalone VS Code CLI 负责下载、缓存、启动和更新 Agent Host；CLI 自身支持：

```sh
code update --check
code update
```

AHP 协议协商与二进制更新相互独立。如果新缓存的 Agent Host 超出了插件验证过的协议范围，Remote SSH 会尝试其他兼容缓存；如果没有兼容版本，则明确显示客户端提供和服务端接受的协议版本。

## 安全

远端命令拥有 SSH 账号本身的权限。AHP permission 不是操作系统 sandbox；当 dsh 策略允许 Full Access 时，同一 SSH 账号通常也能访问所选工作区之外的路径。

bundle 保留 profile 的 sandbox 和 approval 默认配置。文件系统路由转发本地提供方的隔离模式，使 write 和 edit 接收调用 Session 的沙箱策略，而不是无 agent 的部署默认值。本机 shell 调用使用官方 sandbox Bash 或 PowerShell executor，保留逐次调用的隔离、拒绝信息、runner 故障、取消和托管进程清理语义。远端 shell 在选择远端执行环境后拒绝 `read-only` 和 `workspace-write`，绝不回退到本机。只有接受 SSH 账号访问范围时，才应为远端 Session 显式选择 `danger-full-access`。需要更强的远端隔离时，请使用专用 Unix 账号、容器或虚拟机。

Shell 配置保留可实时更新的 `cwd`、`timeoutMs`、`maxTimeoutMs`、`maxOutputBytes`、`maxSpillBytes`、`graceMs` 和 `pwshPath`。PowerShell 也接受旧版 `executable` 覆盖。Bash 仅接受不设置 `executable` 或字面值 `bash`；自定义可执行路径在加载时明确拒绝，因为官方 executor 使用 PATH 中的 Bash。携带 Session id 的调用必须有对应的活动执行环境绑定；已释放或未知的 Session 绝不根据路径文本选择主机。

Web UI 不桥接密码、MFA 和首次 host-key 确认。请先通过 OpenSSH 完成这些步骤。

## 兼容性

- 声明的 DeepSeek Harness peer 依赖版本为 `0.2.1-alpha.2`；
- POSIX/Linux SSH 主机；
- `@microsoft/agent-host-protocol` 1.0.0 客户端，提供 AHP 1.0.0 和 0.9.0 协议；
- 系统 OpenSSH 配置、SSH Agent、`known_hosts` 和 `ProxyJump`。
- 使用原生远端文件打开方式时，本机需要装有 Visual Studio Code、Cursor、Windsurf 或 VSCodium，以及兼容的 Remote SSH 扩展。

### 本地 0.2 Web profile

外层本地插件工作区固定使用 pnpm 11.28.5；此 checkout 声明 DSH 0.2.1-alpha.2 peer 依赖。设置通过 manager 的 volatile profile 配置和 `settings.replace` 保存，不替换运行中的 manager，也不清除其 Session 绑定。本地目录选择使用 `uiWorkspace.listDirectory`；文件资源通过地址所属的 Session 处理，远端地址走 Remote SSH 的打开文件流程，失败时使用内置预览。

PTC 解释器使用保留的本地文件系统和 subprocess provider：AHP 不能承载其控制管道和本机启动文件。通过 `tools` 发起的调用仍使用路由后的 provider；直接导入 Node 文件系统或进程模块的操作仍在本机执行。安装后需要重启现有 Web 服务；仅刷新页面不会加载新的 profile bundle。

### 子进程输出上限

`remote-ssh-subprocess` 路由器提供 `outputChunkBytes`（默认 65536 字节）和 `outputPollMs`（默认 40 毫秒）。每个进程分别使用 stdout/stderr FIFO 泵，每个流拥有一个不可变分块槽。远端输出文件连同临时文件最多占用两倍分块大小。每次输出资源读取最多包含 `4 * ceil(chunkBytes / 3)` 个 base64 字符及 AHP 元数据；每个输出字节只读取一次。消费者背压会延迟确认，而不是累积不断增长的输出文件。管道保留有上限的 Node 流缓冲区和一个待处理分块；收集输出使用请求指定的尾部和 spill 上限。spill 路径指向保留的本机托管输出收集器。

取消只终止调用者对共享连接的等待。普通 shell 执行必须获得终端释放确认或观察到终端退出，才能释放工作区所有权。子进程准备和主执行需要相同的清理确认；已发送的包装脚本还必须在 `graceMs` 内发布停止标记。无法确认终止时会拒绝删除、阻止工作区路由并保留私有资源 URI 供检查。AHP 无法观察任意逃逸的后代进程或未记录的 MSYS 辅助 fork 子进程；stdin 终端发送和进行中的数据 RPC 超时是独立限制。重复发生的不可观察终止失败可能保留多个私有目录。

## 已知限制与后续工作

- 此次适配未提供真实 SSH 目标。SSH 部署、远端 GUI 交互终端、原生编辑器启动及可选 TUI 适配器需要针对实际目标验证。自动终端环境探测目前仍跟随本机；远端终端需要 POSIX shell 参数。
- AHP 1.0 只支持完整资源读取。字节范围读取会在 `maxReadBytes` 上限内下载整个资源后切片，默认上限为 64 MiB。
- 远端不支持控制管道，目前仅支持 POSIX/Linux 主机。
- 源码检查和不监听端口的 profile 启动不能验证 GUI 渲染或远程连接。

路由、协议、权限与生命周期细节见[设计文档](docs/design.md)。

## 开发

```sh
pnpm install
pnpm run check
node scripts/integration-ssh.mjs my-host /tmp/dsh-remote-ssh-integration/workspace
node scripts/integration-transparent.mjs my-host /tmp/dsh-remote-ssh-integration/workspace
```

真实集成脚本只修改显式传入的远端测试工作区和插件自己的运行时路径。

## 许可证

Apache-2.0。插件只调用用户的官方 VS Code CLI/Server，不重新分发 VS Code Server；官方 Server 的使用仍受 Microsoft VS Code Server License Terms 约束。
