/**
 * scheduled-job-actions.test.ts —— 编辑自动发布规则不得删掉兄弟动作。
 *
 * PATCH 把 actions 当权威全量，而自动发布页只认识其中一条。提交单元素数组
 * 就是一次静默的数据删除（Codex review P2，2026-07-29）。
 */

import { describe, expect, it } from 'vitest';

import { mergeReleaseAction, type JobActionLike } from '../../web/src/lib/scheduledJobActions';

const next: JobActionLike & { name?: string } = { id: 'release', type: 'release', targetId: 'rt_prod', name: '发布到环境' };

describe('mergeReleaseAction', () => {
  it('新建规则：只有这一条', () => {
    expect(mergeReleaseAction(undefined, 'rt_prod', next)).toEqual([next]);
    expect(mergeReleaseAction([], 'rt_prod', next)).toEqual([next]);
  });

  it('替换本目标的 release 动作，兄弟动作原样保留', () => {
    const existing: JobActionLike[] = [
      { id: 'a1', type: 'http' },
      { id: 'a2', type: 'release', targetId: 'rt_prod' },
      { id: 'a3', type: 'command' },
      { id: 'a4', type: 'release', targetId: 'rt_stg' },
    ];
    const merged = mergeReleaseAction(existing, 'rt_prod', next);
    expect(merged).toHaveLength(4);
    expect(merged.map((item) => item.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    // 被替换的那条换了内容但沿用原 id —— id 是任务内的稳定标识。
    expect(merged[1]).toMatchObject({ id: 'a2', type: 'release', targetId: 'rt_prod', name: '发布到环境' });
    // 发往别的环境的那条一个字都没动。
    expect(merged[3]).toEqual({ id: 'a4', type: 'release', targetId: 'rt_stg' });
  });

  it('本目标的动作已不在列表里 → 追加，不丢用户刚填的内容', () => {
    const existing: JobActionLike[] = [{ id: 'a1', type: 'http' }];
    const merged = mergeReleaseAction(existing, 'rt_prod', next);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({ id: 'a1', type: 'http' });
    expect(merged[1]).toEqual(next);
  });

  it('同目标出现两条（异常数据）只替换第一条，不合并成一条', () => {
    const existing: JobActionLike[] = [
      { id: 'a1', type: 'release', targetId: 'rt_prod' },
      { id: 'a2', type: 'release', targetId: 'rt_prod' },
    ];
    const merged = mergeReleaseAction(existing, 'rt_prod', next);
    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.id)).toEqual(['a1', 'a2']);
  });

  it('不改动入参数组', () => {
    const existing: JobActionLike[] = [{ id: 'a1', type: 'http' }];
    const snapshot = JSON.stringify(existing);
    mergeReleaseAction(existing, 'rt_prod', next);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});

describe('AutoReleaseTab 真的走这个判定源（接线守卫）', () => {
  it('提交体的 actions 来自 mergeReleaseAction，而不是就地拼一个数组', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.resolve(here, '../../web/src/pages/release-center/AutoReleaseTab.tsx'),
      'utf8',
    );
    expect(source).toContain('mergeReleaseAction(editing?.actions');
    // 回到单元素数组就是把这个 bug 放回去。
    expect(source).not.toMatch(/actions:\s*\[\{\s*id:\s*'release'/);
  });
});
