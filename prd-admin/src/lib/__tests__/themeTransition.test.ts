import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getThemeTransitionRadius, isSelfManagedThemePath } from '../themeTransition';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const TRANSITION_PATH = path.resolve(TEST_DIR, '../themeTransition.ts');
const BASE_CSS_PATH = path.resolve(TEST_DIR, '../../styles/base.css');
const APP_SHELL_PATH = path.resolve(TEST_DIR, '../../layouts/AppShell.tsx');
const THEME_EDITOR_PATH = path.resolve(TEST_DIR, '../../pages/settings/ThemeSkinEditor.tsx');
const MOBILE_HOME_PATH = path.resolve(TEST_DIR, '../../pages/MobileHomePage.tsx');
const REPORT_THEME_CONTROL_PATH = path.resolve(TEST_DIR, '../../pages/report-agent/components/ThemeControl.tsx');
const REPORT_PAGE_PATH = path.resolve(TEST_DIR, '../../pages/report-agent/ReportAgentPage.tsx');
const REPORT_DETAIL_PATH = path.resolve(TEST_DIR, '../../pages/report-agent/ReportDetailPage.tsx');
const THEME_STORE_PATH = path.resolve(TEST_DIR, '../../stores/mobileThemeStore.ts');

describe('主题水波切换契约', () => {
  it('扩散半径始终覆盖距离触发点最远的视口角落', () => {
    expect(getThemeTransitionRadius(0, 0, 100, 80)).toBeCloseTo(Math.hypot(100, 80));
    expect(getThemeTransitionRadius(50, 40, 100, 80)).toBeCloseTo(Math.hypot(50, 40));
    expect(getThemeTransitionRadius(90, 10, 100, 80)).toBeCloseTo(Math.hypot(90, 70));
  });

  it('仅保留独立纸面身份页面对 data-theme 的所有权', () => {
    expect(isSelfManagedThemePath('/daily-post')).toBe(true);
    expect(isSelfManagedThemePath('/report-agent/detail/1')).toBe(false);
    expect(isSelfManagedThemePath('/settings')).toBe(false);
  });

  it('共享实现包含 CDS 同款 View Transition、低动态降级与快照冻结', () => {
    const source = fs.readFileSync(TRANSITION_PATH, 'utf8');
    const css = fs.readFileSync(BASE_CSS_PATH, 'utf8');

    expect(source).toContain('startViewTransition');
    expect(source).toContain("pseudoElement: '::view-transition-new(root)'");
    expect(source).toContain('cubic-bezier(.16, 1, .3, 1)');
    expect(source).toContain('prefersReducedMotion()');
    expect(css).toContain('.theme-transition-snapshotting *::after');
    expect(css).toContain('::view-transition-new(root)');
  });

  it('桌面侧栏、皮肤设置、移动首页与周报共用同一切换入口', () => {
    const consumers = [APP_SHELL_PATH, THEME_EDITOR_PATH, MOBILE_HOME_PATH, REPORT_THEME_CONTROL_PATH]
      .map((filePath) => fs.readFileSync(filePath, 'utf8'));
    const store = fs.readFileSync(THEME_STORE_PATH, 'utf8');

    consumers.forEach((source) => expect(source).toContain('transitionThemeMode({'));
    expect(store).not.toContain('toggle:');
  });

  it('周报主页面与详情页不再保存或直接改写独立明暗状态', () => {
    const reportSources = [REPORT_PAGE_PATH, REPORT_DETAIL_PATH]
      .map((filePath) => fs.readFileSync(filePath, 'utf8'));

    reportSources.forEach((source) => {
      expect(source).not.toContain('report-agent:color-scheme');
      expect(source).not.toContain("setAttribute('data-theme'");
      expect(source).not.toContain("removeAttribute('data-theme'");
    });
  });
});
