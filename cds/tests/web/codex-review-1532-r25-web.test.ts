/**
 * Codex review（PR #1532）第二十五轮的 P2：覆盖率干净被当成了结论干净。
 *
 * 三类漏（合了没验 / 验不过还合 / 部署了没验）都为零、而且每条改动都有报告时，
 * 头条会落到最后那两句 ok 上，绿着说「N 条改动都验过了」——可「已验完」那一段里
 * 完全可能有未通过，同屏的总览条正把那几条画成红的。同一屏一个说好一个说坏，
 * 而读者第一眼看的就是头条。
 *
 * 判据：t.fail > 0 时头条不许是 ok 调，而且句子里要带上未通过的份数。
 */
import { describe, it, expect } from 'vitest';
import { buildPipelineHeadline } from '../../web/src/lib/pipelineHeadline.js';
import type { PipelineOverview } from '../../web/src/lib/api';

function overview(total: Partial<PipelineOverview['total']>): PipelineOverview {
  return {
    total: {
      changes: 0, deployed: 0, accepted: 0, merged: 0,
      pass: 0, conditional: 0, fail: 0, undetermined: 0,
      ...total,
    },
    totalLeaks: {
      'merged-not-accepted': 0, 'merged-while-failing': 0, 'deployed-not-accepted': 0,
      'report-without-change': 0,
    },
    leaks: [],
    projects: [],
    staleReports: 0,
    orphanReports: 0,
  } as unknown as PipelineOverview;
}

describe('头条不许把「验完了但没通过」说成健康', () => {
  it('全部验完、有未通过、没合并——调子是 bad，句子带未通过份数', () => {
    const h = buildPipelineHeadline(overview({
      changes: 4, deployed: 4, accepted: 4, merged: 0,
      pass: 2, conditional: 1, fail: 1,
    }));

    expect(h.tone).toBe('bad');
    expect(h.sentence).toContain('1');
    expect(h.sentence).toContain('没通过');
    // 反面钉死：不许再出现那句无条件的「都验过了」作为结尾。
    expect(h.sentence.endsWith('都验过了')).toBe(false);
  });

  it('全部验完且一条都没挂——才允许是 ok', () => {
    const h = buildPipelineHeadline(overview({
      changes: 3, deployed: 3, accepted: 3, merged: 0, pass: 3,
    }));

    expect(h.tone).toBe('ok');
    expect(h.sentence).toBe('3 条改动都验过了');
  });

  it('还有没部署的那条兜底句同样不许盖住未通过', () => {
    const h = buildPipelineHeadline(overview({
      changes: 5, deployed: 2, accepted: 2, merged: 0, pass: 1, fail: 1,
    }));

    expect(h.tone).toBe('bad');
    expect(h.sentence).toContain('没通过');
  });

  it('原则性通过不触发 bad：它不是「没通过」', () => {
    const h = buildPipelineHeadline(overview({
      changes: 2, deployed: 2, accepted: 2, merged: 0, pass: 1, conditional: 1,
    }));

    expect(h.tone).toBe('ok');
  });
});
