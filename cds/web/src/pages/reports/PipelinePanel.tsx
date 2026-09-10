/**
 * 验收报告首页第一屏 —— `/reports` 不选项目时的跨项目总览（2026-09-10 第三次重做）。
 *
 * 读者是老板 / 观察者 / 架构师：不处理单条待办，只看局面。前两版被否的原因分别是
 * 「一排计数读不出结论」与「正常人进来不知道这个页面在做什么」，所以这一版的顺序是：
 *   顶部五步流程条（先讲清在跟踪什么事，并标明本屏只统计第三、四环节）
 *   → 71 条分流图（已验收 / 未验收，一个方块一条改动）
 *   → 一行一个项目
 *   → 两条脚注（合并环节缺数据、两类不计入方块的报告）
 *
 * 两条纪律，改这个文件前先读：
 *
 * 1. **文风是行政语气，不是报道**。用户原话「你在严谨的页面中插入了一些艺术性话语，
 *    正常情况下不会干这种事」。标题用名词短语不用疑问句；禁用「真的 / 只有 / 全场 /
 *    最该 / 一条都没」这类替读者下判断的词。判断照给（conclusion-before-numbers 要求
 *    第一屏给结论而不是一排计数），只是用陈述句说。
 *
 * 2. **方块只编码验收状态，三档结论只走文字与标签**。因为「已验收」不等于「通过」——
 *    5 条已验收里有 3 条未通过。若方块既表示已验收又表示通过档位，同一个颜色在一屏里
 *    就有两个意思。所以：蓝(--info)=已验收、灰(--surface-sunken)=已部署未验收、
 *    虚线空心=未部署；通过 / 原则性通过 / 未通过退到 chip 与状态句上。
 *    `--primary` 只留给控件选中态，不参与数据编码。
 */
import { useMemo } from 'react';
import { CircleAlert, GitMerge, Info } from 'lucide-react';
import type { PipelineFunnel, PipelineOverview, PipelineProjectRow } from '@/lib/api';

export interface PipelinePanelProps {
  pipeline: PipelineOverview;
  onOpenProject: (projectId: string) => void;
}

/** 一条改动在本屏的三种状态。顺序即叙述顺序，不要重排。 */
type ChangeState = 'accepted' | 'deployed-unaccepted' | 'undeployed';

const STATE_META: Record<ChangeState, { label: string; swatch: string }> = {
  accepted: { label: '已验收', swatch: 'bg-[hsl(var(--info))]' },
  'deployed-unaccepted': {
    label: '已部署未验收',
    swatch: 'bg-[hsl(var(--surface-sunken))] border border-[hsl(var(--hairline-strong))]',
  },
  undeployed: {
    label: '未部署',
    swatch: 'bg-[hsl(var(--card))] border border-dashed border-[hsl(var(--hairline-strong))]',
  },
};

/**
 * 把漏斗基数拆成分流图的三段。
 *
 * 刻意**不用** `leaks['deployed-not-accepted']` 那个桶：它排除了「合并了没验」那一类，
 * 等分支墓碑数据接进来（当前全库 merged=0，因为聚合还没接），桶里的数会小于真实的
 * 「已部署未验收」，分流图就加不回总数、凭空少几个方块，而且今天两者恰好相等、
 * 明天才静默错位——最难查的那种。用基数现推则恒等成立：
 *   accepted + (deployed - accepted) + (changes - deployed) === changes
 */
function splitChanges(f: PipelineFunnel): Record<ChangeState, number> {
  return {
    accepted: f.accepted,
    'deployed-unaccepted': Math.max(0, f.deployed - f.accepted),
    undeployed: Math.max(0, f.changes - f.deployed),
  };
}

