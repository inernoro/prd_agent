// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeamInsightsWorkspace from '../TeamInsightsWorkspace';
import { workspaceFixture } from './workspaceFixture';
import { useAuthStore } from '@/stores/authStore';

vi.mock('@/pages/executive/TeamInsightsPanel', async importOriginal => {
  const actual = await importOriginal<typeof import('../TeamInsightsPanel')>();
  return { ...actual, default: ({ masked, onMaskedChange }: { masked?: boolean; onMaskedChange?: (value: boolean) => void }) => <div>原有完整分析报告<button onClick={() => onMaskedChange?.(!masked)}>报告{masked ? '匿名' : '明文'}</button></div> };
});

describe('CDS 风格真实统计工作区', () => {
  let root: Root;
  let container: HTMLDivElement;
  const data = workspaceFixture();
  const openTab = vi.fn();
  const originalCdn = useAuthStore.getState().cdnBaseUrl;
  const buttons = (text: string) => Array.from(container.querySelectorAll('button')).filter(button => button.textContent?.includes(text));
  async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.removeItem('exec.teamInsights.masked');
    openTab.mockReset();
    useAuthStore.setState({ cdnBaseUrl: 'https://avatars.example.test' });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><TeamInsightsWorkspace data={data} loading={false} onOpenTab={openTab} /></MemoryRouter>));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.removeItem('exec.teamInsights.masked'); useAuthStore.setState({ cdnBaseUrl: originalCdn }); });
  it('真实分类和零记录成员可下钻，返回还原来源焦点', async () => {
    const category = container.querySelector<HTMLButtonElement>('[data-exec-anchor="group:real-team"]')!;
    category.focus(); await click(category);
    expect(container.querySelector('.exec-view-heading')?.textContent).toContain('真实协作组');
    const user = container.querySelector<HTMLButtonElement>('[data-exec-anchor="member:u2"]')!;
    user.focus(); await click(user);
    expect(container.querySelector('.exec-view-heading')?.textContent).toContain('陈测试');
    expect(container.textContent).toContain('本序列范围暂无产出');
    expect(container.textContent).toContain('定价不足，暂不可计算');
    await click(buttons('返回')[0]);
    expect(document.activeElement?.getAttribute('data-exec-anchor')).toBe('member:u2');
    await click(buttons('返回')[0]);
    expect(document.activeElement?.getAttribute('data-exec-anchor')).toBe('group:real-team');
  });
  it('可切换密度、筛选和搜索，未知资料不冒充零记录', async () => {
    await click(buttons('单行')[0]);
    expect(container.querySelector('.exec-density-line')).not.toBeNull();
    await click(buttons('暂无')[0]);
    expect(container.querySelectorAll('.exec-member')).toHaveLength(1);
    expect(container.querySelector('.exec-member')?.textContent).toContain('陈测试');
    await click(buttons('成员')[0]);
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '林测试');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('.exec-member')).toHaveLength(1);
  });
  it('右侧事项展开依据，调用来源与完整报告有可用入口', async () => {
    await click(container.querySelector<HTMLButtonElement>('.exec-attention')!);
    expect(container.textContent).toContain('当前快照中有 2 个未关闭缺陷');
    expect(container.textContent).toContain('确认负责人');
    await click(buttons('全部团队')[0]);
    await click(container.querySelector<HTMLButtonElement>('.exec-caller')!);
    expect(container.textContent).toContain('与成员卡片和团队摘要的人工账号口径不同');
    await click(buttons('查看 Agent 明细')[0]);
    expect(openTab).toHaveBeenCalledWith('agents');
    await click(buttons('完整分析')[0]);
    expect(container.textContent).toContain('原有完整分析报告');
  });
  it('跨团队成员在总览只出现一次，真实头像与姓名头像在卡片和详情可见', async () => {
    const overlapping = workspaceFixture();
    overlapping.workspace!.members[0].avatarFileName = 'lin.png';
    overlapping.workspace!.groups.push({ id: 'second-team', name: '第二协作组', userIds: ['u1'], totalMembers: 1, activeMembers: 1 });
    overlapping.attention[0] = { ...overlapping.attention[0], key: 'low-yield:u1', title: '林测试 调用量高但产出低' };
    await act(async () => root.render(<MemoryRouter><TeamInsightsWorkspace data={overlapping} loading={false} /></MemoryRouter>));
    expect(container.querySelectorAll('.exec-groups .exec-member')).toHaveLength(0);
    expect(container.querySelectorAll('.exec-roster-grid .exec-member')).toHaveLength(2);
    const person = container.querySelector<HTMLButtonElement>('[data-exec-anchor="member:u1"]')!;
    expect(person.querySelector('img')?.getAttribute('src')).toContain('lin.png');
    expect(container.querySelector('[data-exec-anchor="member:u2"] .exec-avatar-initial')?.getAttribute('aria-label')).toBe('陈测试的姓名头像');
    expect(container.querySelector('.exec-attention .exec-people-chips img')?.getAttribute('alt')).toBe('林测试的头像');
    person.focus(); await click(person);
    expect(container.querySelector('.exec-profile-identity img')?.getAttribute('alt')).toBe('林测试的头像');
    expect(container.querySelector('.exec-crumb-item strong img')).not.toBeNull();
    await click(buttons('完整分析')[0]);
    expect(container.querySelector('.exec-crumb-item button img')).not.toBeNull();
    await click(buttons('返回')[0]);
    await click(buttons('返回')[0]);
    expect(document.activeElement?.getAttribute('data-exec-anchor')).toBe('member:u1');
  });
  it('首次渲染继承匿名偏好，卡片、头像、证据与完整分析同步切换', async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.setItem('exec.teamInsights.masked', '1');
    const privateData = workspaceFixture();
    privateData.workspace!.members[0].avatarFileName = 'private-portrait.png';
    privateData.headline.text = '林测试需要查看';
    privateData.attention[0] = { ...privateData.attention[0], title: '林测试的积压', evidence: '林测试有积压', suggestion: '请林测试确认' };
    await act(async () => root.render(<MemoryRouter><TeamInsightsWorkspace data={privateData} loading={false} /></MemoryRouter>));
    expect(container.textContent).not.toContain('林测试');
    expect(container.innerHTML).not.toContain('private-portrait.png');
    expect(container.textContent).toContain('林**');
    await click(container.querySelector<HTMLButtonElement>('.exec-attention')!);
    expect(container.textContent).not.toContain('林测试');
    expect(container.textContent).toContain('林**有积压');
    await click(buttons('完整分析')[0]);
    await click(buttons('报告匿名')[0]);
    expect(localStorage.getItem('exec.teamInsights.masked')).toBe('0');
    expect(container.textContent).toContain('林测试的积压');
    await click(container.querySelector<HTMLButtonElement>('[aria-label="匿名展示"]')!);
    expect(localStorage.getItem('exec.teamInsights.masked')).toBe('1');
    expect(container.textContent).toContain('报告匿名');
    expect(container.textContent).not.toContain('林测试');
  });

});
