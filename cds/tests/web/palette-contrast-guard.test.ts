import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 调色板的两条硬约束。都属于「改完页面照样渲染、测试照样绿，只有真人看才发现」
 * 的那一类，所以必须机械钉住。
 *
 * 背景：2026-08-15 全站换用 design_handoff_release_center 的调色板，主色是一抹
 * 亮绿 `#c8f04a`。它当填充色很好看，**当文字色在白天几乎读不出来**——实测
 * 「接入 Agent」在浅底上对比度只有 1.22:1（AA 要求 4.5:1，大字 3:1）。
 * 模板本来就为此分了两个值：--accent 填充 / --accent-ink 文字。
 */

const CSS = fs.readFileSync(path.resolve(process.cwd(), '../cds/web/src/index.css'), 'utf8');
const TW = fs.readFileSync(path.resolve(process.cwd(), '../cds/web/tailwind.config.js'), 'utf8');
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('主色：填充用 primary，文字用 primary-ink', () => {
  /**
   * 这条是真实故障的回归。`color: hsl(var(--primary))` 曾有 21 处，
   * 白天全部是亮绿字落在浅底上。border-color / background-color 用亮绿是对的，
   * 只有 `color:` 必须换成 ink。
   */
  it('index.css 里不许再用 --primary 当文字色', () => {
    const css = strip(CSS);
    const hits = css.match(/(?<!-)\bcolor:\s*hsl\(var\(--primary\)[^)]*\)/g) || [];
    expect(hits, `这些地方把主色当文字色用了，白天读不出来：\n${hits.join('\n')}`).toEqual([]);
    // 反向确认 ink 真的在用，不是把问题整段删掉了事
    expect(css).toContain('color: hsl(var(--primary-ink)');
  });

  it('Tailwind 的 text-primary 也指向 ink（组件里那一半）', () => {
    const tw = strip(TW);
    expect(tw).toContain('textColor: {');
    expect(tw).toMatch(/textColor:\s*\{[^}]*primary:\s*'hsl\(var\(--primary-ink\)/);
    // bg-primary 仍然是亮绿，别一起改掉
    expect(tw).toMatch(/primary:\s*\{[^}]*DEFAULT:\s*'hsl\(var\(--primary\)/);
  });
});

describe('状态色只走 token，不再硬编码调色板', () => {
  const SRC = path.resolve(process.cwd(), '../cds/web/src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []));

  /**
   * 硬编码的 emerald/amber/red/sky **不跟主题走**：换调色板时它们留在原地
   * 与新底色打架，而且每处都得写 `text-x-600 dark:text-x-400` 双主题对，
   * 漏一半就在某个主题下看不清。1291 处已收敛到 ok/warn/bad/info，不许回流。
   */
  it('组件里没有硬编码的 Tailwind 调色板状态色', () => {
    const bad: string[] = [];
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      const hits = src.match(/\b(?:bg|text|border|ring|fill)-(?:red|emerald|amber|sky|green|blue|orange|rose)-\d{2,3}\b/g);
      if (hits) bad.push(`${path.relative(SRC, file)}: ${[...new Set(hits)].join(' ')}`);
    }
    expect(bad, `改用语义类 ok / warn / bad / info（各带 -soft 底色）：\n${bad.join('\n')}`).toEqual([]);
  });

  /**
   * 中性色（stone / slate / zinc / gray / neutral / bg-white）此前不在守卫范围里 ——
   * 判据太窄（predicate-and-wiring-discipline 形状 1）。真实事故：2026-08-25 用户报
   * 「接入 Agent 的上手助手在黑色皮肤下看不清」，根因是 AgentStarterTab 整块写死
   * 浅色调色板（`bg-[#fffdf9]` / `bg-white` / `text-stone-950`），暗色主题下白面板
   * 加深灰字、选中卡 `bg-warn-soft` 深底上压 `text-stone-950` 近黑字，全部读不出来。
   *
   * 棘轮：存量文件按当前条数封顶（多数已自带 `dark:` 配对，属于历史欠账），
   * 未登记的文件必须是 0。数字只许降不许升；改好一处就把这里调小一格。
   */
  // text-white / text-black 一起盯：它们也不跟主题走。暗色主题下 ok/warn 那几档是亮色，
  // 亮黄底上压 text-white 只有约 2 比 1 的对比度——正是这次要修的那种「看不清」。
  const NEUTRAL_LITERAL = /\b(?:bg|text|border|ring|fill)-(?:stone|slate|zinc|gray|neutral)-\d{2,3}\b|\b(?:bg|text)-(?:white|black)\b/g;
  const NEUTRAL_RATCHET: Record<string, number> = {
    'pages/ProjectListPage.tsx': 19,
    'pages/PreviewPreparingPage.tsx': 14,
    'components/BranchDetailDrawer.tsx': 12,
    'components/branch/ReplicaSetPanel.tsx': 9,
    'pages/cds-settings/tabs/LoadingPagesTab.tsx': 8,
    'components/GlobalUpdateBadge.tsx': 7,
    'components/deployment/ActiveDeployment.tsx': 6,
    'pages/ReportsPage.tsx': 3,
    'components/AccessRequestInbox.tsx': 1,
    'components/CommandPalette.tsx': 1,
    'components/branch/ReplicaLoadTestPanel.tsx': 1,
    'components/monitoring/MonitoringDialog.tsx': 1,
    'components/ui/dialog.tsx': 1,
    'lib/resources.tsx': 1,
    'pages/BranchListPage.tsx': 1,
    'pages/ReleaseConsolePage.tsx': 1,
    'pages/cds-settings/tabs/MaintenanceTab.tsx': 1,
    'pages/release-center/AutoReleaseTab.tsx': 1,
    'pages/release-center/EnvConfigSection.tsx': 1,
  };


  it('组件里没有新增的硬编码中性色（棘轮只降不升）', () => {
    const over: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      const hits = fs.readFileSync(file, 'utf8').match(NEUTRAL_LITERAL) || [];
      const allowed = NEUTRAL_RATCHET[rel] ?? 0;
      if (hits.length > allowed) {
        over.push(`${rel}: ${hits.length} 处（允许 ${allowed}）→ ${[...new Set(hits)].join(' ')}`);
      }
    }
    expect(
      over,
      `中性色请走 token：底色 bg-[hsl(var(--surface-raised|base|sunken))]、边框 border-[hsl(var(--hairline))]、\n`
      + `文字 text-foreground / text-muted-foreground；落在 ok/warn/bad/info 实色上的文字用 text-status-ink。\n${over.join('\n')}`,
    ).toEqual([]);
  });

  it('上手助手（黑色皮肤看不清那处）已经零硬编码中性色', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/AgentStarterTab.tsx'), 'utf8');
    expect(src.match(NEUTRAL_LITERAL) || []).toEqual([]);
    // 反向确认不是把配色整段删了：面板与卡片确实换成了 surface token
    expect(src).toContain('bg-[hsl(var(--surface-base))]');
    expect(src).toContain('bg-[hsl(var(--surface-raised))]');
  });

  it('status-ink 在两个主题里都定义、且 Tailwind 有映射', () => {
    expect((CSS.match(/--status-ink:/g) || []).length).toBe(2);
    expect(strip(TW)).toContain("'status-ink': 'hsl(var(--status-ink)");
  });

  it('四档状态色在两个主题里都定义了', () => {
    for (const token of ['ok', 'ok-soft', 'warn', 'warn-soft', 'bad', 'bad-soft', 'info', 'info-soft']) {
      const count = (CSS.match(new RegExp(`--${token}:`, 'g')) || []).length;
      expect(count, `--${token} 应在 dark 与 light 各定义一次，实际 ${count} 次`).toBe(2);
    }
  });
});


