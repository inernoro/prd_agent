/**
 * 守卫：「点外部关掉浮层」的判据。
 *
 * 三类「其实还在浮层里」的点击，漏一类就是一个用户可感的 bug
 * （.claude/rules/predicate-and-wiring-discipline.md 形状 1「判据比它该管的范围窄」）：
 *
 *   1. 点浮层自己  → 漏了：一点内容面板就关
 *   2. 点触发按钮  → 漏了：pointerdown 先关、紧接着 button 的 click 又开，浮层永远关不掉
 *   3. 点浮层内部组件 portal 出去的弹层 → 漏了：面板内的授权/导入收件箱会把 Radix
 *      Dialog 挂到 body，DOM 上不在面板内，在弹窗里一点就把面板连同弹窗一起卸载
 *
 * 判据抽成纯函数正是为了能测这三类：cds 的 vitest 没有 jsdom（cds/vitest.config.ts），
 * 真实事件行为测不了，不抽出来就只能退化成「源码里含某段字面量」的反向锁死断言。
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoticeRecordTimes } from '../../web/src/components/SiteNoticeInbox';
import { NoticeLedgerService, NOTICE_MERGE_WINDOW_MS } from '../../src/services/notice-ledger';
import { shouldDismissOnEscape, shouldDismissOnPointerDown } from '../../web/src/lib/outside-dismiss';

/** 极简节点替身：只实现判据会用到的 contains / closest。 */
function node(opts: { owns?: unknown[]; closestHits?: string[] } = {}) {
  return {
    contains: (target: unknown) => (opts.owns || []).includes(target),
    closest: (selector: string) => ((opts.closestHits || []).includes(selector) ? {} : null),
  };
}

describe('shouldDismissOnPointerDown', () => {
  it('点空白处 → 关闭', () => {
    const target = node();
    expect(shouldDismissOnPointerDown({ target, owned: [node(), node()] })).toBe(true);
  });

  it('点浮层自己 → 不关', () => {
    const target = node();
    const panel = node({ owns: [target] });
    expect(shouldDismissOnPointerDown({ target, owned: [panel, node()] })).toBe(false);
  });

  it('点触发按钮 → 不关（否则 pointerdown 关、click 又开，永远关不掉）', () => {
    const target = node();
    const trigger = node({ owns: [target] });
    expect(shouldDismissOnPointerDown({ target, owned: [node(), trigger] })).toBe(false);
  });

  it('点 portal 出去的 Radix 弹窗内部 → 不关（默认豁免 [role="dialog"]）', () => {
    const target = node({ closestHits: ['[role="dialog"]'] });
    expect(shouldDismissOnPointerDown({ target, owned: [node(), node()] })).toBe(false);
  });

  it('ref 尚未挂载（null）不炸，按外部处理', () => {
    const target = node();
    expect(shouldDismissOnPointerDown({ target, owned: [null, undefined] })).toBe(true);
  });

  it('target 为空时按外部处理，不抛错', () => {
    expect(shouldDismissOnPointerDown({ target: null, owned: [node()] })).toBe(true);
  });

  it('豁免选择器可覆写，且覆写后默认的 dialog 豁免不再生效', () => {
    const dialogTarget = node({ closestHits: ['[role="dialog"]'] });
    expect(shouldDismissOnPointerDown({
      target: dialogTarget,
      owned: [node()],
      exemptSelectors: ['[data-keep-open]'],
    })).toBe(true);
  });
});

/*
 * 2026-08-06 review P3-1：豁免曾只加在 pointerdown 上，Escape 直连 setOpen(false)。
 * 于是在面板内 portal 出去的弹窗里按 Esc，会一次关掉弹窗和它底下的面板，还把焦点
 * 抢回铃铛——鼠标那路早就修好了，键盘这路照旧。两条路径必须共用同一套豁免。
 */
describe('shouldDismissOnEscape', () => {
  it('焦点在普通位置 → 关闭', () => {
    expect(shouldDismissOnEscape({ target: node(), activeElement: node() })).toBe(true);
  });

  it('事件目标在 portal 弹窗里 → 不关', () => {
    expect(shouldDismissOnEscape({
      target: node({ closestHits: ['[role="dialog"]'] }),
      activeElement: node(),
    })).toBe(false);
  });

  it('焦点在 portal 弹窗里（事件目标是 body）→ 不关', () => {
    // Radix 弹窗打开后焦点常落在弹窗内，而 keydown 的 target 可能是 body：
    // 只判 target 会漏掉这一半。
    expect(shouldDismissOnEscape({
      target: node(),
      activeElement: node({ closestHits: ['[role="dialog"]'] }),
    })).toBe(false);
  });

  it('两个都缺省时按「可以关」处理，不抛错', () => {
    expect(shouldDismissOnEscape({})).toBe(true);
  });
});

