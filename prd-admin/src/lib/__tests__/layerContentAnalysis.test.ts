import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_SAMPLE_SIZE,
  buildLayerContentVerdicts,
  classifyLayerContent,
  computeAlphaCoverage,
  computeContentStats,
  computeMeanAbsDifference,
  describeLayerContent,
  formatCoverage,
  isHiddenByDefault,
  computeInkCoverage,
  EMPTY_INK_COVERAGE_MAX,
} from '@/lib/layerContentAnalysis';
import {
  aiLayerDisplayName,
  aiLayerExportName,
  aiLayerSubtitle,
  clampLayerCount,
  LAYER_COUNT_DEFAULT,
  LAYER_COUNT_MAX,
  LAYER_COUNT_MIN,
} from '@/lib/aiLayerNaming';
import { layerRowSecondaryText } from '@/pages/ai-chat/components/SemanticLayerPanel';
import { decodeFixture, REAL_LAYER_FIXTURE_BASE64 } from './fixtures/realLayerPixels';

const PIXELS = ANALYSIS_SAMPLE_SIZE * ANALYSIS_SAMPLE_SIZE;

/** 造一张 RGBA：前 opaqueCount 个像素不透明，其余全透明。 */
function rgba(opaqueCount: number, rgbValue = 128): Uint8ClampedArray {
  const data = new Uint8ClampedArray(PIXELS * 4);
  for (let i = 0; i < opaqueCount && i < PIXELS; i += 1) {
    const o = i * 4;
    data[o] = rgbValue;
    data[o + 1] = rgbValue;
    data[o + 2] = rgbValue;
    data[o + 3] = 255;
  }
  return data;
}

/** 造一张有花纹的 RGBA：颜色随位置变化，模拟真实内容层。 */
function texturedRgba(opaqueCount: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(PIXELS * 4);
  for (let i = 0; i < opaqueCount && i < PIXELS; i += 1) {
    const o = i * 4;
    data[o] = (i * 37) % 256;
    data[o + 1] = (i * 91) % 256;
    data[o + 2] = (i * 53) % 256;
    data[o + 3] = 255;
  }
  return data;
}

const REAL = {
  source: decodeFixture(REAL_LAYER_FIXTURE_BASE64.source),
  layer0: decodeFixture(REAL_LAYER_FIXTURE_BASE64.layer0),
  layer1: decodeFixture(REAL_LAYER_FIXTURE_BASE64.layer1),
  layer2: decodeFixture(REAL_LAYER_FIXTURE_BASE64.layer2),
  layer3: decodeFixture(REAL_LAYER_FIXTURE_BASE64.layer3),
};

function classifyReal(layer: Uint8ClampedArray) {
  const stats = computeContentStats(layer);
  return classifyLayerContent({
    coverage: stats.coverage,
    stdev: stats.stdev,
    colorBuckets: stats.colorBuckets,
    sourceDifference: computeMeanAbsDifference(layer, REAL.source),
  });
}

