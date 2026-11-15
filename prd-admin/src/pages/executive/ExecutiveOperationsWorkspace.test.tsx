// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExecutiveModelStat } from '@/services/contracts/executive';
const channels = vi.hoisted(() => ({ getStats: vi.fn(), getTasks: vi.fn() }));
vi.mock('@/services', () => ({ channelService: channels }));
import {
  ExecutiveCostWorkspace,
  ExecutiveOverviewWorkspace,
  ExecutiveIntegrationsWorkspace,
} from './ExecutiveOperationsWorkspace';
import { AssetSourceFilter } from '@/components/workspace/AssetSourceFilter';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement('div');
document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
});
const model = (
  name: string,
  priced: boolean,
  cost: number,
): ExecutiveModelStat => ({
  model: name,
  hasPricing: priced,
  totalCost: cost,
  calls: 2,
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 40,
  avgDurationMs: 500,
  imageCount: 0,
  tokenCost: cost,
  callCost: 0,
});
it('缺失定价不加入成本合计，显式零价格保持可估算', async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveCostWorkspace
          models={[
            model('priced', true, 1.25),
            model('unknown', false, 999),
            model('free', true, 0),
          ]}
        />
      </MemoryRouter>,
    ),
  );
  expect(container.querySelector('.ws-metric strong')?.textContent).toBe(
    '¥1.25',
  );
  expect(container.textContent).toContain('2/3 个模型已定价');
  expect(container.textContent).toContain('不能当作零成本');
  const missing = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === '缺失定价',
  )!;
  await act(async () => missing.click());
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  expect(container.querySelector('tbody')?.textContent).toContain('unknown');
  expect(container.querySelector('tbody')?.textContent).toContain('不可估算');
});
it('未收到总览数据时核心指标为未知，真实零值可以显示', async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveOverviewWorkspace />
      </MemoryRouter>,
    ),
  );
  expect(
    [...container.querySelectorAll('.ws-metric strong')].every(
      (item) => item.textContent === '—',
    ),
  ).toBe(true);
});
it('所有模型都缺失价格时不伪造零成本', async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveCostWorkspace models={[model('unknown', false, 0)]} />
      </MemoryRouter>,
    ),
  );
  expect(container.querySelector('.ws-metric strong')?.textContent).toBe(
    '暂不可估算',
  );
});
it('来源筛选明确为已载入范围，并将选择交回真实资源列表', async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <AssetSourceFilter
        items={[
          { source: '视觉创作' },
          { source: '视觉创作' },
          { source: null },
        ]}
        value=""
        onChange={onChange}
      />,
    ),
  );
  expect(container.textContent).toContain('已载入范围');
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === '视觉创作 2',
  )!;
  await act(async () => button.click());
  expect(onChange).toHaveBeenCalledWith('视觉创作');
  expect(container.textContent).toContain('未标注来源 1');
});

it('未记录模型名称的请求有明确标签，不能错误下钻到全部模型', async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveCostWorkspace models={[model('', false, 0)]} />
      </MemoryRouter>,
    ),
  );
  expect(container.querySelector('tbody')?.textContent).toContain('未记录模型');
  expect(container.textContent).toContain('不能按模型准确筛选');
});
it('渠道启用不声称连接健康，选择任务后显示对应人员及错误', async () => {
  channels.getStats.mockResolvedValue({
    channels: [
      {
        channelType: 'webhook',
        displayName: 'Webhook',
        isEnabled: true,
        todayRequestCount: 2,
        todaySuccessCount: 1,
        todayFailCount: 1,
      },
    ],
    todayTaskCount: 2,
    processingCount: 0,
    successRate: 50,
    identityMappingCount: 0,
  });
  const task = (id: string, name: string, status: string, error?: string) => ({
    id,
    channelType: 'webhook',
    senderIdentifier: name,
    mappedUserName: name,
    originalContent: `验收任务 ${id}`,
    status,
    error,
    createdAt: '2026-11-15T09:00:00Z',
  });
  channels.getTasks.mockResolvedValue({
    items: [
      task('a', '成员甲', 'completed'),
      task('b', '成员乙', 'failed', '解析失败'),
    ],
    total: 2,
  });
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveIntegrationsWorkspace revision={0} />
      </MemoryRouter>,
    ),
  );
  expect(container.textContent).toContain('已启用');
  expect(container.textContent).not.toContain('已连接');
  const rows = container.querySelectorAll('tbody tr');
  await act(async () =>
    rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  expect(container.querySelector('aside')?.textContent).toContain('成员乙');
  expect(container.querySelector('aside')?.textContent).toContain('解析失败');
  expect(container.querySelectorAll('tbody .ws-avatar')).toHaveLength(2);
});
