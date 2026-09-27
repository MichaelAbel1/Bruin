# 桌面版实现说明

## 结构

```text
Electron main (desktop/main.cjs)
  ├─ BrowserWindow → React renderer (desktop/renderer/src)
  │                    └─ preload 白名单 → Electron IPC
  └─ 独立 Node 进程 (dist/desktop-host.js)
       ├─ AgentRunner / ModelGateway
       ├─ SQLite EventStore
       ├─ Skills registry
       ├─ RuntimeServices → MCP / 子 Agent / 工作树 / 后台任务 / Hooks / 规划
       └─ ProcessExecutor → 独立工具进程
```

桌面应用与 CLI 使用相同的 `BRUIN_HOME`、模型配置、Skill 快照及 SQLite 会话数据库。Electron 主进程负责窗口、目录选择和监督后台进程；它不运行 Agent 循环。React 渲染进程只能调用 preload 暴露的 `request` 与 `onEvent`，不能直接使用 Node API。后台采用按行 JSON 请求/响应与事件流，支持流式文本、工具审批、取消和会话状态更新。每个请求有唯一 ID；后台退出时，未完成请求会失败并在界面提示。

## 运行和打包

```sh
npm ci
npm run desktop:check
npm run desktop:dev
npm run desktop:pack
```

`desktop:dev` 先编译 TypeScript 核心，再启动 Vite 与 Electron。`desktop:build` 生成核心和 React 静态文件。`desktop:pack` 额外创建 `.desktop-runtime`，其中包含当前平台的 Node 可执行文件、已编译核心和生产依赖，再通过 electron-builder 生成应用目录。`desktop:dist` 生成平台安装包。应在目标平台及 CPU 架构上构建；当前实际验证了 macOS Apple Silicon 应用目录与 ZIP 包。macOS 应用未签名、未公证，不适合作为公开发布包。发布前需配置代码签名、公证、更新渠道及相应验收。

桌面版的 `better-sqlite3` 随独立 Node 运行时安装。不要把它直接加载进 Electron 主进程或 React 渲染进程，也不要让 electron-builder 对它做 Electron ABI 重编译。

## 桌面交互与权限

- 会话创建：用户选工作区和模型。会话列表来自 SQLite；打开旧会话时扫描未完成工具调用。
- 聊天：文本流即时显示，完整响应及工具事件仍由核心写入 SQLite。窗口关闭后可重新打开会话。
- 工具审批：`AgentRunner` 发出审批事件，界面展示完整工具名、参数和原因；只批准本次操作。取消任务时等待中的审批会被拒绝。
- 恢复：未知执行结果会显示检查提示；用户确认检查工作区后才允许继续。确认只对当前后台进程有效，重启后需再次检查。
- 模型：支持现有四类 Provider。已添加模型可以编辑，保存后同别名的已有会话同步配置。打开会话时按当前配置向 Provider 请求模型目录，顶部可切换同一 API 下的其他模型 ID，并可刷新；会话的独立选择不会被默认模型的编辑覆盖。API Key 输入框接收密钥值，仅保存在后台进程内存，重启后需重新输入；高级设置中的环境变量名称只接收 `OPENAI_API_KEY` 这类名称。若旧版把密钥误填进环境变量名称，新版启动时会从配置及当前会话快照中移除该字段，并在本次运行中使用识别到的密钥。
- 图标：构建时从 `desktop/assets/icon.svg` 生成纯白底熊图标和四种配色 PNG。macOS 包内生成 `icon.icns` 用于 Finder；运行时从用户设置选择配色并更新 Dock 图标。其他平台更新窗口/任务栏图标；安装包图标仍是纯白款。
- Skills：四个只读内置基础 Skill 随运行时打包，默认启用、按需加载；可停用但不能卸载。用户可从本地、GitHub 和自建 GitHub 市场安装，查看说明、启用、停用、更新与卸载。远程 Skill 安装后仍默认停用。
- 扩展能力：侧边栏「MCP 与自动化」管理 MCP 服务器、Hook、工作树、子 Agent 和后台任务；会话上方可启用规划模式、批准计划并更新步骤。实现和恢复语义见 [桌面 Agent 扩展能力](RUNTIME_CAPABILITIES.md)。
- 主题：应用默认纯白；「外观」可改为黑色。主题与熊图标背景分别写入 `BRUIN_HOME/appearance.json`。

## 安全设置与边界

BrowserWindow 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。应用加载本地打包页面，限制导航和新窗口，并设置内容安全策略。主进程校验 IPC 来源为当前主窗口的主 frame。模型密钥不会通过会话事件持久化；但在用户输入密钥时，它会短暂存在于渲染进程和 IPC 消息内存中。桌面版的工具权限仍由后台 Agent 核心决定，界面不能绕过。

`desktop/main.cjs` 目前会把 `https://` 新窗口请求交给系统浏览器；若未来渲染不可信 HTML 或链接，应增加明确的 URL 来源白名单。当前模型与工具内容按纯文本呈现，未注入 HTML。Windows、Linux 包尚未实际验收；不同平台还需测试系统沙箱、路径权限、打包依赖与更新机制。

## 验证

- `npm run check`：核心类型检查。
- `npm run desktop:check`：桌面 React 类型检查。
- `npm test`：包含桌面后台 JSON 协议的完整工具审批、文件写入和会话落库测试。
- `npm run desktop:build`：React 静态资源与后台构建。
- `npm run desktop:pack`：macOS Apple Silicon 应用目录构建。
- macOS Apple Silicon ZIP 包完成压缩完整性检查。
- 实际启动 `Bruin.app`，检查模型配置界面与后台连通。

未使用真实云模型 API Key 做验收；可使用模型设置中的本次运行密钥或环境变量在目标模型上补做端到端测试。
