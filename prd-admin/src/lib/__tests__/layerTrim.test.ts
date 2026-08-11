import { describe, expect, it } from 'vitest';

import {
  boundsToCanvasRect,
  computeAlphaBounds,
  computeInkBounds,
  cropRgba,
  TRIM_INK_ALPHA_THRESHOLD,
} from '@/lib/layerTrim';
import { ANALYSIS_SAMPLE_SIZE } from '@/lib/layerContentAnalysis';
import { decodeFixture, REAL_LAYER_FIXTURE_BASE64 } from './fixtures/realLayerPixels';

const N = ANALYSIS_SAMPLE_SIZE;

/** 在 w×h 的透明画布上画一个实心矩形。 */
function withRect(w: number, h: number, r: { x: number; y: number; w: number; h: number }): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const o = (y * w + x) * 4;
      data[o] = 200; data[o + 1] = 100; data[o + 2] = 50; data[o + 3] = 255;
    }
  }
  return data;
}

describe('透明裁剪：求包围盒', () => {
  it('只框住有内容的那块，不多也不少', () => {
    const data = withRect(20, 10, { x: 4, y: 2, w: 6, h: 3 });
    expect(computeAlphaBounds(data, 20, 10)).toEqual({
      left: 4, top: 2, right: 10, bottom: 5, width: 6, height: 3,
    });
  });

  it('内容贴边时包围盒等于整幅', () => {
    const data = withRect(8, 6, { x: 0, y: 0, w: 8, h: 6 });
    expect(computeAlphaBounds(data, 8, 6)).toMatchObject({ left: 0, top: 0, width: 8, height: 6 });
  });

  it('【关键】整幅全透明返回 null，绝不回退成整幅', () => {
    // 回退成整幅会让一个空层在 PSD 里占满画布，也会在画布上给出一个整幅大的选中框。
    expect(computeAlphaBounds(new Uint8ClampedArray(8 * 6 * 4), 8, 6)).toBeNull();
  });

  it('低于阈值的羽化像素不算内容', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    data[3] = 5; // alpha 5，低于阈值 8
    expect(computeAlphaBounds(data, 4, 4)).toBeNull();
    data[3] = 200;
    expect(computeAlphaBounds(data, 4, 4)).toMatchObject({ width: 1, height: 1 });
  });

  it('尺寸与数据对不上时不猜', () => {
    expect(computeAlphaBounds(new Uint8ClampedArray(10), 20, 10)).toBeNull();
    expect(computeAlphaBounds(new Uint8ClampedArray(400), 0, 10)).toBeNull();
  });
});

describe('透明裁剪：裁子图', () => {
  it('裁出来的像素与包围盒一致，内容位置对得上', () => {
    const data = withRect(20, 10, { x: 4, y: 2, w: 6, h: 3 });
    const bounds = computeAlphaBounds(data, 20, 10)!;
    const cropped = cropRgba(data, 20, 10, bounds)!;
    expect(cropped.width).toBe(6);
    expect(cropped.height).toBe(3);
    // 裁完应当处处不透明（原来的实心矩形正好被框住）
    let opaque = 0;
    for (let o = 3; o < cropped.data.length; o += 4) if (cropped.data[o]! > 8) opaque += 1;
    expect(opaque).toBe(6 * 3);
  });

  it('越界的包围盒不裁，返回 null', () => {
    const data = withRect(8, 8, { x: 0, y: 0, w: 2, h: 2 });
    expect(cropRgba(data, 8, 8, { left: 6, top: 6, right: 12, bottom: 12, width: 6, height: 6 })).toBeNull();
  });
});

describe('包围盒换算到画布坐标', () => {
  it('图层与原图分辨率不同也能对齐', () => {
    // 实测：原图 1024、模型返回的图层 640。不按比例换算，各块拼回去会整体偏移。
    const rect = boundsToCanvasRect({
      bounds: { left: 64, top: 32, right: 320, bottom: 160, width: 256, height: 128 },
      layerWidth: 640,
      layerHeight: 640,
      canvasX: 100,
      canvasY: 200,
      canvasW: 1024,
      canvasH: 1024,
    });
    expect(rect).toEqual({
      x: 100 + 64 * (1024 / 640),
      y: 200 + 32 * (1024 / 640),
      w: 256 * (1024 / 640),
      h: 128 * (1024 / 640),
    });
  });

  it('同分辨率时就是平移', () => {
    const rect = boundsToCanvasRect({
      bounds: { left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 },
      layerWidth: 100, layerHeight: 100, canvasX: 5, canvasY: 7, canvasW: 100, canvasH: 100,
    });
    expect(rect).toEqual({ x: 15, y: 27, w: 30, h: 40 });
  });
});

