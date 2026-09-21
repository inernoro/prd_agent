import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('./ArticleIllustrationEditorPage.tsx', import.meta.url),
  'utf8',
);

describe('文学配图场景模型目录刷新', () => {
  it('风格图场景变化后同时刷新配置和当前场景模型池', () => {
    expect(source).toContain('const reloadImageGenPools = useCallback(async () => {');
    expect(source).toContain('const res = await getLiteraryAgentModels();');
    expect(source.match(/reloadImageGenPools\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('config.isActive ? reloadImageGenPools() : Promise.resolve()');
  });
});
