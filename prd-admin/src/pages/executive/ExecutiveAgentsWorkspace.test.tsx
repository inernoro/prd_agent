// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it } from 'vitest';
import { ExecutiveAgentsWorkspace } from './ExecutiveAgentsWorkspace';
import type { ExecutiveAgentStat } from '@/services/contracts/executive';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function Location() {
  return <output>{useLocation().search}</output>;
}
it('图与列表同选一个Agent，选择后保留筛选和时间范围深链', async () => {
  const item = (
    key: string,
    calls: number,
    ms: number,
  ): ExecutiveAgentStat => ({
    appKey: key,
    name: `测试${key}`,
    calls,
    llmCalls: calls,
    apiCalls: 0,
    tokens: 100,
    avgDurationMs: ms,
    users: 1,
  });
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/executive?tab=agents&days=7']}>
          <ExecutiveAgentsWorkspace
            agents={[item('A', 4, 100), item('B', 2, 600), item('C', 3, 0)]}
            team={[]}
          />
          <Location />
        </MemoryRouter>,
      ),
    );
    expect(node.querySelectorAll('.op-plot-point')).toHaveLength(2);
    const target = [
      ...node.querySelectorAll<HTMLButtonElement>('.op-plot-point'),
    ].find((button) => button.getAttribute('aria-label')?.startsWith('测试B'))!;
    await act(async () => target.click());
    expect(node.querySelector('.op-agent-inspector h2')?.textContent).toBe(
      '测试B',
    );
    expect(
      node.querySelector('.op-agent-row[aria-pressed=true]')?.textContent,
    ).toContain('测试B');
    expect(node.querySelector('output')?.textContent).toContain('agent=B');
    expect(node.querySelector('output')?.textContent).toContain('days=7');
    const select = node.querySelector('select')!;
    await act(async () => {
      select.value = 'avgDurationMs';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(node.querySelector('.op-agent-row')?.textContent).toContain('测试B');
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
