# 仓库索引、文件回滚与 MCP OAuth

## 仓库索引

`search_repository({ query, limit? })` 建立并查询本机文件/符号索引，默认返回 20 项、最多 100 项。结果包含路径、大小、声明名称和行号，按路径关键词与符号匹配排序，可接着用 `read_file` 分页读取。每次查询重扫候选文件并验证 SHA-256 内容哈希，更新新增/修改/删除文件；不单凭 mtime 判断失效。Git 仓库使用 `git ls-files` 包含跟踪及未忽略的新文件；非 Git 仓库跳过 `.git/node_modules/.bruin`，并明确返回 `gitIgnore=false`。符号提取支持常见声明形式，不是完整 AST、类型分析或依赖图谱。

每轮最多 10,000 个候选文件、约 20 MB 文本与 20 秒扫描；单文件超过 1 MB 时只索引路径和大小。不可读、二进制、无效编码或符号链接跳过；结果包含扫描截断和更多匹配标记。缓存位于 `BRUIN_HOME/repository-index`，不保存源码正文，也不索引 BRUIN_HOME 中的私有记录。索引是按次读取的视图，不承诺跨文件一致性。

## 文件快照与回滚

Bruin 的 `write_file/edit_file` 和桌面保存会在替换文件前记录原始字节、权限与预期修改后哈希，保存在 `BRUIN_HOME/snapshots/<workspace-hash>`。`list_snapshots({ offset?, limit? })` 默认每页 20 条，最多 100 条，返回 `snapshots/nextOffset`；`restore_snapshot({ id })` 经审批恢复单个文件，当前内容与修改后哈希不一致时拒绝覆盖。原文件不存在的快照表示新建文件，回滚会删除该文件；桌面两次点击确认并明确显示这个动作。工作区和路径校验防止跨工作区使用快照或访问符号链接。恢复已有文件时同样生成快照；新建文件的删除回滚没有自动重建入口。

快照仅覆盖 Bruin 文件工具和桌面保存，不覆盖 Shell、MCP 或外部编辑，也不是整个工作区的原子检查点。写入中止后也可能留下未应用的记录，此时修改后哈希不匹配会拒绝恢复。仅支持不超过 10 MB 的普通文件；每工作区最多 200 条、约 500 MB 存储，达到上限时拒绝新写入，需用户先备份并清理对应快照目录，不自动删除历史。快照含源码原始内容，应按会话数据库同样保护。本地路径/哈希检查不能消除恶意进程在最后一步替换路径的竞态。

桌面保存发送原始内容作为版本基线。文件回滚、删除或外部修改后，旧编辑页保存会被拒绝，需重新打开文件。旧程序调用未发送基线时保持原接口行为。

桌面「MCP 与自动化」提供索引查询、快照列表和回滚入口；模型工具在 CLI 和桌面均可用。规划未批准阶段和只读子 Agent 可查索引、列快照，不能回滚。

## MCP OAuth

HTTP 服务器可选择 OAuth 浏览器登录（与 Bearer 环境变量互斥）。复用现有 MCP SDK 的受保护资源/授权服务器发现、PKCE S256、资源绑定、issuer 校验及刷新；包括 401 challenge 提供的元数据地址和 scope。默认使用动态客户端注册，已有客户端可填 Client ID 与固定回调端口。服务器不支持动态注册时需预注册客户端；固定端口须与服务器注册的 redirect URI 一致。参考 [MCP 授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。

点击「OAuth 登录」后系统浏览器打开授权页；回调只监听 `127.0.0.1`，随机端口默认、state 校验、单次代码消费，120 秒超时，支持取消。桌面主进程使用 Electron safeStorage 将令牌和客户端凭证加密保存到 `BRUIN_HOME/oauth.enc.json`；凭证绑定完整服务器配置，重启恢复，刷新后同步保存。它们不写入配置、会话事件或渲染进程。PKCE verifier、回调和发现缓存只在后台内存保存。CLI 与独立后台服务不解密桌面凭证。

退出登录/删除或更改服务器会清除本机凭证并断开连接，退出不等同于服务端撤销授权。正常关闭应用保留加密凭证。系统加密不可用（包括 Linux basic_text）时拒绝桌面 OAuth 登录；保存或清除失败会明确报告。模型调用不自动打开浏览器，需要重新授权时提示到设置登录。远程授权地址要求 HTTPS；本机 loopback 可用 HTTP。网络请求受超时限制。

MCP 设置提供 GitHub（Bearer 环境变量）与 Notion（OAuth）模板，仅预填表单，保存和调用继续经过原有规则。地址与授权说明分别来自 [GitHub 官方文档](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) 和 [Notion 官方文档](https://developers.notion.com/guides/mcp/get-started-with-mcp)。当前 SDK 支持发现与动态注册，本实现没有托管公共 Client ID 元数据文档。真实服务 OAuth、系统浏览器和操作系统密钥环端到端流程尚待目标平台验证。
