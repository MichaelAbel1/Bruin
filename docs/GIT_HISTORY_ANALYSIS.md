# Bruin Git 历史与架构演进分析

> 分析日期：2026-09-30（Asia/Shanghai）  
> 基线：`dca9d2f88273497402784da41b042057b64e157f`（`main`、本地 `origin/main`）  
> 范围：本地 HEAD 可达的全部 **41 个提交：40 个非合并提交、1 个合并提交**，起点为 `14733ce`，提交时间覆盖 2026-09-27 17:33 至 2026-09-30 16:50。其他本地引用未发现额外提交；未执行远程 fetch，不声称覆盖服务器上尚未拉取的历史。

> 工作区范围说明：调查开始时无已跟踪文件修改；收尾时检测到并行工作新增或修改了源码、测试和文档。本文只新增本报告，未改动这些并行文件。历史判断固定于上述 SHA，测试结果对应检查运行时的工作区，不构成对后来未提交修改的验证。

## 1. 总体判断与证据方法

Bruin 在四天的提交历史中，从具备模型调用、文件工具和桌面界面的本地编码 Agent，演进为具有持久任务图、审批策略、长任务检查点、仓库探索、单文件快照和 MCP OAuth 的单机协作系统。最有长期价值的方向，是把“模型说了什么”“工具是否获批”“副作用是否发生”“任务是否完成”分开记录和判断。

历史的主要矛盾是：新能力扩大执行范围后，需要持续补齐取消、恢复、隔离和数据完整性边界。提交序列既展示了架构进步，也展示了高频大提交带来的验证压力。特别是 9 月 30 日增加长任务之后，紧接着修复上下文保留、重试叠加、取消后的副作用、截断编辑和 MCP 生命周期，说明“更长运行”必须依赖执行语义的成熟。

本文使用以下证据层次：

- **直接事实**：提交 diff、父提交实现、当前源码、测试断言、版本与 CI 配置。
- **动机推断**：由被删除的旧逻辑、新增防护和回归测试反推问题；未明示的商业需求或线上事故不作为事实。
- **收益判断**：说明机制为何可能减少开销或故障；没有基准数据的地方不提供吞吐、延迟或内存改善百分比。
- **建议**：指出当前边界和后续验证方向；历史缺陷若已由后续提交解决，不重复列为当前缺陷。

非合并提交与其父提交比较；根提交与空树比较；合并提交同时核对两个父提交。锁文件、图标、格式变更按依赖和交付意义分析，不把它们视为业务逻辑。大提交重点检查核心执行路径、存储与权限逻辑、相关测试和界面状态变化，而不是仅根据提交标题归纳。

文中路径定位到当前工作区；历史事实由对应 SHA 下的文件版本支持。可用 `git show <SHA> -- <路径>` 复查，当前行号不等同于历史行号。报告不修改业务代码，也不回放历史迁移或运行旧版本。

## 2. 架构演进总览

| 阶段             | 提交范围            | 核心问题                                             | 架构结果                                                                   |
| ---------------- | ------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| 基础骨架         | `14733ce`—`0dd175b` | 模型协议、桌面交互与工具执行需要统一边界             | CLI/Electron 共用 Agent；Provider、EventStore、Executor 解耦；加入编排能力 |
| 持久协作         | `1e8713c`—`9b1453c` | 会话恢复不足以管理跨会话任务和用户资料               | SQLite 租约、工作区任务图、可修复 JSON 快照、指令与偏好、附件              |
| 可靠性收敛       | `1252e89`—`39288b5` | 搜索、重试、快照删除、配置并发和进程退出存在边界问题 | 原子文件替换、错误分类、Worker 请求隔离、配置锁、精确未知结果确认          |
| 跨平台与沙箱     | `f72b207`—`8e3b820` | 平台路径、文件句柄、Shell 和沙箱差异                 | 三平台构建矩阵、bwrap、宿主回退、Hook 强制隔离、文件身份比较               |
| 长任务与上下文   | `d6ec5b6`—`37493ad` | 上下文超限、有限步数、无人值守和取消语义             | 持久摘要、暂停报告、显式长任务模式、统一重试、编码完整性、MCP 串行生命周期 |
| 探索、恢复与审核 | `eacc197`—`dca9d2f` | 大仓库探索、单文件撤销、OAuth 和修改可见性           | 分页工具、符号索引、快照恢复、用量投影、跨会话防陈旧响应、文件审核面板     |

当前分层仍延续根提交的方向：React → Electron → JSON Lines DesktopHost → AgentRunner → ModelGateway / EventStore / ProcessExecutor / RuntimeServices。模型密钥由后台掌握；独立工具进程使用受限环境。进程隔离改善故障与凭据边界，但文件进程隔离本身不等同于操作系统权限沙箱。

## 3. 逐提交分析

以下按历史顺序覆盖全部提交。每节分别讨论动机、实现、运行期与工程期收益、权衡与验证证据。纯版本、诊断和合并提交按实际贡献分析，不虚构运行期优化。

### 01 · `14733ce` · 初始化 Agent 与桌面客户端

**背景与动机。** 根提交建立可实际使用的本地编码 Agent，没有父版本可用于证明此前存在某个 Bug。设计目标直接体现在 CLI、Electron、模型接入、SQLite 日志和独立执行器的同步引入。

**What & How。** `src/core/agent.ts` 组织模型—工具循环；`providers/gateway.ts` 归一化多个 Provider；`storage/event-store.ts` 事务分配事件序号，并启用 WAL、FULL 同步、外键和忙等待。文件与 Shell 通过子进程执行，路径限制和审批位于核心；Skills 支持本地与远程安装、按需加载。Electron 使用 contextIsolation、禁用 nodeIntegration，并验证 IPC 来源。

**Benefits。** 运行期：数据库日志支持重启恢复；未知工具结果保守处理，避免直接重放副作用。工程期：`ModelGateway`、`EventStore`、`ToolExecutor` 提供替换边界，CLI 与桌面复用核心。Prettier、类型检查和测试从起点进入工程流程。

**Trade-offs & Notes。** SQLite 事件与外部文件/Shell 副作用不在同一事务内，不能据此保证 exactly-once。版本为 0.1.1；加入 Electron、React、AI SDK、better-sqlite3 等交付依赖。基础测试覆盖事件排序、模型切换、未知结果、路径越界、执行器输出上限和 Skills；这些不是完整生产验收。

### 02 · `fb9012a` · 桌面编排、主题与模型目录

**背景与动机。** 旧实现偏重单轮文件操作，缺少模型目录、可恢复规划和外部工具编排。默认 Skills 为空，也限制新用户的工作流。

**What & How。** 新增 `src/runtime/services.ts`、`runtime/plan.ts`、`runtime/mcp.ts`、`providers/catalog.ts`。桌面接入只读子 Agent、后台 Shell、托管 worktree、Hooks、规划审批与进度；新增官方 MCP 客户端依赖。模型目录支持 Provider 认证、分页、去重及请求限制；保留会话独立选定的模型。加入四个内置 Skill、图标配色与明暗主题。

**Benefits。** 运行期：子 Agent 和后台任务具有并发上限与关闭时取消/等待；目录请求禁用重定向，降低凭据误转发风险。工程期：扩展能力集中在 RuntimeServices，避免直接塞进文件 Worker；规划状态和操作过程可由事件重建。

**Trade-offs & Notes。** 工具面大幅扩大，MCP 启动、Hook 和子进程退出增加生命周期复杂度。只读子 Agent 不具备协同写入能力，worktree 不自动合并。新增目录、运行时、Skills 回归测试；`docs/PRODUCTION_REVIEW.md` 的历史验收描述不等同于本次实测。

### 03 · `0dd175b` · 自定义 OpenAI 地址改用 Chat Completions

**背景与动机。** 原代码对 OpenAI Provider 固定调用 Responses；自定义服务可能只实现 Chat Completions。旧供应商消息也不能无条件复用于不同协议。

**What & How。** `modelProtocol()` 区分官方 OpenAI 与自定义 endpoint；自定义地址经兼容适配器调用 chatModel。assistant 事件记录 protocol，`buildPrompt()` 仅在协议匹配时复用原生消息。`formatModelError()` 提取结构化 HTTP 错误细节、限制长度，避免直接输出任意响应正文。桌面简化模型选择。

**Benefits。** 运行期：减少错误 endpoint 导致的请求失败，错误信息更可操作。工程期：协议选择集中在网关，历史构建对协议边界有显式判断。

**Trade-offs & Notes。** 自定义 OpenAI 地址默认选择 Chat Completions，是可见行为变化；仅提供 Responses 的自定义服务需另行适配。新增自定义地址与历史重建测试；版本升至 0.3.1。

### 04 · `1e8713c` · 持久编排、加密密钥与 Markdown

**背景与动机。** 进程内编排状态不足以处理桌面/CLI 同时运行、重启后的任务恢复与密钥保存。聊天纯文本也不适合代码和表格表达。

