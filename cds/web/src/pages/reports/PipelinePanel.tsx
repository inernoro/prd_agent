/**
 * 验收流水线总览 —— `/reports` 不选项目时的第一屏（2026-09-09 第二次重做）。
 *
 * 需求来源：首页服务的是老板 / 观察者 / 架构师，要「纵观全局和流水线」。他们不动手
 * 处理单条待办，所以这一屏既不是待办队列，也不是某一份报告结论的放大。
 *
 * 版面只有一条主线：改动 → 部署 → 验收 → 结论 → 合并。真正的信息不在每一环的数，
 * 而在**环与环之间掉下去多少**——那就是漏。所以漏画在环之间的缝里，不另开一块。
 *
 * 明确不做：通过率（分母失真且规范未定义，用户 2026-09-09 拍板去掉，只留三档计数）、
 * 趋势（周报的问题）、时间窗当主轴（会切断流转，降级成右上角一个筛选）。
 *
 * 2026-09-10 返工：第一版把漏斗摆在最上面，用户原话「我看不懂你的首页」。
 * 按 conclusion-before-numbers.md 复盘——那一版只有计数层与对照层，缺结论层：
 * 「5 / 4 / 1 / 0，漏 3」每个数都对，合起来不告诉读者任何事。所以现在顺序是
 * 结论（一句判断）→ 该管的事（点名到分支）→ 走到哪一步（漏斗降级成支撑图）→ 按项目看。
 * 同时把内部词换成人话，并把「报告对不上分支」这类实现边界降为页脚小字——
 * 那是我的问题，不是读者要拍板的事。
 */
import { useMemo } from 'react';
import { CircleAlert, CircleCheck, CircleX, GitMerge, TriangleAlert } from 'lucide-react';
import type { LeakKind, PipelineFunnel, PipelineOverview, PipelineProjectRow } from '@/lib/api';
import { buildPipelineHeadline } from '@/lib/pipelineHeadline';

export interface PipelinePanelProps {
  pipeline: PipelineOverview;
  onOpenProject: (projectId: string) => void;
}

/** 四种漏，按严重度排；文案直接说人话，不用内部词。 */
const LEAK_META: Record<LeakKind, { label: string; hint: string; tone: 'bad' | 'warn' | 'info' }> = {
  'merged-not-accepted': { label: '合并了，从来没验过', hint: '进了主干却没有任何验收报告——最危险的一种漏', tone: 'bad' },
  'merged-while-failing': { label: '验了没过，还是合并了', hint: '最新结论是未通过，分支仍然合进了主干', tone: 'bad' },
  'deployed-not-accepted': { label: '部署了，没人验', hint: '预览起来了但一份报告都没有，验收没跟上开发', tone: 'warn' },
  'report-missing-change-key': { label: '报告没记它验的是谁', hint: '分支 / PR / commit 三样全空，这份报告永远挂不到任何改动上——归档流程的缺口', tone: 'warn' },
};

const TONE = {
  bad: { color: 'hsl(var(--bad))', soft: 'hsl(var(--bad-soft))', Icon: CircleX },
  warn: { color: 'hsl(var(--warn))', soft: 'hsl(var(--warn-soft))', Icon: TriangleAlert },
  info: { color: 'hsl(var(--info))', soft: 'hsl(var(--info-soft))', Icon: CircleAlert },
} as const;

