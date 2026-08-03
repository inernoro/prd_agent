/**
 * 米多墨系色带守卫（no-purple guard）。
 *
 * 2026-08-02 用户当面否掉紫色风格，三个首页（未登录官网 / 桌面首页 / 移动首页）
 * 与它们共享的色板统一收敛到「暖石墨 + 赭红身份色 + 八色墨带」。
 * 这类颜色纪律最容易被下一次改动悄悄推回去（抄一段旧代码就带回一个 #8B5CF6），
 * 所以用扫描守住：**受管文件里不允许出现紫 / 靛 / 品红色相**。
 *
 * 判据取「色相 + 饱和度 + 明度」三件套，而不是简单匹配几个 hex：
 * 只匹配 hex 会被 rgba()、hsl()、以及任何没见过的新紫色绕过。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(TEST_DIR, '../..');

/** 受管范围：三个首页表面 + 它们共享的色板 SSOT。 */
const GUARDED: string[] = [
  'pages/home',
  'pages/MobileHomePage.tsx',
  'pages/AgentLauncherPage.tsx',
  'styles/home-launcher.css',
  'lib/tileAccent.ts',
  'lib/agentAccent.ts',
  'lib/appStoreTokens.ts',
];


/**
 * 品牌 / 首页 token：这些是三端共用的"那支笔"，不许发紫。
 *
 * tokens.css 不能整份扫——`--semantic-purple-*` / `--tag-purple-solid` 是语义色槽，
 * 紫色正是它们的语义，扫进来就是误报。所以按 token 名精确圈定管辖范围：
 * 只要一个 token 会被首页或全局品牌面消费，就必须在这张表里。
 */
const GUARDED_TOKEN_PREFIXES = [
  'accent-primary',
  'accent-gold',
  'gold-gradient',
  'button-primary',
  'selection-',
  'border-focus',
  'section-label-text',
  'home-',
  'launcher-',
  'mobile-fab-',
  'shadow-gold',
];

/** 紫 / 靛 / 品红区间（色相角度）。低饱和的近灰紫不算——那是中性色的正常抖动。 */
const BANNED_HUE_START = 244;
const BANNED_HUE_END = 340;
const MIN_SATURATION = 0.3;

function toHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

/** 判定只认 HSL 三件套，RGB 与 HSL 两种写法共用同一条判据，不许各判各的。 */
function isBannedHsl(h: number, s: number, l: number): boolean {
  if (s < MIN_SATURATION) return false;
  // 极暗/极亮的角落色（近黑近白）不参与判定：它们对观感的贡献是明度不是色相
  if (l < 0.12 || l > 0.92) return false;
  return h >= BANNED_HUE_START && h <= BANNED_HUE_END;
}

function isBanned(r: number, g: number, b: number): boolean {
  const { h, s, l } = toHsl(r, g, b);
  return isBannedHsl(h, s, l);
}

function walk(target: string, out: string[] = []): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (/\.(?:tsx?|css)$/.test(target) && !target.includes('__tests__')) out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    walk(path.join(target, entry.name), out);
  }
  return out;
}

const HEX_RE = /#([0-9a-fA-F]{6})\b/g;
const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g;
/** `hsl(270 60% 50%)` / `hsla(270, 60%, 50%, .4)` —— 两种分隔写法都要认，
 *  否则"改用 hsl 写紫色"就能绕过整条守卫（模板字面量里的 ${h} 不匹配，
 *  那部分由下面「色带只在 INK_HUES 内」的用例覆盖）。 */
