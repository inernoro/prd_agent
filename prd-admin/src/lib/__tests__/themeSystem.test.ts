import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeThemeConfig } from '../themeApplier';
import { THEME_ACCEPTANCE_TARGETS } from '../themeAcceptanceTargets';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { buildStaticAgents } from '@/lib/homeLauncherItems';
import {
  ACCENT_STYLES,
  DEFAULT_THEME_CONFIG,
  MATERIAL_OPTIONS,
  type ThemeConfig,
} from '@/types/theme';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = path.resolve(TEST_DIR, '../../..');
const TOKENS_PATH = path.resolve(TEST_DIR, '../../styles/tokens.css');
const MOBILE_COMPAT_GATE_PATH = path.resolve(TEST_DIR, '../../components/MobileCompatGate.tsx');
const AGENT_SWITCHER_PATH = path.resolve(TEST_DIR, '../../components/agent-switcher/AgentSwitcher.tsx');
const BUTTON_PATH = path.resolve(TEST_DIR, '../../components/design/Button.tsx');
const DOCUMENT_STORE_PATH = path.resolve(TEST_DIR, '../../pages/document-store/DocumentStorePage.tsx');
const SURFACE_PATH = path.resolve(TEST_DIR, '../../styles/surface.css');
const GLASS_STYLES_PATH = path.resolve(TEST_DIR, '../glassStyles.ts');
const TEAM_ACTIVITY_DIR = path.resolve(TEST_DIR, '../../pages/team-activity');
const SETTINGS_PAGE_PATH = path.resolve(TEST_DIR, '../../pages/SettingsPage.tsx');
const PEER_NODES_PATH = path.resolve(TEST_DIR, '../../pages/settings/PeerNodesSettings.tsx');
const INFRA_SERVICES_PATH = path.resolve(TEST_DIR, '../../pages/infra-services/InfraServicesPage.tsx');
const EMERGENCE_CARD_PATH = path.resolve(TEST_DIR, '../../pages/emergence/EmergenceTreeCard.tsx');
const CDS_AGENT_PATH = path.resolve(TEST_DIR, '../../pages/cds-agent/CdsAgentPage.tsx');
const PROJECT_ROUTE_PATH = path.resolve(TEST_DIR, '../../pages/project-route-agent/ProjectRouteAgentPage.tsx');
const WEEKLY_POSTER_PATH = path.resolve(TEST_DIR, '../../pages/weekly-poster/PosterDesignerPage.tsx');
const STYLE_DEBT_REPORT_PATH = path.resolve(TEST_DIR, '../../../scripts/style-debt-report.mjs');
const REPORT_COLORS_PATH = path.resolve(TEST_DIR, '../../pages/report-agent/hooks/lightModeColors.ts');
const REPORT_AGENT_DIR = path.resolve(TEST_DIR, '../../pages/report-agent');
const CHANGELOG_DYNAMIC_PATH = path.resolve(TEST_DIR, '../../pages/changelog/changelog-dynamic.css');
const DOC_BROWSER_PATH = path.resolve(TEST_DIR, '../../components/doc-browser/DocBrowser.tsx');
const BACKLINKS_PANEL_PATH = path.resolve(TEST_DIR, '../../components/doc-browser/BacklinksPanel.tsx');
const SHARE_DOCK_PATH = path.resolve(TEST_DIR, '../../components/share-dock/ShareDock.tsx');
const CREATOR_FILTER_PATH = path.resolve(TEST_DIR, '../../components/showcase/CreatorFilterRow.tsx');
const TAG_PALETTE_PATH = path.resolve(TEST_DIR, '../tagPalette.ts');
const MOBILE_TAB_BAR_PATH = path.resolve(TEST_DIR, '../../components/ui/MobileTabBar.tsx');
const MOBILE_FAB_PATH = path.resolve(TEST_DIR, '../../components/mobile/MobileFab.tsx');
const APP_STORE_TOKENS_PATH = path.resolve(TEST_DIR, '../appStoreTokens.ts');
const AGENT_LAUNCHER_PATH = path.resolve(TEST_DIR, '../../pages/AgentLauncherPage.tsx');
const HOME_LAUNCHER_STYLES_PATH = path.resolve(TEST_DIR, '../../styles/home-launcher.css');

