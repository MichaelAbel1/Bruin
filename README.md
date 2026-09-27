# Bruin

Bruin 是一个本地运行的 TypeScript 编码 Agent，提供 Electron 桌面客户端与 CLI。桌面端使用 React；核心进程管理模型调用、SQLite 事件日志与权限；文件和 Shell 工具在独立进程执行。默认界面为纯白色，可切换黑色主题。消息支持 Markdown，包括代码块、表格、列表和链接。

## 快速开始

需要 Node.js 22.12+、npm、Git 和 ripgrep。桌面打包依赖 Electron；macOS 未签名的本地包可用，公开分发仍需 Apple Developer ID 签名与公证。

```sh
npm ci
npm run check
npm run desktop:check
npm test
npm run desktop:dev
```

打包：`npm run desktop:dist -- --mac zip`。CLI：`npm run build && node dist/cli.js --help`。数据默认放在 `~/.bruin/`，可用 `BRUIN_HOME` 改路径。桌面客户端启动后先添加模型配置和 API Key，再创建指向 Git 仓库或普通目录的会话。

## 模型与密钥

支持 OpenAI、Anthropic、Google Gemini 及 OpenAI Chat Completions 兼容接口。每个配置包含别名、Provider、模型 ID、可选 Base URL 和密钥环境变量名。桌面端可编辑、删除配置；会话顶部只保留一个模型选择器。模型目录会按 API 获取并缓存五分钟，可手动刷新或输入模型 ID。目录列出 ID 不代表该模型支持聊天、流式响应和工具调用；兼容接口也可能不提供 `/models`。

桌面端输入的 API Key 由 Electron `safeStorage` 加密后保存在 `BRUIN_HOME/keys.enc.json`，运行时传给核心进程。环境变量输入框只填变量名，例如 `OPENAI_API_KEY`，不要填密钥值。Linux 在 `safeStorage` 仅提供 `basic_text` 后端时拒绝保存密钥。历史版本误存到会话的密钥会尽量从当前 SQLite 数据中脱敏并压缩旧页；旧备份、外部副本或未识别的格式无法保证清除，曾暴露的密钥应轮换。

CLI 示例：

```sh
export OPENAI_API_KEY='YOUR_KEY'
node dist/cli.js model add main openai MODEL_ID
node dist/cli.js chat --model main --workspace /path/to/project
node dist/cli.js sessions list
node dist/cli.js chat --resume SESSION_ID
```

## 运行架构与恢复

```text
React 渲染进程 → Electron 主进程 → JSON Lines 核心进程
                                      ├─ 模型适配器
                                      ├─ SQLite 事件 / 租约 / 任务图 / Cron / 记忆
                                      └─ 独立工具执行进程 → 工作区或 Shell 沙箱
```

会话保存用户消息、模型回复、工具请求、审批、执行结果和失败事件。每次运行前原子取得 30 秒会话租约并定期续约，阻止桌面与 CLI 同时运行同一会话；崩溃后租约过期即可恢复。已发起但无确定结果的工具调用记为 `tool_unknown`，需要人工检查后继续，不自动重放可能有副作用的操作。删除运行中的会话会被拒绝。SQLite 存储实现通过 `EventStore` 接口接入核心，便于以后增加 PostgreSQL 实现；目前没有 PostgreSQL 后端。

工具先经白名单、路径边界与逐次权限决策，再交给独立执行进程。写文件、Shell、MCP 调用、工作树创建等需要批准；桌面审批嵌在会话界面，不使用系统弹窗。执行进程限制超时和输出，拒绝工作区外路径及符号链接。macOS Shell 使用 `sandbox-exec`，其他环境可配置 Docker。最终文件路径有 `O_NOFOLLOW` 保护，但祖先目录并发替换仍是未完全解决的竞争边界。沙箱能力须在目标系统验证。

## 长期任务能力

| 能力         | 当前实现                                                                      | 边界                                                                                       |
| ------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Hooks        | 回合开始/结束及工具前/后触发，事件记录结果                                    | Hook 命令本身属于可信配置，需谨慎启用                                                      |
| 计划         | 持久步骤、进度与批准门禁                                                      | 目前是线性步骤，不自动证明任务完成                                                         |
| 任务图与协作 | SQLite 保存依赖图；桌面进程自动原子认领就绪任务并续租，Agent 验证后标记完成   | 同一会话的 Agent 运行仍串行；未标记完成的任务记为失败，租约过期记为未知，检查后手动重试    |
| Skills       | 内置 `plan`、`debug`、`code-review`、`test`；本地、GitHub、市场安装；按需加载 | 远程安装默认停用，内容不可信                                                               |
| 工作区记忆   | 最多 50 页，按工作区持久保存，限量加入系统提示词                              | 模型写记忆需审批；记忆内容按不可信项目资料处理                                             |
| 上下文       | 事件可完整追溯；最近至多十轮按字符预算保留，早期文字做有界压缩                | 当前仍是启发式摘要，没有跨模型精确 token 预算或可靠语义摘要                                |
| 后台与 Cron  | 沙箱 Shell 后台任务；SQLite 保存五段 Cron 表达式和提示词，桌面运行时调度      | 进程退出时 Shell 不续跑；Cron 到点若会话占用会记录跳过；无人值守的工具审批会等待用户       |
| 工作树       | 创建、列出、移除 Bruin 管理的 Git worktree；子 Agent 可选工作树               | 子 Agent 当前只读；不自动合并冲突                                                          |
| MCP          | stdio 与 Streamable HTTP、逐次审批、能力列表审计                              | stdio 限当前工作区并在无可用沙箱时拒绝；交互式 OAuth 未实现；HTTP 服务器仍可能有外部副作用 |

桌面「MCP 与自动化」页面配置 MCP、Hooks、Cron、任务图、工作区记忆、工作树与后台任务。Cron 调度和自动认领只在桌面进程运行时执行；运行中的时间点若进程退出，状态可能停在 `dispatched`，请检查会话事件后再处理。任务图认领由 SQLite 事务协调多个本机 Bruin 桌面进程；它不是跨机器分布式队列，也不会让多个 Agent 同时修改同一个会话。

## Skills 与 MCP

```sh
node dist/cli.js skill list
node dist/cli.js skill install-local /path/to/skill
node dist/cli.js skill install-github owner/repo path/to/skill [REF]
node dist/cli.js market add team owner/market-repo
node dist/cli.js market search team
node dist/cli.js market install team SKILL_NAME
```

Skill 目录需有带 `name` 和 `description` front matter 的 `SKILL.md`。安装会检查符号链接、文件数和大小；远程来源先审阅再启用。Agent 加载过的 Skill 正文会进入会话事件，便于恢复时保持版本。MCP stdio 进程只传入允许的环境变量；HTTP 地址要求安全协议，非本机地址需要 HTTPS。MCP 工具输出、Skills、记忆和仓库内容都属于不可信输入，不会提高权限。

## 本地验证与发布状态

```sh
npm run format:check
npm run check
npm run desktop:check
npm test
npm run desktop:dist -- --mac zip
```

GitHub Actions 构建未签名 macOS ZIP 并校验压缩包。Apple Developer ID 签名、公证、自动更新、Linux/Windows 桌面端到端验收、MCP OAuth、强制 Docker 清理、精确 token 预算以及长期 Shell/子 Agent 自动续跑尚未完成。需要这些机制时应先完成目标平台验证，再用于无人值守或公开分发。
