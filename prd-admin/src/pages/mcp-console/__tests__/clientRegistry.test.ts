import { describe, expect, it } from 'vitest';
import { CLIENT_ORDER, CLIENT_REGISTRY } from '../clientRegistry';

const endpoint = 'https://map.example.test/api/mcp';
const credential = 'credential-with-"-quote';

describe('客户端接入配置契约', () => {
  it('只列出 WorkBuddy、Codex、Claude，并按指定顺序排列', () => {
    expect(CLIENT_ORDER.map(client => CLIENT_REGISTRY[client].label)).toEqual(['WorkBuddy', 'Codex', 'Claude']);
  });

  it('WorkBuddy 使用 streamableHttp，JSON 解析后保留完整鉴权值', () => {
    const parsed = JSON.parse(CLIENT_REGISTRY.workbuddy.snippet(endpoint, credential));
    expect(parsed.mcpServers.map).toEqual({
      type: 'streamableHttp', url: endpoint, headers: { Authorization: `Bearer ${credential}` },
    });
  });

  it('Codex 在 http_headers 中携带授权，并转义带引号的值', () => {
    const config = CLIENT_REGISTRY.codex.snippet(endpoint, credential);
    expect(config).toContain(`url = ${JSON.stringify(endpoint)}`);
    expect(config).toContain(`http_headers = { Authorization = ${JSON.stringify(`Bearer ${credential}`)} }`);
    expect(config).not.toContain('[mcp_servers.map.headers]');
  });

  it('Claude 终端配置完整保护地址及鉴权参数', () => {
    const config = CLIENT_REGISTRY.claude.snippet(endpoint, "a'b");
    expect(config).toContain(`'${endpoint}'`);
    expect(config).toContain("--header 'Authorization: Bearer a'\\''b'");
    expect(config).toContain('claude mcp add --transport http map');
    const command = config.replaceAll('\\\n', '');
    expect(command.split('\n')).toHaveLength(1);
    expect(command).not.toMatch(/\s\+\s/);
  });
});