**What & How。** EventStore 增加会话租约、任务节点、Cron、工作区记忆；CLI/DesktopHost 获取 30 秒租约并续约。Electron safeStorage 保存加密密钥，Linux basic_text 后端拒绝保存；旧数据脱敏并尝试数据库压缩。新增 react-markdown、remark-gfm、cron-parser；模型目录缓存五分钟；CI 首次纳入 macOS 检查与打包。数据库支持版本推进到 5。

**Benefits。** 运行期：租约抑制同会话并发执行；持久任务与 Cron 可重启读取；目录缓存减少重复网络调用。工程期：任务状态与界面呈现分离，记忆和 Markdown 提升连续工作可读性。

**Trade-offs & Notes。** 加密存储依赖系统后端；清除当前数据库不能清除旧备份。Cron 是本地桌面调度，不是独立常驻服务。最初任务仍按会话组织，下一提交进一步修改作用域；数据库升级限制向旧版本回退。

### 05 · `27224df` · 工作区共享任务图与可修复快照

**背景与动机。** 会话级任务无法支持同一项目多个会话协作；仅保存数据库又缺少可检查的项目文件。

**What & How。** 新增 workspace_tasks 表并迁移旧任务，schema 5→6；`.tasks/<id>.json` 成为 SQLite 的可修复投影。认领在事务中检查依赖、已有认领和状态；修改依赖以图遍历检测环。新增 get_task/update_task、描述、反向依赖 blocks。CLI 接入完整 RuntimeServices；Agent 与桌面入口二次验证工具 schema；创建/更新任务进入审批。

**Benefits。** 运行期：数据库原子认领比普通 JSON 读改写更适合本机多进程竞争。工程期：任务不随原会话删除而消失，JSON 便于检查；快照可重建，数据权威清晰。

**Trade-offs & Notes。** SQLite 与文件快照无法跨介质原子提交，失败时需要修复；手改 JSON 不反向更新数据库。任务上限 200、依赖上限 30；不是跨机器队列。相关迁移、环检测和认领测试在 `cf5da22` 中集中补充，应区分“实现提交”与“测试补齐提交”。

### 06 · `9db8569` · 指令、显式偏好与文件浏览

**背景与动机。** 模型缺乏项目规范和用户长期偏好；用户也无法直接检查项目文件。

**What & How。** 每轮读取全局与工作区根目录 AGENTS.md，指令文件有大小和文件类型限制。偏好用哈希去重，只接受本轮用户原文并拒绝常见密钥格式，加入数量与提示词长度限制。新增有界文件浏览和隔离预览窗口。网关过滤跨流式片段的 `<think>` 内容；DesktopHost 返回事件时去除 providerMessages。

**Benefits。** 运行期：有限读取和索引长度抑制输入膨胀；隐藏内部供应商消息减少界面泄露面。工程期：规范随文件实时加载，偏好可查看删除，用户有直接检查入口。

**Trade-offs & Notes。** 偏好是本机全局作用域，可能影响其他工作区；自动捕获使用语言模式，不能理解所有自然语言表达。只加载根目录项目指令；think 标签过滤有特定格式边界。schema 6→7，版本升至 0.6.0；专项测试随后补齐。

### 07 · `9b1453c` · 延迟创建工作区与附件

**背景与动机。** 新会话强制选择目录增加启动成本；文件、图像和引用只能依赖手工粘贴，缺少结构化输入。

**What & How。** 会话保存托管工作区路径，首次获批写入时 materialize，而非创建会话就落盘；允许显式切换目录并写 workspace_changed。新增 `attachments.ts`：复制附件、限制单文件/批次、提取 DOCX/XLSX/PDF/文本、当前轮发送图片、历史轮保留说明；引用只接受当前会话用户/助手消息。新增 managed_workspace 字段，schema 7→8；衔接旧密钥迁入加密存储。

**Benefits。** 运行期：减少无用目录创建，控制重复图片和附件文本输入成本。工程期：附件引用进入日志，恢复输入来源更清楚；工作区改变成为显式事件。

**Trade-offs & Notes。** PDF 提取依赖本机 pdftotext，旧 DOC/XLS 和二进制不保证可读；XLSX 只读首表。附件副本占磁盘且含私人内容；历史图像不重复发送意味着后续再分析需重新附上。初版导入失败回滚和增长检查由后续提交加强。

### 08 · `1252e89` · 放宽 MCP stdio 网络与读取

**背景与动机。** 旧 macOS MCP 策略 deny default，只允许有限目录读取，无法兼容需要网络和用户资源的服务器。

**What & How。** `runtime/mcp.ts` 改为 allow default、deny file-write，再允许工作区及临时目录写入；路径做引号/反斜线转义。README 同步说明读取与网络边界。

**Benefits。** 运行期：提高真实 MCP 服务启动与使用兼容性。工程期：降低为不同服务器维护读取白名单的配置成本。

**Trade-offs & Notes。** 这是明确的安全边界放宽：允许读取工作区外本机文件及联网，不能称为安全性全面增强。凭据环境变量过滤仍有价值，但不能阻止服务器直接读取账户可访问的文件。本提交没有新增专门测试。

### 09 · `cf5da22` · 恢复、搜索降级与任务管理

**背景与动机。** 悬空工具调用可能使 Provider 消息不合法；模型临时错误会立即中断；缺 rg 时搜索不可用。前几次功能扩展也需要系统性回归覆盖。

**What & How。** buildPrompt 为未完成调用补错误结果，并在旧上下文摘要中保留工具状态。Agent 对未输出正文的特定 HTTP 暂时错误最多尝试三次；步数可配置且上限 100。新增流式 fallbackSearch、任务安全删除入口和孤立 JSON 清理。集中补充租约、迁移、偏好、文件、任务、重试与流式协议测试。

**Benefits。** 运行期：减少瞬时失败中断，缺 rg 时仍可探索，工具消息成对。工程期：状态恢复从“文本续聊”转向“执行记录续接”，大量边界进入测试。

**Trade-offs & Notes。** fallback 使用字符串包含与简化 glob，与 rg 的语义不完全等价。孤立 JSON 清理可能删除不属于当前数据库的文件，下一提交撤销该行为。此时重试等待还不可立即取消，亦在下一提交修复。

### 10 · `f158bc3` · 原子文件替换与保守快照处理

**背景与动机。** 旧 replaceFd 先截断再写入，中断会留下半文件；孤立快照清理可能误删用户文件；重试退避期间取消不及时。

**What & How。** 文件写入改为同目录随机临时文件、O_EXCL、写入循环、保留权限、fsync 后 rename，并清理临时文件。编辑读取不超过 5 MB。删除任务前验证 `.tasks` 与目标文件，取消自动清理未知 JSON。退避等待注册 AbortSignal。

**Benefits。** 运行期：失败编辑更可能保留原文件，取消响应更快。工程期：快照同步只管理有证据归属的文件，减少隐式破坏。

**Trade-offs & Notes。** rename 替换会改变 inode；权限位保留不代表所有 ACL、扩展属性或硬链接语义都被保留。文件原子替换与数据库事务依旧独立。回归测试明确覆盖失败编辑、权限、取消和无关文件保留。

### 11 · `b39b402` · 嵌套写入与运行时错误语义

**背景与动机。** 新项目写入深层路径时父目录未存在；参数错误与已经开始执行后的故障都抛异常，导致模型恢复方式不明确。

**What & How。** 权限检查寻找现存祖先目录；Worker 逐级创建并验证父路径。RuntimeServices 将未配置服务器、无效计划、容量或名称问题返回 isError；真正执行故障仍传播。会话删除后清理附件副本，失败消息明确指出数据库删除已完成。

**Benefits。** 运行期：正常新建目录结构可执行；可纠正参数错误不必终止整个回合。工程期：预验证失败与未知副作用区分更清楚。

**Trade-offs & Notes。** 创建部分父目录后失败，不保证撤销这些目录。附件清理与会话删除不原子；调用方必须理解“部分完成”的错误。测试覆盖嵌套写入、附件清理、tool_unknown 与预执行错误。

### 12 · `ba9c482` · Skill 错误隔离与搜索流清理

**背景与动机。** loadSkill 的宽 try/catch 可能把数据库写入失败误报为 Skill 查找失败；搜索提前返回容易遗留流资源。

**What & How。** 仅捕获 Skill 读取异常，skill_loaded 的存储异常继续传播；区分 Skill 不存在和停用。MCP 工具列表中找不到工具返回已知 isError；fallbackSearch 在 finally 中关闭 readline 与销毁读取流。

**Benefits。** 运行期：减少错误状态伪装与资源滞留。工程期：存储故障不会被包装成可忽略业务错误，诊断与恢复更可信。

**Trade-offs & Notes。** 严格传播存储失败可能更早停止回合，这是保护日志一致性的合理取舍。新增测试验证 Skill 错误可继续、存储错误不被掩盖。

### 13 · `39288b5` · 配置并发、Worker 竞态与会话安全

