/**
 * 体验下钻抽屉（右栏「指数面板 ↔ 下钻」二选一渲染）。
 * 点热力图痛点块 / 痛点榜「AI 诊断」→ 进入本抽屉。
 *
 * 三段式体验（治「AI 报告埋在长页底部、要往下滑很久」）：
 *   ① 证据先行：进入即展示端点指标 + 错误码分布 + 真实请求样本（图1）。
 *   ② 大模型效果：AI 根因诊断 SSE 流式期间，证据下方一块「大模型阅读证据」面板（旋转球 + 逐字流）。
 *   ③ 收束成 Tab：模型返回后，顶部出现 Tab 栏，第一个 Tab = AI 诊断报告（图2，默认选中），
 *      第二个 Tab = 原始证据（图1）。让用户清楚「报告是从证据分析得来的」。
 *
 * 每个内容块（AI 报告、单条请求样本）都包在 ExpandablePanel：右上角「放大」按钮全屏看，
 * 右下角原生 resize 抓手可拖拽改大小，解决窄抽屉里大段 JSON / 报告看不全的问题。
 *
 * 数据源：GET /api/team-activity/endpoint-detail（明细）+ /api/team-activity/diagnose（SSE 诊断）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bug, ChevronRight, ClipboardList, Maximize2, Minimize2, RotateCcw, Sparkles, X } from 'lucide-react';
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
 * 可放大 / 可拖拽尺寸的内容容器。
 * - 右上角「放大」按钮：createPortal 到 body 的大尺寸浮层全屏阅读（再点还原）。
 * - 右下角原生 resize 抓手（resize:both + overflow:auto）：直接拖拽改大小。
 * 内容 children 会在内联面板与放大浮层各渲染一次（均为静态文本，重复挂载无副作用）。
 */
