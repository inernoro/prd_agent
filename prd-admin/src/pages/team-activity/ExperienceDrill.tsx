/**
 * 体验下钻抽屉（右栏「指数面板 ↔ 下钻」二选一渲染）。
 * 点热力图痛点块 / 痛点榜「AI 诊断」→ 进入本抽屉：
 *   ① 四级面包屑（模块 › 端点 › 错误码 › 样本）
 *   ② 错误码分布（条形）
 *   ③ 真实请求样本（取该端点最近的代表性 apirequestlogs，curl 等宽代码块）
 *   ④ AI 根因诊断（SSE 流式，逐字渲染，复用 ILlmGateway）
 *   操作：转为缺陷（回调到父组件复用 createDefect + setInsightState）/ 关闭返回指数面板
 * 数据源：GET /api/team-activity/endpoint-detail（明细）+ /api/team-activity/diagnose（SSE 诊断）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Bug, ChevronRight, ClipboardList, RotateCcw, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { StreamingText } from '@/components/streaming/StreamingText';
import { useSseStream } from '@/lib/useSseStream';
import { getTeamActivityEndpointDetail } from '@/services';
import type { TeamActivityEndpointDetailData } from '@/services/contracts/teamActivity';

const ERR = '#f8717a';
const SLOW = '#fbbf24';

function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ExperienceDrill({
  target,
  label,
  from,
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
    void diag.start({
      url: `/api/team-activity/diagnose?target=${encodeURIComponent(target)}${from ? `&from=${encodeURIComponent(from)}` : ''}`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, from]);

  // 进入即拉明细 + 自动开始 AI 诊断（边等边看，符合「禁止空白等待」）
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setDetail(null);
    setDetailError(null);
    void getTeamActivityEndpointDetail({ target, from }).then((res) => {
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
  }, [target, from]);

  const moduleName = detail?.module || label.split(' · ')[0] || '模块';
  const leafName = detail?.label || label.split(' · ')[1] || label;
  const topCode = detail?.codes?.[0]?.code;
  const maxCodeN = Math.max(1, ...(detail?.codes ?? []).map((c) => c.n));

  // 面包屑四级：模块 › 端点 › 错误码（无则用「样本」）› 样本
  const crumbs = [moduleName, leafName, topCode || '体验样本', '请求样本'];

  // 整高 drawer 形态：自身撑满父级 drawer 高度（h-full），头部/面包屑/操作区固定，中间滚动区 flex-fill。
  return (
    <div className="flex flex-col h-full" style={{ minHeight: 0 }}>
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

      <div
        className="flex-1 px-4 pb-4 flex flex-col gap-3.5"
        style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
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
              {detail.errorCount > 0 ? (
                <span style={{ color: ERR }}>报错 {detail.errorCount} 次</span>
              ) : null}
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

        {/* 真实请求样本 */}
        {detail && detail.samples.length > 0 ? (
          <div>
            <div className="text-[12px] text-white/55 font-medium mb-2">真实请求样本</div>
            <div className="flex flex-col gap-2">
              {detail.samples.map((s, i) => {
                const isErr = s.statusCode >= 400 && s.statusCode !== 401;
                return (
                  <div key={i} className="rounded-md border border-white/[0.06] bg-[#0c0d0f] overflow-hidden">
                    <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-white/[0.05] text-[10.5px] tabular-nums">
                      <span style={{ color: isErr ? ERR : '#5eead4' }}>HTTP {s.statusCode}</span>
                      {typeof s.durationMs === 'number' ? <span className="text-white/40">{s.durationMs}ms</span> : null}
                      <span className="ml-auto text-white/30 font-mono">{fmtTime(s.occurredAt)}</span>
                    </div>
                    <pre
                      className="px-2.5 py-2 text-[10.5px] leading-relaxed text-white/65 font-mono"
                      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', overflowX: 'auto' }}
                    >
                      {s.curl}
                      {s.requestBody ? `\nbody: ${s.requestBody}` : ''}
                    </pre>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* AI 根因诊断（SSE 流式） */}
        <div>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-[12px] text-white/55 font-medium">AI 根因诊断</span>
            {diagModel ? <span className="text-[10px] text-white/30 font-mono">{diagModel}</span> : null}
            {diag.phase === 'connecting' || diag.phase === 'streaming' ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-white/40">
                <MapSpinner size={11} />
                {diag.phaseMessage || '分析中…'}
              </span>
            ) : null}
            {diag.phase === 'error' ? (
              <span className="text-[11px] text-amber-200/80">{diag.phaseMessage || '诊断失败'}</span>
            ) : null}
            {diag.phase === 'done' || diag.phase === 'error' ? (
              <button
                type="button"
                onClick={startDiagnose}
                className="ml-auto inline-flex items-center gap-1 px-2 h-[22px] rounded text-[11px] border bg-white/[0.03] text-white/50 border-white/10 hover:text-white/80 hover:border-white/25 transition-colors cursor-pointer"
              >
                <RotateCcw size={11} />
                重新诊断
              </button>
            ) : null}
          </div>
          <div
            className="rounded-md px-3 py-2.5 bg-white/[0.02] border border-white/[0.06] text-[12px] leading-relaxed text-white/75"
            style={{ minHeight: 64 }}
          >
            {diag.typing ? (
              diag.phase === 'done' ? (
                <MarkdownContent content={diag.typing} variant="reading" />
              ) : (
                <StreamingText text={diag.typing} streaming mode="blur" />
              )
            ) : diag.phase === 'error' ? (
              <span className="text-[11px] text-white/40">未能生成诊断，可点「重新诊断」重试</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-white/35">
                <MapSpinner size={11} />
                正在准备诊断…
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 操作区：「转为缺陷」「转需求」都改为请求父组件打开弹窗（预填可编辑 + 指派人 / 步骤向导），不再就地直接发送 */}
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