**背景与动机。** 多进程配置读改写可能丢更新；Worker 重启时旧进程退出可能清空新请求；一次“已检查未知调用”的确认可能误覆盖后来新出现的未知结果。

**What & How。** 配置增加可重入跨进程文件锁和 updateConfig；临时文件名加 UUID。ProcessExecutor 为每个 Worker 维护独立 pending Map。DesktopHost 按 unknown 事件序号记录确认；tool_finished 落库后不因后置 Hook 失败改记 unknown。Cron 隔离无效表达式；RuntimeServices 仅包装预期验证错误，数据库异常继续传播；删除会话和关闭服务强化租约/任务释放语义。

**Benefits。** 运行期：降低丢配置、错配请求与重复执行风险。工程期：不同错误来源和不同 Worker 实例都有独立生命周期；回归覆盖从正常流程扩展到故障时序。

**Trade-offs & Notes。** 同步配置锁可能阻塞事件循环，陈旧锁判定依赖 PID 与时间；存活进程锁的处理随后修正。此提交跨 16 文件，可靠性主题一致但审查面较大。

### 14 · `f72b207` · 0.7.1 发布准备与配置形状检查

**背景与动机。** 发布前需要一致版本；损坏配置若根节点为 null/数组，或 profiles 含非对象，旧迁移遍历可能先触发低层 TypeError。

**What & How。** package 与锁文件升至 0.7.1；loadConfig 在迁移前验证根对象并安全遍历 profiles。

**Benefits。** 运行期：坏配置错误更明确；工程期：版本与产物可追溯。新增配置边界断言。

**Trade-offs & Notes。** 改名为 release 不代表已签名、已发布或已经完成目标平台验收；核心架构没有变化。

### 15 · `fb6861e` · 禁止 CI 隐式发布

**背景与动机。** electron-builder 的默认发布推断可能让验证构建尝试发布，造成权限或副作用问题。

**What & How。** CI 的 macOS 打包命令显式追加 `--publish never`。

**Benefits。** 运行期产品逻辑无变化；工程期把构建验证与外部发布职责分开，使只读权限 CI 更稳定。

**Trade-offs & Notes。** 真正发布流程需单独明确授权和配置；本次分析只核对 YAML，没有执行远程 CI。

### 16 · `7cd8d3d` · 整合发布与 CI 分支

**背景与动机。** 0.7.1 发布修复和 CI 禁止发布分别基于 `39288b5` 开发，需要合并。

**What & How。** 第一父提交 `f72b207`，第二父提交 `fb6861e`。相对第一父仅增加 CI 一行；相对第二父带入版本与配置验证变更。

**Benefits。** 运行期无独立新增能力；工程期保留两条工作线的成果与原始历史。

**Trade-offs & Notes。** 不应把合并所带来的差异再统计为一次新功能实现。两个父差异中未发现额外业务改动；这不证明历史上从未发生冲突。

### 17 · `d8a5c79` · 可编辑文件查看器与路径加固

**背景与动机。** 用户只能读文件，无法在聊天区编辑和审核差异；延迟工作区与运行时工具的兼容性也有缺口。

**What & How。** React 引入编辑/差异标签、行号、语法着色和增删统计；workspace-files 增加 Git HEAD 基线与临时文件保存。DesktopHost 在手动保存时持有会话租约。核心处理获批 Shell 的工作区物化；运行时明确报告缺失目录；沙箱允许系统临时目录。新增入门说明。

**Benefits。** 运行期：文件修改与反馈更直接，写入拒绝符号链接和工作区外路径。工程期：人工检查成为产品闭环。行差异先剥离相同前后缀，减少动态规划工作量。

**Trade-offs & Notes。** 差异核心采用 LCS，残余行数 m×n 的时间/空间开销仍存在；超过 1,500,000 单元时退化为整段删增，避免无限增长但降低差异精度。手动保存租约仅绑定会话，不是整个工作区的编辑锁；后续增加原始内容基线保护。

### 18 · `3d1d860` · 跨平台 CI、上下文预算与执行安全

**背景与动机。** macOS 单平台验证无法暴露 Windows/ Linux 行为；重复调用 ID 和无界输入影响恢复正确性；文件替换与 Docker 取消需要更明确防护。

**What & How。** CI 扩展 macOS/Linux/Windows 检查和 ZIP/AppImage/NSIS 构建；Node 最低版本由 20 提至 22.12。加入模型窗口配置和保守字节预算；history 用预计算事件大小削减尾部；恢复按调用 ID 的出现次数排队，拒绝同批重复/空 ID。附件导入失败回滚；文件替换复核 dev/ino/size/mtime，编辑拒绝无效 UTF-8；Docker 取消清理容器。

**Benefits。** 运行期：抑制超限输入、错误重放和并发替换造成的覆盖。工程期：跨平台差异有固定验证入口；历史预算减少重复序列化同一批事件。

**Trade-offs & Notes。** Node 最低版本升级属于运行环境兼容变化。字节预算不是精确 token 计数；最初上限 2,000,000 后被收紧。CI 配置不证明所有矩阵历史执行通过，也不替代桌面端到端验收。

### 19 · `45fb930` · 架构说明与边界输入修补

**背景与动机。** 文档解释不足，文件浏览/写入仍允许根路径进入底层检查，配置错误和 MCP 工具参数可见性影响使用。

**What & How。** 扩充 INTRODUCTION；桌面文件操作显式拒绝工作区根目录，写入上限 10 MB；桌面验证 Base URL。MCP listTools 返回 inputSchema；客户端取消 IPC 增加防护；临时目录和本地 endpoint 处理调整。

**Benefits。** 运行期：更早拒绝错误输入，MCP 调用可看到真实 schema。工程期：用户理解执行、恢复和上下文限制，减少误用。

**Trade-offs & Notes。** 标题以 docs 开头但包含运行期修改。本提交允许 0.0.0.0 免密钥并容错非法 modelProtocol URL；这两项在下一提交被主动收回，不能当作当前行为。

### 20 · `a21287d` · 严格 URL 与沙箱边界

**背景与动机。** 字符串前缀识别 localhost 容易误判含用户名或伪装 hostname 的 URL；0.0.0.0 不应作为 loopback 信任依据。

**What & How。** 用 URL 解析后的 protocol/hostname 判断本地兼容 endpoint，只允许明确 loopback；非法 modelProtocol 地址抛错，避免静默选协议。撤销 MCP 系统 tmpdir 写入扩展，保留固定临时目录；调整桌面缺失目录错误来源。

**Benefits。** 运行期：本地免密钥边界更明确，减少地址歧义。工程期：测试明确覆盖主机伪装与非法 URL，配置问题尽早暴露。

**Trade-offs & Notes。** 对先前使用 0.0.0.0 免密钥或非法地址的配置是行为收紧；改用 loopback 或显式凭据。该安全边界不能泛化为对所有 DNS/代理威胁的保护。

### 21 · `1ad3c56` · bwrap 与审批后的宿主回退

**背景与动机。** 缺少 Docker 或 macOS sandbox-exec 时，Shell/stdio MCP 原本不可用，妨碍开箱使用。

**What & How。** 探测 macOS sandbox-exec 与 Linux bwrap；Shell 的 bwrap 使用根只读挂载、工作区可写、临时目录及网络隔离；MCP 保留网络以支持服务器。无内核沙箱时允许经审批在宿主执行，BRUIN_ENFORCE_SANDBOX 可强制拒绝。Windows 增加系统环境变量和可执行文件扩展解析；IPC send 增加回调。

**Benefits。** 运行期：多平台可用性提升，有 bwrap 的环境仍保持文件写入限制。工程期：隔离能力由探测结果决定，减少外部容器配置成本。

**Trade-offs & Notes。** “经审批”不等于“受沙箱约束”；默认宿主回退显著改变权限风险。原 BRUIN_ALLOW_UNSANDBOXED_SHELL 显式开启机制被替换，部署策略需关注新的强制模式。不能把本提交描述成所有平台默认安全沙箱。

### 22 · `09cbc08` · 无人逐次审批的 Hook 必须有沙箱

**背景与动机。** 前一提交的宿主回退若同样适用于自动 Hook，会让未逐次审批的命令直接在宿主运行。

**What & How。** ToolRequest 增加 requireSandbox，runHooks 设置为 true；Worker 在缺少隔离时拒绝。Shell/MCP 审批文案说明宿主执行范围；Windows 可执行扩展探测修正；版本升至 0.8.0。

**Benefits。** 运行期：自动执行路径不会继承普通审批命令的宿主回退。工程期：是否必须隔离进入显式契约，便于审查。

**Trade-offs & Notes。** 缺沙箱平台上的 Hook 可用性下降，这是主动安全取舍。新增 Hook 拒绝与标准执行回归；该限制针对 Hook，不意味着所有无人值守预授权 Shell 都强制沙箱。

### 23 · `88701c9` · 取消、MCP 连接与配置锁修正

**背景与动机。** Windows 只终止父进程可能留下子进程；同时建立 MCP 连接可能重复启动；活进程持锁超过时间阈值不应被判为陈旧锁。