function readSourceTree(directory: string): string {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return readSourceTree(entryPath);
      return /\.(?:ts|tsx|css)$/.test(entry.name) ? fs.readFileSync(entryPath, 'utf8') : '';
    })
    .join('\n');
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

interface RgbaColor { r: number; g: number; b: number; a: number }

function parseCssColor(value: string): RgbaColor {
  const normalized = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return {
      r: Number.parseInt(normalized.slice(1, 3), 16),
      g: Number.parseInt(normalized.slice(3, 5), 16),
      b: Number.parseInt(normalized.slice(5, 7), 16),
      a: 1,
    };
  }
  const match = normalized.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) throw new Error(`不支持的颜色格式: ${value}`);
  const channels = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
  return { r: channels[0], g: channels[1], b: channels[2], a: channels[3] ?? 1 };
}

function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

function colorToHex(color: RgbaColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')}`;
}

function tokenValue(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`缺少主题 token: --${name}`);
  return match[1].trim();
}

function contrastOnLayer(block: string, foregroundName: string, layerName?: string): number {
  const base = parseCssColor(tokenValue(block, 'bg-base'));
  const card = composite(parseCssColor(tokenValue(block, 'bg-card')), base);
  const layer = layerName ? composite(parseCssColor(tokenValue(block, layerName)), card) : card;
  const foreground = composite(parseCssColor(tokenValue(block, foregroundName)), layer);
  return contrastRatio(colorToHex(foreground), colorToHex(layer));
}

