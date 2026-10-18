# ACP：IDE 调用 Bruin

构建后以 `node /absolute/path/to/Bruin/dist/cli.js acp --model ALIAS` 启动。IDE 用 stdio JSON-RPC 连接，stdout 只输出协议消息；模型与密钥沿用本机配置和环境变量，不通过 ACP 提交。会话使用客户端传入的绝对 cwd，与 CLI/桌面共享 SQLite 事件和租约。此入口不运行 Cron，不监听网络端口，不委派外部 Agent。

首版明确协商 ACP **v1**，支持 initialize、session/new、session/prompt、session/cancel、流式 session/update、工具状态和 session/request_permission。支持文本与资源链接；链接只作为引用传给模型，不自动读取链接目标。敏感工具逐次请求 IDE 用户批准，只提供允许本次/拒绝，不自动保存长期授权。取消、断开或审批 120 秒超时会拒绝待审批请求。模型调用预算耗尽返回 max_turn_requests。

客户端可传入会话级 stdio MCP 配置（绝对启动命令、args、env），复用 Bruin MCP 执行与审批。环境变量只存该会话对应服务器的内存，不改全局环境、配置或事件。客户端配置的同名服务器覆盖该会话中的全局配置；全局服务器仍可使用。首次发现工具时按需连接。HTTP/SSE 会话配置、图片、音频、嵌入资源、历史加载与 ACP v2 尚未声明支持；不支持的输入会明确拒绝。会话历史可在 Bruin 桌面或 CLI 查看。

Zed 等支持自定义 ACP Agent 的客户端可配置：

```json
{
  "agent_servers": {
    "Bruin": {
      "command": "node",
      "args": ["/absolute/path/to/Bruin/dist/cli.js", "acp", "--model", "main"],
      "env": { "BRUIN_HOME": "/absolute/path/to/.bruin" }
    }
  }
}
```

按官方 [ACP v1 初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话](https://agentclientprotocol.com/protocol/v1/session-setup) 和 [工具审批](https://agentclientprotocol.com/protocol/v1/tool-calls) 实现。协议流、真实运行时及本地审批由自动测试覆盖；真实 IDE 和 Provider 的联调仍需目标环境验收。
