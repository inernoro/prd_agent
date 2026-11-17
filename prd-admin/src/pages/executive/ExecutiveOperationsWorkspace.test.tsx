// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExecutiveModelStat } from '@/services/contracts/executive';
const clipboard = vi.hoisted(() => vi.fn());
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: clipboard }));
vi.mock('@/services', () => ({}));
import {
  ExecutiveCostWorkspace,
  ExecutiveOverviewWorkspace,
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

it('从调用分布下钻Agent保留时间窗口和其他查询条件', async () => {
  function Location() {
    const location = useLocation();
    return <output>{location.search}</output>;
  }
  const agents = [
    {
      appKey: 'visual&api',
      name: '视觉创作',
      calls: 3,
      apiCalls: 1,
      llmCalls: 2,
      users: 1,
      tokens: 100,
      avgDurationMs: 500,
    },
  ];
  await act(async () =>
    root.render(
      <MemoryRouter
        initialEntries={['/executive?tab=overview&days=7&other=keep']}
      >
        <ExecutiveOverviewWorkspace agents={agents} />
        <Location />
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === '使用分布')!
      .click(),
  );
  await act(async () =>
    (
      container.querySelector('.scene-treemap button') as HTMLButtonElement
    ).click(),
  );
  const params = new URLSearchParams(
    container.querySelector('output')!.textContent!,
  );
  expect(params.get('days')).toBe('7');
  expect(params.get('other')).toBe('keep');
  expect(params.get('tab')).toBe('agents');
  expect(params.get('agent')).toBe('visual&api');
});
