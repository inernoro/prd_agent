// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ok } from '@/types/api';
import type {
  McpCallLogDto,
  McpConsoleOverviewDto,
} from '@/services/contracts/mcpConsole';
const service = vi.hoisted(() => ({
  getMcpConsoleOverview: vi.fn(),
  listMcpCalls: vi.fn(),
}));
vi.mock('@/services', () => service);
vi.mock('@/pages/mcp-console/McpCallTrendChart', () => ({
  McpCallTrendChart: () => <div>真实聚合趋势</div>,
}));
import { ExecutiveIntegrationsWorkspace } from './ExecutiveIntegrationsWorkspace';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const overview: McpConsoleOverviewDto = {
  endpointUrl: 'https://map.test/api/mcp',
  hasHistory: true,
  today: {
    sinceUtc: '2026-11-16T00:00:00Z',
    calls: 2,
    images: 0,
    writes: 1,
    denied: 1,
    failed: 0,
  },
  capabilities: [
    {
      key: 'visual',
      title: '视觉创作',
      summary: '',
      writeNeedsApproval: false,
      availableToMe: true,
      writeAvailableToMe: true,
      granted: true,
      todayCalls: 1,
      tools: [],
    },
  ],
  clients: [
    {
      keyId: 'key-a',
      name: '我的 Codex',
      keyPrefix: 'masked',
      scopes: ['visual.read'],
      scopeMode: 'manual',
      missingCapabilities: [],
      isActive: true,
      todayCalls: 2,
      dailyImageQuota: 50,
      dailyWriteQuota: 50,
      rateLimitPerMin: 60,
      todayImages: 0,
      todayWrites: 1,
    },
  ],
  recentCalls: [],
};
const call = (id: string, keyId = 'key-a'): McpCallLogDto => ({
  id,
  keyId,
  keyName: '我的 Codex',
  toolName: 'map_visual_get_run',
  capability: 'visual',
  status: 'success',
  isWrite: false,
  imageCount: 0,
  deduplicated: false,
  durationMs: 150,
  createdAt: '2026-11-16T01:00:00Z',
  artifact: { kind: 'image-run', id: `run-${id}` },
});
const records = (items: McpCallLogDto[], total = items.length) =>
  ok({ items, total, skip: 0, limit: 20 });
const view = (revision = 0) => (
  <MemoryRouter>
    <ExecutiveIntegrationsWorkspace revision={revision} />
  </MemoryRouter>
);
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  service.getMcpConsoleOverview.mockResolvedValue(ok(overview));
  service.listMcpCalls.mockResolvedValue(records([call('a')]));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it('外部协作读取MCP真实概览与历史，标清账号范围，不展示旧渠道', async () => {
  await act(async () => root.render(view()));
  expect(service.getMcpConsoleOverview).toHaveBeenCalledTimes(1);
  expect(service.listMcpCalls).toHaveBeenCalledWith(
    expect.objectContaining({ skip: 0, limit: 20 }),
  );
  expect(container.textContent).toContain('当前账号');
  expect(container.textContent).toContain('调用仅限本环境');
  expect(container.textContent).toContain('UTC 自然日');
  expect(container.textContent).toContain('不代表实时在线');
  expect(container.textContent).not.toContain('短信');
  expect(container.querySelector('.ws-toolbar .ws-avatar')).not.toBeNull();
});
it('工具HTTP成功但异步产物没有完成时显示待完成，原始步骤仍保留调用成功', async () => {
  await act(async () => root.render(view()));
  expect(container.querySelector('tbody')?.textContent).toContain('产物待完成');
  expect(container.querySelector('aside')?.textContent).toContain(
    '工具已响应，产物尚未确认完成',
  );
  expect(container.querySelector('.op-mcp-steps')?.textContent).toContain(
    '调用成功',
  );
  expect(container.textContent).not.toContain('javascript:');
});
it('切客户端后不把旧客户端行挂在新筛选下面，慢旧请求不能覆盖新结果', async () => {
  let resolveOld!: (value: ReturnType<typeof records>) => void;
  service.listMcpCalls.mockImplementation(({ keyId }) =>
    keyId
      ? Promise.resolve(records([call('filtered')]))
      : new Promise((resolve) => {
          resolveOld = resolve;
        }),
  );
  await act(async () => root.render(view()));
  await act(async () =>
    (container.querySelector('.op-mcp-client') as HTMLButtonElement).click(),
  );
  expect(service.listMcpCalls).toHaveBeenLastCalledWith(
    expect.objectContaining({ keyId: 'key-a' }),
  );
  await act(async () => resolveOld(records([call('old', 'old-key')])));
  expect(container.querySelector('[data-mcp-event="filtered"]')).not.toBeNull();
  expect(container.querySelector('[data-mcp-event="old"]')).toBeNull();
});
it('概览失败不阻塞调用记录，失败不冒充未接入', async () => {
  service.getMcpConsoleOverview.mockRejectedValue(new Error('概览暂不可用'));
  await act(async () => root.render(view()));
  expect(container.textContent).toContain('MCP 概览读取失败');
  expect(container.querySelector('[data-mcp-event="a"]')).not.toBeNull();
  expect(container.querySelector('.ws-metric strong')?.textContent).toBe('—');
  expect(container.textContent).not.toContain('尚未配置 MCP 客户端');
});
it('翻页失败保留原页与页码，不把第一页标为第二页', async () => {
  service.listMcpCalls
    .mockResolvedValueOnce(records([call('a')], 40))
    .mockRejectedValue(new Error('分页不可用'));
  await act(async () => root.render(view()));
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '下一页')!
      .click(),
  );
  expect(container.textContent).toContain('分页不可用');
  expect(container.textContent).toContain('第 1 / 2 页');
  expect(container.querySelector('[data-mcp-event="a"]')).not.toBeNull();
});
it('后台刷新后选中事件移出列表时保留有标记的快照，不伪造新结果', async () => {
  service.listMcpCalls
    .mockResolvedValueOnce(records([call('a')]))
    .mockResolvedValue(records([]));
  await act(async () => root.render(view()));
  await act(async () =>
    (
      container.querySelector(
        '[data-mcp-event="a"] .ws-row-action',
      ) as HTMLButtonElement
    ).click(),
  );
  await act(async () => root.render(view(1)));
  expect(container.querySelector('aside')?.textContent).toContain(
    '显示上次载入记录',
  );
  expect(container.querySelector('aside')?.textContent).toContain(
    'map_visual_get_run',
  );
});

it('本环境没有历史不能推断账号从未用过MCP', async () => {
  service.getMcpConsoleOverview.mockResolvedValue(
    ok({
      ...overview,
      hasHistory: false,
      clients: [{ ...overview.clients[0], lastUsedAt: '2026-09-24T04:00:00Z' }],
    }),
  );
  service.listMcpCalls.mockResolvedValue(records([]));
  await act(async () => root.render(view()));
  expect(container.textContent).toContain('本环境暂无 MCP 调用');
  expect(container.textContent).not.toContain('等待第一次');
});
