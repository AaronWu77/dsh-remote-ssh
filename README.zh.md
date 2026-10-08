# dsh Remote SSH

[English](README.md) | 中文

把 SSH 主机作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中的透明工作区使用。

选择 `LOCAL > project` 时，普通文件、搜索、shell 和后台任务工具在本机运行；选择 `<服务器> > project` 时，同一批工具改在对应 SSH 主机上运行。插件不会增加另一套 `remote_*` 工具，远端失败也绝不会回退本机。

## 功能

- 自动读取用户与系统 OpenSSH 配置，包括递归 `Include`，并发现其中的具体主机；
- 在设置页面管理多台 SSH 主机，以及每台主机上的多个工作区；
- 本机和远端使用同一个可编辑目录浏览器；
- 工作区与终端调用显示为 `LOCAL > ...` 或 `<服务器> > ...`；
- 文件系统、搜索、子进程、后台任务和终端都根据当前工作区透明路由；
- 为 `dsh-codex` 生图等制品插件提供二进制工作区写入；原始字节只在 AHP `resourceWrite` 传输内部编码为 base64；
- 远端搜索结果始终使用 POSIX 路径；超长工具结果保存在对应 SSH 主机的私有运行目录，可继续用 `read`/`grep` 分页读取；
- POSIX 远端工作区只显示 `bash`，Windows 本机工作区只显示 `pwsh`；
- 远端文件链接通过本机 VSC 兼容编辑器的 Remote SSH 打开；不可用时下载快照并在本机打开；
- 每台服务器复用一条 SSH/AHP 长连接；每次 Bash 调用像 VS Code 新建终端标签页一样打开独立 channel，不会重新进行 SSH 握手；
- 同一服务器上的多个工作区共享一个 host 级 SSH/AHP 连接；
- 删除远端映射后保留可阅读的 Workspace 与 Session 历史，但旧会话不能继续调用工具。

远端工作区目前支持 POSIX/Linux 主机，尚未支持 Windows SSH 主机。

## Agent Host 兼容性

此 fork 固定使用官方 AHP SDK 1.0.0，声明该 SDK 支持的 `1.0.0` 和 `0.9.0` 协议；不声明 `0.10.0`、`0.8.0` 或旧 `0.7.x`。不兼容的嵌入式候选会先停止，再尝试下一候选；成功连接会保留到插件释放。真实 Linux Agent Host 已协商 `0.9.0`，并通过 UTF-8 写入、二进制字节范围读取及终端执行测试。

manager 的 `protocolVersions: ["0.9.0"]` 可限制协商版本。修改版本列表或连接超时会清空 host/workspace 连接缓存。全部候选共用一次启动期限；runtime 的 `shutdownTimeoutMs` 控制停止进程的宽限时间。嵌入式服务器数据位于 `remoteRuntimeRoot` 下，远端进程组清理前会校验存活 PID 及唯一数据目录。

目录选择器显示本地化错误摘要和可展开详情。Web provider 的 `maxErrorCharacters` 默认值为 16384；URL/CLI 连接令牌会被遮盖。替换旧安装包前，请阅读 [fork 升级指南](UPGRADE.md)。

## 安装

此可编辑 fork 对应 DSH 0.2.0-rc.2。请构建并安装本地归档；npm registry 中的是上游版本，不包含此 fork 的适配：

