/**
 * 双皮肤硬编码棘轮（Theme Hardcode Ratchet）
 *
 * 背景（2026-07-12 用户：「做一个系统级的双皮肤，从根上解决这类问题」）：
 * tokens.css 的暗/浅双主题 token 早已齐备，问题始终出在组件绕过 token
 * 硬编码颜色——浅色主题下出现「白底浮暗卡」「白透明表面隐形」。
 *
 * 本测试把两类高危硬编码变成棘轮：**每个文件的数量只许减、不许增**。
 *  1. 白透明表面 rgba(255,255,255,x) —— 浅色下隐形/发灰
 *  2. 深色 hex 字面量（感知亮度 < 0.15）—— 浅色下变成漂浮的暗块
 *
 * 存量违例记录在 themeHardcodeBaseline.json（只是债务台账，不是许可）；
 * 新增代码必须走 token（见 .claude/rules/admin-dual-theme.md 的修法映射表）。
 * 确属「暗色专用装饰」（如彩色渐变上的白字、暗色形态的专用皮肤对象）需要
 * 提高某文件基线时，运行：
 *   UPDATE_THEME_BASELINE=1 pnpm vitest run src/lib/__tests__/themeHardcodeRatchet.test.ts
 * 并在 PR 里说明原因。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(TEST_DIR, '../..');
const BASELINE_PATH = path.join(TEST_DIR, 'themeHardcodeBaseline.json');
const SEMANTIC_THEME_CONSUMERS = [
  'components/agent-shell/AgentCardArtwork.tsx',
  'pages/AgentLauncherPage.tsx',
  'pages/ai-toolbox/components/ToolCard.tsx',
  'styles/home-launcher.css',
  'styles/media-card.css',
] as const;

/** 白透明表面（浅色下隐形）。 */
const WHITE_ALPHA_RE = /rgba\(\s*255\s*,\s*255\s*,\s*255/g;
/** 全部 6 位 hex，再按感知亮度过滤出「深色」。 */
const HEX_RE = /#[0-9a-fA-F]{6}\b/g;

/** 感知亮度 < 0.15 视为深色（#101113 ≈ 0.07 命中；#14b8c4 ≈ 0.60 不命中）。 */
function isDarkHex(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.15;
}

/** 跳过的目录/文件：测试、开发样板、mockup。 */
function skipped(rel: string): boolean {
  return (
    rel.includes('__tests__') ||
    rel.includes('/_dev/') ||
    rel.includes('/_mockup/') ||
    rel.endsWith('.test.tsx')
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

interface Counts {
  whiteAlpha: number;
  darkHex: number;
}

function scan(): Record<string, Counts> {
  const result: Record<string, Counts> = {};
  for (const file of walk(SRC_DIR)) {
    const rel = file.slice(SRC_DIR.length).replace(/\\/g, '/');
    if (skipped(rel)) continue;
    const content = fs.readFileSync(file, 'utf8');
    const whiteAlpha = content.match(WHITE_ALPHA_RE)?.length ?? 0;
    const darkHex = (content.match(HEX_RE) ?? []).filter(isDarkHex).length;
    if (whiteAlpha > 0 || darkHex > 0) result[rel] = { whiteAlpha, darkHex };
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

describe('双皮肤硬编码棘轮（admin-dual-theme）', () => {
  it('每个文件的硬编码暗色/白透明数量不得超过基线（只减不增）', () => {
    const current = scan();

    if (process.env.UPDATE_THEME_BASELINE === '1') {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
      // 基线已重写；本次直接通过（重写行为要出现在 PR diff 里接受 review）
      return;
    }

    const baseline: Record<string, Counts> = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    const violations: string[] = [];

    for (const [file, counts] of Object.entries(current)) {
      const base = baseline[file] ?? { whiteAlpha: 0, darkHex: 0 };
      if (counts.whiteAlpha > base.whiteAlpha) {
        violations.push(
          `${file}: rgba(255,255,255,x) 由 ${base.whiteAlpha} 增至 ${counts.whiteAlpha} —— 浅色主题下会隐形。` +
            `请改用 token：面 var(--bg-card)/var(--bg-secondary)，边 var(--border-subtle)，字 var(--text-*)`,
        );
      }
      if (counts.darkHex > base.darkHex) {
        violations.push(
          `${file}: 深色 hex 字面量由 ${base.darkHex} 增至 ${counts.darkHex} —— 浅色主题下会变成漂浮暗块。` +
            `请改用 var(--bg-base)/var(--bg-elevated)/var(--panel-solid) 等语义 token，不要在组件里新增明暗分支`,
        );
      }
    }

    expect(
      violations,
      [
        '',
        '双皮肤棘轮拦截：新增了绕过主题 token 的硬编码颜色。',
        '修法映射见 .claude/rules/admin-dual-theme.md；',
        '确属暗色专用装饰需提高基线时，跑 UPDATE_THEME_BASELINE=1 vitest 并在 PR 说明。',
        ...violations,
      ].join('\n'),
    ).toEqual([]);
  });

  it('共享首页与图片卡只消费语义 token，不新增页面级明暗分支', () => {
    const violations = SEMANTIC_THEME_CONSUMERS.flatMap((relativePath) => {
      const content = fs.readFileSync(path.join(SRC_DIR, relativePath), 'utf8');
      const reasons: string[] = [];
      if (/useDataTheme|useMobileThemeStore/.test(content)) reasons.push('读取主题状态');
      if (/\[data-theme=["']light["']\]/.test(content)) reasons.push('声明浅色选择器');
      if (/\bisLight\b|\bisDark\b/.test(content)) reasons.push('维护明暗布尔分支');
      return reasons.map((reason) => `${relativePath}: ${reason}`);
    });

    expect(violations).toEqual([]);
  });

  it('移动端百宝箱图片卡标题跟随媒体文字 token', () => {
    const content = fs.readFileSync(
      path.join(SRC_DIR, 'pages/ai-toolbox/MobileToolboxView.tsx'),
      'utf8',
    );
    const agentCard = content.slice(
      content.indexOf('function AgentCard('),
      content.indexOf('/* ─────────── 空状态'),
    );

    expect(agentCard).toContain("color: hasArtwork ? 'var(--text-on-media)' : '#fff'");
    expect(agentCard).not.toMatch(/useDataTheme|\bconst light\b|\bisLight\b|\bisDark\b/);
  });
});
