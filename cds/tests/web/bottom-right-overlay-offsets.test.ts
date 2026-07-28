/**
 * 右下角浮层不打架守卫（2026-07-27）。
 *
 * 常驻的「提交缺陷」pill（z-index 120）与各页面操作反馈 toast（z-index 50）
 * 原本都钉在右下角、几何位置几乎重合，pill 层级高一个数量级 → 保存后的失败原因
 * 被压住半句。本文件锁住两件事：
 *   1. 两者共用 lib/overlayOffsets 的同一份安全偏移，且几何上不重叠；
 *   2. 各页面 toast 不许再回退成裸 `fixed bottom-5 right-5`（源码守卫，改回去就红）。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOTTOM_RIGHT_GAP_PX,
  BOTTOM_RIGHT_SAFE_PX,
  BUG_PILL_BOTTOM_PX,
  BUG_PILL_HEIGHT_PX,
  bottomRightToastStyle,
} from '../../web/src/lib/overlayOffsets.js';

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');

/** 各页面右下角 toast 的宿主文件。 */
const TOAST_PAGES = [
  'pages/ProjectListPage.tsx',
  'pages/BranchListPage.tsx',
  'pages/BranchDetailPage.tsx',
  'pages/ProjectSettingsPage.tsx',
  'pages/BranchTopologyPage.tsx',
  'pages/CdsSettingsPage.tsx',
];

function readWeb(relative: string): string {
  return fs.readFileSync(path.join(WEB_SRC, relative), 'utf-8');
}

function pxOf(value: string): number {
  return Number(value.replace('px', ''));
}

/** 去掉注释再做源码守卫——注释里常写着「事故值长什么样」，会误伤断言。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('右下角安全偏移', () => {
  it('toast 的底部起点高于 pill 顶部，二者不重叠', () => {
    const pillTop = BUG_PILL_BOTTOM_PX + BUG_PILL_HEIGHT_PX;
    expect(BOTTOM_RIGHT_SAFE_PX).toBe(pillTop + BOTTOM_RIGHT_GAP_PX);
    expect(pxOf(bottomRightToastStyle.bottom)).toBeGreaterThanOrEqual(pillTop + BOTTOM_RIGHT_GAP_PX);
  });
});

describe('提交缺陷入口必须加入右下角唯一提醒区，而不是另起一套定位', () => {
  const source = readWeb('components/BugReportDialog.tsx');
  const code = stripComments(source);

  it('入口 portal 进 .cds-global-action-stack，不自己 fixed 定位', () => {
    expect(source).toContain('cds-global-action-stack');
    // 事故值：自己贴 bottom-4 right-4 会与坞里的更新徽章几何重合、被压住半句
    expect(code).not.toMatch(/fixed bottom-4 right-4/);
    expect(code).not.toContain('bugPillAnchorStyle');
  });

  it('坞元素走共享 hook 解析，不各自内联 querySelector', () => {
    expect(source).toContain("useOverlayDock('.cds-global-action-stack')");
    expect(source).not.toMatch(/document\.querySelector\(['"]\.cds-global-action-stack/);
  });

  it('共享 hook 用 effect + MutationObserver，不在 render 期解析（首帧查不到会让入口永不显示）', () => {
    const hook = readWeb('lib/useOverlayDock.ts');
    expect(hook).toMatch(/useEffect\([\s\S]*querySelector/);
    expect(hook).toContain('MutationObserver');
  });
});

describe('底部浮层带是两个坞的唯一定位者（遮挡 + 边缘问题同根）', () => {
  const css = readWeb('index.css');

  it('只有 .cds-bottom-docks 是 fixed，两个坞退化成带内 flex 项', () => {
    expect(css).toMatch(/\.cds-bottom-docks\s*\{[^}]*position: fixed/);
    // 事故值：两个坞各自贴角 fixed，谁都不知道对方和 rail 的存在
    expect(css).not.toMatch(/\.cds-global-action-stack\s*\{[^}]*position: fixed/);
    expect(css).not.toMatch(/\.cds-bottom-left-dock\s*\{[^}]*position: fixed/);
  });

  it('带按 rail token 让开导航图标，两侧留白', () => {
    expect(css).toContain('--cds-rail-w: 72px');
    expect(css).toMatch(/\.cds-bottom-docks\s*\{[^}]*left: calc\(var\(--cds-rail-w/);
    expect(css).toMatch(/\.cds-bottom-docks\s*\{[^}]*right: 1rem/);
    // 事故值：右坞曾是 min(420px, calc(100vw - 2rem))，窄视口下铺到最左压住 rail
    expect(css).not.toMatch(/\.cds-global-action-stack\s*\{[^}]*width: min\(420px, calc\(100vw - 2rem\)\)/);
  });

  it('窄视口自动折行，两个坞不会横向撞在一起', () => {
    expect(css).toMatch(/\.cds-bottom-docks\s*\{[^}]*flex-wrap: wrap/);
  });

  it('两个坞各自竖向堆叠，同侧多个浮层排队而不是叠在同一格', () => {
    expect(css).toMatch(/\.cds-global-action-stack\s*\{[^}]*flex-direction: column/);
    expect(css).toMatch(/\.cds-bottom-left-dock\s*\{[^}]*flex-direction: column/);
  });

  it('手机端 rail 收进抽屉，token 归零让带退回整宽', () => {
    expect(css).toContain('--cds-rail-w: 0px');
  });

  it('AppShell 把两个坞包在同一条带里', () => {
    const shell = readWeb('components/layout/AppShell.tsx');
    expect(shell).toMatch(
      /cds-bottom-docks[\s\S]{0,400}cds-bottom-left-dock[\s\S]{0,400}cds-global-action-stack/,
    );
  });

  it('CommitInbox 不自己定位，只声明宽度', () => {
    const source = stripComments(readWeb('components/CommitInbox.tsx'));
    expect(source).not.toMatch(/fixed bottom-4 left-4/);
    expect(source).not.toMatch(/\bfixed\b/);
  });

  it('接入 Agent 入口保持自定位：它只在无 AppShell 的页面出现，portal 进坞会整个消失', () => {
    expect(css).toMatch(/\.cds-agent-access-floating\s*\{[^}]*position: fixed/);
    expect(readWeb('components/GlobalAgentAccess.tsx')).not.toContain('useOverlayDock');
  });
});

describe.each(TOAST_PAGES)('%s 的操作反馈 toast', (relative) => {
  const source = readWeb(relative);

  it('不再使用与 pill 重合的裸 bottom-5 right-5', () => {
    expect(source).not.toMatch(/fixed bottom-5 right-5/);
  });

  it('改用共享的 bottomRightToastStyle', () => {
    expect(source).toContain("import { bottomRightToastStyle } from '@/lib/overlayOffsets';");
    expect(source).toContain('style={bottomRightToastStyle}');
  });
});