describe('真实产物上的裁剪效果', () => {
  // fixture 是 48×48 的采样图，比例与真实图层一致，用来验证「裁剪确实能省下大片空白」。
  const layers = {
    背景层: decodeFixture(REAL_LAYER_FIXTURE_BASE64.layer0),
    主体层: decodeFixture(REAL_LAYER_FIXTURE_BASE64.layer1),
    器件层: decodeFixture(REAL_LAYER_FIXTURE_BASE64.layer2),
    点缀层: decodeFixture(REAL_LAYER_FIXTURE_BASE64.layer3),
  };

  it('满覆盖的背景层裁不动（本来就占满）', () => {
    const bounds = computeAlphaBounds(layers.背景层, N, N)!;
    expect(bounds.width).toBe(N);
    expect(bounds.height).toBe(N);
  });

  it('【关键】有透明边的图层裁完面积显著变小', () => {
    for (const name of ['主体层', '器件层', '点缀层'] as const) {
      const bounds = computeAlphaBounds(layers[name], N, N)!;
      const area = bounds.width * bounds.height;
      expect(area, `${name} 应当被裁小`).toBeLessThan(N * N);
    }
    // 最稀疏那层省得最多
    const sparse = computeAlphaBounds(layers.点缀层, N, N)!;
    expect(sparse.width * sparse.height).toBeLessThan(N * N * 0.85);
  });
});

describe('实墨包围盒：几粒看不见的雾不该撑大框', () => {
  /** 在 w×h 画布上：一块实墨 + 四角各一粒极淡的雾。 */
  function inkWithHaze(w: number, h: number, ink: { x: number; y: number; w: number; h: number }) {
    const data = new Uint8ClampedArray(w * h * 4);
    const put = (x: number, y: number, a: number) => {
      const o = (y * w + x) * 4;
      data[o] = 200; data[o + 1] = 200; data[o + 2] = 200; data[o + 3] = a;
    };
    for (let y = ink.y; y < ink.y + ink.h; y += 1) {
      for (let x = ink.x; x < ink.x + ink.w; x += 1) put(x, y, 255);
    }
    // 四角的雾：alpha 20，肉眼几乎看不见，但高于「有东西」的阈值 8
    put(0, 0, 20); put(w - 1, 0, 20); put(0, h - 1, 20); put(w - 1, h - 1, 20);
    return data;
  }

  it('【关键】按实墨求框只框住墨，按老阈值求框会被雾撑到整幅', () => {
    // 这正是用户圈出来的现象：文字层的选中框比字大一大圈。
    const data = inkWithHaze(40, 40, { x: 12, y: 14, w: 10, h: 6 });
    const loose = computeAlphaBounds(data, 40, 40)!;
    expect(loose).toMatchObject({ left: 0, top: 0, width: 40, height: 40 });

    const ink = computeInkBounds(data, 40, 40)!;
    expect(ink).toMatchObject({ left: 12, top: 14, width: 10, height: 6 });
  });

  it('整层都很淡时回落到宽松阈值，不会判成空层丢掉', () => {
    const data = new Uint8ClampedArray(20 * 20 * 4);
    for (let y = 5; y < 9; y += 1) {
      for (let x = 5; x < 9; x += 1) {
        const o = (y * 20 + x) * 4;
        data[o + 3] = 30; // 低于实墨阈值，但确实有内容
      }
    }
    expect(computeAlphaBounds(data, 20, 20, TRIM_INK_ALPHA_THRESHOLD)).toBeNull();
    expect(computeInkBounds(data, 20, 20)).toMatchObject({ left: 5, top: 5, width: 4, height: 4 });
  });

  it('整幅真的全透明时仍然返回 null', () => {
    expect(computeInkBounds(new Uint8ClampedArray(8 * 8 * 4), 8, 8)).toBeNull();
  });
});