```sh
pnpm install --ignore-scripts
pnpm run build
pnpm pack --pack-destination ./artifacts
dsh plugin --profile web add file:./artifacts/dsh-remote-ssh-0.2.4-aaron.3.tgz --ignore-scripts
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
2. 打开 **设置 → Remote SSH**。页面会自动读取平台默认的用户与系统 SSH 配置。
3. 测试主机，然后用 **浏览远端…** 选择工作区目录。
4. 在 `<服务器> > <目录>` 中新建或打开会话。

如需使用非默认配置，在 **设置 → 插件 → Remote SSH → 自定义 SSH 配置文件** 中填写绝对路径。

远端文件链接默认自动选择可用的 VSC 兼容编辑器。也可以在 **设置 → 插件 → Remote SSH → 远端文件打开方式** 中指定编辑器，或始终下载后在本机打开。

远端主机需要：

- POSIX shell，以及可非交互使用的 OpenSSH 连接；
- 用于 shell 和子进程执行的 `bash`、`base64` 与 `mkfifo`；
- 为 glob 和 grep 工具提供的 `rg`；
- 由官方 VS Code CLI 或已有 VS Code Server 提供的 VS Code Agent Host。

插件会依次检查 PATH 中的 `code`、私有位置 `~/.dsh-remote-ssh/cli/bin/code`，以及主机上已经缓存的兼容 VS Code Server。插件不会静默安装远端软件包。

## 工作区行为

当前工作区就是执行边界。远端会话中的绝对路径、可执行文件、shell 状态和搜索工具都在对应 SSH 主机上解析；即使本机存在同名文件或命令，也不会混用。

远端文件系统结果只显示 POSIX 路径。本机 Workspace 身份目录不会作为文件路径展示给模型，也不会经由联动插件输出。

工具结果超过内联上限时，远端会话的完整结果通过 AHP 写入该 SSH 主机的私有 runtime 目录，提示中的 locator 也是远端 POSIX 路径。本机 spill 后端仅供本机会话使用；未知或失效的会话不会回退到本机保存。`glob`/`grep` 的结果也会在官方工具执行后校正到远端 POSIX 路径，避免 Windows 宿主把 `/root/...` 显示成 `E:\root\...`。

移除远端映射不会删除它的本地身份目录、Workspace 记录、Session 或消息历史。旧会话仍然可读，但新的工具调用会 fail-closed，而不是意外落到本机执行。

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

为了让本机和远端工具保持一致语义，bundle 当前选择 `danger-full-access` 和 `never` approval policy。需要更强隔离时，请使用专用 Unix 账号、容器或虚拟机。

Web UI 不桥接密码、MFA 和首次 host-key 确认。请先通过 OpenSSH 完成这些步骤。

## 兼容性

- DeepSeek Harness `0.1.0-rc.6` package surface；
- POSIX/Linux SSH 主机；
- `@microsoft/agent-host-protocol` 0.7 客户端，并已针对 AHP 0.8 验证 Resource 与 Terminal 子集；
- 系统 OpenSSH 配置、SSH Agent、`known_hosts` 和 `ProxyJump`。
- 使用原生远端文件打开方式时，本机需要装有 Visual Studio Code、Cursor、Windsurf 或 VSCodium，以及兼容的 Remote SSH 扩展。

### 本地 0.2 Web profile

此 fork 使用 pnpm 11.7.0，安装 peer 对应 DSH 0.2.0-rc.2。设置通过 manager 的 volatile profile 配置和 `settings.replace` 保存，不替换运行中的 manager，也不清除其 Session 绑定。本地目录选择使用 `uiWorkspace.listDirectory`；文件资源通过地址所属的 Session 和 `sidebarRight.openResource` 打开，原生打开失败时使用内置预览。

PTC 解释器使用保留的本地文件系统和 subprocess provider：AHP 不能承载其控制管道和本机启动文件。通过 `tools` 发起的调用仍使用路由后的 provider；直接导入 Node 文件系统或进程模块的操作仍在本机执行。安装后需要重启现有 Web 服务；仅刷新页面不会加载新的 profile bundle。

## 已知限制与后续工作

- 此次适配未提供真实 SSH 目标。SSH 部署、远端 GUI 交互终端、原生编辑器启动及可选 TUI 适配器需要针对实际目标验证。自动终端环境探测目前仍跟随本机；远端终端需要 POSIX shell 参数。
- AHP 0.7 只支持完整资源读取。字节范围读取会在 `maxReadBytes` 上限内下载整个资源后切片，默认上限为 64 MiB。
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