**What & How。** Windows 使用 taskkill /T /F 并有超时兜底；取消过程共享一次清理 Promise。MCP 建连按服务器排队，关闭时等待建连完成。配置锁仅在确认 PID 已死，或无有效 PID 且超时时清理；保存失败清理临时文件。附件按实际读取量限界，历史图像不读取字节。

**Benefits。** 运行期：减少孤儿进程、重复 MCP 会话和大图历史 IO；降低错误破锁导致的丢配置。工程期：取消和连接的生命周期更易推理。

**Trade-offs & Notes。** 同服务器建连串行不能保护完整工具调用生命周期，`37493ad` 继续扩展保护。系统进程终止仍受平台权限影响，不能保证强杀/断电后的所有资源都已清理。

### 24 · `938e480` · 跨平台统一 LF

**背景与动机。** Windows checkout 换行差异会制造格式检查与脚本行为不一致。

**What & How。** `.gitattributes` 增加 `* text=auto eol=lf`。

**Benefits。** 运行期逻辑无变化；工程期减少 CRLF 引起的噪声与跨平台差异。

**Trade-offs & Notes。** text=auto 仍依赖 Git 对文本/二进制的识别；后续特殊格式可加更具体规则。本提交不包含全仓重新格式化。

### 25 · `6576409` · Windows 文件句柄、Shell 引号与 worktree 路径

**背景与动机。** 提交标题将问题归因于 CI；diff 具体表现为打开中的文件句柄阻碍替换、cmd 参数引用与 Git 路径格式差异。

**What & How。** edit_file 先读取/计算并关闭句柄，再 replaceFile；Windows cmd 使用 /d /s /c 和 windowsVerbatimArguments；指令读取增加显式 symlink 检查。worktree 不再直接字符串匹配 Git 输出，而是尝试 realpath 比较；测试适配平台条件。

**Benefits。** 运行期：提高 Windows 编辑、命令传递与目录识别正确性。工程期：平台差异在适配层处理，核心权限语义保留。

**Trade-offs & Notes。** Shell 参数规则不能套用 POSIX 习惯。realpath 字符串仍可能受 Windows 路径别名影响，后续两提交完成诊断和修正；部分 Docker 测试具有平台跳过条件，应在目标平台另做验收。

### 26 · `4a088c2` · worktree 失败诊断

**背景与动机。** 仅断言“已移除”不足以定位 Windows 的路径别名差异。

**What & How。** 测试失败信息追加目标路径、Git 列表及每项 realpath，不改变成功判定。

**Benefits。** 运行期产品行为无变化；工程期失败证据更完整，下一修复有可核对输入。

**Trade-offs & Notes。** 这是诊断提交，不是功能修复或放松断言。输出路径限于测试临时仓库，本次没有读取远程 CI 日志。

### 27 · `8e3b820` · 用文件身份识别 worktree

**背景与动机。** 同一目录在 Windows 不同别名下可返回不同规范路径字符串。

**What & How。** stat 目标及 Git 列表目录，以非零 inode、dev 和目录类型识别同一对象；移除临时诊断信息。

**Benefits。** 运行期：安全移除不再被合法别名误阻挡。工程期：权限身份判断从字符串迁移到文件系统对象证据。

**Trade-offs & Notes。** 文件系统若无法提供非零稳定 inode，会保守拒绝；不能把比较方法扩展成跨文件系统通用标识。仍复用 Git 的非 force 移除保护。

### 28 · `d6ec5b6` · 审批策略、持久摘要与暂停续跑

**背景与动机。** 每次相同命令都审批影响连续工作；超过上下文或步数后直接失败会丢失任务进展认知。

**What & How。** Shell 授权匹配“工作区＋完整命令”，支持单次、会话和长期范围，以及六条固定只读命令 autoSafe。窗口上限收紧至 1,048,576，并迁移旧超限值。网关增加 summarize；Agent 分段摘要并保存 throughSeq 检查点，上下文错误压缩后重试。达到步数写执行报告和 turn_paused，桌面/CLI 提供继续或结束。

**Benefits。** 运行期：减少重复交互与超限失败，保留已执行副作用的上下文。工程期：授权可撤销、摘要可追溯、暂停区别于完成；模型未确认结果时报告来自工具事件。

**Trade-offs & Notes。** 完整命令白名单比任意前缀规则保守，但命令环境和仓库程序仍会变化。摘要有损且增加模型调用；当前超长请求摘要可能改变语义。初版 budgetPrompt 会裁系统指令/附件，`5d529d0` 修正。并非所有额外摘要调用都计入后续主调用预算和用量显示。

### 29 · `8e2777f` · 0.9.0 发布标记

**背景与动机。** 对审批、上下文和续跑阶段建立可识别版本边界。

**What & How。** package/lock 升至 0.9.0，更新 README/DESKTOP；测试变化仅将一个 assert.rejects 格式化为单行。

**Benefits。** 运行期无新能力；工程期提供部署和回滚定位锚点。

**Trade-offs & Notes。** 后续 12 个提交仍保留 package 版本 0.9.0，所以 HEAD 比 v0.9.0 标签具有更多功能。仅凭版本号无法区分这些构建，应记录 Git SHA。

### 30 · `21fa675` · 显式长运行与检查点

**背景与动机。** 24 次主模型调用不够支持较大任务；续跑需要清楚的预算、权限与进度记录。

**What & How。** CLI/桌面开放 24/96/240 调用预算，长任务最长配置 8 小时，每 24 次写 turn_checkpoint。run_configured 保存设置；可显式授权本段文件写入。Electron prevent-app-suspension 防止长任务因应用挂起中断；CLI 非交互暂停返回退出码 2。新回合与续跑区分，避免重复启动回合 Hook。

**Benefits。** 运行期：允许更长连续执行且仍有上限，用户可观察持久进度。工程期：调用预算与授权作为可审计配置，不依赖仅在内存中的开关。

**Trade-offs & Notes。** 长任务提高调用成本与错误累积概率；检查点不是整个工作区备份。8 小时边界在循环检查处生效，不能仅据配置宣称所有在途 Provider/工具请求会在该时刻被强制中断。防应用挂起不等于自动恢复或常驻服务。

### 31 · `5d529d0` · 压缩保留语义与模型边界

**背景与动机。** 先丢旧轮次可能优先丢用户目标；摘要过滤后丢 model_switched 边界，会错误复用旧 Provider 消息；截断输出尾部可能隐藏终态错误。

**What & How。** 在摘要过滤前计算最后模型切换序号；先压缩可重新读取的工具输出，再折叠旧轮次；输出保留头尾。长单轮构造压缩活动说明，保留真实用户请求；最小提示若放不下系统指令/必要附件则报错。

**Benefits。** 运行期：降低误解任务、错误协议续聊与漏读终态的概率。工程期：压缩优先级更明确，并为“不能安全压缩”提供显式失败路径。

**Trade-offs & Notes。** 不再静默缩减系统规则可能令之前勉强运行的配置报预算不足，这是正确性换可用性的取舍。新增五项历史回归测试支持上述结论。

### 32 · `b184828` · 有界无人值守运行

**背景与动机。** 无人值守不能停在审批对话框，也不能自动重放未确认副作用。

**What & How。** 显式 unattended 支持最高 480 主调用及 8 小时；没有预授权的工具立即拒绝，并向模型说明换方案或请求人工协助。保留文件与完整 Shell 的既有授权；headless 恢复发现 unknown 返回退出码 3。配置事件记录实际运行模式。

**Benefits。** 运行期：避免永远等待审批，保护未知结果不自动续跑。工程期：交互与无人值守模式行为明确，预算与授权可回归验证。

**Trade-offs & Notes。** “无人值守”提高执行连续性，不增加默认权限。480 必须显式无人值守；重复请求拒绝主要依赖模型反馈与之后的失败提示，并不是硬性无限循环证明或费用上限。

### 33 · `74977a0` · 取消、单一重试层与任务报告

**背景与动机。** 取消可能发生在模型返回后或审批期间；SDK 与 Runner 重试叠加会放大请求次数；回合结束不等同任务完成。

**What & How。** 批量工具前、每个工具前、审批后与运行时入口检查取消，未开始调用记录 denied。主网关 maxRetries=0，由 Runner 控制最多三次尝试，增加 408/504；已输出正文不重试。重复失败输入按规范化参数计数，三次后提示调整，状态轮询豁免。子 Agent 暂停报告未完成；未完成规划步骤发提示；显式工具属性检查拒绝原型名称；指令文件拒绝 FIFO。

**Benefits。** 运行期：减少取消后副作用和无谓请求；工程期：事件反映实际开始与否，子任务完成语义更准确。

**Trade-offs & Notes。** 最大三次是主 complete 的尝试边界，摘要函数仍有独立重试设置。重复失败提示有 200 事件窗口，不是强制停止策略。新增多类取消、原型、重试、子任务和规划回归。

### 34 · `37493ad` · 文本完整性与 MCP 完整生命周期隔离

