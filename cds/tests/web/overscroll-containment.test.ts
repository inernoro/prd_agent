import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `overscroll-behavior: contain` 只许用在浮层上。
 *
 * 2026-08-13 用户对发布中心的原话：「红色框框部分无法向上拖动，好像被焊死了一样，
 * 想低头看看人家的裤子什么颜色，怎么都看不到。」
 *
 * 根因不是页面不能滚——`.cds-main` 当时有 381px 可滚。是**滚不动它**：
 * 详情面板与左栏各自 `overflow-y-auto` + `overscroll-behavior: contain`，
 * 鼠标停在上面时滚轮只滚那一格，滚到底后 contain **切断了向外层的滚动链**，
 * 于是页面永远不动。
 *
 * 判据很简单：
 * - **浮层**（dialog / drawer / sheet / 命令面板 / 站内通知）——该用。不然滚到底会带着
 *   身后的页面一起动，那是另一种糟糕。
 * - **页内面板**（列表、详情、日志、侧栏）——不许用。用户滚到底就该继续滚页面。
 */

const WEB = path.resolve(process.cwd(), '../cds/web/src');

/** 浮层白名单：这些文件里的 contain 是对的。 */
const OVERLAY_ALLOWLIST = [
  'components/ui/dialog.tsx',
  'components/monitoring/MonitoringDialog.tsx',
  'components/BranchDetailDrawer.tsx',
  'components/BugReportDialog.tsx',
  'components/env/EnvSetupDialog.tsx',
  'components/CapacityFullDialog.tsx',
  'components/branch/DetectStackDialog.tsx',
  'components/SkillDownloadDialog.tsx',
  'components/SiteNoticeInbox.tsx',
  'pages/release-center/StartReleaseDialog.tsx',
];

/** 已经清理干净的页内面板：不许把 contain 加回来。 */
const MUST_STAY_CLEAN = [
  'pages/ReleaseCenterPage.tsx',
  'pages/ReleaseConsolePage.tsx',
  'pages/release-center/EnvironmentSidebar.tsx',
  'pages/release-center/EvidenceTab.tsx',
  'pages/release-center/ConfigTab.tsx',
  'pages/release-center/FailureDiagnosis.tsx',
  'pages/release-center/shared.tsx',
];

describe('滚动链不许被页内面板切断', () => {
  it('发布中心与发布控制台的页内面板没有 overscroll containment', () => {
    for (const rel of MUST_STAY_CLEAN) {
      const src = fs.readFileSync(path.join(WEB, rel), 'utf8');
      expect(src, `${rel} 不该再出现 overscrollBehavior: contain（页内面板会把页面焊死）`)
        .not.toContain("overscrollBehavior: 'contain'");
    }
  });

  it('浮层仍然保留 containment —— 那是它该有的', () => {
    const kept = OVERLAY_ALLOWLIST.filter((rel) => {
      const p = path.join(WEB, rel);
      return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes("overscrollBehavior: 'contain'");
    });
    // 不要求每个浮层都写，但至少 Dialog 这个共用底座必须有
    expect(kept, '共用 Dialog 底座应保留 containment').toContain('components/ui/dialog.tsx');
  });

  /**
   * 发布中心桌面端是固定一屏（用户 2026-08-14：「应该固定一屏，不应该这样滑动」）。
   *
   * 这里一度是反过来的守卫（「不许锁死整页滚动」），因为 08-13 用户说下半部分
   * 拖不上去、像被焊死。两次并不矛盾：焊死的直接原因是本文件禁的那条
   * containment 切断了滚动链，而「上半部分偏高偏大」的原因是顶部两块太占地方。
   * 版本流水轴删掉、头部压成一行之后，固定一屏重新成立——所以 fill 回来了，
   * containment 的禁令继续有效。
   */
  it('发布中心桌面端固定一屏', () => {
    const src = fs.readFileSync(path.join(WEB, 'pages/ReleaseCenterPage.tsx'), 'utf8');
    expect(src).toContain('overflow-y-auto lg:h-full lg:overflow-hidden');
  });

  /**
   * 发布控制台反过来：它是固定外壳 + 各栏内滚（对齐参考稿），
   * 必须带 --fill，否则 h-full 解析不到高度，实时输出会把整页撑到近万像素。
   */
  it('发布控制台带 --fill，三栏才是固定外壳而不是让页面一直长', () => {
    const src = fs.readFileSync(path.join(WEB, 'pages/ReleaseConsolePage.tsx'), 'utf8');
    expect(src).toContain('cds-workspace--fill');
  });
});
