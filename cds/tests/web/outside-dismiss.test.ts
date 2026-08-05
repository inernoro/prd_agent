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
import { shouldDismissOnPointerDown } from '../../web/src/lib/outside-dismiss';

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
    // 刻意不监听 scroll：面板列表区可滚，滚动关闭会误伤
    expect(src).not.toMatch(/addEventListener\('scroll'[^)]*\)\s*;?\s*\/\/\s*close/);
  });
});
