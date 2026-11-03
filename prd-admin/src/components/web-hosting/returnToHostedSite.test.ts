// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostedSite } from '@/services/real/webPages';
import { highlightReturnedSite, returnedSiteSpace } from './returnToHostedSite';
afterEach(() => vi.unstubAllGlobals());
describe('返回网页定位', () => {
  it('跳到有权限的所属团队，优先保留原团队；不能定位到不可见团队', () => {
    const site = { sharedTeamIds: ['hidden', 'a', 'b'] } as HostedSite;
    expect(returnedSiteSpace(site, ['a', 'b'], { kind: 'team', teamId: 'b' })).toEqual({ kind: 'team', teamId: 'b' });
    expect(returnedSiteSpace(site, ['a'], { kind: 'personal' })).toEqual({ kind: 'team', teamId: 'a' });
    expect(returnedSiteSpace(site, [], { kind: 'personal' })).toBeNull();
    expect(returnedSiteSpace({ sharedTeamIds: [] } as unknown as HostedSite, [], { kind: 'team', teamId: 'b' })).toEqual({ kind: 'personal' });
  });
  it.each([true, false])('滚动后强调目标并可清理，减少动态效果=%s', (reduced) => {
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
    const element = document.createElement('div');
    element.style.outline = '1px solid red';
    element.scrollIntoView = vi.fn();
    const cancel = vi.fn(); element.animate = vi.fn(() => ({ cancel }) as unknown as Animation);
    const cleanup = highlightReturnedSite(element);
    expect(element.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    expect(element.style.outline).toContain('var(--accent-primary)');
    expect(element.animate).toHaveBeenCalledTimes(reduced ? 0 : 1);
    cleanup(); expect(element.style.outline).toBe('1px solid red');
    expect(cancel).toHaveBeenCalledTimes(reduced ? 0 : 1);
  });
});
