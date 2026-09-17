/**
 * 分支卡「固定高度」守卫（2026-09-17 用户拍板：保持固定高度、不要拉升）。
 *
 * 事故：卡片是 min-h（下限）而不是 h（定值），顶部又是一个 flex-wrap 行——
 * 端口多一个、状态多一个 chip 就换行，一排五张卡出现三种高度；标签第四个也多占一行。
 * 用户原话：「我以前因为面板高度问题狠狠的重构了一次」。
 *
 * 修法是三件事，缺任何一件这里就红：
 *   1. 卡片高度是定值 h-[15.25rem]（随界面尺度走的 rem），不是 min-h；
 *   2. 顶部改成竖向固定分带：复制集带 / 服务带 / 基础带，每带单行 h-7，溢出走「+N」浮层；
 *   3. 状态类 chip（CI 等待 / CI 未就绪 / 服务漂移）下沉到页脚状态槽，不再占顶部宽度。
 *
 * 实测基线（本地预览实例，最坏情况卡：等待 CI + 6 端口 + 服务漂移 + 3 标签）：
 * 改前 1440 宽下五张卡高度差 32px，改后三档尺度 × 四种宽度全部 delta=0。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const page = fs.readFileSync(path.join(WEB_SRC, 'pages/BranchListPage.tsx'), 'utf-8');

/** 顶部分带区域：从分带注释到标签带注释之间，状态类 chip 不许再出现在这里。 */
const bandsRegion = page.slice(
  page.indexOf('状态/服务分带'),
  page.indexOf('标签带（固定单行）'),
);

describe('分支卡：高度是定值，内容分带不换行', () => {
  it('卡片、骨架卡、复制集卡都用定高，不用 min-h', () => {
    expect(bandsRegion.length, '分带注释或标签带注释找不到了，下面的切片断言会假绿').toBeGreaterThan(500);
    expect(page, '分支卡必须是定高').toContain('group relative flex h-[15.25rem] cursor-pointer flex-col');
    expect(page, '骨架卡要和真卡等高，否则加载完会跳一下').toContain('flex h-[15.25rem] flex-col overflow-hidden rounded-md');
    expect(page, '派生的复制集卡也要等高').toContain('relative flex h-[15.25rem] flex-col rounded-xl border-2');
    expect(page, 'min-h 是「下限」不是「定值」，内容一多就把卡撑高').not.toContain('min-h-[15.25rem]');
  });

  it('顶部是竖向分带，不是会换行的 flex-wrap 行', () => {
    expect(page).toContain('<div className="flex max-w-full flex-col gap-1.5 px-5 pt-3">');
    expect(page, '顶部这一行换回 flex-wrap，端口一多就又把卡撑高').not.toContain('flex max-w-full flex-wrap items-center gap-2 px-5 pt-3');
    // 服务带与基础带：各自固定单行 h-7，左列可裁、右列常驻
    const band = /<div className="grid h-7 w-full grid-cols-\[minmax\(0,1fr\)_auto\] items-center gap-2">/g;
    expect(page.match(band)?.length, '服务带 + 基础带应各有一条固定单行 grid').toBe(2);
    expect(page, '复制集带无内容时要整条不占位').toContain('overflow-hidden empty:hidden');
  });

  it('端口溢出收进「+N」浮层，「+N」在不被裁的右列', () => {
    expect(page).toContain('「+N」常驻右列、不参与左列裁剪');
    expect(page).toContain('{foldedAppCount > 0 ? (');
  });

  it('状态类 chip 下沉页脚，不再占顶部分带的宽度', () => {
    expect(bandsRegion, '服务漂移回到顶部就会把端口挤到第二行').not.toContain('drift?.hasDrift');
    expect(bandsRegion, 'CI 镜像状态回到顶部就会把端口挤到第二行').not.toMatch(/ciImageStatus === 'waiting' && branch\.deployRuntime/);
    expect(page, '页脚状态槽本体').toContain('const footerNotice = (() => {');
    for (const kind of ["kind: 'ci-waiting'", "kind: 'ci-failed'", "kind: 'drift'"]) expect(page).toContain(kind);
    // 优先级：构建进度 > 状态槽 > AI 动态 > 提交说明
    expect(page.indexOf('{deployProgress ? (\n                <span')).toBeLessThan(page.indexOf(') : footerNotice ? ('));
    expect(page.indexOf(') : footerNotice ? (')).toBeLessThan(page.indexOf(') : isAiActive ? ('));
    // 等待态复用构建等待的斜纹底，不另造一套「在等」的视觉
    expect(page).toContain('cds-footer-progress-fill cds-footer-progress-fill--indeterminate');
  });

  it('标签带恒为单行：标签可压缩，两个入口按钮常驻', () => {
    expect(page).toContain('<div className="relative flex items-center gap-1.5 px-5 pt-2 pb-3">');
    expect(page, '标签行换回 flex-wrap，第四个标签就多占一行').not.toContain('relative flex flex-wrap items-center gap-1.5 px-5 pt-2 pb-3');
    expect(page, '标签名先压缩，别把「+ 标签」挤出去').toContain('<span className="min-w-0 max-w-[7.5rem] truncate">{tag}</span>');
    expect(page).toContain('group/tag inline-flex h-6 min-w-0 shrink items-center');
    // 浮层是这一带的绝对定位子元素：裁剪只能加在内层，加在容器上会把浮层一起裁掉
    expect(page).toContain('<div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">');
  });
});
