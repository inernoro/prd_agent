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

  // 上一条只证明「算出来的锚点在右侧」，不证明「这个值真的落到了元素上」。
  // 徽章的 CSS 默认值是 left:12px（左下角，正好压住贴底的头像），只有 inline style
  // 覆盖掉它才轮不到 CSS 生效。而 setWidgetPosition() 只在拖拽/缩放时才调 ——
  // 首屏靠的是 render() 里那两行直接落 pos。这两行删掉，上面的断言依旧全绿，
  // 徽章却会退回左下角压住头像。所以这条单独盯「接线」。
  it('首屏由 render() 把 pos 落成 inline style，CSS 默认的 left:12px 轮不到生效', () => {
    // render() 的函数体：从 function render(){ 到下一个顶层函数 renderLogModal 之前。
    const renderBody = widgetSource.slice(
      widgetSource.indexOf('function render(){'),
      widgetSource.indexOf('function renderLogModal(){'),
    );
    expect(renderBody).not.toHaveLength(0);
    expect(renderBody).toContain("root.style.left=pos.x+'px'");
    expect(renderBody).toContain("root.style.bottom=pos.y+'px'");

    // 而且 render() 必须在初始化时就被调用一次（不是等到某个交互）。
    // 判据只认「整行就是这个调用」：最初写成 /── Initial[\s\S]{0,200}?render\(\);/，
    // 结果把 `// render();` 这种注释掉的调用也判成了证据（红绿闭环时才发现它不变红）。
    const initBlock = widgetSource.slice(widgetSource.indexOf('── Initial'));
    const initCalls = initBlock
      .split('\n')
      .slice(0, 8)
      .filter((line) => line.trim() === 'render();');
    expect(initCalls).toHaveLength(1);
  });
});
