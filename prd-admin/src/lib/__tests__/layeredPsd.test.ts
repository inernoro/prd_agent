import { describe, expect, it } from 'vitest';
import { readPsd, writePsd } from 'ag-psd';
import { buildLayeredPsdDocument, findLayeredImageModel } from '@/lib/layeredPsd';

function pixels(r: number, g: number, b: number, a = 255) {
  return { width: 1, height: 1, data: new Uint8ClampedArray([r, g, b, a]) };
}

describe('layered PSD export', () => {
  it('finds only an enabled Qwen layered model with a concrete platform', () => {
    expect(findLayeredImageModel([
      { actualModelId: 'gpt-image-2', platformId: 'openai', enabled: true },
      { actualModelId: 'fal-qwen-image-layered', platformId: 'exchange-1', enabled: true },
    ])).toEqual({ modelId: 'fal-qwen-image-layered', platformId: 'exchange-1' });

    expect(findLayeredImageModel([
      { actualModelId: 'fal-qwen-image-layered', platformId: 'exchange-1', enabled: false },
    ])).toBeNull();
  });

  it('writes a PSD with an exact source baseline and hidden editable layers', () => {
    const document = buildLayeredPsdDocument({
      source: pixels(12, 34, 56),
      layers: [
        { name: '主体', image: pixels(255, 0, 0, 128) },
        { name: '背景', image: pixels(0, 0, 255) },
      ],
    });
    const buffer = writePsd(document, { noBackground: true });
    const parsed = readPsd(buffer, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    });

    expect(parsed.width).toBe(1);
    expect(parsed.height).toBe(1);
    expect(new TextDecoder().decode(buffer.slice(0, 4))).toBe('8BPS');
    expect(parsed.children?.[0]?.name).toContain('原图基准');
    expect(parsed.children?.[1]?.hidden).toBe(true);
    expect(parsed.children?.[1]?.children?.map((layer) => layer.name)).toEqual(['主体', '背景']);
    expect(Array.from(document.imageData?.data ?? [])).toEqual([12, 34, 56, 255]);
  });
});
