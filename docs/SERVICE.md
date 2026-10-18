# 本机后台服务

构建后运行 `node dist/cli.js service run --timezone Asia/Shanghai`，无需 Electron 或桌面窗口。此命令以前台常驻进程运行，可由操作系统服务管理器或终端后台运行机制托管；Ctrl+C/SIGTERM 会取消在途执行并释放资源。不自动安装开机服务，不监听 HTTP/TCP 端口，不提供远程访问。

服务复用桌面后台的模型、工具、Cron 和任务图运行时，输出 JSON Lines 运行事件。`BRUIN_HOME` 与桌面保持一致即可使用同一数据库，跨进程租约阻止同一会话同时执行。服务通过环境变量获取模型密钥，不能解密 Electron 系统加密存储中的密钥。服务内自动任务使用无人值守策略，未预先授权的操作立即拒绝，不等待不存在的审批界面。

Cron 仍是五段表达式，使用进程时区；`--timezone` 接受 IANA 时区名。创建任务与执行服务应使用相同时区，现有任务的首个已保存时间点不会因切换时区重写。服务每 15 秒检查一次，忙时等待；错过多个时间点仅执行一次，再计算下一次时间，不逐个补跑。

每次派发与 `cron_started` 事件在同一 SQLite 事务提交，记录 runId、jobId、预定时间与时区；结束通过 `cron_finished` 记录状态。未结算执行在失去租约且派发超过 30 秒后标为 `needs_review`，阻止后续自动调度，且不会重放副作用。查看 `node dist/cli.js cron list` 和 `sessions show SESSION_ID`，检查工作区及工具事件后，用 `cron review JOB_ID --confirm` 解锁后续到期执行。尚无逐任务时区或暂停/启用界面。