describe('信息中心接线', () => {
  it('SiteNoticeInbox 真的用了这条判据，且没自己另写一套', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../web/src/components/SiteNoticeInbox.tsx'),
      'utf8',
    );
    expect(src).toContain('shouldDismissOnPointerDown');
    expect(src).toContain("document.addEventListener('pointerdown'");
    // 双 ref 都要传，少一个就对应上面两条用例里的一个 bug
    expect(src).toContain('owned: [panelRef.current, triggerRef.current]');
    // Esc 也要能关，并把焦点还给铃铛
    expect(src).toMatch(/event\.key !== 'Escape'/);
    expect(src).toContain('triggerRef.current?.focus()');
    // Esc 必须走同一套豁免，不能直连 setOpen(false)（review P3-1）
    expect(src).toContain('shouldDismissOnEscape({ target: event.target, activeElement: document.activeElement })');
    // 刻意不监听 scroll：面板列表区可滚，滚动关闭会误伤
    expect(src).not.toMatch(/addEventListener\('scroll'[^)]*\)\s*;?\s*\/\/\s*close/);
  });
});


describe('信息中心真实账本记录时间', () => {
  const input = { id: 'owned-release-notice', dedupeKey: 'release.failed:owned-target',
    level: 'danger' as const, source: 'release', title: '隔离目标发布失败', body: '门禁未通过' };
  const render = (times: Parameters<typeof NoticeRecordTimes>[0]) => renderToStaticMarkup(createElement(NoticeRecordTimes, times));

  it('同窗重复展示首次和最近记录，标已读不改变两个记录时间', () => {
    let now = Date.UTC(2026, 10, 14, 1);
    const ledger = new NoticeLedgerService({ storePath: '', now: () => now });
    const first = ledger.upsert(input).record;
    now += 1000;
    const merged = ledger.upsert(input).record;
    expect(merged.occurrences).toBe(2);
    const html = render(merged);
    expect(html).toContain('首次记录'); expect(html).toContain('最近记录');
    expect(html).toContain(`dateTime="${first.createdAt}"`);
    expect(html).toContain(`title="${merged.updatedAt}"`);
    expect(html.match(/<time /g)).toHaveLength(2);
    ledger.markAllRead();
    expect(ledger.list()[0].readAt).toBeDefined();
    expect(render(ledger.list()[0])).toBe(html);
  });

  it('超窗再次发生仍显示原首次记录，最近记录来自新轮次而非已读时间', () => {
    let now = Date.UTC(2026, 10, 14, 1);
    const ledger = new NoticeLedgerService({ storePath: '', now: () => now });
    const first = ledger.upsert(input).record;
    now += NOTICE_MERGE_WINDOW_MS + 1;
    const relit = ledger.upsert(input);
    expect(relit.action).toBe('relit');
    const html = render(relit.record);
    expect(html).toContain(`dateTime="${first.createdAt}"`);
    expect(html).toContain(`dateTime="${relit.record.updatedAt}"`);
    expect(relit.record.updatedAt).not.toBe(first.createdAt);
    expect(html).not.toMatch(/本轮首次|故障发生|已恢复/);
  });

  it.each([
    { createdAt: '', updatedAt: 'invalid' },
    { createdAt: undefined, updatedAt: undefined },
  ])('缺失或无效时间不补当前时间或epoch：%j', times => {
    const html = render(times as Parameters<typeof NoticeRecordTimes>[0]);
    expect(html.match(/时间未记录/g)).toHaveLength(2);
    expect(html).not.toMatch(/<time |Invalid Date|1970/);
  });

  it('一个字段缺失时不拿另一个字段代替，保留有效ISO供核对', () => {
    const iso = '2026-11-14T01:02:03.456Z';
    const html = render({ createdAt: iso, updatedAt: '' });
    expect(html.match(/<time /g)).toHaveLength(1);
    expect(html).toContain(`dateTime="${iso}" title="${iso}"`);
    expect(html).toContain('最近记录：时间未记录');
  });

  it('实际通用站内卡调用时间元信息，不只导出未接线的组件', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/SiteNoticeInbox.tsx'), 'utf8');
    const card = source.slice(source.indexOf('activeNotices.map((notice)'));
    expect(card).toContain('<NoticeRecordTimes');
    expect(card).toContain('createdAt={notice.createdAt}');
    expect(card).toContain('updatedAt={notice.updatedAt}');
  });
});
