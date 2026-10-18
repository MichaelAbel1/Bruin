/** Templates only prefill the form; saving and tool calls retain normal approval. */
export const connectorTemplates = [
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    tokenEnv: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    oauth: false,
    help: '使用个人访问令牌环境变量；权限取决于令牌范围与组织策略。',
    docs: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
  },
  {
    id: 'notion',
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    tokenEnv: '',
    oauth: true,
    help: '保存后点击 OAuth 登录，在浏览器中选择工作区并授权。',
    docs: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
  },
] as const;
