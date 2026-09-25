import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 生成的任务逻辑随工作台搬进了 useSiteGenerationRun；判据跟着逻辑走。
const dialog = readFileSync(new URL('./workbench/useSiteGenerationRun.ts', import.meta.url), 'utf8');

/**
 * 与改写面板同一处判据的另一半（Codex P2，2026-09-15）。上一轮修了 SiteEditPanel，
 * 生成弹窗原样留着，于是同一个形状立刻被报了第二次：徽章的清空排在创建请求之后，
 * 不关弹窗直接发起第二次生成时，创建期间顶上挂的是上一轮的模型；创建失败时它更会被
 * 留在一次根本没发生的调用上——「读不到模型」长得跟「这次用的就是它」一模一样。
 */
describe('生成弹窗的模型徽章', () => {
  it('在进入 generating 的同一拍清空，且排在创建任务之前', () => {
    const generatingAt = dialog.lastIndexOf('setGenerating(true);');
    expect(generatingAt).toBeGreaterThan(-1);
    const createAt = dialog.indexOf('await createDesignArtifactRun(', generatingAt);
    expect(createAt, 'createDesignArtifactRun 不见了，契约可能被挪走了').toBeGreaterThan(generatingAt);

    const resetAt = dialog.indexOf('setResolvedModel(null);', generatingAt);
    expect(resetAt, '发起生成那一段从来没清空过徽章').toBeGreaterThan(-1);
    expect(resetAt, '清空排在了创建任务之后：创建期间顶上挂的是上一轮的模型')
      .toBeLessThan(createAt);
  });

  it('打开弹窗那一段也仍然清空（两处语义不同，都要在）', () => {
    const openReset = dialog.indexOf('setResolvedModel(null);');
    expect(openReset).toBeGreaterThan(-1);
    expect(openReset, '打开弹窗的重置被删了，重开会显示上一次的模型')
      .toBeLessThan(dialog.lastIndexOf('setGenerating(true);'));
  });
});
