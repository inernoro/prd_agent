/**
 * 分支卡页脚「进度即背景」守卫（2026-09-08 用户拍板方案 B）。
 *
 * 事故：构建期间页脚中间列塞了「排队」+「极速版进度」两个 shrink-0 chip，
 * 左列被压到零宽后 sha chip 溢出叠在「前面 N 个」上。修法是页脚只留两列，
 * 进度改成背景填充层 + 提交说明槽位里的一行字。删掉任一半，这里就红。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');

function readWeb(relative: string): string {
  return fs.readFileSync(path.join(WEB_SRC, relative), 'utf-8');
}

describe('分支卡页脚：进度是背景填充，不占横向空间', () => {
  const page = readWeb('pages/BranchListPage.tsx');
  const css = readWeb('index.css');
  const footerStart = page.indexOf('<footer');
  const footerEnd = page.indexOf('</footer>', footerStart);
  const footer = page.slice(footerStart, footerEnd);

  it('页脚只有两列，构建态没有第三列可以挤压左列', () => {
    expect(footerStart).toBeGreaterThan(-1);
    expect(footer).toContain('grid-cols-[minmax(0,1fr)_auto]');
    expect(footer).not.toContain('grid-cols-[minmax(0,1fr)_auto_auto]');
    // 旧的排队 chip 文案不再出现在页脚里（它现在是进度文字的一部分）。
    expect(footer).not.toContain('排队 · 前面');
  });

  it('构建态渲染填充层，并暴露机读进度值', () => {
    expect(footer).toContain('className={`cds-footer-progress-fill');
    expect(footer).toContain('cds-footer-progress-fill--indeterminate');
    expect(footer).toContain('cds-footer-progress-fill--overdue');
    expect(footer).toContain('data-progress=');
    // 进度文字占的是提交说明的槽位：优先级 构建进度 > AI 动态 > 提交说明。
    expect(footer.indexOf('{deployProgress ? (')).toBeGreaterThan(-1);
    expect(footer.indexOf('{deployProgress ? (')).toBeLessThan(footer.indexOf(') : isAiActive ? ('));
    // 左右两簇都得压在填充层之上，否则右侧按钮会被填充盖住。
    expect(footer).toContain('<div className="relative flex shrink-0 items-center gap-2">');
  });

  it('样式走 token、不确定态有动效且尊重 reduced-motion', () => {
    expect(css).toMatch(/\.cds-footer-progress-fill\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?transition:\s*width/);
    expect(css).toMatch(/\.cds-footer-progress-fill--indeterminate\s*\{[\s\S]*?width:\s*100%;[\s\S]*?animation:\s*cds-footer-progress-sweep/);
    expect(css).toContain('@keyframes cds-footer-progress-sweep');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.cds-footer-progress-fill--indeterminate\s*\{\s*animation:\s*none;/);
    const block = css.slice(css.indexOf('.cds-footer-progress-fill {'), css.indexOf('@keyframes cds-footer-progress-sweep'));
    expect(block, '填充色必须走 token，双主题才都成立').not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(\s*\d/i);
  });
});
