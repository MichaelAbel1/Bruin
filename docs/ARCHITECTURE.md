# Bruin 架构与扩展契约

第一次了解 Bruin，可先跟着一次修复测试的请求阅读[《Bruin 架构图解》](ARCHITECTURE_GUIDE.md)，再回到本文查阅接口与恢复契约。

## 组件

```text
CLI (src/cli.ts)                     Electron + React (desktop/)
  │                                          │ JSON lines / IPC
  │                                  desktop-host.ts (Node)
  └───────────────┬──────────────────────────┘
                  │
                  ├── AgentRunner (src/core/agent.ts)
                  │     ├── ModelGateway → AI SDK → OpenAI / Anthropic / Google / OpenAI-compatible
                  │     ├── EventStore → SqliteEventStore → sessions.sqlite
                  │     ├── ProcessExecutor → IPC → worker process → 文件工具 / 搜索 / Shell
                  │     └── Skills registry → BRUIN_HOME/skills
                  │     └── RuntimeServices → MCP / 子 Agent / Git 工作树 / 后台任务 / Hook / 规划
                  └── 配置 → BRUIN_HOME/config.json
```

Agent 后台进程掌握模型密钥、权限判断和事件事务；工具子进程不继承模型密钥。桌面版的 Electron 主进程负责窗口与通信，React 渲染进程负责呈现审批提示。`ModelGateway`、`EventStore` 和 `ToolExecutor` 是替换边界。工作区路径在创建会话时规范化，并绑定到会话；恢复时可检查请求的工作区是否一致。

## 单轮执行时序

1. 先提交 `user` 事件，再根据持久事件构建模型输入。
2. 模型流式输出文本与工具调用。完整响应写为 `assistant` 事件。
3. 每个工具调用写 `tool_requested`。权限策略决定允许、拒绝或询问；结果写 `tool_approved` 或 `tool_denied`。
4. 已批准调用写 `tool_started`，经 IPC 发给工具进程。返回结果写 `tool_finished`，然后进入下一次模型调用。
5. 模型无工具调用时写 `turn_completed`。单段默认最多 24 次模型调用；显式长任务模式支持 96 或 240 次，无人值守模式可选 480 次，最多 8 小时，每 24 次写 `turn_checkpoint`。无人值守时未获授权的请求立即写入 `tool_denied` 并反馈原因。达到调用或时间上限时写执行报告与 `turn_paused`，用户可继续或结束，已完成工具不会自动重放。桌面端有按钮，CLI 可按回车或输入 `/continue` 续跑，输入 `/stop` 结束暂停任务。

批准与执行分成不同事件，方便审计。事件记录包含工具输入与输出，因此会话数据库可能含源代码、用户输入和模型输出，应视为敏感数据。`providerMessages` 用于同一模型配置下保留供应商所需的响应细节；跨模型切换时使用通用消息重建。模型不会从供应商侧“恢复远程会话”，而是从本地事件构造请求。

桌面控件、CLI、ACP 和调度器通过同一 `turnState` 事件投影判断回合状态，不使用日志最后一条事件的类型代替运行状态。`turn_paused` 与 `turn_completed` 决定暂停和结束；新的用户输入、助手响应、模型错误或未知工具结果表明仍有未结算工作。运行配置、后台结果、子任务结果、模型切换、Hook、计划进度及桌面独立工具记录不会覆盖已有暂停/结束状态。因此暂停后的晚到结果仍可被继续汇总，已结束的对话也不会因后台记录而意外重新执行。

`SessionLeases` 复用 `EventStore` 的 acquire/renew/release 操作。同一进程中，一个会话的前台与后台工作持有同一 SQLite 所有者；各项工作独立释放引用，最后一项结算才停止心跳并释放存储租约。子 Agent 同时持有父会话和独立子会话租约。每次新增工作都重新验证 SQLite 所有权；续期异常或发现所有权丢失时，向全部持有者发送取消信号。CLI 的审批、恢复确认和输入等待也接收该取消信号。

## 桌面编排时序

桌面扩展经 `RuntimeServices` 执行，继续使用 `tool_requested`、`tool_approved`、`tool_started`、`tool_finished` / `tool_unknown` 链；MCP 及编排工具不进入文件工具子进程。后台 Shell 和 Hook 仍经 `ProcessExecutor` 的受限 Shell 路径执行。规划的 `plan_mode`、`plan_updated`、`plan_approved`、`plan_progress` 事件可从日志重建；子 Agent 和后台任务另有开始、结束事件。详见 [桌面 Agent 扩展能力](RUNTIME_CAPABILITIES.md)。

## 崩溃恢复语义

`recover()` 扫描 `assistant` 中尚无最终结果的工具调用。没有 `tool_started` 的调用追加 `tool_denied`；开始事件明确标记 `recovery: safe` 且注册表仍将其列为执行器只读工具时，追加失败的 `tool_finished`。如果 `subagent_started` 记录了对应的 `tool_started` 事件序号，恢复会补回子任务 ID；子任务结果仍以独立的完成记录为准。其他已经开始的调用追加 `tool_unknown`，包括缺少恢复标记的旧版记录、带工具 Hook 的读取、写入、Shell 和 MCP。已存在的未知结果仍须人工检查。恢复不会自动重放任何调用，重复扫描不会重复补齐结果。工具批次使用固定的 Hook 配置快照，配置变化在下一批生效。

桌面「我已检查」与 CLI 交互确认会在持有会话租约时保存 `unknown_reviewed`，记录确认来源和所见未知结果的最大序号。确认后出现的新记录仍需检查。桌面、CLI 与 ACP 共用同一套状态计算，读取此前保存的 `cron_reviewed` 和通用确认记录。确认只记录人工检查，原工具结果仍保留为未知。