function Eyebrow({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{children}</div>;
}

/** 一个方块 = 一条改动。size 用于稀疏与密集两端共用同一画法（不放大、只换行）。 */
function Blocks({ counts, size = 11 }: { counts: Record<ChangeState, number>; size?: number }): JSX.Element {
  const cells: ChangeState[] = [];
  for (let i = 0; i < counts.accepted; i += 1) cells.push('accepted');
  for (let i = 0; i < counts['deployed-unaccepted']; i += 1) cells.push('deployed-unaccepted');
  for (let i = 0; i < counts.undeployed; i += 1) cells.push('undeployed');
  if (!cells.length) return <span className="text-[12px] text-muted-foreground">无改动</span>;
  return (
    // 永远换行、从不横滚：窄屏下方块按容器宽度自然折行，不给页面制造横向滚动条
    <span className="flex flex-wrap gap-[4px]">
      {cells.map((state, i) => (
        <span
          key={`${state}-${i}`}
          className={`inline-block rounded-[2px] ${STATE_META[state].swatch}`}
          style={{ width: size, height: size }}
          title={STATE_META[state].label}
        />
      ))}
    </span>
  );
}

function Chip({ tone, children }: { tone: 'ok' | 'warn' | 'bad'; children: React.ReactNode }): JSX.Element {
  return (
    <span
      className="inline-flex items-center rounded px-2 py-0.5 font-mono text-[12px] font-semibold"
      style={{ background: `hsl(var(--${tone}-soft))`, color: `hsl(var(--${tone}))` }}
    >
      {children}
    </span>
  );
}

/** 顶部五步流程条：先讲清一条改动本来要走什么路，再标明本屏只统计其中两步。 */
function FlowStrip(): JSX.Element {
  const steps = [
    { n: '01', title: '提交改动', desc: '一条分支为一条改动' },
    { n: '02', title: '部署预览环境', desc: 'CDS 起一个可访问的预览地址' },
    { n: '03', title: '对预览做验收', desc: '打开预览地址执行验收', scope: true },
    { n: '04', title: '归档验收报告', desc: '结论三档：通过 / 原则性通过 / 不通过', scope: true },
    { n: '05', title: '合并进主干', desc: '代码进入正式分支' },
  ];
  return (
    <section className="rounded-[10px] border border-[hsl(var(--hairline))] bg-card px-5 py-4">
      <p className="m-0 text-[13px] text-muted-foreground">
        一条代码改动从提交到进入主干的五个环节。<span className="font-semibold text-foreground">本屏统计第三、第四环节的执行情况。</span>
      </p>
      <div className="mt-3 grid gap-0 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((s) => (
          <div
            key={s.n}
            className="px-3 py-2.5 first:pl-0"
            // 统计范围用底色标，不用 --primary：那个色留给控件选中态，不参与数据编码
            style={s.scope ? { background: 'hsl(var(--surface-sunken))' } : undefined}
          >
            <div className="font-mono text-[11px] text-muted-foreground">{s.n}</div>
            <div className="mt-0.5 text-[13.5px] font-semibold">{s.title}</div>
            <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{s.desc}</div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 text-center text-[12px] font-medium text-muted-foreground lg:text-left lg:pl-[42%]">
        本屏统计范围
      </div>
    </section>
  );
}

/** 分流图：左边总数，右边分成已验收 / 未验收两支。这组数全屏只在这里出现一次。 */
function SplitDiagram({ funnel }: { funnel: PipelineFunnel }): JSX.Element {
  const c = splitChanges(funnel);
  const unaccepted = c['deployed-unaccepted'] + c.undeployed;
  return (
    <section className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <div className="flex flex-col justify-center rounded-[10px] border border-[hsl(var(--hairline))] bg-card px-6 py-6">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[52px] font-semibold leading-none tracking-[-0.03em]">{funnel.changes}</span>
          <span className="text-[15px] text-muted-foreground">条</span>
        </div>
        <div className="mt-2 text-[14px] font-semibold">改动</div>
        <p className="m-0 mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          一条分支为一条改动。下方一个方块即其中一条。
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <div className="rounded-[10px] border border-[hsl(var(--hairline))] bg-card px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="min-w-[92px]">
              <div className="text-[13.5px] font-semibold">已验收</div>
              <div className="mt-0.5 flex items-baseline gap-1">
                <span className="font-mono text-[26px] font-semibold leading-none" style={{ color: 'hsl(var(--info))' }}>
                  {c.accepted}
                </span>
                <span className="text-[12px] text-muted-foreground">条</span>
              </div>
            </div>
            <Blocks counts={{ accepted: c.accepted, 'deployed-unaccepted': 0, undeployed: 0 }} />
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="ok">通过 {funnel.pass}</Chip>
              <Chip tone="warn">原则性通过 {funnel.conditional}</Chip>
              <Chip tone="bad">未通过 {funnel.fail}</Chip>
              {funnel.undetermined > 0 ? (
                <span className="text-[12px] text-muted-foreground">未标结论 {funnel.undetermined}</span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="rounded-[10px] border border-[hsl(var(--hairline))] bg-card px-5 py-4">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="min-w-[92px]">
              <div className="text-[13.5px] font-semibold">未验收</div>
              <div className="mt-0.5 flex items-baseline gap-1">
                <span className="font-mono text-[26px] font-semibold leading-none">{unaccepted}</span>
                <span className="text-[12px] text-muted-foreground">条</span>
              </div>
            </div>
            <div className="min-w-[200px] flex-1">
              <Blocks counts={{ accepted: 0, 'deployed-unaccepted': c['deployed-unaccepted'], undeployed: c.undeployed }} />
            </div>
            <p className="m-0 max-w-[300px] text-[12px] leading-relaxed text-muted-foreground">
              其中 <span className="font-semibold text-foreground">{c['deployed-unaccepted']}</span> 条已部署未验收：预览环境已就绪，无对应验收报告。
              <span className="font-semibold text-foreground"> {c.undeployed}</span> 条未部署（虚线方块）。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/** 图例：方块的三种含义，兼作全局计数。 */
function Legend({ funnel }: { funnel: PipelineFunnel }): JSX.Element {
  const c = splitChanges(funnel);
  const order: ChangeState[] = ['accepted', 'deployed-unaccepted', 'undeployed'];
  return (
    <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[10px] border border-[hsl(var(--hairline))] bg-card px-4 py-3">
      <Eyebrow>方块图例</Eyebrow>
      {order.map((s) => (
        <span key={s} className="inline-flex items-center gap-2 text-[12.5px]">
          <span className={`inline-block h-[11px] w-[11px] rounded-[2px] ${STATE_META[s].swatch}`} />
          {STATE_META[s].label} <span className="font-mono font-semibold">{c[s]}</span>
        </span>
      ))}
      <span className="ml-auto inline-flex max-w-[520px] items-start gap-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
        <Info className="mt-[2px] h-3.5 w-3.5 shrink-0" />
        方块颜色只表示验收状态，三档结论不进方块，只出现在文字与标签上——已验收不等于通过
        （已验收 {funnel.accepted} 条中 {funnel.fail} 条未通过）。
      </span>
    </section>
  );
}

/** 项目行右侧的状态列：一句结论 + 构成 + 一条真实的未验收分支名。 */
function ProjectStatus({ row, sampleBranch }: { row: PipelineProjectRow; sampleBranch: string | null }): JSX.Element {
  const c = splitChanges(row.funnel);
  const verdicts: string[] = [];
  if (row.funnel.pass > 0) verdicts.push(`通过 ${row.funnel.pass}`);
  if (row.funnel.conditional > 0) verdicts.push(`原则性通过 ${row.funnel.conditional}`);
  if (row.funnel.fail > 0) verdicts.push(`未通过 ${row.funnel.fail}`);
  const hasFail = row.funnel.fail > 0;
  const rail = row.funnel.changes === 0
    ? 'hsl(var(--hairline-strong))'
    : hasFail ? 'hsl(var(--bad))' : row.funnel.accepted > 0 ? 'hsl(var(--info))' : 'hsl(var(--warn))';

  return (
    <div className="border-l-[3px] pl-3" style={{ borderColor: rail }}>
      <div className="text-[13px] font-semibold">
        {row.funnel.changes === 0
          ? '无改动'
          : row.funnel.accepted === 0
            ? '无验收记录'
            : `已验收 ${row.funnel.accepted} 条：${verdicts.join('，')}`}
      </div>
      <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
        {row.funnel.changes === 0
          ? '无在途分支，无最近撤下分支'
          : [
              c['deployed-unaccepted'] > 0 ? `${c['deployed-unaccepted']} 条已部署未验收` : '',
              c.undeployed > 0 ? `${c.undeployed} 条未部署` : '',
            ].filter(Boolean).join('，')}
      </div>
      {sampleBranch ? (
        <div className="mt-1.5">
          <div className="text-[11.5px] text-muted-foreground">
            未验收分支{c['deployed-unaccepted'] > 1 ? `（示例，另有 ${c['deployed-unaccepted'] - 1} 条）` : ''}
          </div>
          <span
            className="mt-1 inline-block max-w-full truncate rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 font-mono text-[11px]"
            title={sampleBranch}
          >
            {sampleBranch}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function PipelinePanel({ pipeline, onOpenProject }: PipelinePanelProps): JSX.Element {
  // 每个项目取一条真实的未验收分支名当示例。分支名可长达 50+ 字符，靠 truncate 兜住。
  const sampleBranches = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of pipeline.leaks) {
      if (l.kind !== 'deployed-not-accepted') continue;
      if (!m.has(l.projectId)) m.set(l.projectId, l.subject);
    }
    return m;
  }, [pipeline.leaks]);

  const unlinked = pipeline.projects.filter((p) => !p.githubLinked);
  const noAcceptance = pipeline.projects.filter((p) => p.funnel.changes > 0 && p.funnel.accepted === 0).length;
  const missingKeyed = pipeline.totalLeaks['report-missing-change-key'];

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <Eyebrow>CDS 验收报告中心 · 全部项目 · 当前在途 + 最近撤下</Eyebrow>
          <h1 className="m-0 mt-1.5 text-[24px] font-semibold tracking-[-0.02em]">代码改动的验收状态</h1>
          <p className="m-0 mt-1.5 max-w-[760px] text-[13px] leading-relaxed text-muted-foreground">
            CDS 上一条分支即一条代码改动。下方一个方块代表一条改动，方块颜色为该改动的验收状态；
            {pipeline.projects.length} 个项目、{pipeline.total.changes} 条改动全部列出，一行一个项目。
          </p>
        </div>
        <div className="text-right font-mono text-[11.5px] leading-relaxed text-muted-foreground">
          <div>{pipeline.projects.length} 个项目 · {pipeline.total.changes} 条改动</div>
          <div>统计口径：当前在途 + 最近撤下{pipeline.recentDays ? ` ${pipeline.recentDays} 天` : ''}</div>
        </div>
      </header>

      <FlowStrip />
      <SplitDiagram funnel={pipeline.total} />
      <Legend funnel={pipeline.total} />

      <section className="overflow-hidden rounded-[10px] border border-[hsl(var(--hairline))] bg-card">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-3">
          <h2 className="text-[14px] font-semibold tracking-tight">按项目分列</h2>
          <span className="text-xs text-muted-foreground">
            {pipeline.projects.length} 个项目中，{noAcceptance} 个项目无验收记录 · 改动数由多到少 ·
            右侧列出的分支名为该项目真实的未验收分支 · 点项目名进入该项目的验收明细
          </span>
        </div>
        <ul className="m-0 list-none p-0">
          {pipeline.projects.map((p) => (
            <li
              key={p.projectId}
              className="grid gap-x-5 gap-y-3 border-t border-[hsl(var(--hairline))] px-4 py-3.5 first:border-t-0 lg:grid-cols-[220px_minmax(0,1fr)_300px]"
            >
              <div className="min-w-0">
                <button
                  type="button"
                  className="text-left text-[13.5px] font-semibold text-foreground hover:underline"
                  onClick={() => onOpenProject(p.projectId)}
                >
                  {p.projectName}
                </button>
                <div className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">
                  改动 {p.funnel.changes} · {p.lastActivityAt ? `最近动静 ${p.lastActivityAt.slice(5, 10)}` : '无动静'}
                </div>
                {!p.githubLinked ? (
                  <span
                    className="mt-1.5 inline-flex items-center gap-1 rounded border border-dashed border-[hsl(var(--hairline-strong))] px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                    title="未接 GitHub 的项目查不到合并记录，「合并进主干」这一环无从判断"
                  >
                    <GitMerge className="h-3 w-3" />未接 GitHub
                  </span>
                ) : null}
              </div>
              <div className="min-w-0">
                <Blocks counts={splitChanges(p.funnel)} />
                <div className="mt-1.5 font-mono text-[11.5px] text-muted-foreground">{p.funnel.changes} 条改动</div>
              </div>
              <ProjectStatus row={p} sampleBranch={sampleBranches.get(p.projectId) ?? null} />
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="flex items-start gap-2 rounded-[10px] border border-dashed border-[hsl(var(--hairline-strong))] px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
          <CircleAlert className="mt-[3px] h-3.5 w-3.5 shrink-0" />
          <span>
            本屏不含「合并进主干」环节：本次聚合未接入分支墓碑数据，全库查不到合并记录，
            <span className="font-semibold text-foreground">这是查不到</span>，不作为结论。
            {unlinked.length > 0 ? (
              <> 另有 {unlinked.map((p) => p.projectName).join('、')} {unlinked.length > 1 ? '两' : ''}个项目未接 GitHub，其合并记录本就无从查询。</>
            ) : null}
          </span>
        </div>
        <div className="flex items-start gap-2 rounded-[10px] border border-dashed border-[hsl(var(--hairline-strong))] px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
          <CircleAlert className="mt-[3px] h-3.5 w-3.5 shrink-0" />
          <span>
            另有两类报告不计入方块：<span className="font-semibold text-foreground">{missingKeyed} 份</span>报告未记录所验改动
            （分支 / PR / commit 三项均为空），无法挂到任何一条改动，属归档流程缺口；
            <span className="font-semibold text-foreground"> {pipeline.staleReports} 份</span>报告所指分支已被 CDS 回收，
            <span className="font-semibold text-foreground">无从核对</span>，属背景数，不计为漏。
          </span>
        </div>
      </section>
    </div>
  );
}
