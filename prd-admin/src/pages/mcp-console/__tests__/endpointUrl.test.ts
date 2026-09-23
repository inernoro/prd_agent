import { describe, expect, it } from 'vitest';
import { secureSameSiteEndpoint } from '../endpointUrl';

describe('MCP 外部连接地址', () => {
  it('从实际 HTTPS 页面复制同站配置时不降级明文', () => {
    expect(secureSameSiteEndpoint('http://map.ebcone.net/api/mcp', 'https://map.ebcone.net'))
      .toBe('https://map.ebcone.net/api/mcp');
  });
  it('保留其它主机、端口及本地 HTTP 配置', () => {
    for (const [endpoint, origin] of [
      ['http://localhost:5000/api/mcp', 'http://localhost:5500'],
      ['http://internal:5000/api/mcp', 'https://map.ebcone.net'],
      ['http://map.ebcone.net:5000/api/mcp', 'https://map.ebcone.net'],
      ['https://map.ebcone.net/api/mcp', 'https://map.ebcone.net'],
      ['', 'https://map.ebcone.net'],
    ]) expect(secureSameSiteEndpoint(endpoint, origin)).toBe(endpoint);
  });
});
