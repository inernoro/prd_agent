import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildConsoleStance, sameCommit } from '../../web/src/lib/releaseConsoleState';

/**
 * 「我现在在哪」。用户 2026-08-15：
 * 「我从发布中心页跳转到发布页忽然发现，是已经发布过的，会给用户一种
 *  『我在那、我在干什么、现在怎么做的过程』，很有心智负担。
 *  这些没有被标记为已发布吗？」
 *
 * 根因：`shown = run || row?.latestRun`。本次没发起任何操作时退回展示上一次历史
 * 发布，于是标题「发布成功」+ 满格绿进度条 + 打勾步骤 + 一屏日志，整屏都在说
 * 「你刚成功发布了一版」。历史被渲染成了现在时——**页面照样跑、测试照样绿**，
 * 只有真人打开才会懵，所以必须钉住。
 */

const base = {
  sessionRun: null,
  latestRun: null,
  liveCommit: '',
  selectedCommit: '',
  running: false,
  failed: false,
};

describe('短 sha 比较', () => {
  it('全长与 7 位互相认得出，大小写与空白不影响', () => {
    expect(sameCommit('c0bc1ee9f0a1b2c3', 'c0bc1ee')).toBe(true);
    expect(sameCommit('C0BC1EE', ' c0bc1ee ')).toBe(true);
    expect(sameCommit('c0bc1ee', 'd96cc98')).toBe(false);
  });

  /** 空串不能判成「相同」，否则没选版本时会被标成「已在线上」。 */
  it('任一侧为空一律判不同', () => {
    expect(sameCommit('', '')).toBe(false);
    expect(sameCommit('c0bc1ee', '')).toBe(false);
    expect(sameCommit(undefined, 'c0bc1ee')).toBe(false);
  });
});

describe('从发布中心跳过来、本次什么都没做', () => {
  const stance = buildConsoleStance({
    ...base,
    latestRun: { status: 'success', commitSha: 'c0bc1ee9f0', operator: 'user' },
    liveCommit: 'c0bc1ee9f0',
    selectedCommit: 'c0bc1ee9f0',
  });

  it('标题带「上次」，不能说成刚刚发生', () => {
    expect(stance.phase).toBe('history');
    expect(stance.title).toBe('上次发布成功');
    expect(stance.title).not.toBe('发布成功');
  });

  it('挂「历史记录」标签', () => {
    expect(stance.badge).toBe('历史记录');
  });

  it('明说这不是本次操作', () => {
    expect(stance.hint).toContain('不是本次操作');
  });

  it('选中的就是线上那一版时，明说再发一次不会改变线上', () => {
    expect(stance.selectedIsLive).toBe(true);
    expect(stance.hint).toContain('已经在线上');
    expect(stance.hint).toContain('线上内容不会变');
    expect(stance.primaryLabel).toBe('重新发布这一版');
  });

  it('归因带上是哪一版、谁发的', () => {
    expect(stance.hint).toContain('c0bc1ee');
    expect(stance.hint).toContain('user');
  });

  /** 缺字段时整段定语不出，不许拼出「（ · ）」这种半截话。 */
  it('拿不到 sha / 操作人时不拼半截话', () => {
    const bare = buildConsoleStance({ ...base, latestRun: { status: 'success' } });
    expect(bare.hint).toContain('不是本次操作');
    expect(bare.hint).not.toContain('（）');
    expect(bare.hint).not.toContain('· ）');
  });
});

describe('历史态但选了别的版本', () => {
  const stance = buildConsoleStance({
    ...base,
    latestRun: { status: 'success', commitSha: 'c0bc1ee', operator: 'user' },
    liveCommit: 'c0bc1ee',
    selectedCommit: 'ff00f91',
  });

  it('不标「已在线上」，按钮回到「开始发布」', () => {
    expect(stance.selectedIsLive).toBe(false);
    expect(stance.primaryLabel).toBe('开始发布');
    expect(stance.hint).not.toContain('已经在线上');
    expect(stance.hint).toContain('才会真正发');
  });
});

describe('本次真的发起过：照旧说现在时', () => {
  it('成功', () => {
    const stance = buildConsoleStance({ ...base, sessionRun: { status: 'success' } });
    expect(stance.phase).toBe('session');
    expect(stance.title).toBe('发布成功');
    expect(stance.badge).toBe('');
    // 本次刚做完，屏幕自己说得清，不再叠一条解释
    expect(stance.hint).toBe('');
  });

  it('失败', () => {
    const stance = buildConsoleStance({ ...base, sessionRun: { status: 'failed' }, failed: true });
    expect(stance.title).toBe('发布失败');
    expect(stance.primaryLabel).toBe('重新发布');
  });

  it('进行中压过一切', () => {
    const stance = buildConsoleStance({
      ...base,
      sessionRun: { status: 'running' },
      latestRun: { status: 'success' },
      running: true,
    });
    expect(stance.phase).toBe('running');
    expect(stance.title).toBe('发布中');
    expect(stance.hint).toBe('');
  });
});

describe('从没发布过的环境', () => {
  it('说清这是第一版，不说「上次」', () => {
    const stance = buildConsoleStance({ ...base, selectedCommit: 'abc1234' });
    expect(stance.phase).toBe('never');
    expect(stance.title).toBe('待发布');
    expect(stance.hint).toContain('第一版');
    expect(stance.title).not.toContain('上次');
  });
});

describe('接线：判定必须真的渲染到屏幕上', () => {
  const PAGE = fs.readFileSync(
    path.resolve(process.cwd(), '../cds/web/src/pages/ReleaseConsolePage.tsx'),
    'utf8',
  );

  /**
   * 判定函数写好却没接进页面，是本仓库反复栽的「链路只建到一半」：
   * 单测全绿、页面照旧渲染旧文案。四处渲染点逐一钉住。
   */
  it('标题 / 标签 / 说明 / 主按钮四处都走同一份判定', () => {
    expect(PAGE).toContain('const stance = buildConsoleStance({');
    expect(PAGE).toContain('const statusTitle = stance.title;');
    expect(PAGE).toContain('{stance.badge}');
    expect(PAGE).toContain('{stance.hint}');
    expect(PAGE).toContain(': stance.primaryLabel}');
    // 旧的三元判定必须删干净，留着就是第二份判据
    expect(PAGE).not.toContain("failed ? '重新发布' : '开始发布'");
  });

  it('版本下拉里标出线上那一版', () => {
    expect(PAGE).toContain("sameCommit(item.commitSha, row?.currentCommit) ? ' · 线上' : ''");
  });
});
