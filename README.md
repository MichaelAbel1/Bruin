# Bruin

Bruin 是跑在你电脑上的编程助手，有桌面版和命令行。打开一个项目，就可以让它读代码、改文件、跑测试。桌面版能看文件差异，关掉应用后也可以打开原来的会话接着做。

你可以接 OpenAI、Anthropic、Gemini，也可以用兼容 OpenAI Chat Completions 的服务，包括本机模型服务。

## 快速开始

从源码运行需要 Node.js 22.12 或更新版本，以及 npm、Git 和 ripgrep（`rg`）。以下命令都在 Bruin 仓库根目录执行。

### 桌面版

```sh
npm ci
npm run desktop:dev
```

1. 打开「模型设置」，选供应商，填写模型 ID 和所需的 API Key。使用 OpenAI 兼容服务时，还要填服务地址。
2. 点「新建会话」，选一个已有的项目目录。
3. 先试一句「帮我看看这个项目从哪里启动，相关测试怎么跑」。让 Bruin 改完代码后，可以点「文件变更」看它改了哪些地方。

### 命令行

下面以 OpenAI 为例。把 `YOUR_KEY`、`YOUR_MODEL_ID` 和项目路径换成自己的值。

```sh
npm ci
npm run build
export OPENAI_API_KEY='YOUR_KEY'
node dist/cli.js model add main openai YOUR_MODEL_ID
node dist/cli.js chat --model main --workspace /path/to/project
```

上面的 `export` 适用于 Bash 和 Zsh。PowerShell 里用 `$env:OPENAI_API_KEY = 'YOUR_KEY'`。

输入 `/exit` 退出对话。用 `sessions list` 找到会话 ID，再用 `--resume` 接着聊。完整命令列表见 `--help`。

```sh
node dist/cli.js sessions list
node dist/cli.js chat --resume SESSION_ID
node dist/cli.js --help
```

非交互式 `chat` 可用位置参数，或通过 stdin 读取最多 1 MB 的 UTF-8 提示词。管道输入在 EOF 后作为一条用户消息提交。两种来源同时有非空内容，或开启新会话时两者都为空，命令会报错。仅传 `--resume` 可继续已有任务。

```sh
printf '检查工作区并列出需要验证的改动\n' | node dist/cli.js chat --model main
```

## 在项目里用 Bruin

- **把项目约定写进 `AGENTS.md`。** 工作区根目录适合写通用测试命令和约定，子目录的规则仅适用于该目录及其下级目录。Bruin 会根据文件工具访问的路径载入这些规则。各项目都适用的约定可放在 `~/.bruin/AGENTS.md`。
- **边跑边补充要求。** 桌面版运行中可以选「补充当前任务」或「当前任务结束后」。改动范围比较大时，可以先打开「规划模式」，等你看过并批准计划再开始修改。
- **检查和撤回改动。** 在「文件变更」里看差异。通过 Bruin 文件工具或桌面编辑器保存的修改，可以用快照按文件回滚。Shell、MCP 和外部编辑产生的修改不在快照范围内。见[文件快照与回滚](docs/REPOSITORY_RECOVERY_AUTH.md#文件快照与回滚)。
- **把独立的活交给子 Agent。** 可以让子 Agent 只读查代码，也可以授权它在单独的 Git 工作树里改代码。工作树从当前提交（`HEAD`）开始，原工作区未提交的改动不会带过去。桌面版可以审核文件和导出补丁，由你决定怎么合入。见[子 Agent](docs/RUNTIME_CAPABILITIES.md#子-agent)。
- **任务太长就分段跑。** 桌面版可以在「运行预算」里提高上限。达到上限后点「继续任务」，命令行用 `/continue`。如果中断时有操作已经开始但结果未知，Bruin 会先让你检查工作区，再继续。见[长任务](docs/LONG_TASKS.md)。

## 扩展和自动化

- **Skills** 是可复用的操作说明。Bruin 自带规划、调试、代码审查和测试 Skills，也能从本地或 GitHub 安装。用 `node dist/cli.js skill list` 查看。远程安装的 Skill 默认停用。
- **MCP、Hooks 和定时任务** 在桌面版的「MCP 与自动化」面板里设置。这里也能管理带依赖的工作区任务。见[运行时功能](docs/RUNTIME_CAPABILITIES.md)。
- **后台服务** 可以在没有桌面窗口时运行定时任务。构建后执行 `node dist/cli.js service run --timezone Asia/Shanghai`。请通过环境变量提供模型密钥。见[后台服务](docs/SERVICE.md)。
- **编辑器接入** 使用 ACP v1。把编辑器的 Agent 启动命令设为 `node /absolute/path/to/Bruin/dist/cli.js acp --model main`。见[ACP 配置示例](docs/ACP.md)。

## 数据与权限

会话和配置默认保存在 `~/.bruin/`，可用 `BRUIN_HOME` 改路径。使用云模型时，请求内容会发给配置的模型服务。桌面版用系统加密存储保护已保存的模型密钥，CLI 从环境变量读取。备份、恢复和环境检查见[运维文档](docs/OPERATIONS.md)。

改文件、运行 Shell 和调用 MCP 时，Bruin 会按权限规则决定是否询问你。普通 Shell 命令在系统没有可用沙箱时，获批后可能直接在本机执行。无人值守模式会拒绝未事先授权的操作。见[安全说明](docs/SECURITY.md)。

## 开发

```sh
npm run check          # 核心类型检查
npm run desktop:check  # 桌面端类型检查
npm test              # 编译并运行测试
npm run format:check   # 检查格式
```

在 macOS 上可用 `npm run desktop:dist -- --mac zip` 打包。本地构建的包默认未签名、未公证。各平台的打包方式见[桌面版说明](docs/DESKTOP.md#运行和打包)。

| 从哪里看                   | 对应代码或文档                                                    |
| -------------------------- | ----------------------------------------------------------------- |
| 一轮对话怎样调用模型和工具 | [AgentRunner](src/core/agent.ts) · [架构](docs/ARCHITECTURE.md)   |
| 桌面界面怎样连接后台       | [Electron 主进程](desktop/main.cjs) · [后台](src/desktop-host.ts) |
| 会话事件怎样保存           | [SQLite 存储](src/storage/event-store.ts)                         |
| 第一次接手，想按顺序读源码 | [项目学习指南](docs/PROJECT_STUDY_GUIDE.md)                       |
