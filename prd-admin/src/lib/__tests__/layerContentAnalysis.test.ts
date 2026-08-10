import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_SAMPLE_SIZE,
  classifyLayerContent,
  computeAlphaCoverage,
  computeMeanAbsDifference,
  describeLayerContent,
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

describe('图层命名与源提示词解耦', () => {
  it('主标题只由序号决定，源提示词再长也不影响分辨', () => {
    // 原缺陷：名字是「源提示词 · AI 图层 01」，60 字截断把序号后缀切掉，
    // 四层在面板里退化成同一串文字。
    const monster = '参考两张图片的构图与配色，生成一张深色科技风的产品展示海报'.repeat(8);
    const names = [0, 1, 2, 3].map((i) => aiLayerDisplayName(i));
    expect(names).toEqual(['图层 01', '图层 02', '图层 03', '图层 04']);
    expect(new Set(names).size).toBe(4);
    // 副标题可以截断，但它不承担分辨职责。
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

describe('分层产物内容判定', () => {
  it('几乎全透明的层判为空层并默认隐藏', () => {
    const coverage = computeAlphaCoverage(rgba(1));
    expect(classifyLayerContent({ coverage, sourceDifference: null })).toBe('empty');
    expect(isHiddenByDefault('empty')).toBe(true);
  });

  it('稀疏但有内容的线稿层不能被当成空层', () => {
    // 用户实测里有一层是细线稿：内容稀疏但有用，误判它就是新缺陷。
    // 0.5% 覆盖远高于 0.1% 的空层阈值。
    const coverage = computeAlphaCoverage(rgba(Math.round(PIXELS * 0.005)));
    expect(coverage).toBeGreaterThan(0.004);
    expect(classifyLayerContent({ coverage, sourceDifference: null })).toBe('layer');
  });

  it('与原图几乎一致的满覆盖层判为整图参考层', () => {
    const source = rgba(PIXELS, 120);
    const flatten = rgba(PIXELS, 121);
    const coverage = computeAlphaCoverage(flatten);
    const diff = computeMeanAbsDifference(flatten, source);
    expect(classifyLayerContent({ coverage, sourceDifference: diff })).toBe('source-reference');
    expect(isHiddenByDefault('source-reference')).toBe(true);
  });

  it('满覆盖的背景层不会被误判成整图', () => {
    // 关键区分点：背景层也满覆盖，但它缺了叠在上面的主体，与原图差异显著。
    // 只看覆盖率的判据会把背景层误杀，所以必须比对原图。
    const source = rgba(PIXELS, 200);
    const background = rgba(PIXELS, 40);
    const coverage = computeAlphaCoverage(background);
    const diff = computeMeanAbsDifference(background, source);
    expect(coverage).toBeGreaterThan(0.98);
    expect(diff).toBeGreaterThan(6);
    expect(classifyLayerContent({ coverage, sourceDifference: diff })).toBe('layer');
  });

  it('拿不到原图时不猜整图，宁可当普通层', () => {
    const full = rgba(PIXELS, 120);
    const coverage = computeAlphaCoverage(full);
    expect(classifyLayerContent({ coverage, sourceDifference: null })).toBe('layer');
  });

  it('普通图层不带说明文案，两类特殊层都带', () => {
    expect(describeLayerContent('layer')).toBe('');
    expect(describeLayerContent('empty')).not.toBe('');
    expect(describeLayerContent('source-reference')).not.toBe('');
    expect(isHiddenByDefault('layer')).toBe(false);
  });
});