describe('左栏当前页：一处强调，且不许退回淡底橙字', () => {
  /*
   * 这条规则被手工断言过三次（2026-08-31 定实心底、2026-09-01 调尺度、
   * 2026-09-02 改竖条），属于「改完页面照样渲染、没人会发现」的那一类。
   *
   * 三代演进，两个都被否掉的档要一起钉住：
   *   一代「淡橙底 + 橙字」——白天 4.25:1，比未选中的 4.72:1 还低，选中项反而最弱。
   *   二代「整项实心橙 + 反色墨」——数值没问题（白天 5.13、暗色 7.67），
   *        问题是主色铺了约 3400px²，一个只表示「你在这」的指示物
   *        抢在页面所有真正的操作前面；底部「接入 Agent」又是第二块橙。
   *   三代（现行）「竖条 + 抬升底 + 主色图标 + 满墨标签」——主色约 60px²，
   *        且是全栏唯一的彩色。
   *
   * 判据分三半：接线（竖条 + 抬升底 + 主色图标 + 满墨标签）、
   * 唯一性（栏里不许有第二处主色文字）、数值（图标与标签都过 AA，
   * 且都高于被否掉的淡底档；竖条按非文字构件的 3:1 判）。
   * 红绿闭环见每条用例。
   */
  const css = strip(CSS);

  const themeBlock = (selector: string): string => {
    const at = css.indexOf(selector);
    if (at < 0) throw new Error(`找不到主题块 ${selector}`);
    const open = css.indexOf('{', at);
    return css.slice(open, css.indexOf('\n  }', open));
  };

  const token = (block: string, name: string): [number, number, number] => {
    const m = block.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
    if (!m) throw new Error(`${name} 没在这个主题块里定义`);
    return [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  };

  const luminance = ([h, s, l]: [number, number, number]): number => {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const seg = Math.floor(h / 60) % 6;
    const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg]
      .map((v) => v + m)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };

  const ratio = (a: [number, number, number], b: [number, number, number]): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };

  const ruleAt = (selector: string): string => {
    const at = css.indexOf(selector);
    expect(at, `找不到这条规则（选择器变了？）：${selector}`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  /*
   * 红绿闭环：把选中态改回 `background-color: hsl(var(--primary-ink))`，
   * 本条报 `expected '…' to contain 'background-color: hsl(var(--surface-raised))'`。
   */
  it('接线：抬升底 + 主色图标 + 一根主色竖条 + 满墨标签', () => {
    const active = ruleAt(".cds-rail .cds-rail-item[data-active='true'] {");
    expect(active).toContain('background-color: hsl(var(--surface-raised))');
    expect(active).toContain('color: hsl(var(--primary-ink))');
    // 一代那个淡底档不许再出现
    expect(active).not.toContain('primary-soft');

    const bar = ruleAt(".cds-rail .cds-rail-item[data-active='true']::before {");
    expect(bar, '竖条没了，「我在哪」就只剩底色差').toContain('background-color: hsl(var(--primary-ink))');

    // 标签必须显式转满墨：item 现在是主色，标签跟着继承就正好落回一代那个被否掉的档。
    const label = ruleAt(".cds-rail .cds-rail-item[data-active='true'] > .cds-rail-short {");
    expect(label).toContain('color: hsl(var(--foreground))');
    expect(label).not.toContain('primary-ink');
  });

  /*
   * 「两个橙在抢」是这次改版的头号诉求，而它天然会复发：
   * .cds-agent-access-entry 的基础规则本来就写着 `color: primary-ink !important`，
   * 谁把栏里这条覆盖删掉，橙字就自己回来了，页面照常渲染、别的用例全绿。
   * 红绿闭环：删掉 `.cds-rail .cds-agent-access-entry` 那条，本条报找不到规则。
   */
  it('唯一性：栏里只有当前页用主色，接入 Agent 不再是第二块橙', () => {
    const entry = ruleAt('.cds-rail .cds-agent-access-entry {');
    expect(entry, '接入 Agent 在栏里必须显式转中性，否则基础规则的橙字会漏出来')
      .toContain('color: hsl(var(--foreground-muted))');
    expect(entry).not.toContain('color: hsl(var(--primary-ink))');
  });

  for (const theme of ["[data-theme='dark']", "[data-theme='light']"]) {
    it(`数值：${theme} 下图标与标签都过 AA，竖条过非文字的 3:1`, () => {
      const block = themeBlock(theme);
      const idle = ratio(token(block, 'foreground-muted'), token(block, 'surface-sunken'));
      const icon = ratio(token(block, 'primary-ink'), token(block, 'surface-raised'));
      const label = ratio(token(block, 'foreground'), token(block, 'surface-raised'));
      const bar = ratio(token(block, 'primary-ink'), token(block, 'surface-sunken'));
      const rejected = ratio(token(block, 'primary-ink'), token(block, 'primary-soft'));

      expect(idle, `未选中项对栏底只有 ${idle}:1`).toBeGreaterThanOrEqual(4.5);
      expect(icon, `选中态图标只有 ${icon}:1，没过 AA`).toBeGreaterThanOrEqual(4.5);
      expect(label, `选中态标签只有 ${label}:1，没过 AA`).toBeGreaterThanOrEqual(4.5);
      // 竖条是构件不是文字，判据是 WCAG 1.4.11 的 3:1。
      expect(bar, `竖条对栏底只有 ${bar}:1，非文字构件也要 3:1`).toBeGreaterThanOrEqual(3);
      expect(icon, `选中图标 ${icon}:1 并不比被否掉的淡底档 ${rejected}:1 更清楚`)
        .toBeGreaterThan(rejected);
    });
  }
});
