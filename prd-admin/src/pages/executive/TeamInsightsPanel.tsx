import { useMemo, useState, useEffect } from 'react';
import { AlertTriangle, Eye, EyeOff, ChevronRight, Info } from 'lucide-react';
import { resolveAvatarUrl } from '@/lib/avatar';
import { getRoleMeta } from '@/lib/roleConfig';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { Tooltip } from '@/components/ui/Tooltip';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import type {
  TeamInsights,
  TeamInsightKpi,
  TeamInsightMember,
  TeamInsightFlowNode,
} from '@/services/contracts/executive';

/**
 * 团队洞察 — 结论优先四段式。
 *
 * 设计契约（对应 doc/design.executive-dashboard.md「结论先于明细」）：
 * - 所有数字来自 GET /api/executive/team-insights 的真实聚合，前端不做任何补零或推算。
 * - 后端给 null 的指标一律显示「数据不足」，禁止渲染成 0。
 * - 后端 meta.unavailable 列出的指标在页面底部照实说明缺什么、为什么，不假装有。
 */

const MASK_KEY = 'exec.teamInsights.masked';

const SEV = {
  critical: { color: 'var(--semantic-danger-text)', soft: 'var(--semantic-danger-soft)', border: 'var(--semantic-danger-border)', label: '立即处理' },
  watch: { color: 'var(--semantic-warning-text)', soft: 'var(--semantic-warning-soft)', border: 'var(--semantic-warning-border)', label: '本周观察' },
} as const;

const QUADRANT_COLOR: Record<string, string> = {
  '主力产出': 'var(--semantic-success-text)',
  '精工型': 'var(--semantic-warning-text)',
  '高量低果': 'var(--semantic-danger-text)',
  '低活跃': 'var(--text-muted)',
  '数据不足': 'var(--text-muted)',
};

export function maskName(name: string, masked: boolean) {
  if (!masked || !name) return name;
  return `${name[0]}**`;
}

