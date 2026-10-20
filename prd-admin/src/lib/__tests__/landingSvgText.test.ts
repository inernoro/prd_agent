import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 首页的 SVG 若用 preserveAspectRatio="none" 拉伸到容器，里面就不许有文字。
 *
 * 非等比拉伸对色块、曲线无害，对字是灾难：宽屏上字被横向拉宽近两倍、纵向反而压扁，
 * 读起来像字体被压坏了（2026-09-29 体验地图那一幕，用户截图指出）。
 * 要在拉伸的图形上写字，改成按真实像素排布（量出 SVG 尺寸再算坐标），或把字放到 HTML 层。
 */
const HOME = path.resolve(__dirname, '../../pages/home');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === '__tests__' ? [] : sourceFiles(p);
    return /\.tsx$/.test(d.name) ? [p] : [];
  });
}

/** 找出「preserveAspectRatio="none" 的 <svg> 标签里含 <text>」的位置。 */
function stretchedSvgWithText(src: string): number[] {
  const hits: number[] = [];
  const re = /preserveAspectRatio="none"/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = src.lastIndexOf('<svg', m.index);
    const close = src.indexOf('</svg>', m.index);
    if (open < 0 || close < 0) continue;
    // 这个属性确实挂在最近的 <svg 上（而不是某个 <image> / <pattern> 上）
    const tagEnd = src.indexOf('>', open);
    if (tagEnd < m.index) continue;
    if (/<text[\s>]/.test(src.slice(m.index, close))) hits.push(src.slice(0, m.index).split('\n').length);
  }
  return hits;
}

describe('首页拉伸的 SVG 里不许写字', () => {
  it('判据自身能认出违规写法', () => {
    expect(stretchedSvgWithText('<svg viewBox="0 0 10 10" preserveAspectRatio="none"><rect/><text>x</text></svg>')).toEqual([1]);
    expect(stretchedSvgWithText('<svg viewBox="0 0 10 10" preserveAspectRatio="none"><path/></svg>')).toEqual([]);
    expect(stretchedSvgWithText('<svg viewBox="0 0 10 10"><text>x</text></svg>')).toEqual([]);
  });

  it('pages/home 下没有一处违规', () => {
    const bad = sourceFiles(HOME).flatMap((f) =>
      stretchedSvgWithText(fs.readFileSync(f, 'utf8')).map((line) => `${path.relative(HOME, f)}:${line}`),
    );
    expect(bad, '这些 SVG 被非等比拉伸，里面的字会变形').toEqual([]);
  });
});