**背景与动机。** 截断预览若可保存会覆盖完整文件；UTF-8 截断产生替换字符；仅串行建连无法防止切工作区关闭在途 MCP 调用。

**What & How。** 桌面截断预览只读、后端重新检查目标大小；严格 UTF-8、保留 BOM、流式解码保留不完整边界字符；指令文件实际读取上限。McpManager 按 server 名串行连接/调用/断开，并等待在途操作关闭；失败不会毒化后续队列。上下文提醒恢复已加载 Skill 快照。

**Benefits。** 运行期：降低字节损坏和中断在途调用风险。工程期：前后端共同保护完整性，Skill 恢复复用保存版本，MCP 生命周期可测试。

**Trade-offs & Notes。** 同服务器串行牺牲并行吞吐；一个慢调用会延迟后续调用/注销。256 KB 在源码中实际为 256,000 字节，不应解释为 256 KiB。无效编码直接拒绝，需要外部工具处理。

### 35 · `eacc197` · 分页文件与目录探索

**背景与动机。** 只读文件头部及前 300 目录条目会漏掉大仓库关键内容；stat 后增长和短读取导致不完整结果。

**What & How。** read_file 增加可选 startLine/lineCount；新增 list_files，复用目录校验、offset 和输出预算，在 CLI、桌面、规划与只读子 Agent 全链路接入。Worker 有界读取循环处理短读和增长；附件按实际复制量校验并回滚，提取截断显式标记且保留 Unicode 字符；特殊文件不阻塞读取。

**Benefits。** 运行期：按需取内容，减少单次输出和上下文占用；工程期：工具契约表达 hasMore/nextOffset 与行范围，模型可继续探索。

**Trade-offs & Notes。** 分页改善输出规模，不意味着随机寻址：按行读取需从文件头扫描到目标行；目录每页仍读取/排序整层。list_files 不遵循 gitignore，模型应结合 search_repository。新增 14 项探索/附件/短读回归。

### 36 · `b79ec42` · 展示已记录 Token 用量

**背景与动机。** 长任务成本缺少可见指标；缺失计数若视为零会给用户虚假的精确性。

**What & How。** `src/core/usage.ts` 从 assistant 事件投影累计输入/输出，合法安全整数转 BigInt 相加，分别统计报告覆盖数；部分用量显示 ≥，缺失显示未提供；React useMemo 使用持久事件，不受上下文压缩和模型切换清零。

**Benefits。** 运行期：用户能观察已记录资源消耗；工程期：不更改数据库/IPC/Provider 契约，投影逻辑有独立测试。

**Trade-offs & Notes。** 不是费用账单、当前上下文占用，也不覆盖所有摘要或失败尝试的费用。BigInt 只能保持已接受计数的累计精度，不能修复 Provider 原始不精确数据；程序生成的 assistant 报告也影响覆盖口径。

### 37 · `a3e1a0d` · 仓库索引、快照与 MCP OAuth

**背景与动机。** 大仓库缺少声明定位；文件操作缺少受保护撤销；HTTP MCP 只支持 Bearer 环境变量，无法交互式授权。

**What & How。** 新增 repository-index：Git 候选列表、SHA-256 每次校验、声明正则和路径/符号排序；限制候选、文本读取、扫描时间并跳过私有目录。snapshots 在替换前保存字节、权限、before/after hash，恢复必须匹配当前 after hash；新建文件恢复意味着删除。桌面保存提交 expectedContent 防旧页覆盖。MCP OAuth 复用 SDK discovery/PKCE，loopback 回调校验 state、单次消费、超时取消，凭据只存后台内存。

**Benefits。** 运行期：定位代码更直接，外部修改后拒绝回滚/旧编辑页覆盖，支持标准授权服务。工程期：索引、快照、OAuth 拆为独立模块，复用既有审批与只读工具边界。

**Trade-offs & Notes。** 索引不是 AST/语义依赖图，每次仍读文件校验 hash；快照不是工作区事务或通用备份，不覆盖 Shell/MCP。上限 200 条、约 500 MB 时拒绝新增写入，快照包含源码；OAuth 重启需重新登录，注销不撤销服务端授权。新增模拟 OAuth、索引失效、权限/BOM/回滚与并发覆盖测试。

### 38 · `6e9922c` · 预览、缓存、默认 worktree 名与特殊路径

**背景与动机。** 单次 readSync 不保证读满；子目录工作区 Git 基线定位错误；可变缓存被调用方修改；UUID 以数字开头会违反默认 worktree 名规则。

**What & How。** 预览循环短读；Git show 使用 HEAD:./ 相对仓库子目录解析；索引过滤无效缓存条目，模型列表验证 JSON 形状并返回数组副本。默认名加 worktree-；MCP 路径验证用原始 realpath，仅在策略字符串中转义。搜索降级准确标记省略匹配并保留字符边界；保留未保存编辑的旧基线。

**Benefits。** 运行期：消除若干看似偶发的路径、缓存和读写错误。工程期：测试覆盖短读、调用方缓存污染、数字 UUID 与引号/空格目录，扩大输入多样性。

**Trade-offs & Notes。** 缓存恢复并非发现所有磁盘损坏；列表数组副本有小额分配成本，换取调用隔离。默认工作树命名是可见改动，但用户显式名称规则没有放宽。

### 39 · `642f8e3` · 搜索生命周期与跨会话状态隔离

**背景与动机。** 慢异步响应可能把会话 A 的文件/附件写入已切换的 B；释放过期任务若重新 pending，会把未知副作用重新自动派发。fallback 搜索缺少取消/超时与同句柄读取闭环。

**What & How。** React 引入 viewRevision 与 sessionId 双检查，陈旧 open/save/import/refresh 响应不提交；切换清空文件、附件、引用、授权和运行配置。releaseTask 按过期情况设 unknown/pending。搜索绑定 active 取消入口和 deadline，使用同一 O_NOFOLLOW/nonblock fd 检查并读流，有限读取、等待流完成、定期让出事件循环。

**Benefits。** 运行期：减少会话间状态串扰、误重跑及取消后后台 IO；工程期：异步更新具有可复用的有效性条件，租约释放和过期语义保持一致。

**Trade-offs & Notes。** revision 忽略陈旧返回，不一定取消底层工作；切换会重置编辑状态，需要关注未保存内容体验。新增服务端搜索/任务回归，但没有为 React 竞态新增桌面端到端测试。对 autoClose:false 路径做专项复现后未发现当前 Node 下描述符泄漏，不将其报告为缺陷。

### 40 · `c9dc95c` · 主题统一与浮动文件审核

**背景与动机。** 文件变更分散在日志/文件树，用户缺少统一审核入口；暗色主题仍有亮色局部表面。

**What & How。** 新增 workspace-review 模块与 listWorkspaceChanges/readWorkspaceReview 接口；按工具请求/结果出现次数配对，仅归属成功文件写入，工作区切换清空旧写入。合并 Git porcelain -z 状态，处理仓库子目录、空格、重命名和删除；优先会话首个成功写入时间范围内快照，回退 Git HEAD。React 加审核 dock、只读删除差异，CSS 用主题变量统一表面。

**Benefits。** 运行期：用户更容易发现、比较和检查 Agent 修改；工程期：事件归属与 Git 工作区状态分开，减少将所有未提交修改误归因于 Agent。

**Trade-offs & Notes。** 非 Git 目录不能自动发现 Shell/MCP 的其他修改；快照缺失时无法重建精确会话前状态。来源标签代表成功写入记录，不保证之后未被他人修改。四类审核回归通过；主题视觉与真实点击仍需验收。

### 41 · `dca9d2f` · 对话区居中审批与主题一致

**背景与动机。** 审批曾位于应用层浮动区域，视觉位置与实际对话区不一致；局部颜色未完全遵循主题。

**What & How。** 审批 JSX 移入 main-area；父容器 relative，dock absolute 并避开顶部栏，用 grid 居中。外层 pointer-events:none、面板 auto 保留可交互区域；限制高度并允许滚动。颜色、边框和阴影使用 review 主题变量。

**Benefits。** 运行期：审批上下文更清楚，大输入可滚动；工程期：复用主题变量，减少颜色分叉。审批范围、参数显示与决定回调未新增业务规则。

**Trade-offs & Notes。** 小窗口、键盘焦点、读屏与文件审核遮挡仍需 UI 验收；本提交没有新增测试。类型检查验证 JSX 类型，不能证明像素和交互无误。

## 4. 跨提交技术剖析

### 4.1 从文本记录到执行证据

从根提交到 `39288b5`、`74977a0`，日志逐步明确了请求、授权、开始、完成、拒绝和未知。重复工具 ID 从简单 Map 演进为按出现次数配对；取消后尚未执行的调用记 denied；已完成操作的后置 Hook 失败不会推翻完成事实。