export function fmt(n: number | null, unit: string) {
  if (n === null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (unit === 'tokens' && abs >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (abs >= 10000) return n.toLocaleString();
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function sparkPath(vals: number[], w: number, h: number) {
  if (vals.length < 2) return '';
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const rg = mx - mn || 1;
  return vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - ((v - mn) / rg) * (h - 4) - 2;
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

/* ── A. 团队状态 ─────────────────────────────────────────── */

function KpiCard({ kpi }: { kpi: TeamInsightKpi }) {
  const hasDelta = kpi.deltaPct !== null;
  const improving = hasDelta ? (kpi.higherIsBetter ? kpi.deltaPct! >= 0 : kpi.deltaPct! <= 0) : false;
  const deltaColor = !hasDelta
    ? 'var(--text-muted)'
    : improving
      ? 'var(--semantic-success-text)'
      : 'var(--semantic-warning-text)';
  const deltaBg = !hasDelta
    ? 'var(--bg-secondary)'
    : improving
      ? 'var(--semantic-success-soft)'
      : 'var(--semantic-warning-soft)';

  return (
    <div
      className="relative overflow-hidden rounded-xl px-4 pt-3.5 pb-3"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {kpi.label}
        <Tooltip content={<span style={{ fontWeight: 400 }}>{kpi.note}</span>} side="top">
          <Info size={11} style={{ color: 'var(--text-muted)', opacity: 0.6, flexShrink: 0 }} />
        </Tooltip>
      </div>
      <div className="flex items-baseline gap-1 mt-1.5">
        <span
          className="text-[26px] font-bold tabular-nums leading-none"
          style={{ color: kpi.value === null ? 'var(--text-muted)' : 'var(--text-primary)' }}
        >
          {kpi.value === null ? '数据不足' : fmt(kpi.value, kpi.unit)}
        </span>
        {kpi.value !== null && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{kpi.unit}</span>
        )}
      </div>
      <div
        className="inline-flex items-center mt-1.5 px-2 py-0.5 rounded-full text-[10.5px] tabular-nums"
        style={{ color: deltaColor, background: deltaBg }}
      >
        {hasDelta ? `${kpi.deltaPct! > 0 ? '+' : ''}${kpi.deltaPct}% vs 上一窗` : '无环比'}
      </div>
      {kpi.series.length > 1 && (
        <svg className="absolute right-0 bottom-0 opacity-80" width="104" height="38" viewBox="0 0 104 38" aria-hidden="true">
          <path d={`${sparkPath(kpi.series, 104, 38)} L104 38 L0 38 Z`} fill="var(--semantic-info-text, #5B8CFF)" opacity="0.07" />
          <path d={sparkPath(kpi.series, 104, 38)} fill="none" stroke="#5B8CFF" strokeWidth="1.5" opacity="0.5" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}

/* ── C. 成员画像散点 ─────────────────────────────────────── */

function Quadrant({
  members, medians, masked, pickedId, onPick,
}: {
  members: TeamInsightMember[];
  medians: { output: number; quality: number };
  masked: boolean;
  pickedId: string | null;
  onPick: (id: string) => void;
}) {
  const maxOutput = Math.max(1, ...members.map(m => m.output));
  const plotted = members.filter(m => m.quality !== null);
  const noQuality = members.length - plotted.length;

  return (
    <div className="rounded-xl px-4 pt-4 pb-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="relative ml-7 mt-4" style={{ height: 360 }}>
        {/* 中位线 —— 阈值来自后端真实中位数，不是拍的常数 */}
        <div
          className="absolute"
          style={{ left: `${(medians.output / maxOutput) * 92 + 4}%`, top: 0, width: 1, height: '100%', background: 'var(--border-default)' }}
        />
        <div
          className="absolute"
          style={{ left: 0, top: `${100 - (medians.quality * 0.88 + 6)}%`, width: '100%', height: 1, background: 'var(--border-default)' }}
        />

        <div className="absolute top-1 left-1 text-[9.5px] tracking-widest uppercase" style={{ color: 'var(--text-muted)' }}>精工型</div>
        <div className="absolute top-1 right-1 text-[9.5px] tracking-widest uppercase" style={{ color: 'var(--semantic-success-text)' }}>主力产出</div>
        <div className="absolute bottom-1 left-1 text-[9.5px] tracking-widest uppercase" style={{ color: 'var(--text-muted)' }}>低活跃</div>
        <div className="absolute bottom-1 right-1 text-[9.5px] tracking-widest uppercase" style={{ color: 'var(--semantic-danger-text)' }}>高量低果</div>

        <div
          className="absolute text-[10px] whitespace-nowrap"
          style={{ left: -24, top: '50%', transform: 'rotate(-90deg) translateX(50%)', transformOrigin: 'left center', color: 'var(--text-muted)' }}
        >
          结果质量
        </div>
        <div className="absolute text-[10px]" style={{ left: 0, bottom: -18, color: 'var(--text-muted)' }}>产出量</div>

        {plotted.map(m => {
          const x = (m.output / maxOutput) * 92 + 4;
          const y = 100 - (m.quality! * 0.88 + 6);
          const size = 22 + Math.min(m.outputDays, 10) * 2.6;
          const color = getRoleMeta(m.role).color;
          const active = pickedId === m.userId;
          return (
            <button
              key={m.userId}
              type="button"
              onClick={() => onPick(m.userId)}
              aria-pressed={active}
              aria-label={m.displayName}
              className="absolute rounded-full grid place-items-center transition-transform hover:scale-110"
              style={{
                left: `${x}%`,
                top: `${y}%`,
                width: size,
                height: size,
                transform: 'translate(-50%,-50%)',
                background: `${color}26`,
                border: `1.5px solid ${color}`,
                color,
                boxShadow: active ? `0 0 0 3px ${color}33` : undefined,
                zIndex: active ? 5 : 1,
              }}
            >
              <span className="text-[10px] font-bold">{maskName(m.displayName, masked)[0]}</span>
              <span
                className="absolute whitespace-nowrap text-[10.5px] pointer-events-none"
                style={{ top: 'calc(100% + 4px)', left: '50%', transform: 'translateX(-50%)', color: 'var(--text-secondary)' }}
              >
                {maskName(m.displayName, masked)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-6 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        气泡大小 = 有产出的天数 · 十字线 = 分型阈值（产出 {medians.output} 件 / 质量 {medians.quality}）
        {noQuality > 0 && ` · ${noQuality} 人本窗无结果型信号（缺陷或生图），未入图`}
      </div>
    </div>
  );
}

function MemberDetail({ member, masked }: { member: TeamInsightMember | null; masked: boolean }) {
  if (!member) {
    return (
      <div className="rounded-xl p-4 text-[12px]" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
        点左侧任一成员查看画像
      </div>
    );
  }
  const b = member.breakdown;
  const color = getRoleMeta(member.role).color;
  const bars: [string, number, number][] = [
    ['知识库文档', b.docs, Math.max(1, b.docs)],
    ['网页站点', b.sites, Math.max(1, b.sites)],
    ['生图完成', b.imageRuns, Math.max(1, b.imageRuns)],
    ['周报提交', b.reports, Math.max(1, b.reports)],
    ['缺陷解决', b.defectsResolved, Math.max(1, b.defectsAssigned || b.defectsResolved)],
  ];
  const barMax = Math.max(1, ...bars.map(x => x[1]));

  return (
    <div className="rounded-xl p-4 flex flex-col gap-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-2.5">
        {member.avatarFileName ? (
          <UserAvatar src={resolveAvatarUrl({ avatarFileName: member.avatarFileName })} className="w-9 h-9 rounded-full object-cover flex-shrink-0" />
        ) : (
          <div className="w-9 h-9 rounded-full grid place-items-center text-[13px] font-bold flex-shrink-0" style={{ background: `${color}22`, color }}>
            {maskName(member.displayName, masked)[0]}
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {maskName(member.displayName, masked)}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {getRoleMeta(member.role).label} · <span style={{ color: QUADRANT_COLOR[member.quadrant] }}>{member.quadrant}</span>
          </div>
        </div>
      </div>

      <div
        className="text-[12px] leading-relaxed rounded-lg px-3 py-2.5"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
      >
        本窗产出 <b className="tabular-nums" style={{ color: 'var(--text-primary)' }}>{member.output}</b> 件，
        分布在 <b className="tabular-nums" style={{ color: 'var(--text-primary)' }}>{member.outputDays}</b> 天。
        结果质量 <b className="tabular-nums" style={{ color: 'var(--text-primary)' }}>{member.quality ?? '数据不足'}</b>
        {member.quality !== null && ' / 100'}。
        模型调用 <b className="tabular-nums" style={{ color: 'var(--text-primary)' }}>{member.llmCalls}</b> 次
        {member.llmErrors > 0 && <>（失败 <b className="tabular-nums" style={{ color: 'var(--semantic-warning-text)' }}>{member.llmErrors}</b> 次）</>}，
        AI 成本 <b className="tabular-nums" style={{ color: 'var(--text-primary)' }}>{member.cost}</b> 元。
      </div>

      <div className="flex flex-col gap-2">
        {bars.map(([label, val]) => (
          <div key={label}>
            <div className="flex justify-between text-[11.5px] mb-1" style={{ color: 'var(--text-secondary)' }}>
              <span>{label}</span>
              <span className="tabular-nums" style={{ color: 'var(--text-primary)' }}>{val}</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="h-full rounded-full" style={{ width: `${(val / barMax) * 100}%`, background: color, opacity: 0.65 }} />
            </div>
          </div>
        ))}
      </div>

      <div>
        <div className="text-[10px] tracking-widest uppercase mb-1.5" style={{ color: 'var(--text-muted)' }}>本窗要点</div>
        <div className="flex flex-wrap gap-1.5">
          {member.highlights.map(h => (
            <span
              key={h}
              className="text-[11px] px-2 py-0.5 rounded-full"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
              {h}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── D. 价值流 ───────────────────────────────────────────── */

function FlowColumn({ title, nodes }: { title: string; nodes: TeamInsightFlowNode[] }) {
  const max = Math.max(1, ...nodes.map(n => n.value));
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="text-[10px] tracking-widest uppercase" style={{ color: 'var(--text-muted)' }}>{title}</div>
      {nodes.length === 0 && <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>本窗无数据</div>}
      {nodes.map(n => {
        const c = n.loss ? 'var(--semantic-danger-text)' : 'var(--text-primary)';
        return (
          <div key={n.name} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-[12px]">
              <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{n.name}</span>
              <span className="tabular-nums font-semibold whitespace-nowrap" style={{ color: c }}>
                {fmt(n.value, n.unit)}<span className="text-[10px] font-normal ml-0.5" style={{ color: 'var(--text-muted)' }}>{n.unit}</span>
              </span>
            </div>
            <div className="h-2 rounded-full overflow-hidden mt-1" style={{ background: 'var(--bg-tertiary)' }}>
              <div
                className="h-full rounded-full"
                style={{ width: `${(n.value / max) * 100}%`, background: n.loss ? 'var(--semantic-danger-text)' : '#5B8CFF', opacity: n.loss ? 0.55 : 0.5 }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── 主面板 ──────────────────────────────────────────────── */

export default function TeamInsightsPanel({ data, loading }: { data: TeamInsights | null; loading: boolean }) {
  const [masked, setMasked] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);

  useEffect(() => {
    try { setMasked(localStorage.getItem(MASK_KEY) === '1'); } catch { /* 隐私偏好读不到就按明文 */ }
  }, []);

  const toggleMask = () => {
    setMasked(prev => {
      const next = !prev;
      try { localStorage.setItem(MASK_KEY, next ? '1' : '0'); } catch { /* 存不下不影响本次会话 */ }
      return next;
    });
  };

  const members = useMemo(() => data?.members ?? [], [data]);
  const picked = useMemo(
    () => members.find(m => m.userId === pickedId) ?? members.find(m => m.quality !== null) ?? members[0] ?? null,
    [members, pickedId],
  );

  if (loading && !data) return <MapSectionLoader text="正在聚合团队洞察…" />;
  if (!data) return <div className="text-[13px] py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无数据</div>;

  const { pulse, attention, flow, meta } = data;

  return (
    <div className="space-y-5">
      {/* A. 团队状态 */}
      <section>
        <div className="flex items-baseline gap-3 mb-2.5 flex-wrap">
          <h2 className="text-[14px] font-semibold m-0" style={{ color: 'var(--text-primary)' }}>团队状态</h2>
          <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            结果型指标，非点击次数{meta.prevFrom ? ' · 对比等长上一窗' : ' · 全部时间无环比'}
          </span>
          <button
            type="button"
            onClick={toggleMask}
            className="ml-auto inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1 rounded-lg transition-colors"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            {masked ? <EyeOff size={12} /> : <Eye size={12} />}
            {masked ? '匿名' : '明文'}
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5">
          {pulse.map(k => <KpiCard key={k.key} kpi={k} />)}
        </div>
      </section>

      {/* B. 需要关注 */}
      <section>
        <div className="flex items-baseline gap-3 mb-2.5 flex-wrap">
          <h2 className="text-[14px] font-semibold m-0" style={{ color: 'var(--text-primary)' }}>需要关注</h2>
          <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>规则触发，没触发就是空的</span>
        </div>
        {attention.length === 0 ? (
          <div
            className="rounded-xl px-4 py-5 text-[12.5px] text-center"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
          >
            本窗没有触发任何关注规则（缺陷积压、生图失败率、调用量高产出低、成本离群）
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
            {attention.map(a => {
              const s = SEV[a.severity] ?? SEV.watch;
              return (
                <div
                  key={a.key}
                  className="rounded-xl overflow-hidden grid"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', gridTemplateColumns: '3px 1fr' }}
                >
                  <div style={{ background: s.color }} />
                  <div className="px-4 py-3">
                    <span
                      className="inline-block text-[9.5px] tracking-widest uppercase px-2 py-0.5 rounded"
                      style={{ color: s.color, background: s.soft, border: `1px solid ${s.border}` }}
                    >
                      {s.label}
                    </span>
                    <h3 className="text-[13.5px] font-semibold mt-2 mb-1.5" style={{ color: 'var(--text-primary)' }}>{a.title}</h3>
                    <p className="text-[12.5px] leading-relaxed m-0 mb-2.5" style={{ color: 'var(--text-secondary)' }}>{a.evidence}</p>
                    <div className="flex items-center gap-2 flex-wrap pt-2" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
                      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>建议：{a.suggestion}</span>
                      <a
                        href={a.linkTo}
                        className="ml-auto inline-flex items-center gap-0.5 text-[11.5px] whitespace-nowrap"
                        style={{ color: '#5B8CFF' }}
                      >
                        {a.linkLabel}<ChevronRight size={12} />
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* C. 成员画像 */}
      <section>
        <div className="flex items-baseline gap-3 mb-2.5 flex-wrap">
          <h2 className="text-[14px] font-semibold m-0" style={{ color: 'var(--text-primary)' }}>成员画像</h2>
          <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>产出量 × 结果质量，按团队中位分型，不排名</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-2.5">
          <Quadrant
            members={members}
            medians={meta.medians}
            masked={masked}
            pickedId={picked?.userId ?? null}
            onPick={setPickedId}
          />
          <MemberDetail member={picked} masked={masked} />
        </div>
      </section>

      {/* D. 价值流 */}
      <section>
        <div className="flex items-baseline gap-3 mb-2.5 flex-wrap">
          <h2 className="text-[14px] font-semibold m-0" style={{ color: 'var(--text-primary)' }}>价值流</h2>
          <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>三列各按自己的口径计量，条宽只表示同列内占比</span>
        </div>
        <div
          className="rounded-xl px-4 py-4 grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-5"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
        >
          <FlowColumn title="投入" nodes={flow.left} />
          <FlowColumn title="环节（模型调用分布）" nodes={flow.mid} />
          <FlowColumn title="产出与损耗" nodes={flow.right} />
        </div>
      </section>

      {/* 明细 + 口径 */}
      <section>
        <details className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <summary className="cursor-pointer px-4 py-3 text-[13px] flex items-center justify-between gap-3" style={{ color: 'var(--text-primary)' }}>
            <span>成员明细</span>
            <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{members.length} 人 · 默认折叠</span>
          </summary>
          <div className="overflow-x-auto" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <table className="w-full text-[12px] whitespace-nowrap">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  {['成员', '产出', '质量', '产出天', '文档', '站点', '生图', '周报', '缺陷解决/指派', '积压', '调用', '失败', 'AI 成本'].map((h, i) => (
                    <th key={h} className={`px-3 py-2 font-medium ${i === 0 ? 'text-left' : 'text-right'}`} style={{ color: 'var(--text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map(m => (
                  <tr key={m.userId} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td className="px-3 py-2 text-left" style={{ color: 'var(--text-primary)' }}>{maskName(m.displayName, masked)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold" style={{ color: 'var(--text-primary)' }}>{m.output}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{m.quality ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{m.outputDays}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{m.breakdown.docs}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{m.breakdown.sites}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{m.breakdown.imageRuns}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{m.breakdown.reports}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{m.breakdown.defectsResolved} / {m.breakdown.defectsAssigned}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: m.breakdown.defectsBacklog > 0 ? 'var(--semantic-warning-text)' : 'var(--text-secondary)' }}>{m.breakdown.defectsBacklog}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{m.llmCalls.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: m.llmErrors > 0 ? 'var(--semantic-warning-text)' : 'var(--text-secondary)' }}>{m.llmErrors}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{m.cost}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      {/* 口径与缺口：照实说明哪些指标本系统还取不到 */}
      <section className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {meta.sources.map(s => <span key={s.metric}>{s.metric}：{s.source}</span>)}
        </div>
        {meta.unavailable.length > 0 && (
          <div className="mt-2 flex items-start gap-1.5">
            <AlertTriangle size={12} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>
              未纳入：{meta.unavailable.map(u => `${u.metric}（${u.reason}）`).join('；')}
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
