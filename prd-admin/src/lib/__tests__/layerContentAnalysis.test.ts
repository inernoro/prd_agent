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

  it('覆盖率极小时不退化成 0%，否则和真空层看起来一样', () => {
    expect(formatCoverage(0.0004)).toBe('不足 0.1%');
    expect(formatCoverage(0.0723)).toBe('7%');
    expect(formatCoverage(1)).toBe('100%');
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
    expect(verdicts.every((v) => v.stats.coverage > 0)).toBe(true);
  });

  it('采样失败的那层被跳过，不影响其余层，也不瞎猜', async () => {
    const verdicts = await buildLayerContentVerdicts({
      layers: [{ key: 'a', src: 'src://missing' }, { key: 'b', src: 'src://l1' }],
      source: { src: 'src://source' },
      sampler,
    });
    expect(verdicts.map((v) => v.key)).toEqual(['b']);
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