长期价值是恢复时少做错误判断：**未知不等于失败，模型回复不等于任务完成，审批不等于执行成功。** 当前事件能审计执行意图，但文件、Shell、MCP 副作用与数据库不原子。未来接入资金、发布等不可逆系统时，需要目标系统幂等键/查询/补偿，而不是增加一条本地事件就声称 exactly-once。

### 4.2 SQLite 权威与可修复投影

`1e8713c` 引入租约，`27224df` 将任务作用域改为工作区；`f158bc3` 撤销危险孤立清理；`642f8e3` 修复过期释放。整体选择是让 SQLite 管竞争和状态，文件提供可读投影。

这比依赖 `.tasks` 文件读改写减少同机并发认领风险，但仍不是分布式协调。不同会话可指向同工作区，会话租约并不能自动排他保护全部文件；expectedContent/hash/stat 冲突检测承担另一层责任。错误消息和 UI 应一直清楚说明数据库已提交但快照失败的情形。

### 4.3 文件完整性从“能写”演进为“可检查地写”

主要链条：文件描述符写入 → 随机临时文件＋fsync＋rename → 身份复核 → 严格编码/增长限界 → expectedContent → before/after 快照 → 会话级审核。它们分别解决中途截断、目标变化、字节损坏、旧编辑页覆盖、撤销和人工检视。

这些机制互补：快照不能替代写入冲突检测，原子替换不能保证检查后路径不变，Git HEAD 不能代表当前会话开始前的未提交文件。最后一步路径替换竞态仍在 README/SECURITY 中明示；元数据如 ACL/扩展属性也不应从 mode 保留推断为完整保留。

### 4.4 上下文管理是在取舍信息价值

预算机制先从固定轮数/字符上限，演进到事件大小预计算、模型窗口字节预算、throughSeq 持久摘要，再调整为先压工具输出、保留用户目标/系统规则/必要附件。

真正优化是降低大输出对决策信息的挤压，并可跨重启复用摘要。字节计数、图片固定估算仍不是精确 tokenizer；摘要会遗漏信息，额外摘要调用也消耗时间与费用。只读分页和索引因此不仅是工具增强，也帮助模型从源文件重新获得被压缩的细节。

### 4.5 权限、可用性和平台能力不能合并成一个指标

`1252e89` 放宽 MCP 读取/联网；`1ad3c56` 增加沙箱与宿主回退；`09cbc08` 为 Hook 排除宿主回退；`d6ec5b6` 增加授权范围；`b184828` 无人值守立即拒绝未授权。它们优化的目标不同。

| 机制                          | 能证明的事情                   | 不能证明的事情                         |
| ----------------------------- | ------------------------------ | -------------------------------------- |
| 工具 schema 与白名单          | 输入结构和工具身份符合显式定义 | 命令/外部服务本身安全                  |
| 工作区路径校验                | 检查时路径符合边界             | 恶意进程并发替换后仍无竞态             |
| 审批与完整命令授权            | 用户授权了特定执行意图         | 执行受到内核隔离或命令长期行为不变     |
| sandbox-exec / bwrap / Docker | 在有效配置下具有相应系统边界   | 所有平台具备相同隔离能力               |
| 限制子进程环境变量            | 不直接继承未允许的环境密钥     | 子进程无法读取账户可访问的本地文件     |
| 无人值守模式                  | 未授权请求不会等待用户         | 可无限运行、自动完成或自动修复所有故障 |

### 4.6 性能收益的证据和局限

| 优化             | 技术机制                                             | 收益边界                                                            |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| 历史尾部预算     | 预计算事件序列化大小，逐轮减去已计数大小             | 相比反复序列化整段减少重复工作；完整 Prompt 构建仍有扫描/序列化成本 |
| 模型目录缓存     | 五分钟有效期，Provider/地址/凭据 hash 隔离，返回副本 | 减少重复请求；缓存条目仍需生命周期管理，列表能力不代表实际聊天能力  |
| 历史图像跳过     | 旧轮不读/不发图像字节                                | 减少磁盘 IO、编码与上下文；需要重新分析时必须重新提供图像           |
| 行/目录分页      | 有界输出、行范围和 nextOffset                        | 控制响应内存/上下文，不等于 O(1) 随机页读取                         |
| 行差异           | 相同前后缀剥离；剩余 LCS 超阈值降级                  | 常见局部修改更便宜；中间部分仍 O(mn)，超过阈值牺牲精度              |
| 仓库索引缓存     | 全量候选重新读 hash，未变内容复用声明解析            | 节省解析，仍近似 O(候选数＋读取字节)；不是亚线性检索引擎            |
| MCP 串行队列     | 同服务器连接/调用/关闭统一排队                       | 稳定性和隔离提升，单服务器吞吐下降；不同服务器仍有独立队列          |
| 单一主请求重试层 | SDK 主请求不重试，Runner 最多三次                    | 防重试倍增；摘要请求另有策略，预算不是所有网络请求/费用硬上限       |

没有性能压测或生产数据支持改善幅度。需要区分机制收益与实际用户延迟收益：磁盘 hash、摘要模型请求和完整事件扫描都可能成为新开销。

## 5. 当前影响与建议

### 5.1 基线已确认的文档一致性问题（并行工作已修正）

基线 `dca9d2f` 的 `docs/ARCHITECTURE.md:47` SQLite 小节写 `PRAGMA user_version=1`，且称“没有正式迁移器”。当前 `src/storage/event-store.ts:102` 支持至版本 8，并执行 5→6、6→7、7→8 的内联升级逻辑。可以准确说“没有独立、版本化迁移框架”，但不能继续把当前 schema 描述为 1。

建议同步文档与真实升级流程，列出备份、升级失败与不支持降级的边界。这是本次可直接核对的基线问题，不需要假设线上故障。收尾时观察到其他并行工作已将未提交的架构文档改为 schema 8，并说明构造阶段升级分支；因此不再把这一点列为当前工作区尚未修复的问题。

### 5.2 按优先级建议的后续工作

| 优先级 | 主题               | 证据与影响                                                      | 建议与验收方式                                                                                         |
| ------ | ------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 高     | 三平台真实桌面验收 | CI 多平台与单机测试不覆盖 Electron 点击、系统沙箱和浏览器授权   | 在 macOS/Linux/Windows 跑启动、文件编辑、取消子进程、Hook 拒绝、OAuth 回调与审核流程，记录实际隔离后端 |
| 高     | 长运行预算口径     | maxModelCalls 控制主循环；摘要请求、重试和在途 IO 有不同边界    | 明确主轮数/真实请求数/费用/墙钟截止区别；用卡住的 Provider 与慢工具验证上限生效时序                    |
| 高     | 当前文档与版本定位 | schema 文档陈旧；v0.9.0 标签后仍有 12 个提交且包版本不变        | 更新 schema 章节，在产物/诊断中展示 SHA，避免用相同版本号误判能力                                      |
| 中     | 快照空间与恢复预期 | 上限时拒绝写入；只覆盖文件工具/桌面，记录可能尚未应用           | 给出可审查清理/导出流程，显示空间与未应用状态；不自动删历史，不宣称工作区原子回滚                      |
| 中     | UI 陈旧响应与草稿  | revision 防污染，但没有端到端竞态覆盖，切换重置文件状态         | 人为延迟 A 的打开/保存/导入后切到 B，断言不污染；验收未保存编辑的提示/保留策略                         |
| 中     | 大仓库与长日志     | 索引每次读 hash、目录每页排序、日志反复扫描，差异在主线程计算   | 针对万文件、超大目录、长单轮与大量事件测 p95 延迟/内存，再决定增量索引、缓存投影或 Worker 化           |
| 中     | 错误类型与模块规模 | services 通过错误 message 分类；Agent/Host/React 主文件持续增长 | 保持行为的前提下引入可区分的错误类型；先按生命周期/投影边界拆分，避免无需求大重写                      |
| 中     | 权限反馈透明度     | 宿主回退与 MCP 全局读取被文档允许                               | 界面持续显示实际隔离后端和作用域；测试配置变化、长期授权撤销及恶意格式输入                             |
| 低     | 用量口径           | assistant 事件统计包含程序报告，摘要/失败费用不可完整覆盖       | 分离模型响应数与程序报告数，明确已报告用量覆盖率；不把它伪装成计费或窗口剩余量                         |

以上除文档不一致外主要是边界与工程建议，不表示已经发现对应生产缺陷，也不建议未经业务确认直接改变公共接口、数据库或权限策略。

### 5.3 兼容与依赖清单

