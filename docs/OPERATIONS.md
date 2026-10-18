# 备份、恢复与诊断

以下命令均在构建后执行。数据库 schema 仍为 8，没有新增迁移。升级前先关闭所有 Bruin 桌面、CLI、ACP 和后台服务，再创建备份；新版本启动时仍由既有迁移分支升级数据库。独立的迁移管理器、跨 schema 恢复与自动回退未实现。

```sh
node dist/cli.js doctor
node dist/cli.js capabilities
node dist/cli.js backup create /absolute/path/to/backup-directory
node dist/cli.js backup inspect /absolute/path/to/backup-directory
# 检查预演结果后，粘贴其中的 confirmation 值：
node dist/cli.js backup restore /absolute/path/to/backup-directory --confirm TOKEN
```

## 备份范围

备份是一个私有目录，包含 manifest.json 以及 data/ 下的 SQLite backup API 一致性副本、模型与 MCP 配置、全局 AGENTS.md、系统加密凭证、外观、附件、文件快照、用户技能和托管 workspaces。清单记录逐文件 SHA-256、大小、权限和原始 BRUIN_HOME；不会覆盖已有备份。缺少可选文件时跳过，复制或校验失败则不发布备份。

外部项目文件、Git worktrees、缓存和临时锁不包含在内；预演列出未备份的外部工作区。符号链接及特殊文件会使备份失败，不会静默遗漏。含有 node_modules 符号链接等内容的托管工作区需先另行整理或备份。加密凭证依赖原用户/机器的系统密钥环，跨机器不能保证解密。备份本身含对话和源码，目录权限为私有；文件校验用于发现损坏，不证明备份来源可信。

## 恢复边界

恢复先重新校验清单、路径、所有文件和 SQLite 完整性/外键，再比对预演 token，只允许恢复到原绝对 BRUIN_HOME，以保持工作区、记忆和快照引用一致。当前存在未归档的托管 Git worktrees 时拒绝恢复。准备在临时目录完成，通过后把当前数据目录改名为同级的 `.before-restore-UUID`，保留全部原始内容，再切入恢复目录；切换失败会尝试回退。不会自动删除回退副本。

恢复清除旧会话租约，将运行中任务标为 unknown，将已派发未结算 Cron 标为 needs_review；不自动继续或重放这些工作。检查 `.tasks` 快照与数据库状态后可使用桌面的修复入口同步。这里没有跨进程副作用的回滚保证。

本版本的所有 EventStore 实例会登记数据库使用状态，备份/恢复需独占维护权，正在打开的实例会阻止操作。崩溃实例的登记仅在进程已退出后清理；损坏锁保守拒绝。旧版 Bruin 或直接访问 SQLite 的外部工具不遵守此协议，仍必须人工关闭。维护登记放在当前用户临时目录，不随备份恢复移动。

## 诊断与能力清单

doctor 检查 Node.js、Git、ripgrep、SQLite 原生依赖/完整性/schema 与配置格式，不调用模型或网络、不输出密钥、不迁移旧配置；失败返回非零退出码。它不证明真实 Provider、系统浏览器、密钥环或沙箱在目标机器可用。

capabilities 从工具注册表生成各入口工具名及只读、规划、执行目标和恢复属性，避免手写列表落后于实现。

| 入口        | 模型工具               | 自动调度           | OAuth 凭证                 |
| ----------- | ---------------------- | ------------------ | -------------------------- |
| 桌面        | full                   | 桌面后台存活时运行 | 系统加密持久保存           |
| CLI chat    | full                   | 不运行 Cron 轮询   | 无登录入口，不读取桌面凭证 |
| ACP v1      | full，会话 MCP 配置    | 不运行 Cron 轮询   | 无登录入口，不读取桌面凭证 |
| service run | full，无人值守审批策略 | 独立进程运行       | 不读取桌面加密凭证         |
| 子 Agent    | read-only 注册表子集   | 无                 | 不暴露 MCP                 |

另见 [本机服务](SERVICE.md)、[ACP 接入](ACP.md) 与 [OAuth 和文件回滚](REPOSITORY_RECOVERY_AUTH.md)。
