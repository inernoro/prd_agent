/**
 * 体验下钻抽屉（右栏「指数面板 ↔ 下钻」二选一渲染）。
 * 点热力图痛点块 / 痛点榜「AI 诊断」→ 进入本抽屉。
 *
 * 两个页签（治「根因分析埋在长页底部、要往下滑很久才看到」）：
 *   ①【根因分析】（默认进入这一页）：AI 根因诊断报告。诊断流式期间在本页内就地展示
 *      「大模型阅读证据」效果（旋转球 + 逐字流），返回后渲染完整报告。报告包在 ExpandablePanel：
 *      右上角放大全屏看 + 右下角拖拽改尺寸（用户自调显示面积，把长报告看全）。
 *   ②【真实请求样本】：端点指标 + 错误码分布 + 真实请求样本（curl）。
 *   页签常驻、根因分析常为落地页 —— 进入即见结论，不再需要翻页找。
 *
 * 数据源：GET /api/team-activity/endpoint-detail（明细）+ /api/team-activity/diagnose（SSE 诊断）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bug, Check, ChevronRight, ClipboardList, Maximize2, Minimize2, RotateCcw, Sparkles, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { StreamingText } from '@/components/streaming/StreamingText';
import { useSseStream } from '@/lib/useSseStream';
import { getTeamActivityEndpointDetail } from '@/services';
import type { TeamActivityEndpointDetailData } from '@/services/contracts/teamActivity';

const ERR = '#f8717a';
const SLOW = '#fbbf24';
const VIOLET = '#a78bfa';

function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 可放大 / 可拖拽尺寸的内容容器（用户要求：根因分析报告右下角能拖大拖小，方便看全）。
 * - 右上角「放大」按钮：createPortal 到 body 的大尺寸浮层全屏阅读（再点还原）。
 * - 右下角原生 resize 抓手（resize:both + overflow:auto）：直接拖拽改大小。
 */
