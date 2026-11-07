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
import { runInNewContext } from 'node:vm';

const SRC = fs.readFileSync(path.resolve(__dirname, '../../web/src/pages/ReportsPage.tsx'), 'utf8');

describe('验收报告主页 · 桌面端返回入口', () => {
  it('返回按钮存在且不带 lg:hidden（桌面端也要能回到结论首页）', () => {
    const m = /<Button[^>]*aria-label="返回报告首页"[^>]*>/.exec(SRC);
    expect(m, '找不到 aria-label="返回报告首页" 的返回按钮').toBeTruthy();
    const tag = m![0];
    expect(tag.includes('lg:hidden'), `返回按钮不得带 lg:hidden，实际：${tag}`).toBe(false);
    expect(tag.includes('onClick={onBack}')).toBe(true);
  });

  it('阅读器返回同时复位选择和报告深链，保留项目与文件夹', () => {
    const wiring = /<ReportViewer\b[^>]*onBack=\{(\w+)\}/.exec(SRC);
    expect(wiring, '阅读器必须接入返回处理').toBeTruthy();
    const handler = new RegExp(`const ${wiring![1]} = useCallback\\(\\(\\) => \\{([\\s\\S]*?)\\n  \\}, \\[` ).exec(SRC);
    expect(handler, '找不到实际返回处理').toBeTruthy();
    let selected: string | null = 'old-report';
    let params = new URLSearchParams('project=prd-agent&folder=owned-folder&report=old-report');
    let replacesHistory = false;
    const back = runInNewContext(`(() => { ${handler![1]} })`, {
      URLSearchParams,
      setSelected: (value: null) => { selected = value; },
      setSearchParams: (update: (current: URLSearchParams) => URLSearchParams, options: { replace?: boolean }) => {
        params = update(params);
        replacesHistory = options.replace === true;
      },
    });
    back();
    expect(selected).toBeNull();
    expect(params.has('report')).toBe(false);
    expect(params.get('project')).toBe('prd-agent');
    expect(params.get('folder')).toBe('owned-folder');
    expect(replacesHistory).toBe(true);
  });

  it('未选中报告时渲染结论首页，选中后才回到列表 + 阅读器', () => {
    expect(SRC).toContain("state.status === 'ok' && !selected");
    expect(SRC).toContain("state.status === 'ok' && selected");
  });

  it('延后的地址提交前保留原页面，不抢先选择后又被旧地址清空', () => {
    const source = /const handleSelectReport = useCallback\([\s\S]*?=> \{([\s\S]*?)\n  \}, \[/.exec(SRC);
    expect(source).toBeTruthy();
    let selected: unknown = 'original';
    let scheduled = new URLSearchParams('report=original');
    const select = runInNewContext(`((report) => { ${source![1]} })`, {
      URLSearchParams, setSelected: (value: unknown) => { selected = value; },
      setNavDrawerOpen: () => {},
      setSearchParams: (update: (current: URLSearchParams) => URLSearchParams) => {
        scheduled = update(new URLSearchParams('project=prd-agent&report=original'));
      },
    });
    select({ id: 'target' });
    expect(selected).toBe('original');
    expect(scheduled.get('report')).toBe('target');
  });
});