function Eyebrow({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">{children}</div>;
}

/**
 * 漏斗：四环横排，环与环之间的缝里标掉下去多少。
 * 环用等宽块而不是按数值缩放——数值差距常常是几十倍，缩放会把后面几环压成看不见的线。
 * 数量靠数字表达，位置靠顺序表达，缝里的红字才是要读的东西。
 */
function Funnel({ funnel }: { funnel: PipelineFunnel }): JSX.Element {
  const stages = [
    { key: 'changes', label: '在改的分支', value: funnel.changes, hint: '还挂在 CDS 上的 + 最近撤下的' },
    { key: 'deployed', label: '开了预览', value: funnel.deployed, hint: '起过预览容器，可以打开看' },
    { key: 'accepted', label: '有人验过', value: funnel.accepted, hint: '至少一份对得上的验收报告' },
    { key: 'merged', label: '进了主干', value: funnel.merged, hint: 'GitHub 合并记录' },
  ];
  // 每个缝一条，下标对齐左边那一环。第三个缝（验收 → 合并）不画：
  // 「验了还没合并」是在途的正常状态，不是漏；那一段真正的漏是「合并了没验 / 验了没过还合并」，
  // 它们是跨过环去的，画在下面的漏点卡里。
  const drops = [
    { n: funnel.changes - funnel.deployed, text: '没部署', tone: 'info' as const },
    { n: funnel.deployed - funnel.accepted, text: '开了预览没人验', tone: 'warn' as const },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid items-stretch gap-0" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        {stages.map((s, i) => (
          <div key={s.key} className="relative flex flex-col gap-1 px-4 py-3" style={{ borderLeft: i === 0 ? 'none' : '1px solid hsl(var(--hairline))' }}>
            <Eyebrow>{s.label}</Eyebrow>
            <div className="font-mono text-[20px] font-semibold leading-none tracking-[-0.02em]">{s.value}</div>
            <div className="text-[11.5px] leading-snug text-muted-foreground">{s.hint}</div>
            {drops[i] && drops[i].n > 0 ? (
              <div
                className="absolute -right-px top-1/2 z-10 hidden -translate-y-1/2 translate-x-1/2 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold lg:block"
                style={{ color: TONE[drops[i].tone].color, background: TONE[drops[i].tone].soft, borderColor: `color-mix(in srgb, ${TONE[drops[i].tone].color} 30%, transparent)` }}
              >
                −{drops[i].n} {drops[i].text}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {/* 结论三档：跟在「跑过验收」那一环下面，因为它就是那一环的构成。不给百分比。 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[hsl(var(--hairline))] px-4 pt-3">
        <Eyebrow>验过的这些，结论是</Eyebrow>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'hsl(var(--ok))' }}>
          <CircleCheck className="h-3.5 w-3.5" />通过 {funnel.pass}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'hsl(var(--warn))' }}>
          <TriangleAlert className="h-3.5 w-3.5" />原则性通过 {funnel.conditional}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'hsl(var(--bad))' }}>
          <CircleX className="h-3.5 w-3.5" />未通过 {funnel.fail}
        </span>
        {funnel.undetermined > 0 ? (
          <span className="text-[12.5px] text-muted-foreground">另有 {funnel.undetermined} 份没有标结论</span>
        ) : null}
      </div>
    </div>
  );
}

/** 项目行里的迷你漏斗：四段等宽方块，缺的那几段用灰虚线，读的是「哪一段断了」。 */
function MiniFunnel({ f }: { f: PipelineFunnel }): JSX.Element {
  const seg = (n: number, total: number, color: string) => (
    n > 0
      ? <span className="flex h-[18px] flex-1 items-center justify-center rounded-[4px] font-mono text-[11px] font-semibold" style={{ background: color, color: 'hsl(var(--card))' }}>{n}</span>
      : <span className="flex h-[18px] flex-1 items-center justify-center rounded-[4px] border border-dashed border-[hsl(var(--hairline-strong))] font-mono text-[11px] text-muted-foreground">{total > 0 ? '0' : '—'}</span>
  );
  return (
    <span className="flex min-w-0 items-stretch gap-[3px]" title={`改动 ${f.changes} · 部署 ${f.deployed} · 验收 ${f.accepted} · 合并 ${f.merged}`}>
      {seg(f.changes, f.changes, 'hsl(var(--hairline-strong))')}
      {seg(f.deployed, f.changes, 'hsl(var(--info))')}
      {seg(f.accepted, f.changes, 'hsl(var(--primary))')}
      {seg(f.merged, f.changes, 'hsl(var(--ok))')}
    </span>
  );
}

export function PipelinePanel({ pipeline, onOpenProject }: PipelinePanelProps): JSX.Element {
  // 顺序必须与后端 acceptance-pipeline.ts 的 severity 表一致，守卫见 tests/web/pipeline-leak-order.test.ts
  const leakOrder: LeakKind[] = [
    'merged-not-accepted', 'merged-while-failing', 'deployed-not-accepted',
    'report-missing-change-key',
  ];
  const activeLeaks = leakOrder.filter((k) => pipeline.totalLeaks[k] > 0);
  const leakSubjects = useMemo(() => {
    const m = new Map<LeakKind, string[]>();
    for (const l of pipeline.leaks) {
      const list = m.get(l.kind) ?? [];
      if (list.length < 4) list.push(l.subject);
      m.set(l.kind, list);
    }
    return m;
  }, [pipeline.leaks]);
  const unlinked = pipeline.projects.filter((p) => !p.githubLinked).length;
  const headline = buildPipelineHeadline(pipeline);
  const rail = TONE[headline.tone === 'ok' ? 'info' : headline.tone].color;

  return (
    <div className="flex flex-col gap-7">
      {/* 结论层：第一眼就是一句挂着数字的判断，不是一排要人自己算的计数 */}
      <section className="flex flex-col gap-2.5 border-l-[3px] pl-4" style={{ borderColor: headline.tone === 'ok' ? 'hsl(var(--ok))' : rail }}>
        <Eyebrow>验收现状 · {pipeline.projects.length} 个项目 · {pipeline.recentDays ? `近 ${pipeline.recentDays} 天` : '不限时间'}</Eyebrow>
        <h1 className="m-0 text-[30px] font-semibold leading-[1.2] tracking-[-0.02em]">{headline.sentence}</h1>
        {headline.points.length ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {headline.points.map((pt) => (
              <li key={pt} className="text-[13.5px] leading-relaxed text-muted-foreground">{pt}</li>
            ))}
          </ul>
        ) : null}
        {headline.action ? (
          <div className="mt-0.5 text-[13.5px] font-medium" style={{ color: headline.tone === 'ok' ? 'hsl(var(--ok))' : rail }}>{headline.action}</div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight">该管的是这些</h2>
          <span className="text-xs text-muted-foreground">按严重度排 · 点名到分支</span>
        </div>
        {activeLeaks.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-[hsl(var(--hairline-strong))] px-4 py-6 text-center text-[13px] text-muted-foreground">
            没有需要你管的。{unlinked > 0 ? `不过 ${unlinked} 个项目没接 GitHub，合并这一步查不到——是看不见，不是没有。` : ''}
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
            {activeLeaks.map((k) => {
              const meta = LEAK_META[k];
              const tone = TONE[meta.tone];
              const subjects = leakSubjects.get(k) ?? [];
              const n = pipeline.totalLeaks[k];
              return (
                <div key={k} className="flex flex-col gap-2 rounded-[10px] border bg-card p-4" style={{ borderColor: `color-mix(in srgb, ${tone.color} 30%, hsl(var(--hairline)))` }}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="inline-flex items-center gap-2 text-[13.5px] font-semibold" style={{ color: tone.color }}>
                      <tone.Icon className="h-4 w-4 shrink-0" />{meta.label}
                    </span>
                    <span className="font-mono text-[20px] font-semibold leading-none" style={{ color: tone.color }}>{n}</span>
                  </div>
                  <div className="text-[12px] leading-relaxed text-muted-foreground">{meta.hint}</div>
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {subjects.map((sub) => (
                      <span key={sub} className="max-w-full truncate rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 font-mono text-[11px]" title={sub}>{sub}</span>
                    ))}
                    {n > subjects.length ? <span className="px-1 py-0.5 text-[11px] text-muted-foreground">还有 {n - subjects.length} 个</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 构成：漏斗从主角降级为支撑图——它解释上面那句判断是怎么来的 */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight">这 {pipeline.total.changes} 条走到哪一步了</h2>
          <span className="text-xs text-muted-foreground">一条分支算一条 · 相邻两步之间少掉的就是上面点名的</span>
        </div>
        <div className="rounded-[10px] border border-[hsl(var(--hairline))] bg-card py-1">
          <Funnel funnel={pipeline.total} />
        </div>
      </section>

      <section className="overflow-hidden rounded-[10px] border border-[hsl(var(--hairline))] bg-card">
        <div className="flex items-baseline gap-2.5 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-3">
          <h2 className="text-[15px] font-semibold tracking-tight">按项目看</h2>
          <span className="text-xs text-muted-foreground">要管的多的排前面 · 点项目名进它的验收明细</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">项目</th>
                <th className="w-[150px] px-3 py-2.5 font-medium">走到哪一步</th>
                <th className="w-[190px] px-3 py-2.5 font-medium">验过的结论</th>
                <th className="w-[120px] px-3 py-2.5 font-medium">要管的</th>
                <th className="px-3 py-2.5 font-medium">没做过的验收类型</th>
              </tr>
            </thead>
            <tbody>
              {pipeline.projects.map((p: PipelineProjectRow) => {
                const leakTotal = Object.values(p.leaks).reduce((n, v) => n + v, 0);
                return (
                  <tr key={p.projectId} className="border-t border-[hsl(var(--hairline))] align-top">
                    <td className="px-4 py-3">
                      <button type="button" className="text-left font-semibold text-foreground hover:underline" onClick={() => onOpenProject(p.projectId)}>{p.projectName}</button>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11.5px] text-muted-foreground">
                        <span>在途 {p.inFlight}</span>
                        {p.lastActivityAt ? <span>· 最近动静 {p.lastActivityAt.slice(5, 10)}</span> : <span>· 无动静</span>}
                        {!p.githubLinked ? (
                          <span className="inline-flex items-center gap-1 rounded border border-dashed border-[hsl(var(--hairline-strong))] px-1.5 text-[11px]" title="没接 GitHub 就没有合并事件，「合并」这一环永远是 0——那是看不见，不是没有">
                            <GitMerge className="h-3 w-3" />未接 GitHub
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-3"><MiniFunnel f={p.funnel} /></td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1.5 font-mono text-[11.5px]">
                        <span className="rounded px-1.5 py-0.5" style={{ background: 'hsl(var(--ok-soft))', color: 'hsl(var(--ok))' }}>通过 {p.funnel.pass}</span>
                        <span className="rounded px-1.5 py-0.5" style={{ background: 'hsl(var(--warn-soft))', color: 'hsl(var(--warn))' }}>原则性 {p.funnel.conditional}</span>
                        <span className="rounded px-1.5 py-0.5" style={{ background: 'hsl(var(--bad-soft))', color: 'hsl(var(--bad))' }}>未通过 {p.funnel.fail}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {leakTotal === 0
                        ? <span className="text-muted-foreground">无</span>
                        : <span className="font-mono text-[15px] font-semibold" style={{ color: p.leaks['merged-not-accepted'] || p.leaks['merged-while-failing'] ? 'hsl(var(--bad))' : 'hsl(var(--warn))' }}>{leakTotal}</span>}
                      {p.staleReports > 0 ? (
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground" title="这些报告验的分支已被 CDS 回收，无从核对，所以不计进漏">
                          另有 {p.staleReports} 份无从核对
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      {p.missingKinds.length === 0
                        ? <span className="text-muted-foreground">九类都做过</span>
                        : (
                          <div className="flex flex-wrap gap-1">
                            {p.missingKinds.map((k) => (
                              <span key={k} className="rounded border border-dashed border-[hsl(var(--hairline-strong))] px-1.5 py-0.5 text-[11.5px] text-muted-foreground">{k}</span>
                            ))}
                          </div>
                        )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