function ExpandablePanel({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  const [max, setMax] = useState(false);

  const head = (large: boolean) => (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] shrink-0">
      <span className="text-[12px] font-medium text-white/60 flex items-center gap-1.5 min-w-0">
        <Sparkles size={12} style={{ color: VIOLET }} />
        <span className="truncate">{title}</span>
      </span>
      <button
        type="button"
        onClick={() => setMax(!large)}
        title={large ? '还原' : '放大查看'}
        className="ml-auto inline-flex items-center justify-center w-6 h-6 rounded text-white/40 hover:text-white/85 hover:bg-white/[0.08] transition-colors cursor-pointer shrink-0"
      >
        {large ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
    </div>
  );

  return (
    <>
      <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] overflow-hidden flex flex-col">
        {head(false)}
        <div
          style={{
            // 默认自适应内容高度：完整展示全部 AI 分析，不再固定高度内截断；
            // 整页滚动交给抽屉 body。仍保留右下角原生抓手可手动拖大拖小。
            resize: 'both',
            overflow: 'auto',
            overscrollBehavior: 'contain',
            maxWidth: '100%',
            minHeight: 120,
          }}
        >
          <div className="p-3">{children}</div>
        </div>
      </div>

      {max
        ? createPortal(
            <div
              className="fixed inset-0 z-[120] flex items-center justify-center p-4"
              style={{ background: 'rgba(0,0,0,0.62)' }}
              onClick={() => setMax(false)}
            >
              <div
                className="flex flex-col rounded-xl border border-white/12 overflow-hidden"
                style={{
                  width: 'min(980px, 95vw)',
                  height: 'min(88vh, 920px)',
                  background: '#16171b',
                  boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
                  resize: 'both',
                  maxWidth: '95vw',
                  maxHeight: '92vh',
                  minWidth: 360,
                  minHeight: 240,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {head(true)}
                <div className="flex-1 p-5" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                  {children}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

/**
 * 诊断等待动画：旋转球 + 推进式步骤清单。模型还没吐首字时占位，
 * 让用户「有东西在动可看」（用户反馈：等待时没东西可看，加点小动画）。
 * 步骤按时间推进（不依赖真实进度，纯节奏占位），推进到最后一步保持脉冲。
 */
const DIAG_STEPS = ['读取真实请求样本', '解析慢请求耗时分布', '比对错误码与参数线索', '归纳根因结论'];
function DiagnosingAnimation() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((v) => Math.min(v + 1, DIAG_STEPS.length - 1)), 1400);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <span
        className="relative"
        style={{ width: 34, height: 34, borderRadius: '50%', background: `conic-gradient(from 0deg, ${VIOLET}, #60a5fa, #2dd4bf, ${VIOLET})`, animation: 'voc-orb-spin 1.4s linear infinite' }}
      >
        <span className="absolute" style={{ inset: 5, borderRadius: '50%', background: '#16171b' }} />
      </span>
      <div className="text-[11.5px] text-white/45">大模型正在分析真实请求样本…</div>
      <div className="flex flex-col gap-2 w-full max-w-[260px]">
        {DIAG_STEPS.map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <div key={i} className="flex items-center gap-2.5 text-[11.5px]">
              <span
                className="inline-flex items-center justify-center shrink-0 rounded-full"
                style={{
                  width: 16,
                  height: 16,
                  border: `1px solid ${done ? 'rgba(52,211,153,0.5)' : active ? 'rgba(167,139,250,0.6)' : 'rgba(255,255,255,0.12)'}`,
                  background: done ? 'rgba(52,211,153,0.16)' : active ? 'rgba(167,139,250,0.18)' : 'transparent',
                  // 当前步：脉冲光环（1:1 复刻 demo 的 active ring）
                  animation: active ? 'voc-step-ring 1.3s ease-in-out infinite' : undefined,
                }}
              >
                {done ? (
                  <Check size={10} style={{ color: '#34d399' }} />
                ) : active ? (
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: VIOLET, animation: 'voc-blink 1.1s ease-in-out infinite' }} />
                ) : (
                  <span className="w-1 h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.25)' }} />
                )}
              </span>
              <span style={{ color: done ? 'rgba(236,236,239,0.45)' : active ? '#c4b5fd' : 'rgba(236,236,239,0.3)' }}>
                {s}
                {active ? '…' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 单条真实请求样本：curl + body 内容过长（图文 JSON 动辄数千字）默认截断，
 * 「展开全部」后限高滚动，避免撑爆抽屉（用户反馈：内容过长，需要截断）。
 */
function SampleBlock({ s }: { s: TeamActivityEndpointDetailData['samples'][number] }) {
  const [expanded, setExpanded] = useState(false);
  const isErr = s.statusCode >= 400 && s.statusCode !== 401;
  const full = `${s.curl}${s.requestBody ? `\nbody: ${s.requestBody}` : ''}`;
  const LIMIT = 600;
  const tooLong = full.length > LIMIT;
  const shown = !tooLong || expanded ? full : `${full.slice(0, LIMIT)}…`;
  return (
    <div className="rounded-md border border-white/[0.06] bg-[#0c0d0f] overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-white/[0.05] text-[10.5px] tabular-nums">
        <span style={{ color: isErr ? ERR : '#5eead4' }}>HTTP {s.statusCode}</span>
        {typeof s.durationMs === 'number' ? <span className="text-white/40">{s.durationMs}ms</span> : null}
        <span className="ml-auto text-white/30 font-mono">{fmtTime(s.occurredAt)}</span>
      </div>
      <pre
        className="px-2.5 py-2 text-[10.5px] leading-relaxed text-white/65 font-mono"
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          // 展开时限高滚动，不让超长 JSON 把整页顶飞
          maxHeight: expanded ? 320 : undefined,
          overflowY: expanded ? 'auto' : undefined,
          overscrollBehavior: 'contain',
        }}
      >
        {shown}
      </pre>
      {tooLong ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full px-2.5 py-1.5 text-left text-[10.5px] text-white/45 hover:text-white/80 border-t border-white/[0.05] bg-white/[0.015] hover:bg-white/[0.04] transition-colors cursor-pointer"
        >
          {expanded ? '收起' : `展开全部（约 ${full.length.toLocaleString()} 字）`}
        </button>
      ) : null}
    </div>
  );
}

/** 把诊断报告 markdown 按标题切段（# / ①②③ / 1. 起头），供分段浮现 */
function splitSections(md: string): string[] {
  const isHeading = (l: string) =>
    /^#{1,4}\s/.test(l) || /^\s*[①②③④⑤⑥⑦⑧⑨⑩]/.test(l) || /^\s*\d+[.、)]\s/.test(l);
  const lines = md.split('\n');
  const secs: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (isHeading(l) && cur.some((x) => x.trim())) {
      secs.push(cur.join('\n'));
      cur = [l];
    } else {
      cur.push(l);
    }
  }
  if (cur.length) secs.push(cur.join('\n'));
  return secs.filter((s) => s.trim());
}

/** 完成态：根因报告按段「浮现 + 左缘点亮」依次出现（1:1 复刻 demo 的分段点亮） */
function ReportSections({ md }: { md: string }) {
  const secs = useMemo(() => splitSections(md), [md]);
  if (secs.length <= 1) return <MarkdownContent content={md} variant="reading" />;
  return (
    <div className="flex flex-col gap-1">
      {secs.map((s, i) => (
        <div key={i} className="voc-rca-sec" style={{ animationDelay: `${i * 0.18}s` }}>
          <MarkdownContent content={s} variant="reading" />
        </div>
      ))}
    </div>
  );
}

export function ExperienceDrill({
  target,
  label,
  from,
  to,
  convertingRequirement,
  requirementNo,
  onRequestDefectModal,
  onRequestRequirementModal,
  onClose,
}: {
  target: string;
  /** 痛点块/痛点榜给的展示名（模块 · 端点），明细到达前先用它兜底面包屑 */
  label: string;
  from?: string;
  /** 选中的窗口结束时间：透传给明细 + 诊断，避免后端默认 end=now 把历史选择混入后续请求 */
  to?: string;
  /** 父组件正在执行「转需求」 */
  convertingRequirement?: boolean;
  /** 该痛点已转产品需求时的需求编号（展示「已转需求 #No」chip） */
  requirementNo?: string | null;
  /** 请求父组件打开「转为缺陷」真实缺陷面板（GlobalDefectSubmitDialog，携预填，确认后才创建） */
  onRequestDefectModal: () => void;
  /** 请求父组件打开「转需求」步骤向导弹窗（选产品 → 核对 → 确认流转） */
  onRequestRequirementModal: () => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<TeamActivityEndpointDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [diagModel, setDiagModel] = useState<string | null>(null);
  // 页签常驻；默认落地在【根因分析】，进入即见结论，不再埋在长页底部
  const [tab, setTab] = useState<'rca' | 'samples'>('rca');

  const diag = useSseStream({
    url: '/api/team-activity/diagnose',
    typingEvent: 'delta',
    onEvent: {
      model: (data) => {
        const d = data as { model?: string; platform?: string };
        setDiagModel(d.model ? `${d.model}${d.platform ? ` · ${d.platform}` : ''}` : null);
      },
    },
  });

  const startDiagnose = useCallback(() => {
    setDiagModel(null);
    setTab('rca');
    void diag.start({
      url: `/api/team-activity/diagnose?target=${encodeURIComponent(target)}${from ? `&from=${encodeURIComponent(from)}` : ''}${to ? `&to=${encodeURIComponent(to)}` : ''}`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, from, to]);

  // 进入即拉明细 + 自动开始 AI 诊断（边等边看，符合「禁止空白等待」）
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setDetail(null);
    setDetailError(null);
    void getTeamActivityEndpointDetail({ target, from, to }).then((res) => {
      if (!alive) return;
      if (res.success) setDetail(res.data);
      else setDetailError(res.error?.message ?? '加载端点明细失败');
      setLoading(false);
    });
    startDiagnose();
    return () => {
      alive = false;
      diag.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, from, to]);

  const moduleName = detail?.module || label.split(' · ')[0] || '模块';
  const leafName = detail?.label || label.split(' · ')[1] || label;
  const topCode = detail?.codes?.[0]?.code;
  const maxCodeN = Math.max(1, ...(detail?.codes ?? []).map((c) => c.n));
  const crumbs = [moduleName, leafName, topCode || '体验样本', tab === 'rca' ? '根因分析' : '请求样本'];

  const diagActive = diag.phase === 'idle' || diag.phase === 'connecting' || diag.phase === 'streaming';

  /* ──【根因分析】页签：AI 报告（可放大 / 拖拽）。流式期间就地展示大模型阅读效果 ── */
  const renderRca = () => (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-white/40">
        <Sparkles size={11} style={{ color: VIOLET }} />
        结论由 AI 阅读「真实请求样本」分析得出
      </div>
      {/* 证据卡：端点 + 指标。大模型阅读期间点亮（表示模型正在读它，1:1 复刻 demo） */}
      <div className={`rounded-md px-3 py-2.5 bg-white/[0.02] border border-white/[0.06] transition-all duration-500 ${diagActive ? 'voc-evi-lit' : ''}`}>
        <div className="text-[12px] text-white/85 font-mono break-all">{target}</div>
        {detail ? (
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-2 text-[11px] tabular-nums">
            <span className="text-white/45">{detail.count} 次调用</span>
            {detail.errorCount > 0 ? <span style={{ color: ERR }}>报错 {detail.errorCount} 次</span> : null}
            {detail.slowCount > 0 ? (
              <span style={{ color: SLOW }}>
                慢请求 {detail.slowCount} 次 · 均 {detail.avgSlowSec}s
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <ExpandablePanel
        title={
          <span className="flex items-center gap-2">
            AI 根因诊断
            {diagModel ? <span className="text-[10px] text-white/30 font-mono">{diagModel}</span> : null}
            {diagActive ? (
              <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: VIOLET }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: VIOLET, animation: 'voc-blink 1.1s ease-in-out infinite' }} />
                {diag.phaseMessage || '阅读中…'}
              </span>
            ) : null}
          </span>
        }
      >
        {diagActive ? (
          diag.typing ? (
            // 大模型效果：逐字流（StreamingText blur）
            <div className="text-[12px] leading-relaxed text-white/80">
              <StreamingText text={diag.typing} streaming mode="blur" />
            </div>
          ) : (
            // 还没有首字：旋转球 + 推进式步骤清单，给用户「有东西在动」可看
            <DiagnosingAnimation />
          )
        ) : diag.typing ? (
          // 完成态：分段浮现 + 左缘点亮
          <ReportSections md={diag.typing} />
        ) : (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="text-[12px] text-white/45">{diag.phaseMessage || '未能生成诊断'}</span>
            <button
              type="button"
              onClick={startDiagnose}
              className="inline-flex items-center gap-1 px-2.5 h-[26px] rounded text-[11px] border bg-white/[0.03] text-white/55 border-white/12 hover:text-white/85 hover:border-white/25 transition-colors cursor-pointer"
            >
              <RotateCcw size={11} />
              重新诊断
            </button>
          </div>
        )}
      </ExpandablePanel>
    </div>
  );

  /* ──【真实请求样本】页签：指标 + 错误码 + curl 样本 ── */
  const renderSamples = () => (
    <div className="flex flex-col gap-3.5">
      <div className="rounded-md px-3 py-2.5 bg-white/[0.02] border border-white/[0.06]">
        <div className="text-[12px] text-white/85 font-mono break-all">{target}</div>
        {loading ? (
          <div className="mt-2">
            <MapSpinner size={13} />
          </div>
        ) : detail ? (
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-2 text-[11px] tabular-nums">
            <span className="text-white/45">{detail.count} 次调用</span>
            {detail.errorCount > 0 ? <span style={{ color: ERR }}>报错 {detail.errorCount} 次</span> : null}
            {detail.slowCount > 0 ? (
              <span style={{ color: SLOW }}>
                慢请求 {detail.slowCount} 次 · 均 {detail.avgSlowSec}s
              </span>
            ) : null}
          </div>
        ) : detailError ? (
          <div className="mt-2 text-[11px] text-amber-200/70">{detailError}</div>
        ) : null}
      </div>

      {detail && detail.codes.length > 0 ? (
        <div>
          <div className="text-[12px] text-white/55 font-medium mb-2">错误码分布</div>
          <div className="flex flex-col gap-2">
            {detail.codes.map((c) => (
              <div key={c.code} className="flex items-center gap-2">
                <span className="text-[11px] text-white/70 font-mono w-[120px] shrink-0 truncate" title={c.code}>
                  {c.code}
                </span>
                <span className="flex-1 h-[7px] rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <i
                    className="block h-full rounded-full"
                    style={{ width: `${Math.round((c.n / maxCodeN) * 100)}%`, background: ERR, transition: 'width .8s cubic-bezier(.2,.8,.2,1)' }}
                  />
                </span>
                <span className="text-[11px] text-white/40 tabular-nums w-8 text-right">{c.n}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {detail && detail.samples.length > 0 ? (
        <div>
          <div className="text-[12px] text-white/55 font-medium mb-2">真实请求样本</div>
          <div className="flex flex-col gap-2">
            {detail.samples.map((s, i) => (
              <SampleBlock key={i} s={s} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 0 }}>
      <style>{`
        @keyframes voc-orb-spin{to{transform:rotate(360deg)}}
        @keyframes voc-blink{0%,100%{opacity:.3}50%{opacity:1}}
        @keyframes voc-step-ring{0%,100%{box-shadow:0 0 0 0 rgba(167,139,250,0)}50%{box-shadow:0 0 0 5px rgba(167,139,250,.18)}}
        @keyframes voc-sec-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
        @keyframes voc-pane-in{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}
        /* 报告分段浮现 + 左缘点亮（边吐边逐段亮起） */
        .voc-rca-sec{opacity:0;border-left:2px solid rgba(167,139,250,.45);padding-left:11px;animation:voc-sec-in .5s cubic-bezier(.2,.8,.2,1) forwards}
        /* 证据卡在大模型阅读期间点亮（表示模型正在读它） */
        .voc-evi-lit{border-color:rgba(167,139,250,.4)!important;box-shadow:0 0 0 4px rgba(167,139,250,.07)}
      `}</style>

      <div className="flex items-center justify-between px-4 pt-3.5 pb-2 shrink-0">
        <span className="text-[13px] font-semibold text-white/85">端点下钻诊断</span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="inline-flex items-center justify-center w-7 h-7 rounded-md text-white/40 hover:text-white/80 hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <X size={16} />
        </button>
      </div>

      {/* 四级面包屑 */}
      <div className="px-4 pb-2 flex items-center gap-1 flex-wrap text-[11px] text-white/45 shrink-0">
        {crumbs.map((c, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {i > 0 ? <ChevronRight size={11} className="text-white/25" /> : null}
            <span className={i === crumbs.length - 1 ? 'text-white/75' : ''}>{c}</span>
          </span>
        ))}
      </div>

      {/* 页签栏：常驻。【根因分析】默认在前，【真实请求样本】在后 */}
      <div className="px-4 pb-2.5 flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => setTab('rca')}
          className={`inline-flex items-center gap-1.5 px-3 h-[30px] rounded-lg text-[12.5px] font-medium border transition-colors cursor-pointer ${
            tab === 'rca'
              ? 'bg-violet-500/14 text-violet-200 border-violet-500/40'
              : 'bg-white/[0.02] text-white/55 border-white/10 hover:text-white/80 hover:border-white/20'
          }`}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: VIOLET }} />
          根因分析
          {diagActive ? <MapSpinner size={11} /> : null}
        </button>
        <button
          type="button"
          onClick={() => setTab('samples')}
          className={`inline-flex items-center gap-1.5 px-3 h-[30px] rounded-lg text-[12.5px] font-medium border transition-colors cursor-pointer ${
            tab === 'samples'
              ? 'bg-cyan-500/14 text-cyan-200 border-cyan-500/35'
              : 'bg-white/[0.02] text-white/55 border-white/10 hover:text-white/80 hover:border-white/20'
          }`}
        >
          真实请求样本
          {detail ? <span className="text-[10px] text-white/40 tabular-nums">{detail.count}</span> : null}
        </button>
        {!diagActive ? (
          <button
            type="button"
            onClick={startDiagnose}
            title="重新诊断"
            className="ml-auto inline-flex items-center gap-1 px-2 h-[26px] rounded text-[11px] border bg-white/[0.03] text-white/50 border-white/10 hover:text-white/80 hover:border-white/25 transition-colors cursor-pointer"
          >
            <RotateCcw size={11} />
            重新诊断
          </button>
        ) : null}
      </div>

      <div
        className="flex-1 px-4 pb-4"
        style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {/* key=tab：切换时整块重挂载，触发淡入位移过渡（1:1 复刻 demo 的页签过渡） */}
        <div key={tab} style={{ animation: 'voc-pane-in .34s cubic-bezier(.2,.8,.2,1)' }}>
          {tab === 'rca' ? renderRca() : renderSamples()}
        </div>
      </div>

      {/* 操作区 */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-white/[0.05] flex-wrap shrink-0">
        <button
          type="button"
          onClick={onRequestDefectModal}
          className="inline-flex items-center gap-1 px-2.5 h-[26px] rounded text-[11px] border bg-amber-500/15 text-amber-200 border-amber-500/30 hover:bg-amber-500/25 transition-colors cursor-pointer"
        >
          <Bug size={12} />
          转为缺陷
        </button>
        {requirementNo ? (
          <span className="inline-flex items-center gap-1 px-2.5 h-[26px] rounded text-[11px] bg-cyan-500/10 text-cyan-200/90 border border-cyan-500/25">
            <ClipboardList size={12} />
            已转需求 #{requirementNo}
          </span>
        ) : convertingRequirement ? (
          <span className="inline-flex items-center gap-1 px-2.5 h-[26px] rounded text-[11px] bg-cyan-500/10 text-cyan-200/90 border border-cyan-500/25">
            <MapSpinner size={11} />
            流转中…
          </span>
        ) : (
          <button
            type="button"
            onClick={onRequestRequirementModal}
            className="inline-flex items-center gap-1 px-2.5 h-[26px] rounded text-[11px] border bg-cyan-500/10 text-cyan-200/90 border-cyan-500/25 hover:bg-cyan-500/20 transition-colors cursor-pointer"
          >
            <ClipboardList size={12} />
            转需求
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex items-center gap-1 px-2.5 h-[26px] rounded text-[11px] border bg-white/[0.03] text-white/50 border-white/10 hover:text-white/80 hover:border-white/25 transition-colors cursor-pointer"
        >
          <X size={12} />
          关闭
        </button>
      </div>
    </div>
  );
}