function ExpandablePanel({
  title,
  icon,
  initialHeight,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  /** 内联态初始高度（px）；不传则自适应内容，仍可向下拖拽 */
  initialHeight?: number;
  children: ReactNode;
}) {
  const [max, setMax] = useState(false);

  const head = (large: boolean) => (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] shrink-0">
      <span className="text-[12px] font-medium text-white/60 flex items-center gap-1.5 min-w-0">
        {icon}
        <span className="truncate">{title}</span>
      </span>
      <button
        type="button"
        onClick={() => setMax(large ? false : true)}
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
            // 右下角原生抓手：拖拽改大小。窄抽屉里宽度受容器约束，高度可自由拉伸。
            resize: 'both',
            overflow: 'auto',
            overscrollBehavior: 'contain',
            maxWidth: '100%',
            ...(initialHeight ? { height: initialHeight } : {}),
            minHeight: 80,
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
                <div
                  className="flex-1 p-5"
                  style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
                >
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
  // 当前激活 Tab（仅模型返回后出现 Tab 栏）：ai = AI 报告（图2，默认）/ raw = 原始证据（图1）
  const [tab, setTab] = useState<'ai' | 'raw'>('ai');

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
    setTab('ai');
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
      if (res.success) {
        setDetail(res.data);
      } else {
        setDetailError(res.error?.message ?? '加载端点明细失败');
      }
      setLoading(false);
    });
    startDiagnose();
    return () => {
      alive = false;
      diag.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, from, to]);

  // 模型返回（done）→ 默认切到 AI 报告 Tab，呈现「图2 由图1 分析得出」
  const prevPhase = useRef(diag.phase);
  useEffect(() => {
    if (diag.phase === 'done' && prevPhase.current !== 'done') setTab('ai');
    prevPhase.current = diag.phase;
  }, [diag.phase]);

  const moduleName = detail?.module || label.split(' · ')[0] || '模块';
  const leafName = detail?.label || label.split(' · ')[1] || label;
  const topCode = detail?.codes?.[0]?.code;
  const maxCodeN = Math.max(1, ...(detail?.codes ?? []).map((c) => c.n));
  const crumbs = [moduleName, leafName, topCode || '体验样本', '请求样本'];

  // 模型返回（或失败）后才把页面收束成 Tab；之前是「证据 + 大模型阅读中」单列
  const showTabs = diag.phase === 'done' || diag.phase === 'error';

  /* ── 原始证据（图1）：指标 + 错误码 + 真实请求样本，Tab=raw 与未收束时复用 ── */
  const renderEvidence = () => (
    <div className="flex flex-col gap-3.5">
      {/* target + 量化指标 */}
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

      {/* 错误码分布 */}
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

      {/* 真实请求样本：每条包 ExpandablePanel（放大 + 拖拽），治大段 JSON 看不全 */}
      {detail && detail.samples.length > 0 ? (
        <div>
          <div className="text-[12px] text-white/55 font-medium mb-2">真实请求样本</div>
          <div className="flex flex-col gap-2.5">
            {detail.samples.map((s, i) => {
              const isErr = s.statusCode >= 400 && s.statusCode !== 401;
              return (
                <ExpandablePanel
                  key={i}
                  initialHeight={150}
                  title={
                    <span className="flex items-center gap-2 tabular-nums">
                      <span style={{ color: isErr ? ERR : '#5eead4' }}>HTTP {s.statusCode}</span>
                      {typeof s.durationMs === 'number' ? <span className="text-white/40">{s.durationMs}ms</span> : null}
                      <span className="text-white/30 font-mono">{fmtTime(s.occurredAt)}</span>
                    </span>
                  }
                >
                  <pre
                    className="text-[10.5px] leading-relaxed text-white/65 font-mono"
                    style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                  >
                    {s.curl}
                    {s.requestBody ? `\nbody: ${s.requestBody}` : ''}
                  </pre>
                </ExpandablePanel>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );

  /* ── AI 根因诊断正文（图2）：done 时进 Tab，可放大 / 拖拽 ── */
  const renderAiReport = () => (
    <ExpandablePanel
      initialHeight={460}
      icon={<Sparkles size={12} style={{ color: VIOLET }} />}
      title={
        <span className="flex items-center gap-2">
          AI 根因诊断
          {diagModel ? <span className="text-[10px] text-white/30 font-mono">{diagModel}</span> : null}
        </span>
      }
    >
      {diag.typing ? (
        <MarkdownContent content={diag.typing} variant="reading" />
      ) : (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <span className="text-[12px] text-white/45">未能生成诊断</span>
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
  );

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 0 }}>
      <style>{`@keyframes voc-orb-spin{to{transform:rotate(360deg)}}@keyframes voc-blink{0%,100%{opacity:.3}50%{opacity:1}}`}</style>

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

      {/* Tab 栏：仅模型返回后出现，AI 报告（图2）作为第一个、默认选中 */}
      {showTabs ? (
        <div className="px-4 pb-2.5 flex items-center gap-2 shrink-0" style={{ animation: 'voc-drawer-tabin .32s cubic-bezier(.2,.8,.2,1)' }}>
          <style>{`@keyframes voc-drawer-tabin{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}`}</style>
          <button
            type="button"
            onClick={() => setTab('ai')}
            className={`inline-flex items-center gap-1.5 px-3 h-[30px] rounded-lg text-[12.5px] font-medium border transition-colors cursor-pointer ${
              tab === 'ai'
                ? 'bg-violet-500/14 text-violet-200 border-violet-500/40'
                : 'bg-white/[0.02] text-white/55 border-white/10 hover:text-white/80 hover:border-white/20'
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: VIOLET }} />
            AI 诊断报告
          </button>
          <button
            type="button"
            onClick={() => setTab('raw')}
            className={`inline-flex items-center gap-1.5 px-3 h-[30px] rounded-lg text-[12.5px] font-medium border transition-colors cursor-pointer ${
              tab === 'raw'
                ? 'bg-cyan-500/14 text-cyan-200 border-cyan-500/35'
                : 'bg-white/[0.02] text-white/55 border-white/10 hover:text-white/80 hover:border-white/20'
            }`}
          >
            原始证据
            {detail ? <span className="text-[10px] text-white/40 tabular-nums">{detail.count}</span> : null}
          </button>
          {diag.phase === 'done' || diag.phase === 'error' ? (
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
      ) : null}

      <div
        className="flex-1 px-4 pb-4 flex flex-col gap-3.5"
        style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {showTabs ? (
          // 收束后：Tab 切换。AI 报告（图2）默认在前，原始证据（图1）可切回。
          tab === 'ai' ? (
            <>
              {diag.phase === 'done' ? (
                <div className="flex items-center gap-1.5 text-[11px] text-white/40 -mb-1">
                  <Sparkles size={11} style={{ color: VIOLET }} />
                  下方结论由 AI 阅读「原始证据」Tab 的真实请求分析得出
                </div>
              ) : null}
              {diag.phase === 'error' ? (
                <div className="rounded-md px-3 py-2.5 bg-amber-500/10 border border-amber-500/25 text-[11.5px] text-amber-200/85">
                  {diag.phaseMessage || '诊断失败，可点右上「重新诊断」重试'}
                </div>
              ) : null}
              {renderAiReport()}
            </>
          ) : (
            renderEvidence()
          )
        ) : (
          // 收束前：① 证据先行 + ② 大模型阅读证据（流式）
          <>
            {renderEvidence()}
            <div
              className="rounded-lg border p-3"
              style={{
                borderColor: 'rgba(167,139,250,0.32)',
                background: 'linear-gradient(180deg,rgba(40,33,60,0.55),rgba(22,18,32,0.55))',
              }}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="relative shrink-0"
                  style={{ width: 26, height: 26, borderRadius: '50%', background: `conic-gradient(from 0deg, ${VIOLET}, #60a5fa, #2dd4bf, ${VIOLET})`, animation: 'voc-orb-spin 1.4s linear infinite' }}
                >
                  <span className="absolute" style={{ inset: 4, borderRadius: '50%', background: '#1a1428' }} />
                </span>
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold text-violet-200">AI 根因诊断</div>
                  {diagModel ? <div className="text-[10px] text-white/35 font-mono truncate">{diagModel}</div> : null}
                </div>
                <span className="ml-auto inline-flex items-center gap-1.5 text-[11px]" style={{ color: VIOLET }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: VIOLET, animation: 'voc-blink 1.1s ease-in-out infinite' }} />
                  {diag.phaseMessage || '正在阅读真实请求…'}
                </span>
              </div>
              <div className="mt-2.5 text-[12px] leading-relaxed text-white/75" style={{ minHeight: 40 }}>
                {diag.typing ? (
                  <StreamingText text={diag.typing} streaming mode="blur" />
                ) : (
                  <span className="text-[11px] text-white/35">大模型正在分析上方证据，稍后将收起为顶部标签页…</span>
                )}
              </div>
            </div>
          </>
        )}
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
