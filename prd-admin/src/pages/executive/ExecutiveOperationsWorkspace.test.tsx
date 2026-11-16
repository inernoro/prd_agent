// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExecutiveModelStat } from '@/services/contracts/executive';
const clipboard = vi.hoisted(() => vi.fn());
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: clipboard }));
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
  await act(async () =>
    (
      container.querySelector('[data-task-id="b"]') as HTMLButtonElement
    ).click(),
  );
  expect(container.querySelector('aside')?.textContent).toContain('成员乙');
  expect(container.querySelector('aside')?.textContent).toContain('解析失败');
  expect(container.querySelectorAll('.op-task-card .ws-avatar')).toHaveLength(
    2,
  );
});

it('分布数据未到达时直接提示，不渲染空白面积画布', async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveOverviewWorkspace />
      </MemoryRouter>,
    ),
  );
  const toggle = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '使用分布',
  )!;
  await act(async () => toggle.click());
  expect(container.querySelector('.scene-treemap')).toBeNull();
  expect(container.textContent).toContain('调用分布读取中');
});

it('复制缺价清单排除空名称，失败反馈不能误报成功', async () => {
  clipboard.mockResolvedValue(false);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveCostWorkspace
          models={[
            model('', false, 0),
            model('need-price', false, 0),
            model('priced', true, 2),
          ]}
        />
      </MemoryRouter>,
    ),
  );
  const copy = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('复制待定价模型清单'),
  )!;
  await act(async () => copy.click());
  expect(clipboard).toHaveBeenCalledWith('need-price');
  expect(container.textContent).toContain('复制失败');
  expect(container.textContent).not.toContain('已复制');
});
it('任务翻页失败保留上一页快照和原页码，不能误判为空', async () => {
  channels.getStats.mockResolvedValue({
    channels: [],
    todayTaskCount: 80,
    processingCount: 0,
    successRate: 100,
  });
  channels.getTasks
    .mockResolvedValueOnce({
      items: [
        {
          id: 'saved',
          channelType: 'webhook',
          senderIdentifier: '成员',
          originalContent: '已有任务',
          status: 'completed',
          createdAt: '2026-11-16T00:00:00Z',
        },
      ],
      total: 80,
      page: 1,
      pageSize: 40,
    })
    .mockRejectedValue(new Error('网络中断'));
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ExecutiveIntegrationsWorkspace revision={0} />
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent === '下一页')!
      .click(),
  );
  expect(container.textContent).toContain('第 1 / 2 页');
  expect(container.textContent).toContain('已有任务');
  expect(container.textContent).toContain('网络中断');
  expect(container.textContent).not.toContain('还没有外部任务');
});
it('后台刷新后所选任务移出本页仍保留明确标注的历史快照', async () => {
  channels.getStats.mockResolvedValue({
    channels: [],
    todayTaskCount: 2,
    processingCount: 0,
    successRate: 100,
  });
  const task = {
    id: 'chosen',
    channelType: 'webhook',
    senderIdentifier: '成员',
    originalContent: '所选任务',
    status: 'completed',
    createdAt: '2026-11-16T00:00:00Z',
    statusHistory: [
      { status: 'completed', at: '2026-11-16T00:00:01Z', note: '真实历史' },
    ],
  };
  channels.getTasks
    .mockResolvedValueOnce({ items: [task], total: 1, page: 1, pageSize: 40 })
    .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 40 });
  const render = (revision: number) => (
    <MemoryRouter>
      <ExecutiveIntegrationsWorkspace revision={revision} />
    </MemoryRouter>
  );
  await act(async () => root.render(render(0)));
  await act(async () =>
    (
      container.querySelector('[data-task-id="chosen"]') as HTMLButtonElement
    ).click(),
  );
  await act(async () => root.render(render(1)));
  expect(container.querySelector('aside')?.textContent).toContain('所选任务');
  expect(container.querySelector('aside')?.textContent).toContain('真实历史');
  expect(container.querySelector('aside')?.textContent).toContain(
    '显示上次载入记录',
  );
});
