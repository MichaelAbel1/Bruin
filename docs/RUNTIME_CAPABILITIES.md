# Bruin 桌面 Agent 扩展能力

本页描述桌面客户端的 MCP、子 Agent、Git 工作树、后台任务、Hook 和规划模式。这些能力从 Electron 主窗口经 `desktop-host.ts` 进入同一个 `AgentRunner`，状态写入 SQLite 会话事件。CLI 目前使用基础工具集，不暴露这些桌面扩展工具。

## MCP

在侧边栏「MCP 与自动化」中添加服务器。支持两种传输：

- **stdio**：填写可执行命令、每行一个参数，以及显式允许传给服务器的环境变量名。Bruin 启动独立 MCP 进程，默认只传 `PATH`、`HOME`、`TMPDIR`、`LANG`，不继承模型密钥。服务器进程由 MCP SDK 管理，不等同于 Bruin 的受限文件工具进程或 Shell 沙箱。只安装和启动可信服务器。
- **Streamable HTTP**：填写 URL 和可选 Bearer Token 环境变量名。远端地址必须使用 HTTPS，本机 loopback 可用 HTTP。Token 值只从进程环境读取，不写入配置文件。

「测试工具」执行握手及 `tools/list`。模型通过 `mcp_list_tools(server)` 发现工具，再以 `mcp_call(server, tool, arguments)` 调用。**每次 MCP 调用都需审批**，参数与结果记录在事件日志。连接、列表与调用分别有 10 秒、10 秒、30 秒超时；单条 stdio 消息限制为 1 MB，返回给模型的调用结果限制为 100 KB。远程服务仍可能产生外部副作用，超时或断线后的结果可能不确定；Bruin 会标记 `tool_unknown`，不会自动重试。

## 子 Agent

模型或桌面界面可启动子 Agent，最多同时两个。子 Agent 拥有独立 SQLite 会话，使用父会话的模型配置，并且只暴露 `read_file`、`search`、`load_skill`。父会话记录 `subagent_started` 和 `subagent_finished`，通过 ID 查询状态与最后一条回答。当前不允许子 Agent 再创建子 Agent，也不能调用 MCP、Shell 或修改文件。关闭桌面后台时，运行中的子 Agent 会收到取消信号；重启后未完成任务显示为未知，必须由用户决定是否重新发起。

## Git 工作树

`create_worktree` 从当前仓库 `HEAD` 创建分离工作树，目录位于 `BRUIN_HOME/worktrees/<name>`。名字只允许小写字母、数字和连字符。`list_worktrees` 查询 Git 的工作树列表。`remove_worktree` 只接受当前仓库中位于 Bruin 管理目录下的工作树，调用 `git worktree remove`，不会强制删除有未提交更改的工作树。创建和移除都需模型工具审批；桌面按钮代表用户直接发起操作。

子 Agent 可选择 Bruin 管理的工作树作为只读任务目录。工作树中的 Shell、MCP 或其他进程仍可能绕过模型的只读指令，当前只读边界仅对该子 Agent 暴露的工具集生效。

## 后台任务

`start_background(command)` 使用现有 `ProcessExecutor` 的 Shell 沙箱，在独立工具进程中启动命令，最多同时两个，10 分钟超时，输出最多 100 KB。通过 ID 查询或取消。启动前需模型工具审批；桌面按钮代表用户直接发起。事件日志记录开始和结束。应用重启后，不会自动重放未完成命令；状态显示为未知。取消会发送终止信号，但外部副作用无法回滚。

## Hooks

可配置 `turn_started`、`before_tool`、`after_tool`、`turn_finished` 四种 Hook。Hook 是用户保存的**静态 Shell 命令**，不把模型输出拼接进命令。通过与普通 Shell 相同的沙箱和 30 秒超时运行，结果写入 `hook_finished`。`turn_started` / `before_tool` 失败会中止当前执行；`after_tool` / `turn_finished` 的错误保留在事件中。未批准的规划阶段不运行 Hook，避免只读规划期间发生隐藏的修改。配置 Hook 等同于授权该静态命令在相应时机运行；启用前应检查命令。

## 完整规划模式

会话中点击「开启」后，规划状态作为 `plan_mode` 事件保存。模型可读取工作区并调用 `update_plan` 提交 1–30 个步骤；在用户批准前，写文件、Shell、MCP 调用、工作树变更、后台任务等均由权限层拒绝。计划显示在对话上方，用户点击「批准计划并允许执行」后写入 `plan_approved`，再发送“执行计划”等指令。执行中模型或用户可更新每一步的 `pending`、`in_progress`、`completed` 状态。修改计划会撤销原批准，需要重新审批。每个实际写入或 Shell 调用仍需单次工具审批。

规划事件与其他会话事件一同恢复。规划模式是执行门禁与进度记录，不保证模型一定按计划实施，也不替代工具审批和操作系统沙箱。

## 恢复和限制

会话操作按 `tool_requested` → `tool_approved` → `tool_started` → `tool_finished` 记录。中断时无法确认外部副作用，恢复扫描会标记 `tool_unknown`，要求人工检查后继续。后台任务和子 Agent 的开始、结束也有单独事件；重启不自动继续这些进程。

当前仍缺少跨进程会话租约、系统钥匙串、MCP OAuth 交互式登录、后台任务跨重启续跑、Docker 容器取消后的强制回收保证，以及面向敌对代码的强隔离。参见 [安全模型](SECURITY.md) 与 [生产化审查](PRODUCTION_REVIEW.md)。
