import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(new URL('./SiteEditPanel.tsx', import.meta.url), 'utf8');

/**
 * 模型徽章的清空原先排在 createHostedSiteEditRun 之后：新任务创建期间顶上挂的是上一轮
 * 的模型，创建失败时那个模型更会被留在一次根本没发生的调用上——「读不到模型」长得跟
 * 「这次用的就是它」一模一样（Codex P2，2026-09-15）。
 *
 * 判据就一句：进入 generating 的那一拍必须已经清掉，且清空只能有这一处。
 */
describe('改写面板的模型徽章', () => {
  it('在进入 generating 的同一拍清空，且排在创建任务之前', () => {
    const source = panel;
    const generatingAt = source.indexOf('setGenerating(true);');
    expect(generatingAt).toBeGreaterThan(-1);
    const createAt = source.indexOf('await createHostedSiteEditRun(', generatingAt);
    expect(createAt, 'createHostedSiteEditRun 不见了，契约可能被挪走了').toBeGreaterThan(generatingAt);

    const resetAt = source.indexOf('setResolvedModel(null);');
    expect(resetAt, '徽章从来没被清空过').toBeGreaterThan(-1);
    expect(resetAt, '清空排在了创建任务之后：创建期间顶上挂的是上一轮的模型')
      .toBeLessThan(createAt);
    expect(resetAt).toBeGreaterThan(generatingAt - 400);

    // 只许有这一处清空——两处各写各的就是下一次只改好其中一个的起点。
    const resets = source.split('setResolvedModel(null);').length - 1;
    expect(resets).toBe(1);
  });
});
