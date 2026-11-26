import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(fileURLToPath(new URL('../../web/src/components/layout/AppShell.tsx', import.meta.url)), 'utf8');

/** 去注释：块注释必须独占行首，否则源码里的 '/api/*' 会把扫描带偏。 */
const code = SOURCE
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/^[ \t]*\{\/\*[\s\S]*?\*\/\}/gm, '')
  .replace(/^\s*\/\/.*$/gm, '');

const topBar = code.slice(code.indexOf('export function TopBar'), code.indexOf('export interface CrumbItem'));
const trailing = topBar.slice(topBar.indexOf('<div className="cds-topbar-trailing'), topBar.indexOf('</header>'));

describe('公共顶栏右侧', () => {
  it('有独立的靠右容器，即使页面没有搜索或动作槽也显示全局入口', () => {
    const header = trailing.slice(0, trailing.indexOf('>'));
    expect(header).toMatch(/^<div className="cds-topbar-trailing [^"]*\bml-auto\b[^"]*"/);
    expect(header).toContain('shrink-0');
    expect(topBar).toMatch(/<InstanceSwitcher\s*\/>\s*<div id="cds-information-center-host"[^>]*\/>\s*<\/div>\s*<\/header>/);
    expect(trailing).toContain('<InstanceSwitcher />');
  });

  it('页面动作留在同一右侧容器，紧凑顶栏通过更多操作进入', () => {
    expect(trailing).toMatch(/cds-topbar-actions [^"]*\bxl:flex\b/);
    expect(trailing).toMatch(/xl:hidden[\s\S]*aria-label="更多操作"/);
  });

  it('窗口变宽后关闭隐藏入口对应的操作菜单', () => {
    expect(topBar).toMatch(/kebabRef\.current\?\.getClientRects\(\)\.length === 0\) setActionsOpen\(false\)/);
    expect(topBar).toContain("window.addEventListener('resize', closeHiddenActions)");
  });

  it('标题较长时可以收缩，为固定入口保留空间', () => {
    expect(topBar).toMatch(/cds-topbar-lead [^"]*\bmin-w-0\b[^"]*\bmd:flex-initial\b/);
    expect(topBar).toMatch(/cds-topbar-center [^\x60]*\bmd:min-w-40\b/);
  });
});