describe('图层命名与源提示词解耦', () => {
  it('主标题只由序号决定，源提示词再长也不影响分辨', () => {
    // 原缺陷：名字是「源提示词 · AI 图层 01」，60 字截断把序号后缀切掉，
    // 四层在面板里退化成同一串文字。
    const monster = '参考两张图片的构图与配色，生成一张深色科技风的产品展示海报'.repeat(8);
    const names = [0, 1, 2, 3].map((i) => aiLayerDisplayName(i));
    expect(names).toEqual(['图层 01', '图层 02', '图层 03', '图层 04']);
    expect(new Set(names).size).toBe(4);
    expect(aiLayerSubtitle(monster).length).toBeLessThanOrEqual(25);
    expect(new Set([0, 1, 2, 3].map((i) => aiLayerExportName(i, aiLayerSubtitle(monster)))).size).toBe(4);
  });

  it('导出名去掉路径与保留字符', () => {
    expect(aiLayerExportName(0, 'a/b:c*d?e"f<g>h|i')).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('副标题为空时导出名只剩序号，不留下悬空的分隔符', () => {
    expect(aiLayerExportName(2)).toBe('图层 03');
    expect(aiLayerExportName(2, '   ')).toBe('图层 03');
  });

  it('层数夹在 2-8，脏值回落默认', () => {
    expect(clampLayerCount(1)).toBe(LAYER_COUNT_MIN);
    expect(clampLayerCount(99)).toBe(LAYER_COUNT_MAX);
    expect(clampLayerCount('abc')).toBe(LAYER_COUNT_DEFAULT);
    expect(clampLayerCount(undefined)).toBe(LAYER_COUNT_DEFAULT);
    expect(clampLayerCount(6)).toBe(6);
  });

  it('【关键】没存过偏好时默认 4 层，不能掉到下限 2', () => {
    // 真机实测（2026-08-10）：面板显示「下次拆 2 层」，看着像用户自己选的，其实是缺省被夹坏了。
    // 调用方传的就是 localStorage.getItem(...)，没存过是 null，而 Number(null) === 0（不是 NaN），
    // 于是被夹成下限 2。旧用例只测 undefined，照不出这条。
    expect(clampLayerCount(null)).toBe(LAYER_COUNT_DEFAULT);
    expect(clampLayerCount('')).toBe(LAYER_COUNT_DEFAULT);
    expect(clampLayerCount('   ')).toBe(LAYER_COUNT_DEFAULT);
    expect(LAYER_COUNT_DEFAULT).not.toBe(LAYER_COUNT_MIN);
  });
});

describe('分层产物内容判定（构造样本）', () => {
  it('几乎全透明的层判为空层并默认隐藏', () => {
    const coverage = computeAlphaCoverage(rgba(1));
    expect(classifyLayerContent({ coverage, sourceDifference: null })).toBe('empty');
    expect(isHiddenByDefault('empty')).toBe(true);
  });

  it('稀疏但有花纹的线稿层不能被当成空层，也不能被当成纯色', () => {
    const data = texturedRgba(Math.round(PIXELS * 0.005));
    const stats = computeContentStats(data);
    expect(stats.coverage).toBeGreaterThan(0.004);
    expect(classifyLayerContent({ ...stats, sourceDifference: null })).toBe('layer');
  });

  it('与原图几乎一致的满覆盖层判为整图参考层', () => {
    const source = rgba(PIXELS, 120);
    const flatten = rgba(PIXELS, 121);
    const stats = computeContentStats(flatten);
    const diff = computeMeanAbsDifference(flatten, source);
    expect(classifyLayerContent({ ...stats, sourceDifference: diff })).toBe('source-reference');
    expect(isHiddenByDefault('source-reference')).toBe(true);
  });

  it('拿不到原图时不猜整图，宁可当普通层', () => {
    const data = texturedRgba(PIXELS);
    const stats = computeContentStats(data);
    expect(classifyLayerContent({ ...stats, sourceDifference: null })).toBe('layer');
  });

  it('纯色块只标注、绝不默认隐藏——它可能就是背景层', () => {
    // 这是本次最关键的一条：把「近乎纯色」当成废层自动关掉，会把整块底色掀掉。
    expect(isHiddenByDefault('flat')).toBe(false);
    expect(describeLayerContent('flat')).toContain('纯色');
  });

  it('覆盖率两头都不退化：极小值不是 0%，中间段不取整撞车', () => {
    expect(formatCoverage(0.0004)).toBe('不足 0.1%');
    expect(formatCoverage(0.0723)).toBe('7.2%');
    expect(formatCoverage(1)).toBe('100%');
    expect(formatCoverage(0)).toBe('0%');
    // 冒烟实测撞过：两层 13.8% / 14.2% 取整后都显示「14%」，事实行就白占一行。
    expect(formatCoverage(0.138)).not.toBe(formatCoverage(0.142));
  });
});

describe('分层产物内容判定（真实产物像素）', () => {
  // fixture 来自 2026-08-10 预览环境真跑的一次分层（run 751ad868…，请求 4 层、返回 4 层）。
  // 上一版判据在构造样本上全绿、碰真实产物 0 命中，所以这一组用真像素兜底。

  it('真实背景层是「近乎纯色」，而不是空层、也不是整图', () => {
    const stats = computeContentStats(REAL.layer0);
    expect(stats.coverage).toBeGreaterThan(0.98);
    expect(stats.stdev).toBeLessThan(10);
    expect(classifyReal(REAL.layer0)).toBe('flat');
    // 满覆盖 + 与原图差异显著 → 绝不能被当成整张原图而默认隐藏。
    expect(computeMeanAbsDifference(REAL.layer0, REAL.source)).toBeGreaterThan(10);
    expect(isHiddenByDefault(classifyReal(REAL.layer0))).toBe(false);
  });

  it('三个真实内容层都判为普通图层（含只有 7% 覆盖的细碎层）', () => {
    expect(classifyReal(REAL.layer1)).toBe('layer');
    expect(classifyReal(REAL.layer2)).toBe('layer');
    expect(classifyReal(REAL.layer3)).toBe('layer');
    expect(computeContentStats(REAL.layer3).coverage).toBeLessThan(0.1);
  });

  it('原图自己跟自己比会判成整图参考层（探测器在真实图上确实会触发）', () => {
    const stats = computeContentStats(REAL.source);
    expect(classifyLayerContent({
      ...stats,
      sourceDifference: computeMeanAbsDifference(REAL.source, REAL.source),
    })).toBe('source-reference');
  });

  it('四个真实图层的第二行文案互不相同——这一行的职责就是把它们区分开', () => {
    // 用户实测缺陷：三行副标题全是同一个文件名，等于白占一行。
    const rows = [REAL.layer0, REAL.layer1, REAL.layer2, REAL.layer3].map((data, index) => {
      const stats = computeContentStats(data);
      return layerRowSecondaryText({
        key: `k${index}`,
        name: aiLayerDisplayName(index),
        subtitle: describeLayerContent(classifyReal(data), stats.coverage),
        src: 'x',
        compositeSrc: 'x',
        opacity: 1,
      });
    });
    expect(new Set(rows).size).toBe(4);
    expect(rows[0]).toContain('纯色');
    expect(rows.every((row) => row.includes('覆盖'))).toBe(true);
  });
});

describe('采样 → 判定 → 回写这条链本身', () => {
  const sources: Record<string, Uint8ClampedArray> = {
    'src://source': REAL.source,
    'src://l0': REAL.layer0,
    'src://l1': REAL.layer1,
  };
  const sampler = async (src: string) => sources[src] ?? null;

  it('每一层都产出补丁（普通层也要，面板每行都要显示覆盖率）', async () => {
    const verdicts = await buildLayerContentVerdicts({
      layers: [{ key: 'a', src: 'src://l0' }, { key: 'b', src: 'src://l1' }],
      source: { src: 'src://source' },
      sampler,
    });
    expect(verdicts.map((v) => v.key)).toEqual(['a', 'b']);
    expect(verdicts[0]!.kind).toBe('flat');
    expect(verdicts[0]!.hidden).toBe(false);
    expect(verdicts[1]!.kind).toBe('layer');
    expect(verdicts.every((v) => (v.stats?.coverage ?? 0) > 0)).toBe(true);
  });

  it('【关键】采样失败的那层也要出结论，不许永远停在「正在识别…」', async () => {
    // 用户截图实测：跨域直链读像素被浏览器拦掉（对象存储不给 CORS 头），
    // 早先这里直接跳过，那一行就永远显示「正在识别内容…」——一个不会结束的进行时。
    const verdicts = await buildLayerContentVerdicts({
      layers: [{ key: 'a', src: 'src://missing' }, { key: 'b', src: 'src://l1' }],
      source: { src: 'src://source' },
      sampler,
    });
    expect(verdicts.map((v) => v.key)).toEqual(['a', 'b']);
    expect(verdicts[0]!.stats).toBeNull();
    expect(verdicts[0]!.hidden).toBe(false);
    expect(describeLayerContent(verdicts[0]!.kind, undefined)).toBe('内容未识别');
    expect(describeLayerContent(verdicts[0]!.kind, undefined)).not.toContain('正在');
  });

  it('拿不到原图时仍然出判定，只是不判整图', async () => {
    const verdicts = await buildLayerContentVerdicts({
      layers: [{ key: 'a', src: 'src://l1' }],
      source: null,
      sampler,
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.kind).toBe('layer');
  });
});

describe('单一实色填充层（模型为凑层数补的垃圾层）', () => {
  /** 造一张 N×N 的纯色不透明图。 */
  function solid(r: number, g: number, b: number): Uint8ClampedArray {
    const n = ANALYSIS_SAMPLE_SIZE;
    const data = new Uint8ClampedArray(n * n * 4);
    for (let o = 0; o < data.length; o += 4) {
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
    return data;
  }

  it('【关键】纯黑方块判成 solid 并默认隐藏', () => {
    // 2026-08-11 用户截图：拆 4 层，其中一层是纯黑方块占着位置。
    // 它覆盖率 100%（不透明），只看 alpha 的空层判据结构上就抓不到。
    const stats = computeContentStats(solid(0, 0, 0));
    const kind = classifyLayerContent({ ...stats, sourceDifference: 999 });
    expect(kind).toBe('solid');
    expect(isHiddenByDefault(kind)).toBe(true);
  });

  it('纯白方块同理', () => {
    const stats = computeContentStats(solid(255, 255, 255));
    expect(classifyLayerContent({ ...stats, sourceDifference: 999 })).toBe('solid');
  });

  it('【关键】真实背景层不许被误判成 solid（误判等于把画面掀掉）', () => {
    // 实测背景层 stdev 4.6 / 10 个色桶，必须落在 flat 而不是 solid。
    const background = decodeFixture(REAL_LAYER_FIXTURE_BASE64.layer0);
    const stats = computeContentStats(background);
    const kind = classifyLayerContent({ ...stats, sourceDifference: 18.3 });
    expect(kind).not.toBe('solid');
    expect(isHiddenByDefault(kind)).toBe(false);
  });

  it('真实内容层也不会被误判', () => {
    for (const key of ['layer1', 'layer2', 'layer3'] as const) {
      const stats = computeContentStats(decodeFixture(REAL_LAYER_FIXTURE_BASE64[key]));
      expect(classifyLayerContent({ ...stats, sourceDifference: 80 })).toBe('layer');
    }
  });
});

describe('一层看不见的雾也算空层', () => {
  /** 整幅铺满 alpha=20 的雾：老口径覆盖率 100%，但一处看得见的墨都没有。 */
  function haze(alpha: number): Uint8ClampedArray {
    const n = ANALYSIS_SAMPLE_SIZE;
    const data = new Uint8ClampedArray(n * n * 4);
    for (let o = 0; o < data.length; o += 4) {
      data[o] = 180; data[o + 1] = 180; data[o + 2] = 180; data[o + 3] = alpha;
    }
    return data;
  }

  it('【关键】整幅淡雾判成空层（老口径会当它是正常内容层，在画布上变成一个空盒子）', () => {
    const data = haze(20);
    const stats = computeContentStats(data);
    // 老口径：alpha>8 就算数，覆盖率接近满
    expect(stats.coverage).toBeGreaterThan(0.9);
    // 新口径：一处实墨都没有
    expect(computeInkCoverage(data)).toBe(0);
    expect(classifyLayerContent({
      coverage: stats.coverage,
      inkCoverage: computeInkCoverage(data),
      stdev: stats.stdev,
      colorBuckets: stats.colorBuckets,
      sourceDifference: 999,
    })).toBe('empty');
  });

  it('【关键】真实内容层不会被这条新判据误杀', () => {
    // 判行为，不判我拍脑袋的余量倍数。
    // 实测最稀疏那层（覆盖 7.2%）的实墨覆盖率 1.78%，是空层线 0.2% 的 8.9 倍——
    // 余量够，但没到一个数量级，所以这条断言盯的是「归类结果」而不是倍数。
    for (const key of ['layer1', 'layer2', 'layer3'] as const) {
      const data = decodeFixture(REAL_LAYER_FIXTURE_BASE64[key]);
      const stats = computeContentStats(data);
      const ink = computeInkCoverage(data);
      expect(ink).toBeGreaterThan(EMPTY_INK_COVERAGE_MAX);
      expect(classifyLayerContent({
        coverage: stats.coverage,
        inkCoverage: ink,
        stdev: stats.stdev,
        colorBuckets: stats.colorBuckets,
        sourceDifference: 80,
      })).toBe('layer');
    }
  });

  it('不传实墨覆盖率时保持旧行为（旧调用方不受影响）', () => {
    const data = haze(20);
    const stats = computeContentStats(data);
    expect(classifyLayerContent({ coverage: stats.coverage, sourceDifference: 999 })).not.toBe('empty');
  });
});
