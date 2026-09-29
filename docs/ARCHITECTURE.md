# Bruin 架构与扩展契约

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
5. 模型无工具调用时写 `turn_completed`。单段默认最多 24 次模型调用；达到上限时写执行报告与 `turn_paused`，用户可继续或结束，已完成工具不会自动重放。桌面端有按钮，CLI 可按回车或输入 `/continue` 续跑，输入 `/stop` 结束暂停任务。

批准与执行分成不同事件，方便审计。事件记录包含工具输入与输出，因此会话数据库可能含源代码、用户输入和模型输出，应视为敏感数据。`providerMessages` 用于同一模型配置下保留供应商所需的响应细节；跨模型切换时使用通用消息重建。模型不会从供应商侧“恢复远程会话”，而是从本地事件构造请求。

## 桌面编排时序

桌面扩展经 `RuntimeServices` 执行，继续使用 `tool_requested`、`tool_approved`、`tool_started`、`tool_finished` / `tool_unknown` 链；MCP 及编排工具不进入文件工具子进程。后台 Shell 和 Hook 仍经 `ProcessExecutor` 的受限 Shell 路径执行。规划的 `plan_mode`、`plan_updated`、`plan_approved`、`plan_progress` 事件可从日志重建；子 Agent 和后台任务另有开始、结束事件。详见 [桌面 Agent 扩展能力](RUNTIME_CAPABILITIES.md)。

## 崩溃恢复语义

`recover()` 扫描 `assistant` 中的工具调用，若没有 `tool_finished`、`tool_denied` 或已有 `tool_unknown`，追加 `tool_unknown`。这覆盖了：批准前崩溃、批准后执行前崩溃、工具执行中崩溃、工具已产生副作用但结果未落库等情况。Bruin 无法仅靠本地事件判定副作用是否发生，因此不会自动重复该调用。CLI 提示用户检查工作区后继续，模型得到“执行结果未知”的工具结果。恢复扫描再次运行不会重复写未知事件。

对于需要外部不可逆副作用的未来工具，必须引入幂等键、目标系统查询或补偿逻辑；仅凭追加日志无法提供端到端 exactly-once 执行。当前文件写入和 Shell 命令的副作用并非事务的一部分。

## SQLite 事件模型

- `sessions(id, workspace, profile_json, created_at, updated_at)` 保存会话属性。
- `events(session_id, seq, type, at, payload_json)` 保存有序事件，主键为 `(session_id, seq)`。
- 追加事件使用 SQLite 事务分配序号并更新会话时间；`journal_mode=WAL`、`synchronous=FULL`、外键约束与忙等待已启用。
- `PRAGMA user_version=1` 标识当前 schema 版本；遇到未来版本会拒绝打开。当前没有正式迁移器，部署升级前应先备份并制定迁移脚本。

SQLite 适合单机 CLI：零外部服务、事件与会话同库事务、容易备份。单机写入仍需注意 WAL、SHM 文件与数据库文件整体备份；建议使用 SQLite backup API 或暂停客户端后复制完整数据库相关文件。恢复时不要只复制运行中的 `.sqlite` 主文件。

### PostgreSQL 替换路径

实现 `EventStore` 接口，并保持以下不变量：同一会话内事件序号严格递增；事件插入与会话 `updated_at` 更新原子完成；`setProfile` 的资料变更与 `model_switched` 事件在同一事务完成；恢复扫描看到一致快照。多进程写同一会话时用行锁或会话租约序列化。迁移数据时保留 `session_id`、`seq`、事件类型和原始 JSON，按会话核对数量与最大序号。不要让 CLI 或 AgentRunner 直接依赖 SQLite SQL。

当前 SQLite `setProfile` 在一个事务中更新资料并追加切换事件。迁移到 PostgreSQL 时需保持该语义。

## Rust 核心替换路径

先保持 `AgentRunner` 对外行为、工具协议和事件格式稳定，再将调度、权限或执行器分别迁到 Rust。TypeScript CLI 可以通过受版本约束的 IPC 协议调用 Rust 守护进程；推荐明确协议版本、请求 ID、超时、取消与错误码，而不是共享进程内对象。模型适配器与 Skills 管理可以继续留在 TypeScript，待端到端测试通过后分阶段迁移。事件 JSON 与工具输入需要 schema 版本，避免不同语言对 `undefined`、数字范围或日期的解释不同。

## 上下文管理

`buildPrompt` 按配置的上下文窗口保留近期完整轮次。接近预算时，Agent 分段调用当前模型提炼较早事件，并将带 `throughSeq` 检查点的摘要保存到 SQLite；恢复时从该检查点重建提示，原始事件不删除。当前输入过长时也会分段提炼。输入按窗口的 75% 作 UTF-8 JSON 字节预算，图片每张按 16,384 估算字节计入，余量留给回复、工具定义及协议开销。模型摘要不可用时使用本地片段压缩兜底。摘要仍是有损的，尤其是超长附件和图像；预算也不是 Provider tokenizer 的精确计数，需在目标模型上验证。

## 扩展建议

新增 Provider 时先在 `ModelGateway` 统一工具调用、用量与流式文本，再用本地模拟 HTTP 测试协议；不要把 Provider 专属字段扩散到 AgentRunner。新增工具时先定义输入 schema、权限规则、执行器实现和事件结果格式，再加入异常/中断测试。新增外部市场时复用 Skills 快照安装与默认停用策略。
