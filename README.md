# Bruin

Bruin 是一个本地运行的 TypeScript 编码 Agent，提供 Electron 桌面客户端与 CLI。桌面端使用 React；核心进程管理模型调用、SQLite 事件日志与权限；文件和 Shell 工具在独立进程执行。默认界面为纯白色，可切换黑色主题。消息支持 Markdown，包括代码块、表格、列表和链接。新手入门与核心原理解析请参阅 [小白通俗介绍文档](docs/INTRODUCTION.md)。

## 快速开始

需要 Node.js 22.12+、npm、Git 和 ripgrep。桌面打包依赖 Electron；macOS 未签名的本地包可用，公开分发仍需 Apple Developer ID 签名与公证。

```sh
npm ci
npm run check
npm run desktop:check
npm test
npm run desktop:dev
```

打包：`npm run desktop:dist -- --mac zip`。CLI：`npm run build && node dist/cli.js --help`。数据默认放在 `~/.bruin/`，可用 `BRUIN_HOME` 改路径。桌面客户端启动后先添加模型配置和 API Key，再直接新建会话；也可以在新建时选择已有 Git 仓库或普通目录。

## 模型与密钥

支持 OpenAI、Anthropic、Google Gemini 及 OpenAI Chat Completions 兼容接口。每个配置包含别名、Provider、模型 ID、可选 Base URL 和密钥环境变量名。桌面端可编辑、删除配置；会话顶部只保留一个模型选择器。模型目录会按 API 获取并缓存五分钟，可手动刷新或输入模型 ID。目录列出 ID 不代表该模型支持聊天、流式响应和工具调用；兼容接口也可能不提供 `/models`。

模型设置可用滑块设置上下文窗口（8192–1048576 tokens），默认 32768。CLI 可在 `model add` 后加 `--context-tokens N`。Bruin 将窗口的 75% 作为保守的文本输入字节预算，图片按固定估算量计入；用户应填写模型实际公布的窗口大小。接近上限时会压缩较早的对话，当前输入过长时尝试提炼摘要；预算不是精确 tokenizer 计数。

