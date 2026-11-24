import { describe, expect, it } from 'vitest';
import { readPsd, writePsd } from 'ag-psd';
import { buildLayeredPsdDocument, compositePixelLayers, resolveReadableImageUrl } from '@/lib/layeredPsd';

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

  it('【关键】PSD 层序与合成顺序一致：写在最后的那层既压住下面、又排在 children 末尾', () => {
    // 这条把「层序」和「谁压住谁」绑在一起，防止有人按「ag-psd children 是 top-to-bottom」
    // 去反转 semanticLayers（2026-08-12 有 review 这样建议过，核查后不成立：
    // ag-psd 的 children 与 PSD 层记录段同序，而层记录段按 bottom-first 存储，
    // writer/reader 全程无 reverse）。反转之后 Photoshop 里的层序会和嵌入的
    // 合成预览正好相反——而这两者本来必须是同一件事。
    //
    // 不写成「children 等于某个字面数组」是有意的：那种断言只钉住写法，
    // 钉不住语义。这里断言的是「合成图呈现哪一层的颜色，哪一层就该排在末尾」。
    const bottom = pixels(255, 0, 0);   // 不透明红
    const top = pixels(0, 0, 255);      // 不透明蓝，完全盖住红
    const document = buildLayeredPsdDocument({
      source: pixels(0, 0, 0),
      layers: [
        { name: '下层', image: bottom },
        { name: '上层', image: top },
      ],
    });

    // 合成图取到的是「上层」的蓝——证明 input.layers 是自下而上。
    expect(Array.from(document.imageData?.data ?? [])).toEqual([0, 0, 255, 255]);

    const parsed = readPsd(writePsd(document, { noBackground: true }), {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    });
    const names = parsed.children?.[0]?.children?.map((layer) => layer.name) ?? [];
    // 盖住别人的那一层必须排在末尾（bottom-first），与合成结果同一个方向。
    expect(names[names.length - 1]).toBe('上层');
    expect(names[0]).toBe('下层');
  });

  it('keeps a hidden layer in the PSD but out of the flattened preview', () => {
    // 图层面板关掉眼睛 = 不参与合成；但图层本身仍要写进 PSD，
    // 否则用户在 Photoshop 里想把它打开时会发现层根本不在。
    const document = buildLayeredPsdDocument({
      source: pixels(12, 34, 56),
      layers: [
        { name: '背景', image: pixels(0, 0, 255) },
        { name: '被隐藏的主体', image: pixels(255, 0, 0), hidden: true },
      ],
    });

    expect(document.children?.[0]?.children?.map((layer) => layer.name))
      .toEqual(['背景', '被隐藏的主体']);
    expect(document.children?.[0]?.children?.[1]?.hidden).toBe(true);
    // 合成里只剩背景的蓝色，没有被隐藏那层的红色。
    expect(Array.from(document.imageData?.data ?? [])).toEqual([0, 0, 255, 255]);
  });

  it('bakes layer opacity into the flattened preview and records it on the layer', () => {
    // 面板把主体调到 50%：合成必须真的半透，PSD 图层也要带上 opacity，
    // 不然「预览是半透、导出是全不透」。
    const document = buildLayeredPsdDocument({
      source: pixels(12, 34, 56),
      layers: [
        { name: '背景', image: pixels(0, 0, 255) },
        { name: '主体', image: pixels(255, 0, 0), opacity: 0.5 },
      ],
    });

    expect(document.children?.[0]?.children?.[1]?.opacity).toBe(0.5);
    const composite = Array.from(document.imageData?.data ?? []);
    expect(composite[0]).toBeGreaterThan(100);
    expect(composite[0]).toBeLessThan(160);
    expect(composite[2]).toBeGreaterThan(100);
    expect(composite[3]).toBe(255);
  });
});