- **运行环境**：Node 最低版本在 `3d1d860` 从 20 升为 22.12；平台沙箱能力不同，真实执行可能在宿主。
- **数据契约**：schema 从根版本 1 演进至 8；工作区任务迁移后不随源会话删除；旧程序面对未来 schema 会拒绝打开。文件快照/索引单独落盘，不是同库事务。
- **工具契约**：read_file 的分页参数为可选，旧调用保留；新增 list_files/search_repository/list_snapshots/restore_snapshot；审批边界与子 Agent 白名单同步扩展。外部自定义网关或执行器需按新工具集验证。
- **上下文配置**：窗口上限由 2,000,000 收紧为 1,048,576，loadConfig 迁移旧值；超预算不再静默删系统规则/必要附件。
- **依赖扩展**：`fb9012a` 新增 MCP 客户端 2.1.0；`1e8713c` 新增 cron-parser、react-markdown、remark-gfm。OAuth 复用现有 SDK，没有再增加独立 OAuth 库。package-lock 变化也包含版本更新，不能将其全部解释为升级依赖。
- **用户行为**：自定义 OpenAI 默认转 Chat Completions；0.0.0.0 不享有 loopback 免密钥；默认新会话延迟创建目录；旧图像不重复发送；大文件截断预览不可覆盖保存。

## 6. 本次验证

针对分析基线执行当前版本检查，未对全部历史 SHA 逐一构建，未升级依赖或修改实现：

| 验证                           | 结果                                 | 解释                                                     |
| ------------------------------ | ------------------------------------ | -------------------------------------------------------- |
| `git status --short`           | 初始只有两个未跟踪 `.DS_Store`       | 保留原文件，不清理用户数据                               |
| 提交计数、父图与全部本地引用   | HEAD 可达 41；未发现其他引用额外提交 | 无远程 fetch，范围限定本地                               |
| 根提交、普通提交与合并父差异   | 全部提交已纳入本文                   | 核心路径、测试、文档与配置交叉核对                       |
| `npm run check`                | 通过                                 | 核心 TypeScript 检查                                     |
| `npm run desktop:check`        | 通过                                 | 桌面 TypeScript 检查                                     |
| `npm test`，受限沙箱首次       | 149 通过、10 失败、1 跳过            | 10 项均因 `listen EPERM 127.0.0.1`，未据此判为代码故障   |
| `npm test`，允许本地监听后重跑 | **160 项：159 通过、0 失败、1 跳过** | 含构建；Provider/MCP OAuth 使用本地模拟服务器            |
| `npm run format:check`         | 通过                                 | 原仓库检查通过；新增本文另做格式化和检查                 |
| 搜索描述符专项核对             | 未复现泄漏                           | 当前 Node 销毁流路径关闭描述符；撤销静态阅读时的初步疑点 |

尚未验证真实 Provider 账号、远端 MCP/OAuth、实际系统浏览器交互、三平台桌面端到端、签名公证、远程 CI 运行结果与性能基准。源码与测试支持本文机制结论，但不支持“生产绝无副作用”或“所有平台已验收”的表述。

## 7. 工程演进评价

值得保持的做法是复用统一 Agent 与执行器、把 schema/权限/审批/执行/事件串成链、为危险历史状态保守拒绝自动重放，以及用回归测试锁定故障时序。`4a088c2`→`8e3b820` 的诊断再修复、`cf5da22`→`f158bc3` 的撤销危险清理、`21fa675` 之后的长任务边界补齐，都是历史中可学习的案例。

需要改善的是提交粒度与模块增长。功能、文档、安全和 UI 经常同批进入，虽能快速交付完整闭环，也提高因果定位难度。后续宜把独立生命周期修复、契约扩展、界面展示拆成能单独验证的提交，保留跨模块必要的原子改动；在有性能数据和真实验收后，再推动增量索引、模块拆分和迁移框架。

Bruin 的长期价值目前最强地体现在**可追溯执行、保守恢复和人工审核闭环**。仓库索引、长任务与 OAuth 扩展了能力范围，而能否稳定持续运行，仍取决于这些已建立的边界是否被新的功能持续遵守。

## 附录 A · 复查命令

```sh
git rev-list --count HEAD
git log --reverse --format='%h %ad %p %s' --date=iso-strict
git show --root <SHA> -- src/core/agent.ts src/storage/event-store.ts
git diff 7cd8d3d^1 7cd8d3d
git diff 7cd8d3d^2 7cd8d3d
git log --all --oneline --not HEAD
npm run check
npm run desktop:check
npm test
npm run format:check
```

## 附录 B · 完整提交索引

下表由本地 Git 元数据生成，时间均为 +08:00；提交标题保留原文，规模包含源码、测试、文档、锁文件等。合并提交规模以第一父提交比较，仅用于定位，不作为独立功能工作量。