桌面端输入的 API Key 由 Electron `safeStorage` 加密后保存在 `BRUIN_HOME/keys.enc.json`，运行时传给核心进程。环境变量输入框只填变量名，例如 `OPENAI_API_KEY`，不要填密钥值。升级时若旧配置或会话中仍有可识别的明文密钥，启动阶段会迁入系统加密存储；已经被旧版本清除、且 `keys.enc.json` 不存在的密钥无法恢复，需在「模型设置」中重新输入一次。模型目录缺少密钥时，顶部会显示「添加 API Key」入口。Linux 在 `safeStorage` 仅提供 `basic_text` 后端时拒绝保存密钥。历史版本误存到会话的密钥会尽量从当前 SQLite 数据中脱敏并压缩旧页；旧备份、外部副本或未识别的格式无法保证清除，曾暴露的密钥应轮换。

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
                                      ├─ SQLite 事件 / 租约 / 工作区任务图 / Cron / 记忆
                                      ├─ 工作区 .tasks/*.json 快照
                                      └─ 独立工具执行进程 → 工作区或 Shell 沙箱
```

会话保存用户消息、模型回复、工具请求、审批、执行结果和失败事件；桌面聊天区会折叠连续工具调用，详情仍可展开。每次运行前原子取得 30 秒会话租约并定期续约，阻止桌面与 CLI 同时运行同一会话；崩溃后租约过期即可恢复。默认每段最多 24 次模型调用；可显式开启 96 或 240 次的长任务模式，无人值守时可选 480 次，最长 8 小时，每 24 次记录检查点。无人值守模式直接拒绝未授权操作，不会扩大工具权限。达到预算时，Agent 会报告已执行操作并暂停，用户可继续或结束。已发起但无确定结果的工具调用记为 `tool_unknown`，需要人工检查后继续，不自动重放可能有副作用的操作。删除运行中的会话会被拒绝。SQLite 存储实现通过 `EventStore` 接口接入核心，便于以后增加 PostgreSQL 实现；目前没有 PostgreSQL 后端。长任务的具体边界见 [长任务能力与差距](docs/LONG_TASKS.md)。

工具先经白名单、路径边界与权限决策，再交给独立执行进程。模型提出的写文件、MCP 调用、工作树创建等需要批准；Shell 默认逐次审批，可授权同一工作区的完整命令在本次、此会话或以后执行，也可启用固定只读命令的自动审批。桌面端可查看和撤销免审批命令。执行进程限制超时和输出，拒绝工作区外路径及符号链接。文件写入先写临时文件再替换目标，避免写入中断时留下半截内容。Shell 在 macOS 优先使用 `sandbox-exec`、Linux 优先使用 `bwrap`；缺少沙箱时，经审批的 Shell 会直接在宿主机执行。也可配置 Docker 或强制沙箱模式。读取目标使用 `O_NOFOLLOW`；写入前检查目标及路径中的符号链接，但祖先目录并发替换仍是未完全解决的竞争边界。沙箱能力须在目标系统验证。

## 指令、偏好与项目文件

每轮模型调用会加载全局 `BRUIN_HOME/AGENTS.md`（默认 `~/.bruin/AGENTS.md`）以及当前工作区根目录的 `AGENTS.md`，与 Bruin 内置系统提示词、Skills 索引和工作区记忆一起组装。单个指令文件最大 32 KB；符号链接和非普通文件会被拒绝。修改文件后，下一轮调用会读取新内容。项目指令只适用于该工作区；当前没有按子目录逐层加载指令。

对话中以“请记住”“以后请”“我偏好”等形式明确表达的长期偏好会记录在本机 SQLite；模型也可用 `remember_preference` 记录本轮用户原文。Bruin 不根据行为推测偏好，拒绝保存常见格式的 API Key。偏好跨本机工作区使用，最多保存 50 项，加入提示词时限制 8000 字符。桌面侧栏的「用户偏好」可查看和删除；当前用户的新要求优先于历史偏好。

新会话默认分配 `BRUIN_HOME/workspaces/<时间>-<随机名>` 路径，创建会话时不会创建目录；首次获批创建文件或任务快照时才落盘。在会话顶部点击工作区路径可切换到已有目录。侧栏「项目文件」可逐层展开工作区的普通文件和文件夹。点击文件会在对话区域打开编辑/差异标签页，多个文件共用一行标签，可返回对话或关闭标签；单次最多显示前 256 KB。超过上限的预览只读，现有大文件也不能通过此编辑器覆盖保存，以免截断内容覆盖完整文件。二进制或无效 UTF-8 文件不预览，符号链接和工作区外路径会被拒绝。每层最多显示 300 项。

输入框的回形针按钮可添加图片、文档或普通文件，文件夹按钮可递归添加目录中的文件；消息上的「引用」可引用本会话的用户或助手消息。附件会复制到本机 `BRUIN_HOME/attachments/<会话 ID>/`，单文件最多 5 MB、单次最多 30 个文件且合计 20 MB。PNG、JPEG、WebP、GIF 以图像输入传给支持视觉的模型；为控制后续上下文大小，历史轮次的图片不会重复发送，需再次分析时请重新附上。DOCX、XLSX 首个工作表、PDF（需本机 `pdftotext`）、CSV 和 UTF-8 文本会提取有限长度的文字。旧 `.doc`、`.xls` 和无法提取的二进制文件仅保留附件名及错误提示，模型无法读取其内容。附件作为会话事件引用保存，删除会话时会清理该会话的附件副本；若磁盘清理失败，会明确报告会话已删除但附件仍需人工清理。

模型的独立 reasoning 流不会显示；部分兼容模型把思考放在正文的 `<think>` 段落时，Bruin 会过滤该段，只流式显示最终回答。对话记录仍可能在提供商专用消息中保留模型原始内容，用于同模型继续会话，但不会传给桌面界面。

## 工作区任务系统

借鉴 `learn-claude-code/s12_task_system`，Bruin 把 Todo 规划步骤与长期任务图分开。任务在同一工作区的多个会话之间共享；创建后写入工作区 `.tasks/<UUID>.json`，包括 `subject`、`description`、`status`、`owner`、`blockedBy`、`blocks` 和时间戳。可通过桌面界面或桌面/CLI Agent 工具创建、列出、查看详情、增加依赖、认领、完成任务。动态增加依赖时检查环，正在执行的任务不能改依赖。

```json
{
  "version": 1,
  "id": "UUID",
  "subject": "实现 API",
  "description": "完成端点与错误处理",
  "status": "pending",
  "owner": null,
  "blockedBy": ["上游任务 UUID"],
  "blocks": [],
  "createdAt": "2026-09-28T00:00:00.000Z",
  "updatedAt": "2026-09-28T00:00:00.000Z",
  "originSessionId": "创建任务的会话 UUID"
}
```

与教学代码不同，**SQLite 是认领和租约的权威存储**：检查状态、依赖、当前进程是否已有任务与设置 owner 在同一事务内完成。普通 JSON 文件的读改写无法保证多个进程同时认领时的原子性。`.tasks` 是人可读、可修复的快照；Bruin 在任务状态变更后同步它，桌面端也提供「修复 .tasks 快照」按钮。只读的 `list_tasks` / `get_task` 不写文件，手工编辑 JSON 不会反向修改任务。旧版会话任务在数据库升级时迁入工作区任务表；删除原会话不删除任务。Bruin 仓库本身忽略 `.tasks/`；在其他项目中是否纳入版本控制由该项目决定，任务描述可能包含私有信息。

自动认领在桌面核心空闲时运行。只有全部 `blockedBy` 已完成的任务可被认领；进程持有任务时续租。租约过期的任务标为 `unknown`，不会自动再次执行；请检查工作区和会话事件，再点「检查后重试」。模型创建或修改任务需要逐次批准，因为它会写入工作区。任务快照与 SQLite 之间没有跨介质原子提交；磁盘写入失败时 SQLite 状态仍保留，下一次状态变更或手动修复会重试同步。

每个工作区最多保存 200 个任务，每个任务最多依赖 30 个上游任务。桌面端可以删除未运行且没有下游依赖的任务；快照同步不会删除 `.tasks` 中不属于当前数据库的文件。当前没有任务归档功能；`.tasks` 文件可能短暂落后于 SQLite，请以桌面任务列表和数据库状态为准。

## 长期任务能力

| 能力         | 当前实现                                                                             | 边界                                                                                    |
| ------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Hooks        | 回合开始/结束及工具前/后触发，事件记录结果                                           | 不逐次审批；缺少 Shell 沙箱时拒绝执行                                                   |
| 计划         | 持久步骤、进度与批准门禁                                                             | 目前是线性步骤，不自动证明任务完成                                                      |
| 任务图与协作 | SQLite 原子认领，工作区 `.tasks` 快照，跨会话共享、动态依赖与环检测                  | 同一会话的 Agent 运行仍串行；未标记完成的任务记为失败，租约过期记为未知，检查后手动重试 |
| Skills       | 内置 `plan`、`debug`、`code-review`、`test`；本地、GitHub、市场安装；按需加载        | 远程安装默认停用，内容不可信                                                            |
| 工作区记忆   | 最多 50 页，按工作区持久保存，限量加入系统提示词                                     | 模型写记忆需审批；记忆内容按不可信项目资料处理                                          |
| 上下文       | 事件可完整追溯；接近窗口上限时压缩较早的对话并保存摘要；按模型配置的窗口限制输入大小 | UTF-8 字节预算是保守估算，仍无跨模型精确 tokenizer                                      |
| 后台与 Cron  | Shell 后台任务；SQLite 保存五段 Cron 表达式和提示词，桌面运行时调度                  | 审批后缺少沙箱时可在宿主运行；重启不续跑；无人值守的审批会等待用户                      |
| 工作树       | 创建、列出、移除 Bruin 管理的 Git worktree；子 Agent 可选工作树                      | 子 Agent 当前只读；不自动合并冲突                                                       |
| MCP          | stdio 与 Streamable HTTP、逐次审批、能力列表审计                                     | 缺少沙箱时 stdio 进程可访问运行账户有权限的资源；交互式 OAuth 未实现                    |

实现时参考了 `learn-claude-code` 各章节及其「深入 CC 源码」分析，按 Bruin 的桌面端和 SQLite 架构取舍：

| 参考章节                             | Bruin 采用的机制                                                               | 尚未照搬的机制                                               |
| ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| s02–s04 工具、权限、Hooks            | 工具 schema 再验证、白名单、审批先于 Hook 执行、四个生命周期 Hook              | 企业多来源规则、Hook 改写工具输入与权限冒泡                  |
| s05 / s12 Todo 与任务                | 线性计划独立于工作区任务图；任务详情、上下游依赖、环检测、原子认领             | 完整 TaskUpdate 状态机与文件锁；Bruin 用 SQLite 事务处理并发 |
| s06 / s15–s17 子 Agent 与团队        | 只读子 Agent、同机任务共享、空闲轮询和租约                                     | 跨机器团队、消息邮箱、完整关机/计划审批协议                  |
| s07 / s09 / s10 Skills、记忆、提示词 | Skill 元数据索引与按需加载、工作区记忆、动态提示词；Skill 索引限制在 8000 字符 | 记忆相关性模型筛选、Provider 级 prompt cache、forked Skill   |
| s08 / s11 压缩与恢复                 | 工具结果预算、持久摘要、步数上限暂停续跑、未知副作用人工复核                   | 精确 token 预算、摘要无损保证、自动 fallback                 |
| s13 / s14 后台与 Cron                | 后台 Shell、五段 Cron、SQLite 原子派发、每会话最多 50 个作业                   | 长期进程续跑、触发抖动、到期自动删除                         |
| s18 / s19 Worktree 与 MCP            | Bruin 管理工作树；MCP stdio/HTTP、审批与能力审计                               | 工作树合并协议、MCP 交互式 OAuth 与动态工具池                |

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

Skill 目录需有带 `name` 和 `description` front matter 的 `SKILL.md`。安装会检查符号链接、文件数和大小；远程来源先审阅再启用。Agent 加载过的 Skill 正文会进入会话事件，便于恢复时保持版本。macOS MCP stdio 进程可以读取工作区外的本机文件并访问网络，沙箱把写入限制在当前工作区和系统临时目录；Linux 有可用 `bwrap` 时限制写入。Windows 或缺少沙箱时，stdio 服务器经用户配置并由模型请求启动后直接运行，可能读取或修改运行账户可访问的文件。仅传入允许的环境变量，但这不限制进程访问本机资源。HTTP 地址要求安全协议，非本机地址需要 HTTPS。MCP 工具输出、Skills、记忆和仓库内容都属于不可信输入，不会提高权限。

## 本地验证与发布状态

```sh
npm run format:check
npm run check
npm run desktop:check
npm test
npm run desktop:dist -- --mac zip
```

GitHub Actions 在 macOS、Linux、Windows 上运行检查和测试，并分别构建未签名的桌面包；macOS ZIP 另做完整性检查。Apple Developer ID 签名、公证、自动更新、Linux/Windows 桌面端到端验收、MCP OAuth、崩溃后 Docker 容器清理、精确 token 预算以及长期 Shell/子 Agent 自动续跑尚未完成。需要这些机制时应先完成目标平台验证，再用于无人值守或公开分发。
