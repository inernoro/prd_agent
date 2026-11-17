/**
 * 守卫：验收报告主页改成「结论优先」之后，桌面端必须能从阅读器回到首页。
 *
 * 2026-09-08 真人路径验收发现的回归：返回按钮原来写着 `lg:hidden`，只在手机端出现。
 * 主页还是「列表 + 阅读器」时这没问题（列表一直在左边）；改成结论首页后，桌面端
 * 一旦打开一份报告就再也回不到首页——点左栏「报告」是同一条路由，组件不重挂载、
 * selected 不复位，用户只能刷新整页。
 *
 * 这条链「删掉也不会红」（按钮仍然渲染、类型仍然通过、既有用例仍然全绿），
 * 所以按判据与接线纪律形状 2 补一条源码守卫。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.resolve(__dirname, '../../web/src/pages/ReportsPage.tsx'), 'utf8');

describe('验收报告主页 · 桌面端返回入口', () => {
  it('返回按钮存在且不带 lg:hidden（桌面端也要能回到结论首页）', () => {
    const m = /<Button[^>]*aria-label="返回报告首页"[^>]*>/.exec(SRC);
    expect(m, '找不到 aria-label="返回报告首页" 的返回按钮').toBeTruthy();
    const tag = m![0];
    expect(tag.includes('lg:hidden'), `返回按钮不得带 lg:hidden，实际：${tag}`).toBe(false);
    expect(tag.includes('onClick={onBack}')).toBe(true);
  });

  it('阅读器的 onBack 复位 selected，让页面回到结论首页', () => {
    expect(SRC).toContain('onBack={closeReport}');
    const close = SRC.slice(SRC.indexOf('const closeReport ='), SRC.indexOf('// 从列表发起的弹窗动作'));
    expect(close).toContain('setSelected(null)');
    expect(close).toContain('position = { ...readingPosition.current }');
    expect(close).toContain('scrollTo({ top: position.scroll })');
    expect(close).toContain('currentProject.current !== returningProject');
    expect(close).toContain('selectedRef.current');
  });

  it('未选中报告时显示清单或概况，已选正文不依赖清单读取成功', () => {
    expect(SRC).toContain("state.status === 'ok' && !selected");
    expect(SRC).toContain("const selected = centerView === 'reports' && selectedReport");
    expect(SRC).toContain("{selected ? (");
    expect(SRC).not.toContain("state.status === 'ok' && selected");
  });
});
