import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const layoutSource = readFileSync(path.resolve(testDirectory, 'AppShell.tsx'), 'utf8');
const globalsSource = readFileSync(path.resolve(testDirectory, '../styles/globals.css'), 'utf8');
// 跨模块读 CDS 注入脚本：侧栏留不留底部空位，取决于它把徽章锚在哪一侧。
const widgetSource = readFileSync(
  path.resolve(testDirectory, '../../../cds/src/widget-script.ts'),
  'utf8',
);

describe('AppShell CDS preview compatibility', () => {
  it('侧栏账户区仍是 CDS 徽章避让的锚点（挂钩属性不能被改名）', () => {
    expect(layoutSource).toContain('data-app-sidebar-account');
  });

  it('CDS 徽章桌面端锚右侧安全区，所以账户区不再为它留底部空位', () => {
    // 这两条断言必须一起看：右锚是因，去掉留白是果。
    // 哪天 widget 改回左下角，第一条会红 —— 那时要把 globals.css 的 52px 留白加回来，
    // 否则头像又会被徽章压住。
    expect(widgetSource).toMatch(
      /function defaultWidgetLeft\(\)\{[\s\S]{0,400}?window\.innerWidth-492/,
    );
    expect(globalsSource).not.toContain('[data-cds-widget-root]) [data-app-sidebar-account]');
  });
});