对于需要外部不可逆副作用的未来工具，必须引入幂等键、目标系统查询或补偿逻辑；仅凭追加日志无法提供端到端 exactly-once 执行。当前文件写入和 Shell 命令的副作用并非事务的一部分。

父会话的子 Agent 结果同样有恢复投影：未结算且子会话租约失效时，扫描与原始委派输入匹配的首轮结束证据，将原回答、状态和结束序号补回父会话。后续独立聊天不构成原任务的结束证据。没有可靠结束记录的子任务继续显示为未结算，不重跑模型或工具。主 Agent 的最终对话回合与子任务是否完成是两个独立状态；提示词和结束通知会保留未结算任务信息。

## SQLite 事件模型

- `sessions(id, workspace, profile_json, created_at, updated_at)` 保存会话属性。
- `events(session_id, seq, type, at, payload_json)` 保存有序事件，主键为 `(session_id, seq)`。
- 追加事件使用 SQLite 事务分配序号并更新会话时间；`journal_mode=WAL`、`synchronous=FULL`、外键约束与忙等待已启用。
- `PRAGMA user_version=8` 标识当前 schema 版本；遇到未来版本会拒绝打开。`SqliteEventStore` 构造阶段执行已有版本的升级分支，包含工作区任务迁移及托管工作区字段；当前没有独立迁移工具，部署升级前应先备份并验证升级路径。

SQLite 适合单机 CLI：零外部服务、事件与会话同库事务、容易备份。单机写入仍需注意 WAL、SHM 文件与数据库文件整体备份；建议使用 SQLite backup API 或暂停客户端后复制完整数据库相关文件。恢复时不要只复制运行中的 `.sqlite` 主文件。

`backup create/inspect/restore` 已提供离线一致性备份、逐文件校验、恢复预演与保留旧数据目录的恢复流程；当前只支持 schema 8 和原 BRUIN_HOME 路径。EventStore 生命周期登记与独占维护门禁阻止新版实例在恢复时持有数据库。独立迁移管理器仍未实现，边界见 [运维文档](OPERATIONS.md)。

### PostgreSQL 替换路径

实现 `EventStore` 接口，并保持以下不变量：同一会话内事件序号严格递增；事件插入与会话 `updated_at` 更新原子完成；`setProfile` 的资料变更与 `model_switched` 事件在同一事务完成；恢复扫描看到一致快照。多进程写同一会话时用行锁或会话租约序列化。迁移数据时保留 `session_id`、`seq`、事件类型和原始 JSON，按会话核对数量与最大序号。不要让 CLI 或 AgentRunner 直接依赖 SQLite SQL。

当前 SQLite `setProfile` 在一个事务中更新资料并追加切换事件。迁移到 PostgreSQL 时需保持该语义。

## Rust 核心替换路径

先保持 `AgentRunner` 对外行为、工具协议和事件格式稳定，再将调度、权限或执行器分别迁到 Rust。TypeScript CLI 可以通过受版本约束的 IPC 协议调用 Rust 守护进程；推荐明确协议版本、请求 ID、超时、取消与错误码，而不是共享进程内对象。模型适配器与 Skills 管理可以继续留在 TypeScript，待端到端测试通过后分阶段迁移。事件 JSON 与工具输入需要 schema 版本，避免不同语言对 `undefined`、数字范围或日期的解释不同。

## 上下文管理

子目录 `AGENTS.md` 根据当前回合的 `read_file`、`list_files`、`write_file` 和 `edit_file` 请求加载，来源标注为具体文件和目录。越近的目录规则优先，当前用户请求和全局指令仍优先。恢复会话和切换模型时从原始事件重建访问记录，切换工作区后重新收集。只读取所选工作区内的普通文件，每个指令文件最多 32 KB，额外规则受当前输入预算限制。编辑目标的规则需要完整出现在模型提示中；遇到新规则时会推迟本次编辑。Shell 命令不解析工作目录，进入子目录前可用文件工具查看。工具权限仍由原策略与审批决定。

Agent 按实际投递给模型的消息估算上下文用量。输入预算为窗口的 75%，其中包含工具定义和协议开销，余量留给回复。ASCII 和非 ASCII 分开估算，每张图片预留 4096 tokens。同一运行内根据 Provider 实际输入用量向上校准估算比例。

接近预算时，Agent 分段调用当前模型提炼较早事件，并将带 `throughSeq` 检查点的摘要保存到 SQLite。恢复时从检查点和原始事件重建提示。长单轮可在已结算工具之后切分并保留最近两个模型响应。预算允许时，即使收到排队补充，本轮原始请求也可跨多次摘要保留。当前输入过长时也会分段提炼。最终组装提示时，如果系统指令和最新请求能一起放入预算，历史摘要和工具活动会优先让出空间。

每次摘要只尝试一次远端请求。连续两次失败或返回空文本后，本段运行余下的压缩使用本地摘录，摘要事件记录 `fallbackReason`，下一段运行可再次调用模型摘要。模型提示标出本地摘录可能缺失细节。摘要有损，token 估算需在目标模型上验证。

## 扩展建议

新增 Provider 时先在 `ModelGateway` 统一工具调用、用量与流式文本，再用本地模拟 HTTP 测试协议；不要把 Provider 专属字段扩散到 AgentRunner。新增工具时先定义输入 schema、权限规则、执行器实现和事件结果格式，再加入异常/中断测试。新增外部市场时复用 Skills 快照安装与默认停用策略。
