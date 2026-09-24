import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ApiResponse } from '@/types/api';
import type { PrivateSourceReport } from '@/services/real/webPages';
import {
  buildPrivateSourceHeadline,
  describePrivateSourceLocation,
  isPrivateSourceConfirmationError,
  isWideningBeyondCollaborators,
  requestPrivateSourceConfirmation,
  runWithPrivateSourceGate,
  usePrivateSourceConfirmStore,
} from './privateSourceConfirm';

/**
 * 发布前私有资料确认的前端那一半。服务端是最终的闸（没带确认就 409），
 * 这里要保证：有私有资料时先让作者看清后果再发出去；没有时行为与原来完全一样。
 */

const privateReport: PrivateSourceReport = {
  requiresConfirmation: true,
  fingerprint: 'psc1:abc',
  items: [
    {
      entryId: 'entry-1',
      title: '季度经营数据',
      storeId: 'store-1',
      storeName: '财务内部库',
      scope: 'owner-only',
      scopeLabel: '个人知识库，仅所有者可见',
    },
  ],
};

const ok = <T,>(data: T): ApiResponse<T> => ({ success: true, data, error: null });
const fail = (code: string, message = 'x'): ApiResponse<never> => ({ success: false, data: null, error: { code, message } });

describe('runWithPrivateSourceGate', () => {
  it('没有私有资料：不弹确认、不带指纹，行为与原来一致', async () => {
    const ask = vi.fn();
    const run = vi.fn(async () => ok('done'));
    const outcome = await runWithPrivateSourceGate({
      inspect: async () => ok({ requiresConfirmation: false, items: [] }),
      run,
      actionLabel: '发布这版',
      ask,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(undefined);
    expect(outcome).toEqual({ status: 'done', res: ok('done') });
  });

  it('有私有资料且作者确认：带着服务端给的指纹发出', async () => {
    const ask = vi.fn(async () => 'confirm' as const);
    const run = vi.fn(async () => ok('done'));
    const outcome = await runWithPrivateSourceGate({
      inspect: async () => ok(privateReport),
      run,
      actionLabel: '生成分享链接',
      ask,
    });
    expect(ask).toHaveBeenCalledWith(privateReport, { actionLabel: '生成分享链接', allowRevise: undefined });
    expect(run).toHaveBeenCalledWith('psc1:abc');
    expect(outcome.status).toBe('done');
  });

  it('作者取消或返回修改：请求一次都不发', async () => {
    const run = vi.fn(async () => ok('done'));
    const cancelled = await runWithPrivateSourceGate({
      inspect: async () => ok(privateReport), run, actionLabel: '发布这版', ask: async () => 'cancel',
    });
    const revised = await runWithPrivateSourceGate({
      inspect: async () => ok(privateReport), run, actionLabel: '发布这版', allowRevise: true, ask: async () => 'revise',
    });
    expect(cancelled).toEqual({ status: 'cancelled' });
    expect(revised).toEqual({ status: 'revise' });
    expect(run).not.toHaveBeenCalled();
  });

  it('服务端说确认已过期：重新核查、重新确认一次，再带新指纹发出', async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce(ok(privateReport))
      .mockResolvedValueOnce(ok({ ...privateReport, fingerprint: 'psc1:new' }));
    const ask = vi.fn(async () => 'confirm' as const);
    const run = vi.fn()
      .mockResolvedValueOnce(fail('HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_STALE'))
      .mockResolvedValueOnce(ok('done'));
    const outcome = await runWithPrivateSourceGate({ inspect, run, actionLabel: '发布这版', ask });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(2, 'psc1:new');
    expect(outcome.status).toBe('done');
  });

  it('其它失败原样交回调用方，不重试', async () => {
    const run = vi.fn(async () => fail('REVISION_CONFLICT'));
    const outcome = await runWithPrivateSourceGate({
      inspect: async () => ok({ requiresConfirmation: false, items: [] }), run, actionLabel: '发布这版', ask: vi.fn(),
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('done');
  });

  it('没有私有资料时仍走原有确认（设为公开那一句），取消就不发', async () => {
    const run = vi.fn(async () => ok('done'));
    const outcome = await runWithPrivateSourceGate({
      inspect: async () => ok({ requiresConfirmation: false, items: [] }),
      run,
      actionLabel: '设为公开',
      confirmWithoutPrivateSources: () => false,
      ask: vi.fn(),
    });
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('确认层文案与宿主', () => {
  it('第一句先说后果', () => {
    expect(buildPrivateSourceHeadline(2)).toBe('本页引用了以下 2 份私有资料，发布后任何拿到链接的人都能看到其中内容');
    expect(describePrivateSourceLocation(privateReport.items[0])).toBe('财务内部库 · 个人知识库，仅所有者可见');
  });

  it('错误码判定与服务端两个码对齐', () => {
    expect(isPrivateSourceConfirmationError('HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_REQUIRED')).toBe(true);
    expect(isPrivateSourceConfirmationError('HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_STALE')).toBe(true);
    expect(isPrivateSourceConfirmationError('REVISION_CONFLICT')).toBe(false);
  });

  it('有宿主时交给确认层，作者的决定原样回到调用方', async () => {
    const store = usePrivateSourceConfirmStore.getState();
    store.claimHost('host-a');
    const pending = requestPrivateSourceConfirmation(privateReport, { actionLabel: '发布这版', allowRevise: true });
    expect(usePrivateSourceConfirmStore.getState().current?.allowRevise).toBe(true);
    usePrivateSourceConfirmStore.getState().settle('revise');
    await expect(pending).resolves.toBe('revise');
    store.releaseHost('host-a');
  });

  it('没有宿主的页面退回原生确认框，绝不静默放行', async () => {
    const confirmSpy = vi.fn((_text: string) => false);
    vi.stubGlobal('window', { confirm: confirmSpy });
    try {
      await expect(requestPrivateSourceConfirmation(privateReport, { actionLabel: '发布这版' })).resolves.toBe('cancel');
      const text = confirmSpy.mock.calls[0]?.[0] ?? '';
      expect(text.startsWith(buildPrivateSourceHeadline(1))).toBe(true);
      expect(text).toContain('季度经营数据（财务内部库 · 个人知识库，仅所有者可见）');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('改链接可见性：只有「仅协作者 → 对外」才要确认，与服务端 PATCH 判据一致', () => {
    // 仅协作者改公开 / 登录可见：等同一次对外分享，要弹确认。
    expect(isWideningBeyondCollaborators('owner-only', 'public')).toBe(true);
    expect(isWideningBeyondCollaborators('owner-only', 'logged-in')).toBe(true);
    // 已经对外的链接改档、原样再选一次、收紧：都直接提交，取消确认不能挡住收紧（Codex P2）。
    expect(isWideningBeyondCollaborators('public', 'logged-in')).toBe(false);
    expect(isWideningBeyondCollaborators('public', 'public')).toBe(false);
    expect(isWideningBeyondCollaborators('logged-in', 'public')).toBe(false);
    expect(isWideningBeyondCollaborators('public', 'owner-only')).toBe(false);
    expect(isWideningBeyondCollaborators('owner-only', 'owner-only')).toBe(false);
    // 没有可见性字段的存量链接按公开处理（后端读路径同样如此），改档不是新的暴露。
    expect(isWideningBeyondCollaborators(undefined, 'public')).toBe(false);
    expect(isWideningBeyondCollaborators('', 'logged-in')).toBe(false);
    // 这次没改可见性（只改有效期）。
    expect(isWideningBeyondCollaborators('owner-only', undefined)).toBe(false);
  });

  it('改链接可见性时不属于放宽的修改不核查、不弹确认，直接提交', async () => {
    const ask = vi.fn();
    const inspect = vi.fn(async () => ok(privateReport));
    const run = vi.fn(async (_fingerprint: string | undefined) => ok({ visibility: 'logged-in' }));
    const widening = isWideningBeyondCollaborators('public', 'logged-in');
    const outcome = await runWithPrivateSourceGate({
      inspect: widening ? inspect : async () => ok({ requiresConfirmation: false, items: [] }),
      run,
      actionLabel: '放宽分享范围',
      ask,
    });
    expect(outcome.status).toBe('done');
    expect(inspect).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(undefined);
  });

  it('接线：五个对外发出的入口都走同一个闸，宿主挂在 AppShell 与分享阅读页', () => {
    // 删掉任何一处接线，页面照常渲染、测试照常绿，而私有资料就会不经确认发出去（形状 2）。
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const session = read('workbench/useSiteEditSession.ts');
    const popover = read('QuickSharePopover.tsx');
    const page = read('../../pages/WebPagesPage.tsx');
    expect(session).toMatch(/runWithPrivateSourceGate\(\{\s*inspect: \(\) => getRevisionPrivateSources/);
    expect(popover.match(/runWithPrivateSourceGate\(/g)?.length).toBe(2);
    // 改可见性那一处必须按「当前 → 目标」判放宽，不能只看目标档位（否则公开改登录可见也会弹确认）。
    expect(popover).toContain('isWideningBeyondCollaborators(link.visibility, body.visibility)');
    expect(page.match(/runWithPrivateSourceGate\(/g)?.length).toBe(3);
    expect(read('../../layouts/AppShell.tsx')).toContain('<PrivateSourceConfirmHost />');
    expect(read('../../pages/ShareViewPage.tsx')).toContain('<PrivateSourceConfirmHost />');
  });
});
