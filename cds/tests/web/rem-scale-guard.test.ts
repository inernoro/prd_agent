/**
 * 整站 85% 呈现的棘轮守卫（2026-09-08 用户拍板）。
 *
 * 缩放走根字号（html { font-size: 85% }），前提是尺寸全部用 rem：任何 >3px 的 px 字面量
 * 都不会跟着缩，会在 85% 的页面里显得「独自变大」。1–3px 的细线 / 竖条刻意保留 px。
 * 这里扫 index.css（非注释、非媒体查询）与全部 tsx/ts（非注释）里的 px 字面量，
 * 新增 >3px 的就红——想加尺寸请写 rem（px / 16）。React 数字型 style 长度会按 px
 * 序列化（maxWidth: 360 就是 360px），同样不跟着缩，这里一并扫 style={{ }} 里的数字长度。
 * 媒体查询与 Tailwind 断点是另一套契约：它们读不到根字号，三档尺度共用原始 px 断点，
 * 这里钉的是「断点表没有被按某一档缩过」。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const SRC = path.join(WEB, 'src');
// 下划线在 Tailwind 方括号里是空格（grid-cols-[20rem_minmax(0,1fr)]），所以 px 前后的 _ 不算单词字符。
const PX = /(?<![A-Za-z0-9.-])(\d*\.?\d+)px(?![A-Za-z0-9-])/g;

/** 允许保留的 >3px 场景（每条写明原因）。 */
const ALLOW: Array<{ file: string; needle: string; why: string }> = [
  { file: 'index.css', needle: 'max(10px, 0.6875rem)', why: '左栏两字标签的可读性下限：9.5px 已糊，保底 10 物理像素' },
  { file: 'pages/StatusPage.tsx', needle: "'(max-width: 767px)'", why: '媒体查询字符串：断点读不到根字号，和 CSS 断点一样保持 px' },
];

/** 整个文件按画布单位工作的组件：几何是 px 常量或量出来的容器宽度，内容也必须是同一套单位，
 *  否则「框是 px、字是 rem」在 85% 下会双重缩小。RelationGraph 由 transform 按容器整体缩放，
 *  本来就跟着尺度走；ReplicaSetPanel 的画布常量尚未随根字号走，记在 doc/debt.cds.md。 */
const CANVAS_FILES = ['components/branch/RelationGraph.tsx', 'components/branch/ReplicaSetPanel.tsx'];

/** React style 里按 px 序列化的长度属性；unitless 的（opacity / zIndex / flex / lineHeight / order）不在此列。 */
const LENGTH_PROPS = ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'top', 'left', 'right', 'bottom', 'inset', 'fontSize', 'gap', 'rowGap', 'columnGap', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'borderRadius'];
const NUMERIC_STYLE = new RegExp(`\\b(${LENGTH_PROPS.join('|')})\\s*:\\s*(\\d+)\\s*[,}]`, 'g');

function numericStyleHits(text: string): string[] {
  const hits: string[] = [];
  for (const block of text.matchAll(/style=\{\{([\s\S]*?)\}\}/g)) {
    for (const m of block[1].matchAll(NUMERIC_STYLE)) if (Number(m[2]) > 3) hits.push(`${m[1]}: ${m[2]}`);
  }
  return hits;
}

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

  it('根字号默认 85%，三档 80 / 85 / 100 由 data-ui-scale 切换，首帧前落地', () => {
    expect(css).toMatch(/html\s*\{\s*font-size:\s*85%;/);
    expect(css).toMatch(/html\[data-ui-scale='80'\]\s*\{\s*font-size:\s*80%;/);
    expect(css).toMatch(/html\[data-ui-scale='100'\]\s*\{\s*font-size:\s*100%;/);
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf-8');
    expect(html, '预加载脚本要在首帧前把 cds_ui_scale 落到 <html>，否则切档的用户每次打开都闪一下').toContain("localStorage.getItem('cds_ui_scale')");
    const shell = fs.readFileSync(path.join(SRC, 'components/layout/AppShell.tsx'), 'utf-8');
    expect(shell, '账号浮层里要有「界面尺度」三档入口').toContain('aria-label="界面尺度"');
    expect(shell).toContain('UI_SCALE_PRESETS.map(');
  });

  it('分支卡网格：列宽下限是 rem token，五等分宽度也算进下限，auto-fill 自然封顶五列', () => {
    const block = css.match(/\.cds-branch-card-grid\s*\{[^}]*\}/)?.[0] ?? '';
    expect(block).toMatch(/--cds-branch-card-min:\s*[\d.]+rem;/);
    expect(block).toContain('repeat(auto-fill, minmax(min(100%, max(var(--cds-branch-card-min), calc((100% - 4 * var(--cds-branch-card-gap)) / 5))), 1fr))');
    expect(css, '封顶不许走媒体查询：断点读不到根字号，三档尺度下会错位').not.toMatch(/@media[^{]*\{\s*\.cds-branch-card-grid\s*\{\s*grid-template-columns:\s*repeat\(5,/);
    expect(block, '列数不许靠 zoom 凑').not.toContain('zoom:');
  });

  it('index.css 里没有新的 >3px 字面量', () => {
    const hits = bigPx(applyAllow('index.css', stripCss(css)));
    expect(hits, `index.css 出现 >3px 的 px 字面量：${hits.slice(0, 10).join(', ')}（请改写为 rem = px / 16）`).toEqual([]);
  });

  it('tsx / ts 里没有新的 >3px 字面量（画布组件除外）', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (CANVAS_FILES.some((c) => file.endsWith(c))) continue;
      const hits = bigPx(applyAllow(file, stripTs(fs.readFileSync(file, 'utf-8'))));
      if (hits.length) offenders.push(`${path.relative(WEB, file)}: ${hits.slice(0, 5).join(', ')}`);
    }
    expect(offenders, `以下文件出现 >3px 的 px 字面量（请改写为 rem = px / 16）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('tsx 的 style={{ }} 里没有 >3 的数字型长度（React 会按 px 序列化）', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (CANVAS_FILES.some((c) => file.endsWith(c))) continue;
      const hits = numericStyleHits(stripTs(fs.readFileSync(file, 'utf-8')));
      if (hits.length) offenders.push(`${path.relative(WEB, file)}: ${hits.slice(0, 5).join(', ')}`);
    }
    expect(offenders, `以下 style 里的数字长度不会随界面尺度缩放（请写成 'Nrem' 字符串）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('Tailwind 断点与 CSS 媒体查询保持原始 px，不按某一档尺度缩', () => {
    const cfg = fs.readFileSync(path.join(WEB, 'tailwind.config.js'), 'utf-8');
    expect(cfg).toMatch(/screens:\s*\{\s*wide:\s*'1440px'\s*\}/);
    for (const k of ['sm', 'md', 'lg', 'xl', "'2xl'"]) expect(cfg, `不要覆盖默认断点 ${k}`).not.toMatch(new RegExp(`${k}:\\s*'\\d+px'`));
    // 85% 那一档缩出来的特征值，出现任何一个都说明断点又被按尺度缩了
    for (const scaled of ['765px', '652px', '1306px', '1088px', '870px', '544px']) {
      expect(css, `媒体查询里出现 ${scaled}：断点不该随尺度缩`).not.toMatch(new RegExp(`@media[^{]*\\b${scaled}`));
    }
  });
});
