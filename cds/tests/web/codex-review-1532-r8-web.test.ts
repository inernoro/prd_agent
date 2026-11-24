/**
 * Codex review（PR #1532）第八轮的前端一条：判断句与同屏那张图各算各的。
 *
 * 后端的 accepted 是独立累加的，报告挂在一条从没部署过的分支上就会让 accepted > deployed。
 * 图走 splitFunnel（逐级夹取），会把那条改动画进「没起预览」；判断句此前用
 * `t.accepted >= t.changes` 自己判，于是屏幕上出现「都验过了」配一张画着未验收方块的图。
 * 这就是本 PR 反复栽进去的形状 3：同一个判据两份实现。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPipelineHeadline } from '../../web/src/lib/pipelineHeadline';
import { splitFunnel } from '../../web/src/lib/pipelineFunnel';
import { splitFunnel as fromStrip, rowSplit } from '../../web/src/pages/reports/CompactStrip';
import type { PipelineOverview } from '../../web/src/lib/api';

const read = (p: string): string => readFileSync(resolve(__dirname, '../..', p), 'utf8');

/** 脏数据：验过的比部署的还多（报告挂在一条从没部署过的分支上）。 */
function dirty(): PipelineOverview {
  return {
    generatedAt: '2026-09-15T00:00:00.000Z', recentDays: null,
    total: {
      changes: 5, deployed: 2, accepted: 5, merged: 0,
      pass: 5, conditional: 0, fail: 0, undetermined: 0,
    },
    totalLeaks: {
      'merged-not-accepted': 0, 'merged-while-failing': 0,
      'deployed-not-accepted': 0, 'report-missing-change-key': 0,
    },
    projects: [], staleReports: 0, leaks: [],
  } as unknown as PipelineOverview;
}

describe('判断句与分流图必须读同一份数字', () => {
  it('验过的比部署的还多时，不许宣称「都验过了」', () => {
    const o = dirty();
    const seg = splitFunnel(o.total);
    // 图会把 3 条画进「没起预览」，所以判断句也不能说全验过了。
    expect(seg.undeployed).toBe(3);
    expect(seg.accepted).toBe(2);
    const h = buildPipelineHeadline(o);
    expect(h.sentence, '判断句说「都验过了」，而同屏的图画着 3 个未验收方块')
      .not.toContain('都验过了');
    expect(h.sentence).toContain('2 条验过');
    expect(h.sentence).toContain('3 条还没部署');
  });

  it('干净数据下该说「都验过了」的仍然照说（别修过头）', () => {
    const o = dirty();
    o.total = { ...o.total, changes: 5, deployed: 5, accepted: 5 };
    expect(buildPipelineHeadline(o).sentence).toContain('都验过了');
  });

  it('判断句真的调了 splitFunnel，不是自己又夹了一遍', () => {
    const src = read('web/src/lib/pipelineHeadline.ts');
    expect(src).toMatch(/import \{ splitFunnel \} from '\.\/pipelineFunnel'/);
    expect(src).toMatch(/const seg = splitFunnel\(t\);/);
    expect(src, '还留着自己那份原始比较').not.toMatch(/t\.accepted >= t\.changes/);
  });
});

describe('splitFunnel 只有一份，住在 lib', () => {
  it('图、明细行、判断句拿到的是同一个函数', () => {
    expect(fromStrip).toBe(splitFunnel);
    const f = { changes: 7, deployed: 9, accepted: 11 } as never;
    expect(rowSplit(f)).toEqual(splitFunnel(f));
  });

  it('lib 不许反过来 import pages', () => {
    const lib = read('web/src/lib/pipelineFunnel.ts');
    expect(lib).not.toMatch(/from '@?\/?\.*pages\//);
    expect(read('web/src/pages/reports/CompactStrip.tsx'))
      .toMatch(/export \{ splitFunnel \} from '@\/lib\/pipelineFunnel'/);
  });
});
