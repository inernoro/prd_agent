export type ClientKind = 'workbuddy' | 'codex' | 'claude';

type ClientConfig = {
  label: string;
  instruction: string;
  snippet: (endpointUrl: string, key: string) => string;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** 客户端顺序、配置格式和接入说明只有这一份来源。 */
export const CLIENT_REGISTRY: Record<ClientKind, ClientConfig> = {
  workbuddy: {
    label: 'WorkBuddy',
    instruction: '在 WorkBuddy 的 MCP 配置编辑器中合并以下配置（用户级文件为 ~/.workbuddy/mcp.json），保存后查看连接状态。',
    snippet: (endpointUrl, key) => JSON.stringify({
      mcpServers: {
        map: { type: 'streamableHttp', url: endpointUrl, headers: { Authorization: `Bearer ${key}` } },
      },
    }, null, 2),
  },
  codex: {
    label: 'Codex',
    instruction: '合并到 ~/.codex/config.toml；如果已有 [mcp_servers.map]，更新该段，保存后重新加载客户端。',
    snippet: (endpointUrl, key) => `[mcp_servers.map]\nurl = ${JSON.stringify(endpointUrl)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${key}`)} }`,
  },
  claude: {
    label: 'Claude',
    instruction: '使用 Claude Code：在终端执行以下命令，再用 /mcp 查看连接状态。',
    snippet: (endpointUrl, key) => `claude mcp add --transport http map \\\n  ${shellQuote(endpointUrl)} \\\n  --header ${shellQuote(`Authorization: Bearer ${key}`)}`,
  },
};

export const CLIENT_ORDER: ClientKind[] = ['workbuddy', 'codex', 'claude'];
