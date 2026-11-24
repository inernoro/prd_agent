import { describe, expect, it } from 'vitest';
import { visualModelSizeSummary, type VisualModelCatalogEntry } from './visualModelPolicy';

describe('visualModelSizeSummary', () => {
  it('只根据网关目录返回的尺寸去重展示', () => {
    const entry: VisualModelCatalogEntry = {
      model: { code: 'dynamic-model', name: '动态模型', capabilities: ['image_generation'] },
      imageCapabilities: {
        supportsImageToImage: true,
        sizesByResolution: {
          small: [{ size: '1024x1024', aspectRatio: '1:1' }],
          large: [
            { size: '1024x1024', aspectRatio: '1:1' },
            { size: '1536x1024', aspectRatio: '3:2' },
          ],
        },
      },
    };

    expect(visualModelSizeSummary(entry)).toBe('1024x1024 / 1536x1024');
  });

  it('网关没有发布尺寸时不编造默认值', () => {
    expect(visualModelSizeSummary({
      model: { code: 'unknown', name: '未知模型', capabilities: [] },
      imageCapabilities: null,
    })).toBe('');
  });
});
