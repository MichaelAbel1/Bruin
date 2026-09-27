# Bruin

Bruin 是一个以 TypeScript 实现的本地编码 Agent，提供 **Electron 桌面图形界面** 和命令行入口。两种入口共用多模型接入、SQLite 会话事件日志、独立工具执行进程、逐次工具授权、会话恢复和可安装的 Skills。安全边界及生产部署条件见 [安全说明](docs/SECURITY.md)。

## 环境与安装

- Node.js 20 或更新版本；推荐当前受支持的 LTS 版本。
- 桌面版构建推荐 Node.js 22.12 或更新版本，以符合 Electron 构建依赖的引擎要求。
- npm、Git、ripgrep (`rg`)。安装 GitHub Skill 时需要 Git；`search` 工具需要 `rg`。
- macOS 可使用内置 `sandbox-exec` 执行 Shell；其他平台应配置 Docker 沙箱。Docker 模式需要可用的 Docker daemon 和本地镜像。

```sh
cd /Users/bear/Projects/agentProjects/Bruin
npm ci
npm run check
npm test
npm run build
node dist/cli.js --help
```

## 桌面图形界面

```sh
npm run desktop:dev    # 开发模式启动 Electron + React 界面
npm run desktop:pack   # 生成当前平台的未签名应用目录
npm run desktop:dist   # 生成当前平台安装包
```

桌面版提供会话列表、流式对话、工具操作与审批弹窗、模型配置和 Skills 管理。macOS 打包目录为 `desktop/release-current/mac-arm64/Bruin.app`（或对应架构目录）。首次打开可从界面添加模型、选择工作区，再开始聊天。已添加的模型可在模型设置中点击“编辑”，修改会同步到使用该模型的已有会话。API Key 应填在“API Key”输入框，仅供本次运行使用；“环境变量名称”只填写如 `OPENAI_API_KEY` 的变量名，并要求在启动 Bruin 前设置该环境变量。API Key 不写入配置或事件库；重启后需重新输入，或使用环境变量。

打包脚本会复制当前 Node.js 可执行文件并独立安装核心的运行依赖，随 Electron 应用一起交付。因此终端 CLI 与桌面版复用同一 TypeScript 核心，也避免 Electron 与 SQLite 原生模块的 ABI 冲突。桌面进程通信、安全设置、构建限制见 [桌面实现说明](docs/DESKTOP.md)。

配置和事件数据库默认位于 `~/.bruin/`。通过 `BRUIN_HOME=/path/to/private/dir` 指定另一位置。工作区默认为启动命令时的当前目录。不要将 Bruin 的数据目录或环境变量文件提交到 Git。

## 命令行快速开始

```sh
export OPENAI_API_KEY='你的密钥'
node dist/cli.js model add main openai gpt-4.1
node dist/cli.js chat --model main --workspace /path/to/project
```

聊天中输入任务；`/exit` 退出，`/model alias` 在当前会话切换模型。Bruin 会打印会话 ID。恢复时使用：

```sh
node dist/cli.js sessions list
node dist/cli.js chat --resume SESSION_ID
node dist/cli.js sessions show SESSION_ID
```

工具写文件和运行 Shell 时会展示调用参数并等待 `y` 明确批准。未知工具、工作区外路径和符号链接路径会被拒绝。恢复时若发现调用已发起但无确定结果，Bruin 会记录 `tool_unknown`，要求人工检查后继续，不会自动重放该操作。

## 模型配置

| Provider         | 配置示例                                                            | 默认密钥环境变量               |
| ---------------- | ------------------------------------------------------------------- | ------------------------------ |
| OpenAI Responses | `model add main openai gpt-4.1`                                     | `OPENAI_API_KEY`               |
| Anthropic        | `model add claude anthropic claude-sonnet-4-5`                      | `ANTHROPIC_API_KEY`            |
| Google Gemini    | `model add gemini google gemini-2.5-pro`                            | `GOOGLE_GENERATIVE_AI_API_KEY` |
| OpenAI 兼容接口  | `model add local openai-compatible MODEL http://localhost:11434/v1` | `BRUIN_COMPATIBLE_API_KEY`     |

命令格式：`model add ALIAS PROVIDER MODEL [BASE_URL] [API_KEY_ENV]`。兼容接口可用于实现 OpenAI Chat Completions 协议并支持工具调用的服务，包括部分本地模型服务及第三方平台。兼容并不保证所有模型支持工具调用、流式输出或相同参数。对本机 `localhost` / `127.0.0.1` 的兼容接口可以不设置密钥；远端接口需设置密钥环境变量。密钥不会写入配置或事件库，但会存在主进程环境中；不要将密钥放进聊天文本。

