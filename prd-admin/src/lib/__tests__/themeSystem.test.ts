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
const CHANGELOG_PAGE_PATH = path.resolve(TEST_DIR, '../../pages/changelog/ChangelogPage.tsx');
const DOC_BROWSER_PATH = path.resolve(TEST_DIR, '../../components/doc-browser/DocBrowser.tsx');
const BACKLINKS_PANEL_PATH = path.resolve(TEST_DIR, '../../components/doc-browser/BacklinksPanel.tsx');
const SHARE_DOCK_PATH = path.resolve(TEST_DIR, '../../components/share-dock/ShareDock.tsx');
const CREATOR_FILTER_PATH = path.resolve(TEST_DIR, '../../components/showcase/CreatorFilterRow.tsx');
const TAG_PALETTE_PATH = path.resolve(TEST_DIR, '../tagPalette.ts');
const MOBILE_TAB_BAR_PATH = path.resolve(TEST_DIR, '../../components/ui/MobileTabBar.tsx');
const MOBILE_FAB_PATH = path.resolve(TEST_DIR, '../../components/mobile/MobileFab.tsx');
const APP_STORE_TOKENS_PATH = path.resolve(TEST_DIR, '../appStoreTokens.ts');
const AGENT_LAUNCHER_PATH = path.resolve(TEST_DIR, '../../pages/AgentLauncherPage.tsx');
const MOBILE_HOME_PATH = path.resolve(TEST_DIR, '../../pages/MobileHomePage.tsx');
const MOBILE_HOME_SHARED_PATH = path.resolve(TEST_DIR, '../../pages/mobile-home/shared.ts');
const HOME_LAUNCHER_STYLES_PATH = path.resolve(TEST_DIR, '../../styles/home-launcher.css');
const ADAPTIVE_SHARED_CONTROL_PATHS = [
  '../../components/FeatureModuleSearchSelect.tsx',
  '../../components/ItemMultiSearchSelect.tsx',
  '../../components/ItemSearchSelect.tsx',
  '../../components/MentionTextarea.tsx',
  '../../components/UserMultiSearchSelect.tsx',
  '../../components/UserSearchSelect.tsx',
  '../../components/notifications/NotificationSubscriptionsPanel.tsx',
  '../../pages/channels/components/TaskDetailDrawer.tsx',
] as const;

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

  it('surface-tone-dark 必须覆盖岛内真实用到的每个主题相关 token', () => {
    /*
     * 暗岛（钉死深色的局部区域）只覆盖一部分 token 会静默翻车：
     * 文字翻回近白、底色仍是浅色档的值 —— 近白字压近白底，几乎不可读。
     *
     * 判据换过一次，值得记：第一版按**族名清单**判（bg/panel/text/border/glass…），
     * 结果 --overlay-panel-solid 以 overlay 开头、不在清单里，UniverseGraphPage
     * 的提示面板照样糊（Codex 在 PR #1374 连抓两轮，同一个「判据太窄」）。
     * 族名清单是猜的，会漏；**消费关系是真的**。
     *
     * 现判据：凡「两个主题取值不同」且「被任何带 surface-tone-dark 的文件用 var() 消费」
     * 的 token，暗岛必须覆盖。新写一个暗岛并用到某个主题相关 token 时，这条会自动收紧。
     */
    const css = fs.readFileSync(TOKENS_PATH, 'utf8');
    const blockOf = (head: string) => {
      const i = css.indexOf(head);
      expect(i, `找不到 ${head}`).toBeGreaterThan(-1);
      const j = css.indexOf('\n}', i);
      return new Map([...css.slice(i, j).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
        .map((m) => [m[1], m[2].trim()] as const));
    };
    const root = blockOf(':root {');
    const light = blockOf('[data-theme="light"] {');
    const island = blockOf('.surface-tone-dark {');
    const themed = [...light].filter(([k, v]) => root.has(k) && root.get(k) !== v).map(([k]) => k);

    // 找出所有带 surface-tone-dark 的源文件，看它们真实消费了哪些未覆盖的主题 token
    const islandFiles: string[] = [];
    const walkSrc = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        // 测试目录要排掉：本文件自己就写着 surface-tone-dark（就是这条用例），
        // 又在别处断言里引用了一堆 var(--xxx)，不排就会把自己算成暗岛消费方、凭空多报。
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walkSrc(full); continue; }
        if (!/\.(tsx?|css)$/.test(e.name)) continue;
        // tokens.css 是 token 的**定义**处，不是暗岛的消费方。
        // 它自己就写着 .surface-tone-dark，不排掉的话它内部的 var() 引用会被
        // 当成「岛内有人在用」，判据凭空多报十几个。
        if (full === TOKENS_PATH) continue;
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes('surface-tone-dark')) islandFiles.push(text);
      }
    };
    walkSrc(path.resolve(TEST_DIR, '../..'));

    const missing = themed
      .filter((t) => !island.has(t))
      .filter((t) => islandFiles.some((text) => text.includes(`var(${t}`)))
      .sort();

    expect(
      missing.length
        ? `surface-tone-dark 缺这些 token，而暗岛内确实有元素在用，浅色档下会「近白字压近白底」：\n  ${missing.join('\n  ')}\n`
          + '补上 :root 里的对应值即可。'
        : '',
    ).toBe('');
  });

  it('强调色配置保持统一结构：底是淡色调、字走双写 token', () => {
    Object.values(ACCENT_STYLES).forEach((accent) => {
      // 底与描边保持低透明度同色调 —— 这一层在两个主题下都成立
      expect(accent.bg).toMatch(/^rgba\(/);
      expect(accent.border).toMatch(/^rgba\(/);
      /*
       * 字必须走 --accent-fg-*，不许再写 rgba 字面量。
       * 这条断言原本写的是 `toMatch(/^rgba\(/)` —— 逐字要求那个**错误**实现存在：
       * 底是 8% 淡色调、字写死 500 档，浅色主题下两层一起被暖纸底稀释，
       * 就是全站最高频的「浅字压浅底」。谁去修这个 bug，谁的 CI 先红。
       * 现在改成断言正确规则，让判据站在修复这一侧。
       */
      expect(accent.text).toMatch(/^var\(--accent-fg-[a-z-]+\)$/);
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
    /*
     * 浅色档禁止近白值——但纸面类介质（缩略图假页渐变、预览窗、二维码底）在设计稿里
     * 本来就是纯白纸，那不是「浅字压浅底」的来源。所以只放行显式点名的介质 token，
     * 其余一律照旧拦下：把这几行注释掉再跑，仍会因为别处的 #fff 变红。
     */
    const PAPER_MEDIA_TOKENS = ['--thumb-gradient'];
    const lightBlockWithoutPaper = lightBlock
      .split('\n')
      .filter((line) => !PAPER_MEDIA_TOKENS.some((t) => line.trim().startsWith(t)))
      .join('\n');
    expect(lightBlockWithoutPaper).not.toMatch(/#fff(?:fff)?\b/i);
    expect(lightBlockWithoutPaper).not.toContain('rgba(255, 255, 255');
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

  it('知识库卡片的迷你目录在明暗主题下都使用可见的嵌套面和分隔线', () => {
    const tokens = fs.readFileSync(TOKENS_PATH, 'utf8');
    const themeBlocks = [
      tokens.slice(0, tokens.indexOf('[data-theme="light"]')),
      tokens.slice(tokens.indexOf('[data-theme="light"]'), tokens.indexOf('/* 固定暗色可视化表面')),
    ];
    const documentStore = fs.readFileSync(DOCUMENT_STORE_PATH, 'utf8');

    for (const block of themeBlocks) {
      expect(parseCssColor(tokenValue(block, 'border-subtle')).a).toBeGreaterThanOrEqual(0.1);
      expect(parseCssColor(tokenValue(block, 'nested-block-border')).a).toBeGreaterThanOrEqual(0.08);
    }
    expect(documentStore).toContain('className="surface-inset rounded-[9px] overflow-hidden"');
    expect(documentStore).toContain("'border-t border-token-subtle'");
    expect(documentStore).toContain('hover:bg-[var(--bg-card-hover)]');
    expect(documentStore).not.toMatch(/\bhover:bg-white(?:\/|\b)/);
    expect(documentStore).not.toMatch(/(?:border(?:Color)?|background)\s*:\s*['"`]rgba\(\s*255\s*,\s*255\s*,\s*255/);
    expect(documentStore).not.toContain("background: 'rgba(255,255,255,0.025)'");
    expect(documentStore).not.toContain("borderTop: idx === 0 ? 'none' : '1px solid rgba(255,255,255,0.05)'");
  });

  it('跨页面共享的搜索、通知和任务控件不绕过自适应主题 token', () => {
    for (const relativePath of ADAPTIVE_SHARED_CONTROL_PATHS) {
      const source = fs.readFileSync(path.resolve(TEST_DIR, relativePath), 'utf8');

      expect(source, relativePath).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255/);
      expect(source, relativePath).not.toMatch(/\b(?:border|bg)-white(?:\/|\b)|\bhover:bg-white(?:\/|\b)/);
      expect(source, relativePath).not.toMatch(/#[01][0-9a-f]{5}\b/i);
    }
  });

  it('更新中心和文档目录只消费共享阴影与选择态契约', () => {
    const changelog = fs.readFileSync(CHANGELOG_DYNAMIC_PATH, 'utf8');
    const changelogPage = fs.readFileSync(CHANGELOG_PAGE_PATH, 'utf8');
    const docBrowser = fs.readFileSync(DOC_BROWSER_PATH, 'utf8');
    const backlinksPanel = fs.readFileSync(BACKLINKS_PANEL_PATH, 'utf8');
    const registryStart = changelogPage.indexOf('const TYPE_BADGE_REGISTRY');
    const registryEnd = changelogPage.indexOf('const CHANGELOG_TYPE_ORDER', registryStart);
    const typeBadgeRegistry = changelogPage.slice(registryStart, registryEnd);

    expect(changelog).toContain('var(--shadow-floating-badge)');
    expect(changelog).toContain('var(--shadow-floating-badge-hot)');
    expect(changelog).toContain('color: var(--bg-base)');
    expect(changelog).not.toMatch(/box-shadow:\s*0\s+\d+px\s+\d+px\s+rgba/);
    expect(typeBadgeRegistry).toContain("color: 'var(--semantic-orange-text)'");
    expect(typeBadgeRegistry).toContain("color: 'var(--semantic-indigo-text)'");
    expect(typeBadgeRegistry).not.toMatch(/#[0-9a-f]{3,8}|rgba\(/i);
    expect(changelogPage).not.toMatch(/color:\s*'(?:#86efac|#fdba74|#fca5a5|#fcd34d|#cbd5e1|#f0abfc|#bfdbfe|#7dd3fc|#dbeafe|#a5b4fc)'/i);
    expect(changelogPage).not.toMatch(/rgba\(255\s*,\s*255\s*,\s*255/);
    expect(changelogPage).not.toContain("background: 'rgba(30, 30, 40, 0.98)'");
    expect(changelogPage).toContain('className="surface-popover');
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

  it('首页工位：密度优先、靠面分区、在办工作诚实', () => {
    const launcher = fs.readFileSync(AGENT_LAUNCHER_PATH, 'utf8');
    const styles = fs.readFileSync(HOME_LAUNCHER_STYLES_PATH, 'utf8');

    expect(launcher).toContain('aria-label="首页快捷入口"');
    // 诚实进度：没有状态机的实体不画进度条（不允许拿 0 或 100 顶替）
    expect(launcher).toContain('item.progress == null');
    // 空态给引导，不给空盒（guided-exploration）
    expect(launcher).toContain('还没有进行中的工作');
    // 上层只有一个容器：台面。命令条 / 用量 / 常去 / 在办 / 动态都在它里面
    expect(launcher).toContain('home-desk-deck');
    expect(styles).toContain('.home-desk-deck {');
    expect(styles).toContain('background: var(--home-panel-bg)');
    // 「全是线条」被明确否掉：不得再出现贯通全宽的装饰横线（flex:1 的 1px 高元素）
    expect(styles).not.toMatch(/\.home-desk-rule\b/);
    // 近 7 日与移动首页同一份数据源，不许各拉各的
    expect(launcher).toContain("from '@/lib/homePulse'");
  });

  it('两端跳转都只有一个出口，打开次数不会漏记', () => {
    // 「你常用的」只认 agentSwitcherStore 的打开次数：漏一个记账点，那条路径
    // 的启动就永远不计数（历史上先漏桌面瓦片、再漏在办工作条，最后漏掉整个
    // 移动首页——桌面收敛成一个出口之后，手机上点开的智能体照旧不计数）。
    // 结构上焊死：两个首页都不许出现裸 navigate(，一律走 useTrackedNavigate。
    const tracker = fs.readFileSync(path.resolve(TEST_DIR, '../useTrackedNavigate.ts'), 'utf8');
    expect(tracker).toMatch(/addRecentVisit\([\s\S]*?\}\);[\s\S]*?navigate\(route\)/);

    for (const [name, file] of [['桌面首页', AGENT_LAUNCHER_PATH], ['移动首页', MOBILE_HOME_PATH]] as const) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${name}没走带记账的跳转出口`).toContain('useTrackedNavigate');
      expect(source.match(/\bnavigate\(/g) ?? [], `${name}还有裸 navigate 调用，那条路径的启动不会计数`).toHaveLength(0);
    }
  });

  it('首页取数失败不许渲染成「你什么都没干过」', () => {
    const launcher = fs.readFileSync(AGENT_LAUNCHER_PATH, 'utf8');

    // 纯函数那侧的判据在 homePulse.test.ts；这里管接线——
    // 失败标记算出来了却没人渲染，等于没修（predicate-and-wiring 形状 2）。
    expect(launcher).toContain('pulse.statsFailed');
    expect(launcher).toContain('pulse.feedFailed');
    // 失败且手上无数据时显示占位而不是 0
    expect(launcher).toMatch(/statsUnavailable[\s\S]{0,200}?return '--'/);
    // 动态的失败态要给重试，不能只是换句话说
    expect(launcher).toMatch(/pulse\.feed\.length === 0 \?[\s\S]{0,400}?\{feedNotice\}[\s\S]{0,200}?onClick=\{pulse\.reload\}/);
    // 两个端点各自成败：用量单独挂了也要有看得见的说明 + 重试。
    // 只挂 title 不算——触屏没有悬停，等于什么都没说。
    expect(launcher).toMatch(/pulse\.statsFailed && \([\s\S]{0,400}?onClick=\{pulse\.reload\}/);
    // 留着旧列表时也要说清它是旧的：默不作声地把过期数据当现状展示，
    // 和显示 0 是同一类谎话，只是更难被发现。
    expect(launcher).toMatch(/feedNotice && pulse\.feed\.length > 0 && \([\s\S]{0,400}?onClick=\{pulse\.reload\}/);
    // 后端 200 但某来源查挂了（HTTP 成功 + 少一半数据）也必须有出口
    expect(launcher).toContain('pulse.feedDegraded');

    // 打开次数是服务端持久化的，必须有人在登录后把它拉下来。少了这一步：
    // 换设备 / 开新标签页时「你常用的」从零开始，而且 scheduleSync 在
    // serverLoaded 为 false 时不回写（防空态覆盖云端），新会话的启动全留在本地。
    // 当前由 AppShell 一个 useEffect 承担——它删掉不会有任何测试变红，故焊在这里。
    const shell = fs.readFileSync(path.resolve(TEST_DIR, '../../layouts/AppShell.tsx'), 'utf8');
    const bound = shell.match(/const (\w+) = useAgentSwitcherStore\(\(s\) => s\.loadFromServer\)/)?.[1];
    expect(bound, 'AppShell 没有取 agentSwitcherStore.loadFromServer').toBeTruthy();
    expect(shell, `AppShell 取了 ${bound} 却没调用它——打开次数不会从服务端水合`).toMatch(
      new RegExp(`${bound}\\(\\)`),
    );

    // 「手边的活儿」同理：store 以前把失败吞成空列表（当时区块整块隐藏，尚可），
    // 首页改版后空态会明说「还没有进行中的工作」，同一个吞法就变成了骗人。
    const recentStore = fs.readFileSync(path.resolve(TEST_DIR, '../../stores/homeRecentWorkStore.ts'), 'utf8');
    expect(recentStore, 'recent-work store 没有失败态，失败会被吞成空列表').toMatch(/failed:\s*true/);
    // 只断言"出现过 workFailed"是不够的：把加载/失败分支整段删掉、只留下面那条
    // 旧数据提示，这两个名字照样在文件里（实测这么改守卫仍绿）。要焊的是
    // **空态引导被 loading/failed 挡在后面**这件事本身。
    // 用位置关系判，不用"相隔多少字符"：中间隔着整个列表分支，距离窗口一调就
    // 要么误报要么漏判。要焊的是**空态引导排在加载/失败判断之后**这个次序。
    const guardAt = launcher.indexOf('workItems.length === 0 && (workLoading || workFailed)');
    const emptyCopyAt = launcher.indexOf('还没有进行中的工作');
    expect(guardAt, '「手边的活儿」没有先判加载中/取不到').toBeGreaterThan(-1);
    expect(emptyCopyAt, '找不到空态引导文案，判据失效').toBeGreaterThan(-1);
    expect(guardAt, '空态引导排在了加载/失败判断前面，加载中和故障都会被说成"没活干"').toBeLessThan(emptyCopyAt);
    expect(launcher).toMatch(/workFailed[\s\S]{0,400}?onClick=\{\(\) => loadRecentWork\(\{ force: true \}\)\}/);

    // 移动端必须走同一个 hook：各拉各的就会出现「桌面修好了、手机还在骗人」，
    // 也会让「两端共用一份数据」这句话变成假话（changelog 曾据此写错）。
    const mobileShared = fs.readFileSync(MOBILE_HOME_SHARED_PATH, 'utf8');
    expect(mobileShared).toMatch(/import \{ useHomePulse \} from '@\/lib\/homePulse'/);
    expect(mobileShared).not.toMatch(/getMobileStats\(|getMobileFeed\(/);

    const mobileHome = fs.readFileSync(MOBILE_HOME_PATH, 'utf8');
    expect(mobileHome).toMatch(/data\.statsFailed && \([\s\S]{0,500}?onClick=\{data\.reload\}/);
    expect(mobileHome).toMatch(/data\.feed\.length === 0 && feedNotice \?[\s\S]{0,600}?onClick=\{data\.reload\}/);
    expect(mobileHome).toMatch(/feedNotice && data\.feed\.length > 0 && \([\s\S]{0,500}?onClick=\{data\.reload\}/);
    expect(mobileHome).toContain('data.feedDegraded');
  });

  it('类别色文字在两个主题下都撑得住 10px 正文', async () => {
    // 「手边的活儿」的状态标是 10px、底色是 --nested-block-bg、前景是 lib/tileAccent
    // 的 Accent.text（hsl(色相 48% var(--workflow-accent-text-lightness))）。
    // 正文级要 4.5:1。逐色相真算，不记死一个数——将来加色相或调明度都会被这条挡住。
    const { INK_HUES } = await import('../tileAccent');
    const tokens = fs.readFileSync(TOKENS_PATH, 'utf8');
    const darkBlock = tokens.slice(0, tokens.indexOf('[data-theme="light"]'));
    const lightBlock = tokens.slice(tokens.indexOf('[data-theme="light"]'));

    const hslToHex = (h: number, s: number, l: number): string => {
      const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
      const channel = (n: number) => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
      };
      return colorToHex({ r: channel(0), g: channel(8), b: channel(4), a: 1 });
    };

    for (const [theme, block] of [['暗色', darkBlock], ['浅色', lightBlock]] as const) {
      const lightness = Number.parseFloat(tokenValue(block, 'workflow-accent-text-lightness'));
      expect(Number.isFinite(lightness), `${theme}主题缺 --workflow-accent-text-lightness`).toBe(true);

      const base = parseCssColor(tokenValue(block, 'bg-base'));
      const card = composite(parseCssColor(tokenValue(block, 'bg-card')), base);
      const surface = colorToHex(composite(parseCssColor(tokenValue(block, 'nested-block-bg')), card));

      for (const [name, hue] of Object.entries(INK_HUES)) {
        const ratio = contrastRatio(hslToHex(hue, 48, lightness), surface);
        expect(ratio, `${theme}主题：${name}（色相 ${hue}）的类别色文字只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('回车快捷键必须放过输入法选词', () => {
    // 中文用户敲「视觉」按回车本意是上屏候选词，若不判 isComposing，
    // 那一下会被当成「打开第一项」直接把页面跳走。中文是这个系统的主力输入方式，
    // 所以两个首页里任何 Enter 快捷键都必须先放过组字中的回车。
    // 扫之前先剥注释：第一版直接 toContain('isComposing')，而我自己写的那行
    // 中文注释里就有这个词——把判断整行删掉，守卫照样绿（实测）。
    const stripComments = (source: string) => source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

    for (const [name, file] of [['桌面首页', AGENT_LAUNCHER_PATH], ['移动首页', MOBILE_HOME_PATH]] as const) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (!code.includes("e.key === 'Enter'")) continue;
      expect(code, `${name}有 Enter 快捷键却没判 isComposing，输入法选词会误触发`).toMatch(/isComposing/);
    }
  });

  it('品牌主渐变的每一档都能撑住它自己的文字色', async () => {
    // 取模块求值结果而不是扫源码：渐变值可能被改成模板字面量 / 拼接，
    // 扫字面量会在那一刻静默失效（predicate-and-wiring 形状 6）。
    const { HERO_GRADIENT, HERO_GRADIENT_FG } = await import('../../pages/home/sections/HeroSection');

    const stops = [...HERO_GRADIENT.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]);
    expect(stops.length, 'HERO_GRADIENT 里没解析到色标，判据已经失效').toBeGreaterThanOrEqual(2);

    // 文字色是 token 引用，判据必须落到两个主题各自的真实值上：
    // 只算暗色那份的话，改浅色 --button-primary-fg 能把 CTA 弄哑而守卫全绿。
    const tokenName = HERO_GRADIENT_FG.match(/var\(--([a-z0-9-]+)/i)?.[1];
    expect(tokenName, 'HERO_GRADIENT_FG 不再是 token 引用，判据取不到真实值').toBeTruthy();

    const tokens = fs.readFileSync(TOKENS_PATH, 'utf8');
    const darkBlock = tokens.slice(0, tokens.indexOf('[data-theme="light"]'));
    const lightBlock = tokens.slice(tokens.indexOf('[data-theme="light"]'));

    // CTA 标签是 13-15px 正文级，走 4.5:1。渐变最暗那档最吃紧——
    // 起点从 #C8623A 抬到 #CE6B41 就是为了让它过线，别再改回去。
    for (const [theme, block] of [['暗色', darkBlock], ['浅色', lightBlock]] as const) {
      const foreground = tokenValue(block, tokenName!);
      for (const stop of stops) {
        const ratio = contrastRatio(foreground, stop);
        expect(ratio, `${theme}主题：HERO_GRADIENT 色标 ${stop} 对 ${foreground} 只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('首页目录默认展示全部三组，分段筛选不得让任何入口从首页消失', () => {
    const launcher = fs.readFileSync(AGENT_LAUNCHER_PATH, 'utf8');

    // 默认筛选必须是 all —— 否则「基础设施」这类入口会在首页隐身，
    // 违反 navigation-registry「即使侧边栏隐藏了它们，首页仍稳定出现」。
    expect(launcher).toContain("useState<CatalogFilter>('all')");
    // 三组来自同一份定义，分段筛选器与组标签不得各写一份
    expect(launcher).toMatch(/const CATALOG_GROUPS: CatalogGroupMeta\[\]/);
    expect(launcher).toContain("catalogFilter === 'all' || catalogFilter === g.key");
    // 搜索横跨三组，不受当前分段影响
    expect(launcher).toContain('[...groups.agents, ...groups.tools, ...groups.infra]');
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
    // 明度具体取多少由「类别色文字」那条按真实叠底算，这里只要求浅色主题**有**这个覆盖
    // （记死一个百分比就是把判据写成了当时那个数——36% 实测五个色相不达标）
    expect(lightBlock).toMatch(/--workflow-accent-text-lightness:\s*\d+%/);
    const selectionText = lightBlock.match(/--selection-text:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(selectionText).toBeTruthy();
    expect(contrastRatio(selectionText!, '#F8F5EF')).toBeGreaterThanOrEqual(4.5);
    const buttonBackground = lightBlock.match(/--button-primary-bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
    const buttonForeground = lightBlock.match(/--button-primary-fg:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(buttonBackground).toBeTruthy();
    expect(buttonForeground).toBeTruthy();
    expect(contrastRatio(buttonForeground!, buttonBackground!)).toBeGreaterThanOrEqual(4.5);

    // 暗色块同样要过：只查浅色是判据太窄——2026-08-03 换赭红身份色时，
    // 暗色主按钮曾掉到 3.74:1 而测试全绿（Codex review 抓到）。
    const darkOnlyBlock = tokens.slice(0, tokens.indexOf('[data-theme="light"]'));
    for (const block of [darkOnlyBlock, lightBlock]) {
      const bg = block.match(/--button-primary-bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
      const fg = block.match(/--button-primary-fg:\s*(#[0-9a-fA-F]{6})/)?.[1];
      const bgHover = block.match(/--button-primary-bg-hover:\s*(#[0-9a-fA-F]{6})/)?.[1];
      expect(bg && fg && bgHover).toBeTruthy();
      expect(contrastRatio(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(fg!, bgHover!)).toBeGreaterThanOrEqual(4.5);
    }
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
    expect(reportScript).toContain('counts.adaptiveBorderRisk + counts.adaptiveSurfaceRisk + counts.adaptiveHoverRisk');
    expect(reportScript).toContain('Actionable adaptive theme findings');
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
    expect(gate).toContain('className="surface-tone-dark w-full max-w-md rounded-2xl p-5 border border-token-subtle"');
    expect(gate).toContain('data-surface-tone="dark"');
    expect(gate).not.toContain("color: 'rgba(255, 236, 179");
  });
});
