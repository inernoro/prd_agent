import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { reloadReferenceImageScenario } from './referenceImageModelCatalog';

const source = readFileSync(
  new URL('./ArticleIllustrationEditorPage.tsx', import.meta.url),
  'utf8',
);

describe('文学配图场景模型目录刷新', () => {
  it('执行场景刷新时等待配置目录和模型目录都完成', async () => {
    const loadReferenceImageConfigs = vi.fn(async () => undefined);
    const reloadImageGenPools = vi.fn(async () => undefined);

    await reloadReferenceImageScenario(loadReferenceImageConfigs, reloadImageGenPools);

    expect(loadReferenceImageConfigs).toHaveBeenCalledOnce();
    expect(reloadImageGenPools).toHaveBeenCalledOnce();
  });

  it('风格图场景变化后同时刷新配置和当前场景模型池', () => {
    expect(source).toContain('const reloadImageGenPools = useCallback(async () => {');
    expect(source).toContain('const res = await getLiteraryAgentModels();');
    expect(source.match(/reloadReferenceImageScenario\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
