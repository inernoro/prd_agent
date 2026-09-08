/**
 * 整站 85% 呈现的棘轮守卫（2026-09-08 用户拍板）。
 *
 * 缩放走根字号（html { font-size: 85% }），前提是尺寸全部用 rem：任何 >3px 的 px 字面量
 * 都不会跟着缩，会在 85% 的页面里显得「独自变大」。1–3px 的细线 / 竖条刻意保留 px。
 * 这里扫 index.css（非注释、非媒体查询）与全部 tsx/ts（非注释）里的 px 字面量，
 * 新增 >3px 的就红——想加尺寸请写 rem（px / 16）。媒体查询与 Tailwind 断点是另一套
 * 契约：它们按 0.85 缩过（px 保留），这里只钉根字号与断点表本身。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const SRC = path.join(WEB, 'src');
const PX = /(?<![\w.-])(\d*\.?\d+)px(?![\w-])/g;

/** 允许保留的 >3px 场景（每条写明原因）。 */
const ALLOW: Array<{ file: string; needle: string; why: string }> = [
  { file: 'index.css', needle: 'max(10px, 0.6875rem)', why: '左栏两字标签的可读性下限：9.5px 已糊，保底 10 物理像素' },
];

function stripCss(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*/g, '');
}
function stripTs(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}
function bigPx(text: string): string[] {
  const hits: string[] = [];
  for (const m of text.matchAll(PX)) if (Number(m[1]) > 3) hits.push(m[0]);
  return hits;
}
function applyAllow(file: string, text: string): string {
  let t = text;
  for (const a of ALLOW) if (file.endsWith(a.file)) t = t.split(a.needle).join('');
  return t;
}

describe('整站 85%：尺寸用 rem，px 只留给细线', () => {
  const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf-8');

  it('根字号是 85%，并留有 100% 逃生阀', () => {
    expect(css).toMatch(/html\s*\{\s*font-size:\s*85%;/);
    expect(css).toMatch(/html\[data-ui-scale='100'\]\s*\{\s*font-size:\s*100%;/);
  });

  it('index.css 里没有新的 >3px 字面量', () => {
    const hits = bigPx(applyAllow('index.css', stripCss(css)));
    expect(hits, `index.css 出现 >3px 的 px 字面量：${hits.slice(0, 10).join(', ')}（请改写为 rem = px / 16）`).toEqual([]);
  });

  it('tsx / ts 里没有新的 >3px 字面量', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const hits = bigPx(applyAllow(file, stripTs(fs.readFileSync(file, 'utf-8'))));
      if (hits.length) offenders.push(`${path.relative(WEB, file)}: ${hits.slice(0, 5).join(', ')}`);
    }
    expect(offenders, `以下文件出现 >3px 的 px 字面量（请改写为 rem = px / 16）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('Tailwind 断点按 0.85 缩过，和根字号一致', () => {
    const cfg = fs.readFileSync(path.join(WEB, 'tailwind.config.js'), 'utf-8');
    for (const [k, v] of [['sm', 544], ['md', 653], ['lg', 870], ['xl', 1088], ["'2xl'", 1306], ['wide', 1224]]) {
      expect(cfg, `断点 ${k} 应为 ${v}px`).toMatch(new RegExp(`${k}:\\s*'${v}px'`));
    }
  });
});
