import { describe, expect, it } from 'vitest';
import { readPsd, writePsd } from 'ag-psd';
import { buildLayeredPsdDocument, compositePixelLayers } from '@/lib/layeredPsd';

function pixels(r: number, g: number, b: number, a = 255) {
  return { width: 1, height: 1, data: new Uint8ClampedArray([r, g, b, a]) };
}

describe('layered PSD export', () => {
  it('builds the flattened preview from visible RGBA layers', () => {
    const composite = compositePixelLayers([
      pixels(0, 0, 255),
      pixels(255, 0, 0, 128),
    ], 1, 1);

    expect(Array.from(composite.data)).toEqual([128, 0, 127, 255]);
  });

  it('writes a PSD with visible editable layers and a hidden source reference', () => {
    const document = buildLayeredPsdDocument({
      source: pixels(12, 34, 56),
      layers: [
        { name: '背景', image: pixels(0, 0, 255) },
        { name: '主体', image: pixels(255, 0, 0, 128) },
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
    expect(parsed.children?.[0]?.name).toBe('AI 可编辑图层');
    expect(parsed.children?.[0]?.hidden).not.toBe(true);
    expect(parsed.children?.[0]?.children?.map((layer) => layer.name)).toEqual(['背景', '主体']);
    expect(parsed.children?.[1]?.name).toContain('原图参考');
    expect(parsed.children?.[1]?.hidden).toBe(true);
    expect(Array.from(document.imageData?.data ?? [])).toEqual([128, 0, 127, 255]);
  });
});
