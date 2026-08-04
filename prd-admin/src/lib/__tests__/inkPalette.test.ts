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
  // 移动首页把配色外置在这里（RECENT_AGENT_META / 快捷入口的 accent），
  // 只扫页面本体会漏掉整份色板——受管范围要跟着 import 走，不是跟着文件名走。
  'pages/mobile-home',
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

/**
 * 紫 / 靛 / 品红区间（色相角度）。低饱和的近灰紫不算——那是中性色的正常抖动。
 *
 * 起点是 225 而不是「紫」的常见起点 244：本次要挡回去的那批靛色恰好落在
 * 234-241（#818cf8 234.5 / #6366f1 238.7 / #5e5ce6 240.9 —— 全是这个 PR 换掉的
 * 老 token 值）。判据画在 244 的话，把它们原样贴回来照样全绿，等于守了个寂寞。
 * 下限压到 225 仍给蓝色留足空间：墨带最蓝的钢蓝 214、Tailwind blue-500 是 217。
 */
const BANNED_HUE_START = 225;
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

interface TokenDeclaration {
  name: string;
  value: string;
  /** 声明起始行号（1-based），只用于报错定位 */
  line: number;
}

/**
 * 把 tokens.css 拆成「完整声明」而不是「每行一条」。
 *
 * 逐行正则会漏掉多行值：`--home-ambient-background:` 那行没有值、后面三行没有 token 名，
 * 于是整条声明既不被当作声明、也不被当作值——往首页氛围光里塞一个紫色渐变，守卫照样绿。
 * 这里改为按分号（或规则块收尾的 `}`）切分，值里允许换行。注释先替换成等长空白，
 * 既不会被当成值扫描，也不会打乱行号。
 */