| #   | SHA                                        | 时间             | 原始标题                                                                                   | 变更文件数 / 增删行                                    |
| --- | ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 01  | `14733ce802b5451583a59410836c5b059570e3d3` | 2026-09-27 17:33 | feat: initialize Bruin agent and desktop client                                            | 40 files changed, 11671 insertions(+)                  |
| 02  | `fb9012af4e446625c4302f6de1644a005b183f1e` | 2026-09-27 22:54 | feat: add desktop agent orchestration and theming                                          | 38 files changed, 3003 insertions(+), 128 deletions(-) |
| 03  | `0dd175b8e14c016babe0665ea7cb0bf5c34ed726` | 2026-09-27 23:08 | fix: use chat completions for custom OpenAI endpoints                                      | 10 files changed, 134 insertions(+), 24 deletions(-)   |
| 04  | `1e8713c13859fc1412971b68294c84ea4a22d474` | 2026-09-28 00:16 | feat: add durable desktop agent orchestration and Markdown rendering                       | 21 files changed, 3013 insertions(+), 236 deletions(-) |
| 05  | `27224df48fd54ad3d87aa95b5402921da8463c8b` | 2026-09-28 00:37 | feat(tasks): share workspace task graph with repairable snapshots                          | 15 files changed, 478 insertions(+), 76 deletions(-)   |
| 06  | `9db8569457da06779e1461f36ce24e34f11d4b79` | 2026-09-28 01:04 | feat(desktop): add instructions, preferences, and workspace browser                        | 16 files changed, 482 insertions(+), 14 deletions(-)   |
| 07  | `9b1453cf07ab3145b98d0af384af0878a1ed58eb` | 2026-09-28 08:55 | feat(desktop): add lazy workspaces and chat attachments                                    | 15 files changed, 892 insertions(+), 111 deletions(-)  |
| 08  | `1252e89e46cab477657fb920ebd1ab7aee3e4ce6` | 2026-09-28 12:55 | feat(mcp): allow stdio network and local reads                                             | 2 files changed, 15 insertions(+), 27 deletions(-)     |
| 09  | `cf5da22edbf6348861c88dd747f8437fa912b4ff` | 2026-09-28 12:57 | feat: improve agent recovery and task management                                           | 9 files changed, 939 insertions(+), 27 deletions(-)    |
| 10  | `f158bc33067df3c2295e7e153b5bfc259336f2b9` | 2026-09-28 14:16 | fix: harden task snapshots and agent file operations                                       | 5 files changed, 169 insertions(+), 49 deletions(-)    |
| 11  | `b39b402bdd81c1f09619af0dbc01ad1c5c82fbd1` | 2026-09-28 14:39 | fix: support nested writes and safe runtime failure handling                               | 8 files changed, 226 insertions(+), 24 deletions(-)    |
| 12  | `ba9c48243b4452a603838576f14020391bd87211` | 2026-09-28 14:58 | fix: isolate skill error boundaries and cleanup search streams                             | 5 files changed, 131 insertions(+), 14 deletions(-)    |
| 13  | `39288b5be264f29eeb08910fe39282b55813741e` | 2026-09-28 18:07 | fix: harden production reliability, session safety, and config concurrency                 | 16 files changed, 950 insertions(+), 153 deletions(-)  |
| 14  | `f72b20770077ad3a4434e13a8ae80403bcbd9a28` | 2026-09-28 18:16 | release: prepare Bruin 0.7.1 local package                                                 | 4 files changed, 14 insertions(+), 4 deletions(-)      |
| 15  | `fb6861ecc336761835ea8af1be84a733854c18bc` | 2026-09-29 00:13 | ci: disable implicit electron-builder publishing                                           | 1 file changed, 1 insertion(+), 1 deletion(-)          |
| 16  | `7cd8d3d4862b3ce22fadfbc4147c75c2639e61dc` | 2026-09-29 00:16 | Merge remote-tracking branch 'origin/main'                                                 | 1 file changed, 1 insertion(+), 1 deletion(-)          |
| 17  | `d8a5c7939ae88df9b8d725cd1910734d7137453a` | 2026-09-29 00:19 | feat: enhance UI, documentation, security and workspace file operations                    | 12 files changed, 2218 insertions(+), 220 deletions(-) |
| 18  | `3d1d860d4e5cd32abccb52281f6cc9315dfb7778` | 2026-09-29 00:55 | feat: harden agent runtime and add cross-platform validation                               | 22 files changed, 795 insertions(+), 131 deletions(-)  |
| 19  | `45fb930174527daa344373eb6de33ce8b50b22f0` | 2026-09-29 01:37 | docs: expand architecture guide and enhance production reliability                         | 9 files changed, 243 insertions(+), 9 deletions(-)     |
| 20  | `a21287d4c847a338495b86cdf277633eb8d48f12` | 2026-09-29 09:00 | fix(security): refine URL resolution, sandbox boundaries, and process error handling       | 6 files changed, 97 insertions(+), 32 deletions(-)     |
| 21  | `1ad3c560b54ef048ad087e3c7685635e8f10e95c` | 2026-09-29 09:26 | feat(sandbox): enable cross-platform out-of-the-box execution with bwrap and approval gate | 7 files changed, 285 insertions(+), 95 deletions(-)    |
| 22  | `09cbc082b08ad20aaea1e2762abf3633013f3552` | 2026-09-29 10:12 | fix: enforce sandbox for unattended hooks and clarify host execution                       | 12 files changed, 71 insertions(+), 23 deletions(-)    |
| 23  | `88701c9cb36a8e6bd25e01fca86855a9ba12a334` | 2026-09-29 14:45 | fix: harden agent cancellation, MCP connection reuse, and config locking                   | 7 files changed, 196 insertions(+), 27 deletions(-)    |
| 24  | `938e480319b7360366f1207f73099a483494f081` | 2026-09-29 14:47 | ci: normalize checkout line endings across platforms                                       | 1 file changed, 1 insertion(+)                         |
| 25  | `65764090dc94868371a7f507353cff474d3be6c2` | 2026-09-29 14:59 | fix: address Windows file and shell portability found by CI                                | 5 files changed, 141 insertions(+), 118 deletions(-)   |
| 26  | `4a088c2bf2ae119a6afd3ace6b52ae2ca71f8870` | 2026-09-29 15:03 | test: report Windows worktree path mismatch                                                | 1 file changed, 14 insertions(+), 1 deletion(-)        |
| 27  | `8e3b8202e7e83254f5bc268081f3b742f9c4ed98` | 2026-09-29 15:07 | fix: compare worktree identity across Windows path aliases                                 | 2 files changed, 9 insertions(+), 15 deletions(-)      |
| 28  | `d6ec5b6ff6bf3fb514447ca68b65d41a64502f3b` | 2026-09-30 02:40 | feat: improve agent approvals, context handling, and task continuity                       | 15 files changed, 1209 insertions(+), 141 deletions(-) |
| 29  | `8e2777fb9c26985162f9005a8410351b0bf40480` | 2026-09-30 02:50 | release: prepare Bruin 0.9.0                                                               | 5 files changed, 20 insertions(+), 23 deletions(-)     |
| 30  | `21fa67512aedf404ebc16b26afdb3bfe742dcf48` | 2026-09-30 03:23 | feat: support longer agent runs with durable checkpoints                                   | 14 files changed, 509 insertions(+), 37 deletions(-)   |
| 31  | `5d529d0a05af914c805793b683bcaac36798e863` | 2026-09-30 09:12 | fix: preserve agent context and model-switch boundaries                                    | 4 files changed, 249 insertions(+), 34 deletions(-)    |
| 32  | `b184828f9a0a11e31165ba48ad68f369d4962aa7` | 2026-09-30 09:19 | feat(agent): support bounded unattended long runs                                          | 11 files changed, 239 insertions(+), 54 deletions(-)   |
| 33  | `74977a0ab9fde727953dd964d46db6adf87e24fc` | 2026-09-30 09:35 | fix(agent): harden cancellation, retries, and task reporting                               | 10 files changed, 648 insertions(+), 9 deletions(-)    |
| 34  | `37493adb9d4bc039da289487b809ce68b563bbb8` | 2026-09-30 10:01 | fix(agent): preserve file integrity and isolate MCP operations                             | 13 files changed, 366 insertions(+), 38 deletions(-)   |
| 35  | `eacc19749ec34bb81d1f5ec0428eaebf13ed73e7` | 2026-09-30 10:24 | feat(agent): add paged file and directory exploration                                      | 14 files changed, 768 insertions(+), 35 deletions(-)   |
| 36  | `b79ec42d4dcb538b968a265e6d35e8ebbbe97775` | 2026-09-30 10:30 | feat(desktop): show recorded session token usage                                           | 6 files changed, 162 insertions(+), 2 deletions(-)     |
| 37  | `a3e1a0d45a605163a569335a2dff532ef6300c7a` | 2026-09-30 11:24 | feat(agent): add repository index, file snapshots and MCP OAuth                            | 26 files changed, 1461 insertions(+), 50 deletions(-)  |
| 38  | `6e9922c72b6ca2e05e2e33ccad276135a0dff89f` | 2026-09-30 15:40 | fix: harden file previews, caches, worktrees and MCP paths                                 | 14 files changed, 251 insertions(+), 27 deletions(-)   |
| 39  | `642f8e394eda99a8a4e59337a1c25dafec5875ef` | 2026-09-30 16:15 | Fix search lifecycle and cross-session state isolation                                     | 5 files changed, 248 insertions(+), 81 deletions(-)    |
| 40  | `c9dc95c80b7281c17bdfa9c7f3298907b8a897d8` | 2026-09-30 16:30 | Unify theme surfaces and add floating file review panel                                    | 8 files changed, 741 insertions(+), 148 deletions(-)   |
| 41  | `dca9d2f88273497402784da41b042057b64e157f` | 2026-09-30 16:50 | Center approval prompts in the conversation and follow theme                               | 2 files changed, 78 insertions(+), 56 deletions(-)     |

## 附录 C · 当前源码与验证定位

这些链接提供工作区导航，行号按收尾时源码定位；文件可能随并行工作继续改变。历史事实以正文 SHA 及 `git show <SHA>:<路径>` 为准。

- [核心调度、恢复、摘要与运行预算](/Users/bear/Projects/agentProjects/Bruin/src/core/agent.ts:268)。
- [日志重建与模型边界](/Users/bear/Projects/agentProjects/Bruin/src/core/history.ts:6)。
- [上下文压缩与最小保留](/Users/bear/Projects/agentProjects/Bruin/src/core/history.ts:319)。
- [数据库版本与迁移](/Users/bear/Projects/agentProjects/Bruin/src/storage/event-store.ts:102)。
- [过期任务释放](/Users/bear/Projects/agentProjects/Bruin/src/storage/event-store.ts:569)。
- [跨进程配置锁](/Users/bear/Projects/agentProjects/Bruin/src/config.ts:160)。
- [工具权限决策](/Users/bear/Projects/agentProjects/Bruin/src/core/permissions.ts:7)。
- [桌面保存、身份与内容前置条件](/Users/bear/Projects/agentProjects/Bruin/src/core/workspace-files.ts:111)。
- [搜索取消、超时与读流](/Users/bear/Projects/agentProjects/Bruin/src/executor/worker.ts:478)。
- [候选扫描、hash 与声明索引](/Users/bear/Projects/agentProjects/Bruin/src/core/repository-index.ts:15)。
- [写入前快照与容量](/Users/bear/Projects/agentProjects/Bruin/src/core/snapshots.ts:71)。
- [恢复 hash 与路径保护](/Users/bear/Projects/agentProjects/Bruin/src/core/snapshots.ts:181)。
- [MCP 生命周期串行队列](/Users/bear/Projects/agentProjects/Bruin/src/runtime/mcp.ts:95)。
- [OAuth 回调与授权](/Users/bear/Projects/agentProjects/Bruin/src/runtime/mcp-oauth.ts:84)。
- [会话归属和 Git 变更](/Users/bear/Projects/agentProjects/Bruin/src/core/workspace-review.ts:48)。
- [Token 用量投影](/Users/bear/Projects/agentProjects/Bruin/src/core/usage.ts:2)。
- [LCS 差异与容量降级](/Users/bear/Projects/agentProjects/Bruin/desktop/renderer/src/main.tsx:165)。
- [UI 异步会话有效性](/Users/bear/Projects/agentProjects/Bruin/desktop/renderer/src/main.tsx:610)。

测试证据：

- [src/tests/agent-control.test.ts](/Users/bear/Projects/agentProjects/Bruin/src/tests/agent-control.test.ts)。
- [src/tests/history.test.ts](/Users/bear/Projects/agentProjects/Bruin/src/tests/history.test.ts)。
- [src/tests/file-exploration.test.ts](/Users/bear/Projects/agentProjects/Bruin/src/tests/file-exploration.test.ts)。
- [src/tests/file-read.test.ts](/Users/bear/Projects/agentProjects/Bruin/src/tests/file-read.test.ts)。
- [src/tests/repository-snapshots.test.ts](/Users/bear/Projects/agentProjects/Bruin/src/tests/repository-snapshots.test.ts)。
- [src/tests/mcp-concurrency.test.ts](/Users/bear/Projects/agentProjects/Bruin/src/tests/mcp-concurrency.test.ts)。
- [src/tests/mcp-oauth.test.ts](/Users/bear/Projects/agentProjects/Bruin/src/tests/mcp-oauth.test.ts)。
- [src/tests/workspace-review.test.ts](/Users/bear/Projects/agentProjects/Bruin/src/tests/workspace-review.test.ts)。
- [src/tests/usage.test.ts](/Users/bear/Projects/agentProjects/Bruin/src/tests/usage.test.ts)。
