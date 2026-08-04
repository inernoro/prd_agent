import { useMemo, useState, useEffect } from 'react';
import { AlertTriangle, Eye, EyeOff, ChevronRight, Info } from 'lucide-react';
import { resolveAvatarUrl } from '@/lib/avatar';
import { getRoleMeta } from '@/lib/roleConfig';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { Tooltip } from '@/components/ui/Tooltip';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import type {
  TeamInsights,
  TeamInsightHeadline,
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

/** 区块标题：mono 眉标建立节奏，标题与说明拉开字重差 */
/** 卡片内表头：让每张卡都有自己的标题带，而不是内容直接怼在边框上 */
function CardHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div
      className="flex items-baseline gap-2 px-4 py-2.5 flex-wrap"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <span className="text-[10px] tracking-[0.14em] uppercase font-medium" style={{ color: 'var(--text-secondary)' }}>{title}</span>
      {hint && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{hint}</span>}
    </div>
  );
}

function SectionHead({ index, title, hint, right }: { index: string; title: string; hint: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5 mb-2.5 flex-wrap">
      <span
        className="text-[10px] tabular-nums font-semibold rounded px-1.5 py-[3px] leading-none"
        style={{
          color: 'var(--text-secondary)',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-subtle)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        {index}
      </span>
      <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>{title}</h2>
      <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{hint}</span>
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

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
  '样本不足': 'var(--text-muted)',
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

/* ── 速读：进页第一眼给结论，不让人自己读五个数字去算 ────────── */

const TONE: Record<string, { c: string; soft: string; label: string }> = {
  critical: { c: 'var(--semantic-danger-text)', soft: 'var(--semantic-danger-soft)', label: '要处理' },
  watch: { c: 'var(--semantic-warning-text)', soft: 'var(--semantic-warning-soft)', label: '要留意' },
  good: { c: 'var(--semantic-success-text)', soft: 'var(--semantic-success-soft)', label: '还不错' },
  neutral: { c: 'var(--text-muted)', soft: 'var(--bg-secondary)', label: '' },
};

function Headline({ h, windowLabel }: { h: TeamInsightHeadline; windowLabel: string }) {
  const t = TONE[h.tone] ?? TONE.neutral;
  return (
    <div
      className="relative overflow-hidden rounded-2xl"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: t.c }} />
      <div className="pl-5 pr-5 py-4 flex flex-col gap-3">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span
            className="text-[10px] tracking-[0.16em] uppercase px-2 py-[3px] rounded"
            style={{ color: t.c, background: t.soft }}
          >
            {windowLabel}速读
          </span>
          {h.criticalCount > 0 && (
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--semantic-danger-text)' }}>
              {h.criticalCount} 项待处理
            </span>
          )}
          {h.attentionCount > h.criticalCount && (
            <span className="text-[11px] tabular-nums" style={{ color: 'var(--semantic-warning-text)' }}>
              {h.attentionCount - h.criticalCount} 项观察
            </span>
          )}
        </div>

        <h2
          className="m-0 text-[21px] leading-[1.35] font-bold tracking-[-0.02em]"
          style={{ color: 'var(--text-primary)', textWrap: 'balance' as never }}
        >
          {h.text}
        </h2>

        {h.points.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {h.points.map(p => {
              const pt = TONE[p.tone] ?? TONE.neutral;
              return (
                <div key={p.text} className="flex items-start gap-2.5 text-[13px] leading-[1.6]">
                  <span
                    className="mt-[7px] rounded-full flex-shrink-0"
                    style={{ width: 5, height: 5, background: pt.c, opacity: p.tone === 'neutral' ? 0.5 : 1 }}
                  />
                  <span style={{ color: p.tone === 'neutral' ? 'var(--text-secondary)' : 'var(--text-primary)' }}>
                    {p.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── A. 团队状态 ─────────────────────────────────────────── */

const PART_TINTS = ['#5B8CFF', '#7BA6FF', '#9ABDFF', '#B9D2FF', '#D5E3FF'];

function KpiCard({ kpi }: { kpi: TeamInsightKpi }) {
  const hasDelta = kpi.deltaPct !== null;
  const improving = hasDelta ? (kpi.higherIsBetter ? kpi.deltaPct! >= 0 : kpi.deltaPct! <= 0) : false;
  const deltaColor = improving ? 'var(--semantic-success-text)' : 'var(--semantic-warning-text)';
  const partsTotal = kpi.parts.reduce((s2, p) => s2 + p.value, 0);
  const isLoss = (label: string) => label === '失败' || label === '无痕迹';

  return (
    <div
      className="ti-card relative overflow-hidden rounded-xl px-3.5 pt-3 pb-2.5 flex flex-col gap-1.5"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center gap-1.5 text-[11.5px] leading-none" style={{ color: 'var(--text-secondary)' }}>
        <span className="truncate">{kpi.label}</span>
        <Tooltip content={<span style={{ fontWeight: 400 }}>{kpi.note}</span>} side="top">
          <Info size={10.5} style={{ color: 'var(--text-muted)', opacity: 0.55, flexShrink: 0 }} />
        </Tooltip>
        {hasDelta && (
          <span className="ml-auto tabular-nums text-[10.5px] font-semibold" style={{ color: deltaColor }}>
            {kpi.deltaPct! > 0 ? '+' : ''}{kpi.deltaPct}%
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-1">
        <span
          className="text-[27px] font-bold tabular-nums leading-none tracking-[-0.02em]"
          style={{ color: kpi.value === null ? 'var(--text-muted)' : 'var(--text-primary)' }}
        >
          {kpi.value === null ? '数据不足' : fmt(kpi.value, kpi.unit)}
        </span>
        {kpi.value !== null && (
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{kpi.unit}</span>
        )}
      </div>

      {/* 构成微条：把一个孤零零的大数拆成看得见的几段 */}
      {partsTotal > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex h-[5px] rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
            {kpi.parts.map((p, i) => (
              <Tooltip key={p.label} content={`${p.label} ${p.value.toLocaleString()}`} side="top">
                <div
                  style={{
                    width: `${(p.value / partsTotal) * 100}%`,
                    background: isLoss(p.label) ? 'var(--semantic-danger-text)' : PART_TINTS[i % PART_TINTS.length],
                    opacity: isLoss(p.label) ? 0.55 : 0.85,
                  }}
                />
              </Tooltip>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
            {kpi.parts.slice(0, 4).map((p, i) => (
              <span key={p.label} className="inline-flex items-center gap-1 tabular-nums">
                <i
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: isLoss(p.label) ? 'var(--semantic-danger-text)' : PART_TINTS[i % PART_TINTS.length] }}
                />
                {p.label} {p.value.toLocaleString()}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 副指标：环比拿不到时也不该留空 */}
      {kpi.secondary && (
        <div className="text-[10.5px] tabular-nums leading-tight" style={{ color: 'var(--text-muted)' }}>
          {kpi.secondary}
        </div>
      )}
      {!kpi.secondary && partsTotal === 0 && hasDelta && (
        <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>对比上一等长窗口</div>
      )}

      {kpi.series.length > 1 && (
        <svg
          className="absolute right-0 bottom-0 pointer-events-none"
          width="96" height="32" viewBox="0 0 96 32" aria-hidden="true"
          style={{ opacity: 0.5 }}
        >
          <path d={`${sparkPath(kpi.series, 96, 32)} L96 32 L0 32 Z`} fill="#5B8CFF" opacity="0.10" />
          <path d={sparkPath(kpi.series, 96, 32)} fill="none" stroke="#5B8CFF" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}

/* ── C. 成员画像散点 ─────────────────────────────────────── */

function Quadrant({
  members, medians, masked, pickedId, onPick, reliable, counts,
}: {
  members: TeamInsightMember[];
  medians: { output: number; quality: number };
  counts: Record<string, number>;
  masked: boolean;
  pickedId: string | null;
  onPick: (id: string) => void;
  reliable: boolean;
}) {
  const maxOutput = Math.max(1, ...members.map(m => m.output));
  // 产出是长尾分布（个位数与上千并存），线性刻度会把大多数人挤在左边缘互相盖住，改用对数刻度
  const logX = (v: number) => (Math.log10(Math.max(0, v) + 1) / Math.log10(maxOutput + 1)) * 88 + 6;
  const plotted = members.filter(m => m.quality !== null);
  const noQuality = members.length - plotted.length;

  return (
    <div className="ti-card relative rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <CardHead title="分型散点" hint={`气泡大小 = 有产出的天数 · 十字线 = 分型阈值（产出 ${medians.output} 件 / 质量 ${medians.quality}）`} />
      <div className="relative ml-11 mr-5 mt-7" style={{ height: 360 }}>
        {/* 中位线 —— 阈值来自后端真实中位数，不是拍的常数 */}
        <div
          className="absolute"
          style={{ left: `${logX(medians.output)}%`, top: 0, width: 1, height: '100%', background: 'var(--border-default)' }}
        />
        <div
          className="absolute"
          style={{ left: 0, top: `${100 - (medians.quality * 0.88 + 6)}%`, width: '100%', height: 1, background: 'var(--border-default)' }}
        />

        {([
          ['精工型', 'top-1 left-1', 'var(--semantic-warning-text)'],
          ['主力产出', 'top-1 right-1', 'var(--semantic-success-text)'],
          ['低活跃', 'bottom-1 left-1', 'var(--text-muted)'],
          ['高量低果', 'bottom-1 right-1', 'var(--semantic-danger-text)'],
        ] as const).map(([name, pos, color]) => (
          <div key={name} className={`absolute ${pos} text-[9.5px] tracking-widest uppercase flex items-baseline gap-1`} style={{ color }}>
            {name}
            {(counts[name] ?? 0) > 0 && (
              <span className="tabular-nums font-semibold" style={{ fontSize: 11 }}>{counts[name]}</span>
            )}
          </div>
        ))}

        <div
          className="absolute text-[10px] whitespace-nowrap"
          style={{ left: -24, top: '50%', transform: 'rotate(-90deg) translateX(50%)', transformOrigin: 'left center', color: 'var(--text-muted)' }}
        >
          结果质量
        </div>
        <div className="absolute text-[10px]" style={{ left: 0, bottom: -18, color: 'var(--text-muted)' }}>产出量</div>

        {plotted.map(m => {
          const x = logX(m.output);
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
              aria-label={maskName(m.displayName, masked)}
              title={`${maskName(m.displayName, masked)} · 产出 ${m.output} · 质量 ${m.quality}`}
              className="absolute rounded-full grid place-items-center transition-transform hover:scale-110 hover:z-10 [&:hover>span:last-child]:opacity-100"
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
              {/* 密集区名字会叠成一片，只有选中的那个常驻显示全名，其余交给 hover 与 title */}
              <span
                className="absolute whitespace-nowrap text-[10.5px] pointer-events-none transition-opacity"
                style={{
                  top: 'calc(100% + 4px)', left: '50%', transform: 'translateX(-50%)',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  opacity: active ? 1 : 0,
                  fontWeight: active ? 600 : 400,
                }}
              >
                {maskName(m.displayName, masked)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-7 mb-3.5 px-4 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {noQuality > 0 && `${noQuality} 人本窗无结果型信号（缺陷或生图），未入图`}
        {!reliable && <span style={{ color: 'var(--semantic-warning-text)' }}>{noQuality > 0 ? ' · ' : ''}入图样本不足 3 人，暂不做分型</span>}
      </div>
    </div>
  );
}

function MemberDetail({ member, masked, costAvailable, bench }: { member: TeamInsightMember | null; masked: boolean; costAvailable: boolean; bench: TeamInsights['meta']['benchmarks'] }) {
  if (!member) {
    return (
      <div className="rounded-xl p-4 text-[12px]" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
        点左侧任一成员查看画像
      </div>
    );
  }
  const b = member.breakdown;
  const color = getRoleMeta(member.role).color;
  // 每项都带团队中位，绝对值才有参照系 —— 只给「12 篇」看不出这算多还是少
  const bars: { label: string; val: number; med: number }[] = [
    { label: '知识库文档', val: b.docs, med: bench.docs },
    { label: '网页站点', val: b.sites, med: bench.sites },
    { label: '生图完成', val: b.imageRuns, med: bench.imageRuns },
    { label: '周报提交', val: b.reports, med: bench.reports },
    { label: '缺陷解决', val: b.defectsResolved, med: bench.defectsResolved },
  ];
  const barMax = Math.max(1, ...bars.map(x => Math.max(x.val, x.med)));

  return (
    <div className="ti-card relative rounded-xl overflow-hidden flex flex-col" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <CardHead title="单人画像" />
      <div className="p-4 flex flex-col gap-3">
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
        AI 成本 <b className="tabular-nums" style={{ color: 'var(--text-primary)' }}>{costAvailable ? `${member.cost} 元` : '数据不足'}</b>。
      </div>

      <div className="flex flex-col gap-2">
        {bars.map(({ label, val, med }) => {
          // 与中位的差距：百分比在极端值下会退化成 +6864% 这种噪音，超过两倍改用「×N」
          const ratio = med > 0 ? val / med : null;
          const diff = ratio === null || val === med
            ? null
            : ratio >= 3 || ratio <= 1 / 3
              ? `×${ratio >= 1 ? ratio.toFixed(ratio >= 10 ? 0 : 1) : (1 / ratio).toFixed(1)}${ratio >= 1 ? '' : ' 以下'}`
              : `${val > med ? '+' : ''}${Math.round(((val - med) / med) * 100)}%`;
          return (
            <div key={label}>
              <div className="flex items-baseline justify-between text-[11.5px] mb-1" style={{ color: 'var(--text-secondary)' }}>
                <span>{label}</span>
                <span className="tabular-nums flex items-baseline gap-1.5">
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{val}</span>
                  {diff && (
                    <span
                      className="text-[10px] tabular-nums"
                      style={{ color: val > med ? 'var(--semantic-success-text)' : 'var(--text-muted)' }}
                    >
                      {diff}
                    </span>
                  )}
                </span>
              </div>
              <div className="relative h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="h-full rounded-full" style={{ width: `${(val / barMax) * 100}%`, background: color, opacity: 0.7 }} />
                {/* 团队中位刻度线 */}
                {med > 0 && (
                  <div
                    className="absolute top-0 bottom-0"
                    style={{ left: `${Math.min((med / barMax) * 100, 100)}%`, width: 1.5, background: 'var(--text-muted)', opacity: 0.75 }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <div className="text-[10px] tracking-widest uppercase mb-1.5 flex items-baseline gap-2" style={{ color: 'var(--text-muted)' }}>
          <span>本窗要点</span>
          <span className="normal-case tracking-normal" style={{ opacity: 0.75 }}>竖线 = 团队中位</span>
        </div>
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
              <span className="truncate flex items-baseline gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                {n.name}
                {n.hint && <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{n.hint}</span>}
              </span>
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

const PANEL_CSS = `
.ti-root section { animation: ti-rise .42s cubic-bezier(.2,.7,.3,1) backwards; }
.ti-root section:nth-of-type(1){animation-delay:.02s}
.ti-root section:nth-of-type(2){animation-delay:.07s}
.ti-root section:nth-of-type(3){animation-delay:.12s}
.ti-root section:nth-of-type(4){animation-delay:.17s}
.ti-root section:nth-of-type(5){animation-delay:.22s}
@keyframes ti-rise { from { opacity:0; transform: translateY(7px) } }
.ti-card { transition: border-color .18s ease, transform .18s ease; }
.ti-card::before {
  content:''; position:absolute; inset:0 0 auto 0; height:1px; pointer-events:none;
  /* 顶边细高光走 token，两个主题各自成立；硬编码白透明会被双皮肤棘轮拦下 */
  background: linear-gradient(90deg, transparent, var(--border-default), transparent);
  opacity: .55;
}
.ti-card:hover { border-color: var(--border-default) !important; transform: translateY(-1px); }
.ti-attn::before { display: none; }
.ti-attn:hover { border-top-color: currentColor; }
.ti-link { transition: background .16s ease, border-color .16s ease; }
.ti-link:hover { background: var(--bg-card-hover); border-color: var(--border-default) !important; }
.ti-table tbody tr { transition: background .14s ease; }
.ti-table tbody tr:hover { background: var(--bg-secondary); }
.ti-root details > summary { transition: background .14s ease; }
.ti-root details > summary:hover { background: var(--bg-secondary); }
@media (prefers-reduced-motion: reduce) {
  .ti-root section { animation: none }
  .ti-card:hover { transform: none }
}
`;

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

  const { headline, pulse, attention, flow, meta } = data;
  const windowLabel = meta.days === 0 ? '全量' : `近 ${meta.days} 天`;

  return (
    <div className="ti-root flex flex-col gap-6">
      <style>{PANEL_CSS}</style>
      <Headline h={headline} windowLabel={windowLabel} />
      {/* A. 团队状态 */}
      <section>
        <SectionHead
          index="01" title="团队状态"
          hint={`结果型指标，非点击次数${meta.prevFrom ? ' · 对比等长上一窗' : ' · 全量窗口无环比'}`}
          right={
            <button
              type="button"
              onClick={toggleMask}
              className="inline-flex items-center gap-1.5 text-[11.5px] px-2.5 py-1 rounded-lg transition-colors hover:opacity-80"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
              {masked ? <EyeOff size={12} /> : <Eye size={12} />}
              {masked ? '匿名' : '明文'}
            </button>
          }
        />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2.5">
          {pulse.map(k => <KpiCard key={k.key} kpi={k} />)}
        </div>
      </section>

      {/* B. 需要关注 */}
      <section>
        <SectionHead index="02" title="需要关注" hint="规则触发，没触发就是空的" />
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
              const isCritical = a.severity === 'critical';
              return (
                <div
                  key={a.key}
                  className="ti-card ti-attn relative rounded-xl overflow-hidden flex flex-col"
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-subtle)',
                    // 严重项用一道顶边定调，而不是贴在左侧的硬色条（那道条读起来像没擦掉的痕迹）
                    borderTop: `2px solid ${isCritical ? s.color : 'var(--border-subtle)'}`,
                  }}
                >
                  <div className="px-4 pt-3.5 pb-3 flex flex-col gap-2 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full" style={{ width: 6, height: 6, background: s.color }} />
                      <span
                        className="text-[10px] tracking-[0.14em] uppercase font-medium"
                        style={{ color: s.color }}
                      >
                        {s.label}
                      </span>
                    </div>
                    <h3 className="text-[14.5px] font-semibold leading-snug m-0 tracking-[-0.01em]" style={{ color: 'var(--text-primary)' }}>
                      {a.title}
                    </h3>
                    <p className="text-[12.5px] leading-[1.7] m-0" style={{ color: 'var(--text-secondary)' }}>
                      {a.evidence}
                    </p>
                  </div>
                  {/* 建议与入口独立成一条动作区：和证据区分开，读者一眼知道「这里是要我做的事」 */}
                  <div
                    className="px-4 py-2.5 flex items-center gap-3 flex-wrap"
                    style={{ background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-subtle)' }}
                  >
                    <span className="text-[12px] leading-snug flex-1 min-w-0" style={{ color: 'var(--text-secondary)' }}>
                      <span
                        className="text-[10px] tracking-[0.12em] uppercase mr-1.5"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        建议
                      </span>
                      {a.suggestion}
                    </span>
                    <a
                      href={a.linkTo}
                      className="ti-link inline-flex items-center gap-0.5 text-[11.5px] whitespace-nowrap px-2 py-1 rounded-md"
                      style={{ color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
                    >
                      {a.linkLabel}<ChevronRight size={12} />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* C. 成员画像 */}
      <section>
        <SectionHead index="03" title="成员画像" hint="不排名，按团队中位分型" />
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-2.5">
          <Quadrant
            members={members}
            medians={meta.medians}
            masked={masked}
            pickedId={picked?.userId ?? null}
            onPick={setPickedId}
            reliable={meta.quadrantReliable}
            counts={meta.quadrantCounts}
          />
          <MemberDetail member={picked} masked={masked} costAvailable={meta.costAvailable} bench={meta.benchmarks} />
        </div>
      </section>

      {/* D. 价值流 */}
      <section>
        <SectionHead index="04" title="价值流" hint="投入变成了什么，损耗在哪" />
        <div
          className="ti-card relative rounded-xl overflow-hidden"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
        >
          <CardHead title="投入 → 环节 → 产出" hint="三列各按自己的口径计量，条宽只表示同列内占比" />
          <div className="px-4 py-4 grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-5">
          <FlowColumn title="投入" nodes={flow.left} />
          <FlowColumn title="环节（模型调用分布）" nodes={flow.mid} />
          <FlowColumn title="产出与损耗" nodes={flow.right} />
          </div>
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
            <table className="ti-table w-full text-[12px] whitespace-nowrap">
              <thead>
                <tr style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-subtle)' }}>
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
                    <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{meta.costAvailable ? m.cost : '—'}</td>
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
