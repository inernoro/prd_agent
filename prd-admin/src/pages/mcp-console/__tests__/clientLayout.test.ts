import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ClientRow } from '../McpConsolePage';
import type { McpClientDto } from '@/services/contracts/mcpConsole';

it('滚动列的客户端卡片不能被 flex 挤成条带', () => {
  const client: McpClientDto = {
    keyId: 'layout-test', name: '验收客户端', keyPrefix: 'test', scopes: [], scopeMode: 'auto',
    missingCapabilities: [], isActive: true, todayCalls: 0, dailyImageQuota: 3,
    dailyWriteQuota: 20, rateLimitPerMin: 60, todayImages: 0, todayWrites: 0,
  };
  const rendered = renderToStaticMarkup(createElement(ClientRow, {
    client, capabilities: [], onRevoke: () => {}, onEditQuota: () => {},
  }));
  const rootStyle = rendered.match(/^<div[^>]*style="([^"]*)"/)?.[1] ?? '';
  const declarations = Object.fromEntries(rootStyle.split(';').filter(Boolean).map(pair => pair.split(':').map(x => x.trim())));
  expect(declarations['flex-shrink']).toBe('0');
  expect(rendered).toContain('验收客户端');
});
