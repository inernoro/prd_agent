/**
 * 验收报告首页第一屏 —— `/reports` 不选项目时的跨项目总览。
 *
 * 编排层：只管「读者先看到什么、点放大之后展开什么」，以及悬浮提示的事件委托。
 * 具体的图形都在 CompactStrip.tsx 里，紧凑态与放大态**共用同一套视觉语言**
 * （数字 + 分段条 + 点阵）。
 *
 * 这一版之前是厂房剖面（传送带 + 货箱 + 闸门）。那套隐喻要占半屏、带标签才读得懂，
 * 缩进第一屏那一小块之后只剩一堆灰方块，用户原话「这个设计可以吗，我看这个完全是
 * 看不明白」。放大态留着它则更糟：同一页上两套编码，读者要来回翻译。整体换掉。
 */
import { useState } from 'react';
import { buildPipelineHeadline } from '@/lib/pipelineHeadline';
import { CompactStrip, EXPAND_CSS, ExpandedPanel, STRIP_CSS, splitFunnel } from '@/pages/reports/CompactStrip';
import { TREND_CSS, TrendCharts } from '@/pages/reports/TrendCharts';
import type { PipelineFunnel, PipelineOverview, PipelineProjectRow, PipelineSeries } from '@/lib/api';

export interface PipelinePanelProps {
  pipeline: PipelineOverview;
  /** 日序列。旧后端不返回它，此时只画存量、不画走向，且不能崩。 */
  series: PipelineSeries | null;
  onOpenProject: (projectId: string) => void;
}

/* ============================ 悬浮提示 ============================
   一格一条改动，光看图不知道是哪一条。提示走**事件委托**：元素只挂一个 data-tip
   字符串（换行用 \n），pp-root 上统一接 mouseover / mousemove / mouseout。 */

const PANEL_CSS = `
.pp-root .pp-tip{position:fixed;z-index:60;pointer-events:none;max-width:18.75rem;
  padding:0.5625rem 0.6875rem;border-radius:0.5rem;border:1px solid hsl(var(--hairline-strong));
  background:hsl(var(--card));color:hsl(var(--foreground));
  box-shadow:0 0.625rem 1.75rem hsl(var(--foreground) / 0.14);}
.pp-root .pp-tip-h{font-size:0.8125rem;font-weight:600;line-height:1.5;word-break:break-all;}
.pp-root .pp-tip-l{font-size:0.75rem;line-height:1.6;color:hsl(var(--muted-foreground));word-break:break-all;}
`;

/** 把几行文字编成 data-tip。空行自动丢掉，省得调用方到处写条件。 */
export function tip(...lines: Array<string | false | null | undefined>): string {
  return lines.filter((l): l is string => Boolean(l)).join('\n');
}

interface TipState {
  x: number;
  y: number;
  lines: string[];
}

function useTipDelegate(): {
  tipState: TipState | null;
  handlers: {
    onMouseOver: (e: React.MouseEvent) => void;
    onMouseMove: (e: React.MouseEvent) => void;
    onMouseOut: (e: React.MouseEvent) => void;
  };
} {
  const [tipState, setTipState] = useState<TipState | null>(null);
  const read = (e: React.MouseEvent): string | null => {
    const el = e.target as Element | null;
    // SVG 元素在旧一点的引擎里没有 closest，兜一手。
    const hit = el && typeof el.closest === 'function' ? el.closest('[data-tip]') : null;
    return hit ? hit.getAttribute('data-tip') : null;
  };
  return {
    tipState,
    handlers: {
      onMouseOver: (e) => {
        const raw = read(e);
        setTipState(raw ? { x: e.clientX, y: e.clientY, lines: raw.split('\n') } : null);
      },
      onMouseMove: (e) => {
        const raw = read(e);
        setTipState(raw ? { x: e.clientX, y: e.clientY, lines: raw.split('\n') } : null);
      },
      onMouseOut: () => setTipState(null),
    },
  };
}

/** 跟着鼠标走的提示框。贴到视口边缘就翻到另一侧，不让它被裁掉。 */
function TipBox({ state }: { state: TipState }): JSX.Element {
  const W = 300;
  const H = 26 * state.lines.length + 20;
  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
  const left = state.x + 16 + W > vw ? Math.max(8, state.x - 16 - W) : state.x + 16;
  const top = state.y + 18 + H > vh ? Math.max(8, state.y - 18 - H) : state.y + 18;
  return (
    <div className="pp-tip" style={{ left, top }}>
      <div className="pp-tip-h">{state.lines[0]}</div>
      {state.lines.slice(1).map((l, i) => (
        <div key={i} className="pp-tip-l">
          {l}
        </div>
      ))}
    </div>
  );
}

/* ============================ 口径 ============================ */

/**
 * 把漏斗基数拆成分流图的三段。
 *
 * 刻意**不用** `leaks['deployed-not-accepted']` 那个桶：它排除了「合并了没验」那一类，
 * 等分支墓碑数据接进来（当前全库 merged=0，因为聚合还没接），桶里的数会小于真实的
 * 「已部署未验收」，分流图就加不回总数、凭空少几个方块，而且今天两者恰好相等、
 * 明天才静默错位——最难查的那种。
 *
 * 实现直接转给 splitFunnel：此前这里和 CompactStrip 的 rowSplit 是两份实现，
 * 这一份只对每段各自 max(0, …)，在「验过的比部署的还多」这种脏数据上三段之和会
 * 大于 changes（Codex review 抓到）。现在只有一个口径。
 */
export function splitChanges(f: PipelineFunnel): { accepted: number; heap: number; undeployed: number } {
  return splitFunnel(f);
}