function parseTokenDeclarations(css: string): TokenDeclaration[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
  const out: TokenDeclaration[] = [];
  for (const match of stripped.matchAll(/--([a-z0-9-]+)\s*:([^;{}]*)[;}]/gi)) {
    out.push({
      name: match[1],
      value: match[2],
      line: stripped.slice(0, match.index ?? 0).split('\n').length,
    });
  }
  return out;
}

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
    const violations: string[] = [];
    const declarations = parseTokenDeclarations(fs.readFileSync(tokensPath, 'utf8'));

    // 守卫自查：多行值必须真的被解析进来。少了这条断言，解析器退回逐行版
    // 仍然全绿——扫不到的那条声明恰恰是首页最大的一块颜色（氛围光渐变）。
    const ambient = declarations.filter((d) => d.name === 'home-ambient-background');
    expect(ambient.length, '--home-ambient-background 没被解析到：多行声明又被跳过了').toBeGreaterThan(0);
    for (const decl of ambient) {
      expect(decl.value, `--home-ambient-background 只取到首行，多行值没拼全（第 ${decl.line} 行）`).toContain('radial-gradient');
    }

    for (const { name, value, line } of declarations) {
      if (!GUARDED_TOKEN_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;

      for (const match of value.matchAll(HEX_RE)) {
        const hex = match[1];
        const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
        if (isBanned(r, g, b)) violations.push(`tokens.css:${line} --${name}: #${hex}`);
      }
      for (const match of value.matchAll(RGB_RE)) {
        const [r, g, b] = [1, 2, 3].map((i) => Number.parseInt(match[i], 10));
        if (isBanned(r, g, b)) violations.push(`tokens.css:${line} --${name}: rgb(${r},${g},${b})`);
      }
      for (const match of value.matchAll(HSL_RE)) {
        const [h, s, l] = [1, 2, 3].map((i) => Number.parseInt(match[i], 10));
        if (isBannedHsl(h, s / 100, l / 100)) violations.push(`tokens.css:${line} --${name}: hsl(${h} ${s}% ${l}%)`);
      }
    }

    expect(
      violations,
      ['', '品牌 / 首页 token 出现紫 / 靛 / 品红——三端共用的那支笔被改回去了。', ...violations].join('\n'),
    ).toEqual([]);
  });

  it('主操作面不许拿 accent 当底再硬凑浅色字', () => {
    // --accent-primary 同时被当"底色"和"前景色"用，两个方向对明度的要求相反：
    // 它作为底色配白字只有 3.12:1，配 --text-primary（#f7f7fb）2.92:1，都不达标。
    // 主操作面一律走 --button-primary-bg/fg 这对已被对比度守卫钉住的 token。
    //
    // 判据要认「渐变形态」：`linear-gradient(…, var(--accent-primary), var(--accent-secondary, var(--accent-primary)))`
    // 渲染出来就是同一块 accent 底色，只查 `var(--accent-primary)` 紧跟白字会整条漏掉
    // （前景色写在 className 里、底色写在 style 里，两者中间隔着几十个字符）。
    const offenders: string[] = [];
    const BG_KEY = /(?:background|backgroundColor|background-color)\s*:\s*/gi;
    /**
     * accent 被当成底色用。`[,)]` 是为了排掉 `var(--accent-primary-rgb)` ——
     * 那个几乎都是 `rgba(…, 0.14)` 的浅底，不是实心 accent 面。
     * `HERO_GRADIENT` 是官网 / Arena 主 CTA 的同一块陶土面（对白字 2.23~3.62:1），
     * 同判据管辖；它自己的文字色走 `HERO_GRADIENT_FG`，深墨不会命中 LIGHT_FG。
     */
    const ACCENT_IN_VALUE = /var\(--accent-primary\s*[,)]|\bHERO_GRADIENT\b/;

    /** sRGB 相对亮度（判"这块底配浅色字够不够"用） */
    const luminance = (hex: string): number => {
      const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
      const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    /** --text-primary 的实际值：浅色前景真正长这样，别拿纯白近似 */
    const TEXT_PRIMARY_LUMINANCE = luminance('#f7f7fb');
    /**
     * 底色写成字面色（含手抄的品牌渐变）时，逐个色标真算一遍。
     *
     * 只认 `var(--accent-primary)` / `HERO_GRADIENT` 这两个名字是不够的：
     * 页脚那枚 MAP 徽标就是 HERO_GRADIENT 的**手抄副本**——名字对不上，判据看不见，
     * 而且抄过去之后还各自漂移（起点停在换笔前的旧值）。
     */
    const literalStopFails = (value: string): boolean => {
      const stops = [...value.matchAll(/#([0-9a-fA-F]{6})\b/g)].map((m) => `#${m[1]}`);
      if (stops.length === 0) return false;
      return stops.some((stop) => {
        const [hi, lo] = [TEXT_PRIMARY_LUMINANCE, luminance(stop)].sort((a, b) => b - a);
        return (hi + 0.05) / (lo + 0.05) < 4.5;
      });
    };

    /**
     * 读出 `background:` 后面那一整个值。
     *
     * 不能用「读到第一个逗号为止」：`linear-gradient(135deg, var(--accent-primary) …)`
     * 第一个逗号就在 135deg 后面，整条渐变会被截掉——渐变形态因此漏判（实测漏掉本次两处气泡）。
     * 所以按括号深度读，只有顶层的 `,` / `;` / `}` 才算值结束。
     */
    const readValue = (content: string, from: number): string => {
      let depth = 0;
      const limit = Math.min(content.length, from + 400);
      for (let i = from; i < limit; i += 1) {
        const ch = content[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          if (depth === 0) return content.slice(from, i);
          depth -= 1;
        } else if (depth === 0 && (ch === ',' || ch === ';' || ch === '}')) return content.slice(from, i);
      }
      return content.slice(from, limit);
    };
    /**
     * 与之配对的浅色前景，两种写法各判各的。
     *
     * 原来写成一条正则，顶层 `|` 让 class 名独立成支（`text-white` 不需要跟在
     * `color:` 后面也能命中，已用探针验过）。但它长得像"class 名嵌在 color: 分支里"，
     * review 时被误读过一次——判据被人读错和判据真的漏，代价一样大，所以拆成两条。
     */
    const COLOR_KEY = /\bcolor\s*:\s*/gi;
    const LIGHT_VALUE = /#fff(?:fff)?\b|['"`]white['"`]|var\(--text-primary/i;
    const CLASS_LIGHT_FG = /\btext-(?:white|token-primary)\b/i;
    /**
     * 前景色判定读的是 `color:` 的**整个值**，不是紧跟其后的那几个字符。
     * 真实写法常是三元：`color: active ? 'var(--text-primary)' : 'var(--text-secondary)'`——
     * 按"紧邻"判会整条漏掉（SkillContentBrowser 的选中行就是这么溜过去的）。
     */
    const LIGHT_FG = {
      test: (tag: string) => {
        if (CLASS_LIGHT_FG.test(tag)) return true;
        for (const match of tag.matchAll(COLOR_KEY)) {
          if (LIGHT_VALUE.test(readValue(tag, (match.index ?? 0) + match[0].length))) return true;
        }
        return false;
      },
    };

    /**
     * 取 accent 底色所在那个 JSX 开标签的属性区。
     *
     * 判据不能用「前后若干字符」的邻近窗口：兄弟元素上的 `color: var(--text-primary)`
     * 会被误配成同一块面（实测误报 3 处，全是隔着标签的邻居）。所以按标签边界切——
     * 底色和前景色写在同一个开标签上才算一块面。`=>` 里的 `>` 不当标签结束。
     */
    const openingTagAround = (content: string, at: number): string => {
      let start = at;
      while (start > 0) {
        const ch = content[start - 1];
        if (ch === '<') break;
        if (ch === '>' && content[start - 2] !== '=') break;
        start -= 1;
      }
      let end = at;
      while (end < content.length) {
        const ch = content[end];
        if (ch === '<') break;
        if (ch === '>' && content[end - 1] !== '=') { end += 1; break; }
        end += 1;
      }
      return content.slice(start, end);
    };

    /**
     * 一段源码里所有「accent 当底 + 同一开标签上写着浅色字」的行号。
     *
     * `checkLiterals` 只对受管表面开：字面色标那一路会连带扫出一批与本次改动
     * 无关的存量（`var(--accent, #6366f1)` 之类别处的老坑）。这个 PR 只对三个
     * 首页的颜色负责，全仓字面扫描留作后续（已在 PR 里记账），不在这里顺手扩面。
     */
    const offendingLines = (content: string, checkLiterals = false): number[] => {
      const lines: number[] = [];
      for (const match of content.matchAll(BG_KEY)) {
        const at = (match.index ?? 0) + match[0].length;
        const value = readValue(content, at);
        if (!ACCENT_IN_VALUE.test(value) && !(checkLiterals && literalStopFails(value))) continue;
        if (!LIGHT_FG.test(openingTagAround(content, at))) continue;
        lines.push(content.slice(0, at).split('\n').length);
      }
      return lines;
    };

    // 判据自查：两种前景写法都得抓到，别的写法不许误报。
    // 这几条是把「我以为它能抓」变成「它确实抓得到」——review 里对这条判据
    // 的能力有过分歧，与其解释，不如让判据自己作证。
    const CLASS_WHITE = `<button className="px-2 text-white" style={{ background: 'var(--accent-primary)' }}>x</button>`;
    const CLASS_TOKEN = `<button className="px-2 text-token-primary" style={{ background: 'var(--accent-primary)' }}>x</button>`;
    const INLINE_WHITE = `<button style={{ background: 'var(--accent-primary)', color: '#fff' }}>x</button>`;
    const GRADIENT_CLASS = `<div className="text-token-primary" style={{ background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-primary) 100%)' }}>x</div>`;
    const SAFE_TOKEN_PAIR = `<button style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}>x</button>`;
    const SAFE_DARK_FG = `<button className="px-2" style={{ background: 'var(--accent-primary)', color: 'var(--button-primary-fg)' }}>x</button>`;
    const SAFE_ALPHA_TINT = `<div className="text-token-primary" style={{ background: 'rgba(var(--accent-primary-rgb), 0.14)' }}>x</div>`;
    const SAFE_SIBLING = `<div style={{ color: 'var(--text-primary)' }}><span style={{ background: 'var(--accent-primary)' }} /></div>`;

    const TERNARY_FG = `<button style={{ background: active ? 'var(--accent-primary)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>x</button>`;
    const COPIED_GRADIENT = `<div className="text-token-primary" style={{ background: 'linear-gradient(135deg, #C8623A 0%, #D97757 48%, #E0A06B 100%)' }}>x</div>`;
    const SAFE_PALE_LITERAL = `<div className="text-token-primary" style={{ background: '#141418' }}>x</div>`;

    for (const [name, snippet] of [['class 白字', CLASS_WHITE], ['class 主文字色', CLASS_TOKEN], ['inline 白字', INLINE_WHITE], ['渐变底 + class 主文字色', GRADIENT_CLASS], ['三元里的浅色字', TERNARY_FG], ['手抄的品牌渐变', COPIED_GRADIENT]] as const) {
      expect(offendingLines(snippet, true), `判据漏了「${name}」这种写法`).toHaveLength(1);
    }
    for (const [name, snippet] of [['按钮 token 对', SAFE_TOKEN_PAIR], ['accent 底 + 深墨字', SAFE_DARK_FG], ['accent 透明底', SAFE_ALPHA_TINT], ['兄弟元素的文字色', SAFE_SIBLING], ['深底配浅字（本来就该这样）', SAFE_PALE_LITERAL]] as const) {
      expect(offendingLines(snippet, true), `判据误报了「${name}」`).toEqual([]);
    }

    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); continue; }
        if (!/\.tsx?$/.test(entry.name) || full.includes('__tests__')) continue;
        const rel = full.slice(SRC.length + 1);
        const guardedSurface = GUARDED.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
        const content = fs.readFileSync(full, 'utf8');
        for (const line of offendingLines(content, guardedSurface)) {
          offenders.push(`${rel}:${line}`);
        }
      }
    };
    scan(SRC);

    expect(
      offenders,
      ['', 'accent 底 + 浅色字（白字 3.12:1 / --text-primary 2.92:1）。改用 var(--button-primary-bg) / var(--button-primary-fg)。', ...offenders].join('\n'),
    ).toEqual([]);
  });

  it('品牌渐变的色标只有一份，不许再手抄', async () => {
    // 这条渐变已经被手抄过三份（页脚徽标 / 产品预览发送键 / 导航 Logo 的 SVG stop），
    // 每一份都各自漂移、各自配错前景色，而且**抄过去就脱离了守卫视野**——
    // 判据只认得出名字，认不出色值。所以直接禁掉色值副本：
    // 官网里除 HeroSection（SSOT 所在）外，不许再出现这三个色标。
    const { HERO_GRADIENT_STOPS } = await import('../../pages/home/sections/HeroSection');
    const offenders: string[] = [];

    // 判的是「整条渐变被抄走」，不是「用了其中一个颜色」：单独用 #D97757 当光晕
    // 或段落强调是正常的，两三档凑在一小段里才是副本。窗口取 240 字符——
    // 一条 linear-gradient / 一组 SVG stop 都在这个量级内。
    const COPY_WINDOW = 240;
    for (const file of walk(path.join(SRC, 'pages/home'))) {
      const rel = file.slice(SRC.length + 1);
      if (rel.endsWith('sections/HeroSection.tsx')) continue;
      const content = fs.readFileSync(file, 'utf8').toLowerCase();
      for (let at = 0; at < content.length; at += COPY_WINDOW / 2) {
        const window = content.slice(at, at + COPY_WINDOW);
        const hits = HERO_GRADIENT_STOPS.filter((stop) => window.includes(stop.toLowerCase()));
        if (hits.length >= 2) {
          offenders.push(`${rel}:${content.slice(0, at).split('\n').length} 附近出现 ${hits.join(' / ')}`);
          break;
        }
      }
    }

    expect(
      offenders,
      ['', '品牌渐变的色标被抄了一份。import HERO_GRADIENT / HERO_GRADIENT_STOPS，别复制色值。', ...offenders].join('\n'),
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
