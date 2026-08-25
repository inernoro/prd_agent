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
  const NEUTRAL_LITERAL = /\b(?:bg|text|border|ring|fill)-(?:stone|slate|zinc|gray|neutral)-\d{2,3}\b|\bbg-(?:white|black)\b/g;
  const NEUTRAL_RATCHET: Record<string, number> = {
    'pages/ProjectListPage.tsx': 19,
    'components/BranchDetailDrawer.tsx': 9,
    'components/GlobalUpdateBadge.tsx': 7,
    'pages/PreviewPreparingPage.tsx': 6,
    'components/deployment/ActiveDeployment.tsx': 6,
    'pages/cds-settings/tabs/LoadingPagesTab.tsx': 5,
    'pages/ReportsPage.tsx': 2,
    'pages/release-center/EnvConfigSection.tsx': 1,
    'pages/release-center/AutoReleaseTab.tsx': 1,
    'pages/cds-settings/tabs/MaintenanceTab.tsx': 1,
    'pages/ReleaseConsolePage.tsx': 1,
    'pages/BranchListPage.tsx': 1,
    'lib/resources.tsx': 1,
    'components/ui/dialog.tsx': 1,
    'components/monitoring/MonitoringDialog.tsx': 1,
    'components/branch/ReplicaSetPanel.tsx': 1,
    'components/branch/ReplicaLoadTestPanel.tsx': 1,
    'components/CommandPalette.tsx': 1,
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