`model list` 查看配置，`model default ALIAS` 设置默认模型。模型别名是会话事件中的标记；会话可以通过 `/model` 切换配置。不同 Provider 之间切换时，历史会转换成通用文本/工具调用格式，Provider 专有元数据可能丢失。

## Skills

本地安装、GitHub 仓库安装、自建 GitHub 市场以及 skills.sh 搜索/安装入口均可使用：

```sh
node dist/cli.js skill install-local /path/to/my-skill
node dist/cli.js skill install-github owner/repo path/to/skill [REF]
node dist/cli.js skill list
node dist/cli.js skill show NAME
node dist/cli.js skill enable NAME
node dist/cli.js skill update NAME

node dist/cli.js market add team owner/market-repo
node dist/cli.js market search team
node dist/cli.js market install team SKILL_NAME
node dist/cli.js market skills-sh-search QUERY
node dist/cli.js market skills-sh-install owner/repo/skill-name
```

Skill 目录需要包含带 `name` 和 `description` YAML front matter 的 `SKILL.md`。安装时快照复制到 `BRUIN_HOME/skills`，拒绝符号链接，并限制文件数量和总大小。**本地安装默认启用；远程安装或更新后默认停用**。先用 `skill show` 查看说明，必要时检查快照目录内脚本，再执行 `skill enable`。Agent 仅在调用 `load_skill` 时加载正文；同一会话已加载的正文会记录在事件日志中，以便恢复后继续使用相同版本。

自建市场仓库根目录需放置 `marketplace.json`：

```json
[{ "name": "review", "description": "Review workflow", "path": "skills/review", "ref": "main" }]
```

条目也可提供 `repo` 指向其他 GitHub 仓库。skills.sh API 目前需要 `VERCEL_OIDC_TOKEN`；若没有该令牌，可在网站寻找仓库地址后使用 `skill install-github`。市场和 Skills 都是不可信内容，安装及启用不等同于授予工具执行权限。

## 主要命令

```text
bruin model add|list|default ...
bruin chat [--model ALIAS] [--workspace DIR] [--resume SESSION_ID] [PROMPT]
bruin sessions list|show ...
bruin skill list|show|enable|disable|install-local|install-github|update|remove ...
bruin market add|list|search|install|skills-sh-search|skills-sh-install ...
```

`npm run dev -- ...` 可从 TypeScript 源码运行 CLI；构建后可用 `node dist/cli.js ...`。需要全局 `bruin` 命令时，可在项目目录执行 `npm link`。

## 已实现的生产机制与边界

| 机制     | 当前实现                                                                     | 仍需加强                                               |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| 会话恢复 | SQLite 追加事件、顺序号、WAL、未完成工具调用标记为未知                       | 跨机器恢复、并发会话租约、正式数据库迁移流程           |
| 权限     | 工具白名单、工作区路径校验、写入/Shell 逐次人工批准                          | 细粒度持久策略、并发路径替换的严格防护、远程审批       |
| 进程隔离 | IPC 工具子进程、受限环境变量、超时与输出上限；Shell 支持 macOS 沙箱或 Docker | 适用于所有平台的强制 OS 隔离、容器取消后的强制清理验证 |
| 上下文   | 最近十轮完整保留、旧消息截断摘要、Provider 消息保留                          | 基于 token 的预算、可靠摘要模型、长会话评估            |
| 失败继续 | 模型错误记账、工具结果未知不自动重试                                         | 幂等工具协议、自动检查点与复杂任务调度                 |
| Skills   | 本地/GitHub/市场安装、快照、默认停用远程来源                                 | 签名、版本锁文件、供应链扫描、市场认证                 |

架构、事件时序与替换 SQLite/Rust 的接口设计见 [架构说明](docs/ARCHITECTURE.md)。安全假设、隔离运行方式和已知风险见 [安全说明](docs/SECURITY.md)。

## 参考项目范围

实现前检查了 `learn-claude-code` 的教学架构。Bruin 借鉴了其 Agent 循环、工具、Skills、上下文与会话等能力的设计方向，但独立实现了持久事件、权限和执行进程。该教学项目中的 MCP、子 Agent、工作树、后台任务、Hook 和完整规划模式目前未实现；后续应在已有边界上逐项增加，避免把教学示例直接视为生产实现。

## 开发与验证

```sh
npm run check
npm test
npm run build
```

测试覆盖事件持久化与恢复、权限边界、子进程路径限制、Skill 安装及启用、Agent 工具生命周期、模拟 OpenAI 兼容 SSE 与工具调用。真实云模型、Docker daemon 和 macOS Shell 沙箱需要在具备对应环境的机器上另做端到端验收。