describe('导出读图地址（治「PSD 导出失败 Failed to fetch」）', () => {
  const sha = 'a'.repeat(64);

  it('有 sha 就走同源资产地址，绕开对象存储的 CORS', () => {
    // 直接 fetch 跨域 COS 链接时浏览器抛的是没有任何上下文的 Failed to fetch，
    // 用户完全无法自测。本站 assets/file/{sha} 同源，资产落库后一定能读。
    expect(resolveReadableImageUrl(`https://cos.example.com/${sha}.png`, sha))
      .toBe(`/api/visual-agent/image-master/assets/file/${sha}`);
  });

  it('没传 sha 时也能从跨域地址里认出 sha 文件名', () => {
    expect(resolveReadableImageUrl(`https://cos.example.com/visual/${sha}.png?sign=abc`))
      .toBe(`/api/visual-agent/image-master/assets/file/${sha}`);
  });

  it('本站相对地址、data / blob 一律原样用', () => {
    expect(resolveReadableImageUrl('/api/visual-agent/image-master/assets/file/x')).toBe('/api/visual-agent/image-master/assets/file/x');
    expect(resolveReadableImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(resolveReadableImageUrl('blob:http://localhost/abc')).toBe('blob:http://localhost/abc');
  });

  it('认不出 sha 的跨域地址原样交给 fetch，不瞎猜', () => {
    const foreign = 'https://cdn.example.com/some/photo.png';
    expect(resolveReadableImageUrl(foreign)).toBe(foreign);
  });

  it('sha 格式不对就不当 sha 用', () => {
    const foreign = 'https://cdn.example.com/photo.png';
    expect(resolveReadableImageUrl(foreign, 'not-a-sha')).toBe(foreign);
    expect(resolveReadableImageUrl(foreign, '')).toBe(foreign);
  });

  it('【关键】每层只写「有内容的最小矩形」，不是满幅', () => {
    // 用户心智：拆完是一个个独立部件，在 Photoshop 里想把 logo 挪一点就直接拖那一块。
    // 满幅写法会让每层的变换框都套着整张画布，还得自己先找边界。
    const canvas = { width: 20, height: 10 };
    const withRect = (r: { x: number; y: number; w: number; h: number }) => {
      const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
      for (let y = r.y; y < r.y + r.h; y += 1) {
        for (let x = r.x; x < r.x + r.w; x += 1) {
          const o = (y * canvas.width + x) * 4;
          data[o] = 180; data[o + 1] = 90; data[o + 2] = 40; data[o + 3] = 255;
        }
      }
      return { ...canvas, data };
    };

    const document = buildLayeredPsdDocument({
      source: { ...canvas, data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255) },
      layers: [
        { name: '图层 01', image: withRect({ x: 2, y: 1, w: 5, h: 3 }) },
        { name: '图层 02', image: withRect({ x: 12, y: 6, w: 4, h: 2 }) },
      ],
    });

    const group = document.children!.find((c) => c.name === 'AI 可编辑图层')!;
    const [first, second] = group.children!;
    expect({ left: first.left, top: first.top, right: first.right, bottom: first.bottom })
      .toEqual({ left: 2, top: 1, right: 7, bottom: 4 });
    expect({ left: second.left, top: second.top, right: second.right, bottom: second.bottom })
      .toEqual({ left: 12, top: 6, right: 16, bottom: 8 });
    // 画布尺寸不变——各块拼回去仍是原来那张图
    expect(document.width).toBe(canvas.width);
    expect(document.height).toBe(canvas.height);
  });

  it('整层全透明时给零面积占位，不占满画布', () => {
    const canvas = { width: 8, height: 8 };
    const document = buildLayeredPsdDocument({
      source: { ...canvas, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) },
      layers: [{ name: '空层', image: { ...canvas, data: new Uint8ClampedArray(8 * 8 * 4) } }],
    });
    const layer = document.children!.find((c) => c.name === 'AI 可编辑图层')!.children![0]!;
    expect(layer.right! - layer.left!).toBe(0);
    expect(layer.bottom! - layer.top!).toBe(0);
  });
});