/** 一垛的悬浮内容：图上只放得下项目名和一个数，其余都在这里。 */
export function projectTip(p: PipelineProjectRow): string {
  const f = p.funnel;
  const verdicts = f.pass + f.conditional + f.fail;
  return tip(
    p.projectName,
    `改动 ${Math.max(0, f.changes)} · 部署过 ${Math.max(0, f.deployed)} · 验过 ${Math.max(0, f.accepted)}`,
    verdicts > 0
      ? `通过 ${f.pass} · 原则性 ${f.conditional} · 未通过 ${f.fail}`
      : '一条都没验过',
    p.staleReports > 0 ? `另有 ${p.staleReports} 份报告的分支已回收` : '',
    p.lastActivityAt ? `最近动静 ${p.lastActivityAt.slice(0, 10)}` : '没有动静',
    p.githubLinked ? '' : '未接 GitHub，合并这一环查不到',
    '点击进入该项目',
  );
}

/* ============================ 结论 ============================ */

const TONE_DOT: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'bg-[hsl(var(--ok))]',
  warn: 'bg-[hsl(var(--warn))]',
  bad: 'bg-[hsl(var(--bad))]',
};

/**
 * 第一眼那句判断。
 *
 * 句子由 buildPipelineHeadline 规则生成，每句都挂着真实数字——它早就写好了，
 * 只是首页三次重做之后没人再引用它（文件和它的 7 条守卫都还在、测试照绿），
 * 于是这一屏退回成「一堆好看的图形，看不出在讲什么」。这里把它接回来。
 */
function Headline({ h, full }: { h: ReturnType<typeof buildPipelineHeadline>; full?: boolean }): JSX.Element {
  // 紧凑态**只给一句**。支撑点与下一步是放大之后才该出现的东西——
  // 第一屏摆三四行字，就成了「左边一堆字、右边一张图」，与「少字多图」正好相反。
  if (!full) {
    return (
      <p className="m-0 flex items-center gap-2 text-[0.9375rem] leading-[1.6] text-muted-foreground">
        <span className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[h.tone]}`} />
        <span className="min-w-0 text-foreground">{h.sentence}</span>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <span className={`mt-[0.5625rem] h-2 w-2 shrink-0 rounded-full ${TONE_DOT[h.tone]}`} />
        <p className="m-0 text-[1.1875rem] font-semibold leading-[1.5]">{h.sentence}</p>
      </div>
      {h.points.length ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 pl-[1.125rem]">
          {h.points.map((t) => (
            <li key={t} className="text-[0.8125rem] leading-[1.6] text-muted-foreground">
              {t}
            </li>
          ))}
        </ul>
      ) : null}
      {h.action ? (
        <p className="m-0 pl-[1.125rem] text-[0.8125rem] leading-[1.6] text-foreground">{h.action}</p>
      ) : null}
    </div>
  );
}

/* ============================ 面板 ============================ */

function Card({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-[0.75rem] border border-[hsl(var(--hairline))] bg-card px-4 py-4 sm:px-5">
      {children}
    </div>
  );
}

export function PipelinePanel({ pipeline, series, onOpenProject }: PipelinePanelProps): JSX.Element {
  const orphan = Math.max(0, pipeline.totalLeaks['report-missing-change-key'] ?? 0);
  const reclaimed = Math.max(0, pipeline.staleReports);
  const split = splitChanges(pipeline.total);
  const headline = buildPipelineHeadline(pipeline);
  const { tipState, handlers } = useTipDelegate();
  const [zoom, setZoom] = useState(false);

  // 走向与存量是两个问题（「在往哪走」和「现在多少」），所以两块都在，
  // 不是二选一。旧后端没有 series 时这一块整块不出现，页面只少一层信息。
  const trends = series ? <TrendCharts series={series} zoom={zoom} /> : null;

  const strip = (
    <CompactStrip
      pipeline={pipeline}
      split={split}
      orphan={orphan}
      reclaimed={reclaimed}
      onOpenProject={onOpenProject}
      projectTip={projectTip}
    />
  );

  return (
    <div className="pp-root flex flex-col gap-4" {...handlers}>
      {tipState ? <TipBox state={tipState} /> : null}
      <style>{PANEL_CSS}</style>
      <style>{STRIP_CSS}</style>
      <style>{EXPAND_CSS}</style>
      <style>{TREND_CSS}</style>

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="m-0 text-[1.375rem] font-bold tracking-[0.14em]">验收流水线</h1>
        <div className="flex items-baseline gap-4">
          <span className="font-mono text-[0.8125rem] tracking-[0.16em] text-muted-foreground">
            {pipeline.generatedAt.slice(0, 10)}
          </span>
          <button
            type="button"
            className="rounded-md border border-[hsl(var(--hairline))] px-2.5 py-1 text-[0.75rem] text-muted-foreground hover:text-foreground"
            onClick={() => setZoom((v) => !v)}
          >
            {zoom ? '收起' : '放大'}
          </button>
        </div>
      </div>

      {/*
        第一眼只占一小块：整屏铺开的图是「好看但不知道在讲什么」。
        放大之后铺开的仍是同一套编码 —— 判断句 → 那条总览 → 逐项目明细，
        不切换成另一种隐喻，读者不必学第二遍怎么读。
      */}
      {zoom ? (
        <>
          <Card>
            <Headline h={headline} full />
          </Card>
          <Card>{strip}</Card>
          {trends}
          <Card>
            <ExpandedPanel
              pipeline={pipeline}
              orphan={orphan}
              reclaimed={reclaimed}
              onOpenProject={onOpenProject}
              projectTip={projectTip}
            />
          </Card>
        </>
      ) : (
        <>
          {strip}
          {trends}
        </>
      )}
    </div>
  );
}
