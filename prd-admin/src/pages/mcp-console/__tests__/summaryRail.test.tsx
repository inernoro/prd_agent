import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { McpCapabilityDto, McpClientDto, McpConsoleOverviewDto } from '@/services/contracts/mcpConsole';
import { McpSummaryRail } from '../McpSummaryRail';

const capability: McpCapabilityDto = { key: 'knowledge', title: '知识库', summary: '', readScope: 'docs:read', writeScope: 'docs:write', writeNeedsApproval: false, availableToMe: true, writeAvailableToMe: true, granted: true, todayCalls: 0, tools: [] };
const client: McpClientDto = { keyId: 'one', name: 'Codex', keyPrefix: 'test', scopes: ['docs:read'], scopeMode: 'auto', missingCapabilities: [], isActive: true, todayCalls: 99, dailyImageQuota: 50, dailyWriteQuota: 200, rateLimitPerMin: 60, todayImages: 99, todayWrites: 99 };

it('汇总保留服务端当天总量，能力覆盖排除停用凭证', () => {
  const overview: McpConsoleOverviewDto = {
    endpointUrl: 'https://example.test/api/mcp', hasHistory: true, capabilities: [capability], recentCalls: [],
    clients: [client, { ...client, keyId: 'two', scopes: [], scopeMode: 'manual' }, { ...client, keyId: 'expired', isActive: false }],
    today: { sinceUtc: '2026-11-03T00:00:00Z', calls: 18, images: 7, writes: 10, failed: 1, denied: 2 },
  };
  const html = renderToStaticMarkup(<McpSummaryRail overview={overview} onCalls={() => {}} onCapability={() => {}} onSettings={() => {}} />);
  const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  expect(text).toContain('凭证可用2/3');
  expect(text).toContain('自动授权1自定义1');
  expect(text).toContain('工具调用18次');
  expect(text).toContain('生成图片7张');
  expect(text).toContain('写入操作10次');
  expect(text).toContain('知识库1/2');
  expect(html).toContain('筛选已授权知识库的客户端');
  expect(text).not.toContain('297');
  expect(text).toContain('不代表客户端在线');
});