const HSL_RE = /hsla?\(\s*(\d{1,3})(?:deg)?\s*[, ]\s*(\d{1,3})%\s*[, ]\s*(\d{1,3})%/g;
/** Tailwind 的紫系工具类（bg-purple-400 / text-violet-300 / from-indigo-500 …） */
const TW_RE = /\b(?:bg|text|from|via|to|border|ring|shadow)-(?:purple|violet|fuchsia|indigo)-\d{2,3}\b/g;

describe('米多墨系色带（首页三端不许发紫）', () => {
  it('受管文件不出现紫 / 靛 / 品红色相', () => {
    const violations: string[] = [];

    for (const entry of GUARDED) {
      for (const file of walk(path.join(SRC, entry))) {
        const rel = file.slice(SRC.length + 1);
        const content = fs.readFileSync(file, 'utf8');

        for (const match of content.matchAll(HEX_RE)) {
          const hex = match[1];
          const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
          if (isBanned(r, g, b)) violations.push(`${rel}: #${hex}`);
        }
        for (const match of content.matchAll(RGB_RE)) {
          const [r, g, b] = [1, 2, 3].map((i) => Number.parseInt(match[i], 10));
          if (isBanned(r, g, b)) violations.push(`${rel}: rgb(${r},${g},${b})`);
        }
        for (const match of content.matchAll(HSL_RE)) {
          const [h, s, l] = [1, 2, 3].map((i) => Number.parseInt(match[i], 10));
          if (isBannedHsl(h, s / 100, l / 100)) violations.push(`${rel}: hsl(${h} ${s}% ${l}%)`);
        }
        for (const match of content.matchAll(TW_RE)) {
          violations.push(`${rel}: ${match[0]}`);
        }
      }
    }

    expect(
      violations,
      [
        '',
        '首页三端出现了紫 / 靛 / 品红色相（用户 2026-08-02 明确否掉）。',
        '改用 lib/tileAccent 的 INK_HUES 八色墨带，或主题 token（--accent-primary 等）。',
        ...violations,
      ].join('\n'),
    ).toEqual([]);
  });


  it('品牌 / 首页 token 也在管辖内（语义色槽除外）', () => {
    const tokensPath = path.resolve(SRC, 'styles/tokens.css');
    const lines = fs.readFileSync(tokensPath, 'utf8').split('\n');
    const violations: string[] = [];

    for (const [index, line] of lines.entries()) {
      const declaration = line.match(/^\s*--([a-z0-9-]+)\s*:\s*(.+?);?\s*$/i);
      if (!declaration) continue;
      const [, name, value] = declaration;
      if (!GUARDED_TOKEN_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;

      for (const match of value.matchAll(HEX_RE)) {
        const hex = match[1];
        const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
        if (isBanned(r, g, b)) violations.push(`tokens.css:${index + 1} --${name}: #${hex}`);
      }
      for (const match of value.matchAll(RGB_RE)) {
        const [r, g, b] = [1, 2, 3].map((i) => Number.parseInt(match[i], 10));
        if (isBanned(r, g, b)) violations.push(`tokens.css:${index + 1} --${name}: rgb(${r},${g},${b})`);
      }
      for (const match of value.matchAll(HSL_RE)) {
        const [h, s, l] = [1, 2, 3].map((i) => Number.parseInt(match[i], 10));
        if (isBannedHsl(h, s / 100, l / 100)) violations.push(`tokens.css:${index + 1} --${name}: hsl(${h} ${s}% ${l}%)`);
      }
    }

    expect(
      violations,
      ['', '品牌 / 首页 token 出现紫 / 靛 / 品红——三端共用的那支笔被改回去了。', ...violations].join('\n'),
    ).toEqual([]);
  });

  it('主操作面不许拿 accent 当底再硬凑白字', () => {
    // --accent-primary 同时被当"底色"和"前景色"用，两个方向对明度的要求相反：
    // 它作为底色配白字只有 3.12:1。主操作面一律走 --button-primary-bg/fg 这对
    // 已被对比度守卫钉住的 token，而不是各写各的白字。
    const offenders: string[] = [];
    const pattern = /var\(--accent-primary[^)]*\)[^;}]{0,120}?(?:color:\s*['"]?(?:#fff(?:fff)?|white)|text-white)/i;

    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); continue; }
        if (!/\.tsx?$/.test(entry.name) || full.includes('__tests__')) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (pattern.test(content)) offenders.push(full.slice(SRC.length + 1));
      }
    };
    scan(SRC);

    expect(
      offenders,
      ['', 'accent 底 + 白字 = 3.12:1。改用 var(--button-primary-bg) / var(--button-primary-fg)。', ...offenders].join('\n'),
    ).toEqual([]);
  });

  it('色阶尺只在墨带内取色相，且暗浅两主题共用同一支笔', async () => {
    const { ICON_HUE, INK_HUES } = await import('../tileAccent');
    const allowed = new Set<number>(Object.values(INK_HUES));

    const outOfBand = Object.entries(ICON_HUE).filter(([, hue]) => !allowed.has(hue));
    expect(outOfBand).toEqual([]);

    // 墨带本身不许滑进紫区
    for (const hue of allowed) {
      expect(hue < BANNED_HUE_START || hue > BANNED_HUE_END).toBe(true);
    }
  });
});
