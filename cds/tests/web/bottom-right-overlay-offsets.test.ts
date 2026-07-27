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
  bugPillAnchorStyle,
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

describe('右下角安全偏移', () => {
  it('toast 的底部起点高于 pill 顶部，二者不重叠', () => {
    const pillTop = BUG_PILL_BOTTOM_PX + BUG_PILL_HEIGHT_PX;
    expect(BOTTOM_RIGHT_SAFE_PX).toBe(pillTop + BOTTOM_RIGHT_GAP_PX);
    expect(pxOf(bottomRightToastStyle.bottom)).toBeGreaterThanOrEqual(pillTop + BOTTOM_RIGHT_GAP_PX);
    expect(pxOf(bugPillAnchorStyle.bottom)).toBe(BUG_PILL_BOTTOM_PX);
  });
});

describe('提交缺陷 pill', () => {
  const source = readWeb('components/BugReportDialog.tsx');

  it('定位走共享偏移，不再硬编码 bottom-4 right-4', () => {
    expect(source).toContain("from '@/lib/overlayOffsets'");
    expect(source).toContain('bugPillAnchorStyle');
    expect(source).not.toMatch(/fixed bottom-4 right-4/);
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