describe('主题系统契约', () => {
  it('默认配置只向用户暴露外观和材质的稳定预设', () => {
    expect(DEFAULT_THEME_CONFIG).toMatchObject({
      version: 1,
      colorDepth: 'default',
      opacity: 'default',
      enableGlow: true,
      sidebarGlass: 'always',
      material: 'solid',
    });
    expect(MATERIAL_OPTIONS.map((item) => item.value)).toEqual(['solid', 'glass']);
  });

  it('存量个性化字段会被归一化，兼容数据不再成为第二份样式来源', () => {
    const legacyConfig: ThemeConfig = {
      ...DEFAULT_THEME_CONFIG,
      colorDepth: 'lighter',
      opacity: 'translucent',
      enableGlow: false,
      sidebarGlass: 'never',
      material: 'glass',
    };

    expect(normalizeThemeConfig(legacyConfig)).toMatchObject({
      colorDepth: 'default',
      opacity: 'default',
      enableGlow: true,
      sidebarGlass: 'always',
      material: 'glass',
    });
  });

  it('强调色配置保持统一结构', () => {
    Object.values(ACCENT_STYLES).forEach((accent) => {
      expect(accent.bg).toMatch(/^rgba\(/);
      expect(accent.border).toMatch(/^rgba\(/);
      expect(accent.text).toMatch(/^rgba\(/);
    });
  });

  it('tokens.css 是明暗主题与材质视觉值的唯一契约', () => {
    const tokens = fs.readFileSync(TOKENS_PATH, 'utf8');
    const darkBlock = tokens.slice(0, tokens.indexOf('[data-theme="light"]'));
    const lightBlock = tokens.slice(
      tokens.indexOf('[data-theme="light"]'),
      tokens.indexOf('/* 固定暗色可视化表面'),
    );
    const artworkTokenPattern = /--agent-card-artwork-[^:]+:\s*url\('\.\.\/assets\/agent-card-art\/[^']+\.webp'\);/g;

    expect(tokens).toContain('[data-material="solid"]');
    expect(lightBlock).toContain('--bg-base:');
    const expectedArtworkCount = new Set([
      ...BUILTIN_TOOLS.map((item) => item.agentKey),
      ...buildStaticAgents().map((item) => item.agentKey),
    ]).size;
    expect(darkBlock.match(artworkTokenPattern)).toHaveLength(expectedArtworkCount);
    expect(lightBlock.match(artworkTokenPattern)).toHaveLength(expectedArtworkCount);
    expect(lightBlock.match(/agent-card-art\/[a-z-]+-light\.webp/g)).toHaveLength(expectedArtworkCount);
    expect(lightBlock).toContain('--media-art-filter:');
    expect(lightBlock).toContain('--media-art-wash: linear-gradient(135deg, transparent, transparent)');
    expect(lightBlock).toContain('--text-on-media:');
    expect(lightBlock).not.toContain('brightness(1.48)');
    expect(lightBlock).not.toMatch(/#fff(?:fff)?\b/i);
    expect(lightBlock).not.toContain('rgba(255, 255, 255');
    expect(lightBlock).not.toContain('!important');
  });

  it('正文与选择态文字在明暗卡片表面均满足 WCAG AA', () => {
    const tokens = fs.readFileSync(TOKENS_PATH, 'utf8');
    const blocks = [
      tokens.slice(0, tokens.indexOf('[data-theme="light"]')),
      tokens.slice(tokens.indexOf('[data-theme="light"]'), tokens.indexOf('/* 固定暗色可视化表面')),
    ];

    for (const block of blocks) {
      expect(contrastOnLayer(block, 'text-primary')).toBeGreaterThanOrEqual(4.5);
      expect(contrastOnLayer(block, 'text-secondary')).toBeGreaterThanOrEqual(4.5);
      expect(contrastOnLayer(block, 'text-muted')).toBeGreaterThanOrEqual(4.5);
      expect(contrastOnLayer(block, 'accent-primary')).toBeGreaterThanOrEqual(4.5);
      expect(contrastOnLayer(block, 'selection-text', 'selection-bg')).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('浅色主题将品牌交互与信息语义分离，普通操作不回退为信息蓝', () => {
    const tokens = fs.readFileSync(TOKENS_PATH, 'utf8');
    const lightBlock = tokens.slice(
      tokens.indexOf('[data-theme="light"]'),
      tokens.indexOf('/* 固定暗色可视化表面'),
    );
    const documentStore = fs.readFileSync(DOCUMENT_STORE_PATH, 'utf8');
    const docBrowser = fs.readFileSync(DOC_BROWSER_PATH, 'utf8');

    expect(tokenValue(lightBlock, 'accent-primary')).toBe('#A64B35');
    expect(tokenValue(lightBlock, 'accent-primary')).not.toBe(tokenValue(lightBlock, 'semantic-info-text'));
    expect(tokenValue(lightBlock, 'selection-text')).toBe('#8F3F2B');
    expect(documentStore).not.toContain('focus-visible:ring-blue-400/60');
    expect(docBrowser).not.toContain('group-hover/resize:bg-[rgba(59,130,246');
  });

  it('更新中心和文档目录只消费共享阴影与选择态契约', () => {
    const changelog = fs.readFileSync(CHANGELOG_DYNAMIC_PATH, 'utf8');
    const docBrowser = fs.readFileSync(DOC_BROWSER_PATH, 'utf8');
    const backlinksPanel = fs.readFileSync(BACKLINKS_PANEL_PATH, 'utf8');

    expect(changelog).toContain('var(--shadow-floating-badge)');
    expect(changelog).toContain('var(--shadow-floating-badge-hot)');
    expect(changelog).not.toMatch(/box-shadow:\s*0\s+\d+px\s+\d+px\s+rgba/);
    expect(docBrowser).toContain("'var(--selection-bg)'");
    expect(docBrowser).toContain("'var(--selection-text)'");
    expect(docBrowser).toContain("'var(--selection-checkbox-bg)'");
    expect(docBrowser).not.toContain("'rgba(18,18,24,0.96)'");
    expect(backlinksPanel).toContain("color: 'var(--text-muted)'");
    expect(backlinksPanel).toContain("background: 'var(--semantic-info-bg)'");
    expect(backlinksPanel).not.toMatch(/rgba\(255\s*,\s*255\s*,\s*255/);
  });

  it('阅读面、标签、共享悬浮窗与创作者筛选只消费主题 token', () => {
    const surface = fs.readFileSync(SURFACE_PATH, 'utf8');
    const glassStyles = fs.readFileSync(GLASS_STYLES_PATH, 'utf8');
    const tagPalette = fs.readFileSync(TAG_PALETTE_PATH, 'utf8');
    const shareDock = fs.readFileSync(SHARE_DOCK_PATH, 'utf8');
    const creatorFilter = fs.readFileSync(CREATOR_FILTER_PATH, 'utf8');
    const readingStart = surface.indexOf('.surface-reading {');
    const readingBlock = surface.slice(readingStart, surface.indexOf('.text-crisp {', readingStart));

    expect(readingBlock).toContain('background: var(--reading-bg)');
    expect(readingBlock).toContain('box-shadow: var(--reading-shadow)');
    expect(readingBlock).not.toMatch(/rgba\(|#[0-9a-f]{3,8}/i);
    expect(surface).toContain('box-shadow: var(--shadow-raised)');
    expect(surface).toContain('box-shadow: var(--shadow-nav)');
    expect(surface).toContain('box-shadow: var(--shadow-surface)');
    expect(surface).toContain('background: var(--nav-surface-bg)');
    expect(glassStyles).toContain("boxShadow: 'var(--shadow-glass-panel)'");
    expect(glassStyles).toContain("boxShadow: 'var(--shadow-glass-bottom-sheet)'");
    expect(glassStyles).not.toMatch(/boxShadow:\s*['"]0\s+\d+px\s+\d+px/);
    expect(tagPalette).toContain("text: 'var(--semantic-info-text)'");
    expect(tagPalette).toContain("dot: 'var(--tag-blue-solid)'");
    expect(tagPalette).not.toMatch(/text:\s*'rgba\(/);
    expect(shareDock).toContain('share-dock__panel');
    expect(shareDock).not.toMatch(/text-white|bg-black|bg-\[#/);
    expect(creatorFilter).toContain("'var(--text-secondary)'");
    expect(creatorFilter).not.toMatch(/rgba\(255\s*,\s*255\s*,\s*255/);
  });

  it('移动端导航不再在组件内复制明暗色，弱文字也必须使用可读 token', () => {
    const mobileTabBar = fs.readFileSync(MOBILE_TAB_BAR_PATH, 'utf8');
    const mobileFab = fs.readFileSync(MOBILE_FAB_PATH, 'utf8');
    const appStoreTokens = fs.readFileSync(APP_STORE_TOKENS_PATH, 'utf8');
    const base = fs.readFileSync(path.resolve(TEST_DIR, '../../styles/base.css'), 'utf8');

    expect(mobileTabBar).not.toContain('useDataTheme');
    expect(mobileTabBar).not.toContain('AS_COLOR');
    expect(mobileTabBar).not.toMatch(/#007aff|rgba\(24,\s*25,\s*28|rgba\(255,\s*255,\s*255,\s*0\.(?:3|35)\)/i);
    expect(mobileTabBar).toContain("labelIdle: 'var(--mobile-tab-idle)'");
    expect(mobileFab).toContain("'var(--mobile-fab-from)'");
    expect(mobileFab).not.toMatch(/#0A84FF|#007aff/i);
    expect(appStoreTokens).not.toMatch(/blue:\s*'#(?:0A84FF|007aff)'/i);
    expect(appStoreTokens).not.toMatch(/labelTertiary:\s*'rgba\([^)]*,\s*0\.30\)'/);
    expect(base).toContain('.text-token-muted-faint { color: var(--text-muted); }');
  });

  it('首页门头使用平衡栅格与真实工作现场，不再复制胶囊式导航', () => {
    const launcher = fs.readFileSync(AGENT_LAUNCHER_PATH, 'utf8');
    const styles = fs.readFileSync(HOME_LAUNCHER_STYLES_PATH, 'utf8');

    expect(launcher).toContain('home-launcher-masthead-grid');
    expect(launcher).toContain('aria-label="首页快捷入口"');
    expect(launcher).toContain('item.progress == null');
    expect(launcher).toContain('回到最近的工作现场');
    expect(launcher).not.toMatch(/className="[^"]*home-launcher-(?:quick-link|recent)(?=\s)[^"]*\brounded-full\b/);
    expect(styles).toContain("grid-template-areas: 'intro command learning'");
    expect(styles).toContain('grid-template-columns: repeat(5, minmax(0, 1fr))');
    expect(styles).toContain('.home-launcher-quick-nav--4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }');
    expect(styles).toContain('.home-launcher-quick-nav--5 .home-launcher-quick-link:nth-child(4)');
    expect(styles).toContain('scroll-snap-type: x proximity');
  });

  it('浅色主题语义文字保持可读，并为固定暗色可视化提供单一表面契约', () => {
    const tokens = fs.readFileSync(TOKENS_PATH, 'utf8');
    const lightBlock = tokens.slice(
      tokens.indexOf('[data-theme="light"]'),
      tokens.indexOf('/* 固定暗色可视化表面'),
    );
    const semanticNames = [
      'success',
      'warning',
      'danger',
      'info',
      'neutral',
      'purple',
      'pink',
      'orange',
      'cyan',
      'indigo',
    ];

    semanticNames.forEach((name) => {
      const match = lightBlock.match(new RegExp(`--semantic-${name}-text:\\s*(#[0-9a-fA-F]{6})`));
      expect(match?.[1]).toBeTruthy();
      expect(contrastRatio(match![1], '#F8F5EF')).toBeGreaterThanOrEqual(4.5);
    });
    expect(lightBlock).toContain('--workflow-accent-text-lightness: 36%');
    const selectionText = lightBlock.match(/--selection-text:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(selectionText).toBeTruthy();
    expect(contrastRatio(selectionText!, '#F8F5EF')).toBeGreaterThanOrEqual(4.5);
    const buttonBackground = lightBlock.match(/--button-primary-bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
    const buttonForeground = lightBlock.match(/--button-primary-fg:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(buttonBackground).toBeTruthy();
    expect(buttonForeground).toBeTruthy();
    expect(contrastRatio(buttonForeground!, buttonBackground!)).toBeGreaterThanOrEqual(4.5);
    expect(tokens).toContain('.surface-tone-dark');
    expect(tokens).toContain('--workflow-accent-text-lightness: 65%');
  });

  it('周报仅保留品牌 token，语义色数值统一归 tokens.css 管理', () => {
    const tokens = fs.readFileSync(TOKENS_PATH, 'utf8');
    const reportColors = fs.readFileSync(REPORT_COLORS_PATH, 'utf8');
    const reportSources = readSourceTree(REPORT_AGENT_DIR);
    const darkBlock = tokens.slice(0, tokens.indexOf('[data-theme="light"]'));
    const lightBlock = tokens.slice(
      tokens.indexOf('[data-theme="light"]'),
      tokens.indexOf('/* 固定暗色可视化表面'),
    );

    ['accent', 'status-done', 'status-going', 'status-idle'].forEach((name) => {
      expect(darkBlock).toContain(`--report-${name}:`);
      expect(lightBlock).toContain(`--report-${name}:`);
    });
    expect(reportColors).toContain('var(--semantic-${token}-text)');
    expect(reportColors).toContain('var(${prefix})');
    expect(reportColors).not.toMatch(/rgba\(|#[0-9a-fA-F]{3,8}/);
    expect(reportColors).not.toContain('if (isLight)');
    expect(reportSources).not.toMatch(/isLight\s*\?\s*['"]#(?:fff|ffffff)['"]/i);
    expect(reportSources).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('关键自适应入口禁止回退为固定暗色表面或低对比小字', () => {
    const agentSwitcher = fs.readFileSync(AGENT_SWITCHER_PATH, 'utf8');
    const button = fs.readFileSync(BUTTON_PATH, 'utf8');
    const documentStore = fs.readFileSync(DOCUMENT_STORE_PATH, 'utf8');
    const surface = fs.readFileSync(SURFACE_PATH, 'utf8');
    const teamActivity = fs.readdirSync(TEAM_ACTIVITY_DIR)
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => fs.readFileSync(path.join(TEAM_ACTIVITY_DIR, name), 'utf8'))
      .join('\n');

    expect(agentSwitcher).toContain('variant="raised"');
    expect(agentSwitcher).toContain('className="surface-backdrop fixed inset-0');
    expect(agentSwitcher).not.toMatch(/rgba\(255\s*,\s*255\s*,\s*255/);
    expect(agentSwitcher).not.toMatch(/linear-gradient\([^\n]*(?:22,\s*23,\s*32|16,\s*17,\s*25)/);
    expect(button).not.toMatch(/LIGHT_STYLES|DARK_STYLES|useDataTheme|\bisLight\b|\bisDark\b/);
    expect(button).toContain('button-${variant}');
    expect(documentStore).not.toContain("color: 'rgba(59,130,246,0.95)'");
    expect(documentStore).toContain("color: 'var(--selection-text)'");
    expect(surface).toMatch(/\.surface-action-danger\s*\{[^}]*var\(--semantic-danger-text\)/s);

    expect(teamActivity).not.toContain('tone="dark"');
    expect(teamActivity).not.toContain('surface-tone-dark');
    expect(teamActivity).not.toMatch(/text-white\/(?:[1-4]?\d|5[0-5])\b/);
    expect(teamActivity).not.toMatch(/bg-\[#(?:0c0d0f|16171a|16171b|1a1c20)\]/i);
  });

  it('设置子页、固定文字与动态文字色都服从自适应表面契约', () => {
    const peerNodes = fs.readFileSync(PEER_NODES_PATH, 'utf8');
    const infraServices = fs.readFileSync(INFRA_SERVICES_PATH, 'utf8');
    const emergenceCard = fs.readFileSync(EMERGENCE_CARD_PATH, 'utf8');

    expect(peerNodes).toContain('className="surface-raised relative overflow-hidden');
    expect(peerNodes).not.toMatch(/linear-gradient\([^\n]*(?:22,\s*27,\s*36|34,\s*42,\s*55)/);
    expect(peerNodes).not.toMatch(/rgba\(255\s*,\s*255\s*,\s*255/);

    expect(infraServices).toContain('text-token-primary');
    expect(infraServices).toContain('className="surface rounded-xl p-5"');
    expect(infraServices).not.toMatch(/text-white(?:\/\d+)?\b/);
    expect(infraServices).not.toMatch(/rgba\(255\s*,\s*255\s*,\s*255|rgba\(0\s*,\s*0\s*,\s*0/);

    expect(emergenceCard).toContain("color: 'var(--text-secondary)'");
    expect(emergenceCard).toContain("background: 'linear-gradient(180deg, transparent, var(--bg-card-hover))'");
    expect(emergenceCard).not.toMatch(/color:\s*hsla?\(/);
  });

  it('有意固定暗色的体验页必须显式声明暗色 scope', () => {
    const cdsAgent = fs.readFileSync(CDS_AGENT_PATH, 'utf8');

    expect(cdsAgent.match(/surface-tone-dark/g)?.length).toBeGreaterThanOrEqual(2);
    expect(cdsAgent.match(/data-surface-tone="dark"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('局部暗色 scope 不得豁免整份文件的主题风险', () => {
    const reportScript = fs.readFileSync(STYLE_DEBT_REPORT_PATH, 'utf8');

    expect(reportScript).toContain('FULL_DARK_SURFACE_FILES.has(relativePath)');
    expect(reportScript).toContain('counts.fixedThemeSurface - counts.declaredDarkScope');
    expect(reportScript).not.toContain('counts.declaredDarkScope > 0\n    ? counts.dynamicTextColor');
  });

  it('风险扫描外扩发现的普通管理页保持自适应，局部暗色弹窗显式隔离', () => {
    const projectRoute = fs.readFileSync(PROJECT_ROUTE_PATH, 'utf8');

    expect(projectRoute).toContain('text-token-primary');
    expect(projectRoute).toContain('className="surface-tone-dark relative rounded-xl');
    expect(projectRoute).toContain('data-surface-tone="dark"');
    expect(projectRoute).not.toMatch(/text-white(?:\/\d+)?\b|bg-white\/\d+|border-white\/\d+/);
  });

  it('周报海报工作台的普通文字随主题切换，固定暗色仅保留在创建弹窗与媒体内容', () => {
    const weeklyPoster = fs.readFileSync(WEEKLY_POSTER_PATH, 'utf8');

    expect(weeklyPoster).toContain('className={`${rootClass} relative overflow-hidden text-token-primary');
    expect(weeklyPoster).toContain('className="surface-tone-dark fixed inset-0');
    expect(weeklyPoster).toContain("color: 'var(--semantic-success-text)'");
    expect(weeklyPoster).not.toMatch(/text-white\/\d+/);
  });

  it('浏览器双主题矩阵覆盖所有设置 tab 与关键交互状态', () => {
    const settingsPage = fs.readFileSync(SETTINGS_PAGE_PATH, 'utf8');
    const tabBlock = settingsPage.slice(
      settingsPage.indexOf('const tabs = useMemo'),
      settingsPage.indexOf('const tabFromUrl'),
    );
    const settingsTabs = Array.from(tabBlock.matchAll(/key:\s*'([^']+)'/g), (match) => match[1]).sort();
    const coveredSettingsTabs = THEME_ACCEPTANCE_TARGETS
      .map((target) => new URL(target.path, 'https://theme-acceptance.local'))
      .filter((url) => url.pathname === '/settings')
      .map((url) => url.searchParams.get('tab'))
      .filter((tab): tab is string => Boolean(tab))
      .sort();

    expect(coveredSettingsTabs).toEqual(settingsTabs);
    THEME_ACCEPTANCE_TARGETS.forEach((target) => {
      expect(target.themes).toEqual(['dark', 'light']);
      expect(target.states.length).toBeGreaterThan(0);
    });
    expect(THEME_ACCEPTANCE_TARGETS.find((target) => target.id === 'command-palette')?.states)
      .toContain('keyboard-overlay-open');
    expect(THEME_ACCEPTANCE_TARGETS.find((target) => target.id === 'emergence')?.states)
      .toContain('hover-primary-card');
    ['web-pages', 'showcase', 'library', 'open-platform'].forEach((id) => {
      expect(THEME_ACCEPTANCE_TARGETS.some((target) => target.id === id)).toBe(true);
    });
  });

  it('测试与正式镜像共用同一构建入口，并完整复制浅色插画产物', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ADMIN_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const dockerfile = fs.readFileSync(path.join(ADMIN_ROOT, 'Dockerfile'), 'utf8');
    const artworkDir = path.join(ADMIN_ROOT, 'src/assets/agent-card-art');
    const lightArtwork = fs.readdirSync(artworkDir).filter((name) => name.endsWith('-light.webp'));

    expect(packageJson.scripts.build).toBe('tsc && vite build');
    expect(dockerfile).toContain('pnpm run build');
    expect(dockerfile).toContain('COPY --from=builder /app/dist ./dist');
    expect(lightArtwork).toHaveLength(new Set([
      ...BUILTIN_TOOLS.map((item) => item.agentKey),
      ...buildStaticAgents().map((item) => item.agentKey),
    ]).size);
  });

  it('移动端兼容提示复用跨主题语义色与固定暗色表面契约', () => {
    const gate = fs.readFileSync(MOBILE_COMPAT_GATE_PATH, 'utf8');

    expect(gate).toContain("color: 'var(--semantic-warning-text)'");
    expect(gate).toContain('className="surface-tone-dark w-full max-w-md rounded-2xl p-5"');
    expect(gate).toContain('data-surface-tone="dark"');
    expect(gate).not.toContain("color: 'rgba(255, 236, 179");
  });
});
