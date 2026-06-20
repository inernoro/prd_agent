/**
 * 声道看板（行为洞察 Hero 视图之一）：双声道并排，回答「机器说的 + 人说的，两边对齐」。
 * 全部从 insights.items 现算，不额外请求后端。
 *  - 左「行为之声」：遥测发现的痛点（尚未流转为缺陷/需求的洞察），按严重度排序
 *  - 右「用户之声」：已被人确认并流转的（有 defectId 或 requirementNo 的洞察）
 * 点卡片 → 调 onSelectTarget 下钻（与热力图同一抽屉联动）。入场：卡片依次滑入。
 * 冷色海主题，禁止 emoji，图标用 lucide。
 */
import { useMemo } from 'react';
import { Activity, Megaphone, Bug, ClipboardList, Users } from 'lucide-react';
import { GlassCard } from '@/components/design';
import type { BehaviorInsight } from '@/services/contracts/teamActivity';
import { getInsightKindMeta } from './insightKinds';

/** 严重度近似：报错 > 秒退 > 慢/横跳 > 停留；同档按影响人数 × log(频次) */
function score(i: BehaviorInsight): number {
  const w: Record<string, number> = { 'api-error': 3, 'quick-exit': 2.5, 'slow-endpoint': 2, 'route-oscillation': 2, 'long-dwell': 1.5 };
  return (w[i.kind] ?? 2) * Math.max(1, i.userCount) * Math.log10(Math.max(10, i.eventCount + 10));
}

export function ExperienceBoard({
  items,
  onSelectTarget,
  onSwitchHeatmap,
}: {
  items: BehaviorInsight[];
  onSelectTarget?: (target: string, fallback: { label: string; metric: string }) => void;
  onSwitchHeatmap?: () => void;
}) {
  const { behaviorVoice, userVoice } = useMemo(() => {
    const visible = items.filter((i) => i.status !== 'ignored');
    // 用户之声 = 已被人确认流转（有缺陷/需求关联）；行为之声 = 其余遥测痛点
    const userVoice = visible.filter((i) => i.defectId || i.requirementNo).sort((a, b) => score(b) - score(a));
    const behaviorVoice = visible.filter((i) => !i.defectId && !i.requirementNo).sort((a, b) => score(b) - score(a));
    return { behaviorVoice, userVoice };
  }, [items]);

  const empty = behaviorVoice.length === 0 && userVoice.length === 0;

  if (empty) {
    return (
      <GlassCard className="overflow-hidden" style={{ padding: 0 }}>
        <Header />
        <div className="flex flex-col items-center justify-center gap-2.5 text-center" style={{ height: 300 }}>
          <span className="w-3 h-3 rounded-full" style={{ background: '#34d399', boxShadow: '0 0 0 5px rgba(52,211,153,0.16)' }} />
          <span className="text-sm text-emerald-300/85">两个声道都很安静</span>
          <span className="text-[12px] text-white/40">既无遥测痛点也无已流转项。可换时间范围，或</span>
          {onSwitchHeatmap ? (
            <button
              type="button"
              onClick={onSwitchHeatmap}
              className="mt-1 inline-flex items-center gap-1.5 px-3 h-8 rounded-lg border border-white/10 bg-white/[0.03] text-[11px] text-white/55 hover:text-white/85 hover:border-white/25 transition-colors cursor-pointer"
            >
              切回体验全景热力图
            </button>
          ) : null}
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="overflow-hidden" style={{ padding: 0 }}>
      <Header />
      <div className="px-3 pb-3 grid grid-cols-2 gap-3" style={{ maxHeight: 460, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {/* 左声道：行为之声 */}
        <Channel
          icon={Activity}
          tint="rgba(94,234,212,0.85)"
          title="行为之声"
          subtitle={`遥测发现 · ${behaviorVoice.length} 项`}
          items={behaviorVoice}
          startIdx={0}
          onSelectTarget={onSelectTarget}
        />
        {/* 右声道：用户之声（已流转），入场延迟接在左声道之后 */}
        <Channel
          icon={Megaphone}
          tint="rgba(167,139,250,0.85)"
          title="用户之声"
          subtitle={`已流转为缺陷/需求 · ${userVoice.length} 项`}
          items={userVoice}
          startIdx={behaviorVoice.length}
          onSelectTarget={onSelectTarget}
        />
      </div>
      <style>{`@keyframes voc-board-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </GlassCard>
  );
}

function Channel({
  icon: Icon,
  tint,
  title,
  subtitle,
  items,
  startIdx,
  onSelectTarget,
}: {
  icon: typeof Activity;
  tint: string;
  title: string;
  subtitle: string;
  items: BehaviorInsight[];
  startIdx: number;
  onSelectTarget?: (target: string, fallback: { label: string; metric: string }) => void;
}) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2 px-1 sticky top-0 z-[1] py-1.5" style={{ background: 'rgba(16,17,19,0.72)', backdropFilter: 'blur(6px)' }}>
        <Icon size={14} style={{ color: tint }} />
        <span className="text-[12.5px] font-semibold text-white/80">{title}</span>
        <span className="text-[10.5px] text-white/35">{subtitle}</span>
      </div>
      {items.length === 0 ? (
        <div className="text-[11px] text-white/30 px-2 py-4 text-center border border-dashed border-white/[0.06] rounded-lg">
          此声道暂无内容
        </div>
      ) : (
        items.map((it, i) => {
          const meta = getInsightKindMeta(it.kind);
          const KIcon = meta.icon;
          const clickable = (it.kind === 'api-error' || it.kind === 'slow-endpoint') && !!onSelectTarget;
          return (
            <button
              key={`${it.kind}|${it.target}`}
              type="button"
              disabled={!clickable}
              onClick={clickable ? () => onSelectTarget!(it.target, { label: `${it.kindLabel} · ${it.target}`, metric: it.metric }) : undefined}
              title={clickable ? `下钻 ${it.target}` : it.target}
              className="flex flex-col gap-1.5 rounded-lg px-2.5 py-2 text-left border transition-colors hover:border-white/20"
              style={{
                cursor: clickable ? 'pointer' : 'default',
                background: 'rgba(255,255,255,0.02)',
                borderColor: 'rgba(255,255,255,0.07)',
                animation: 'voc-board-in .35s ease both',
                animationDelay: `${(startIdx + i) * 35}ms`,
              }}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ background: meta.soft }}>
                  <KIcon size={11} style={{ color: meta.accent }} />
                </span>
                <span className="text-[11px] font-semibold shrink-0" style={{ color: meta.accent }}>{it.kindLabel}</span>
                <span className="text-[11px] text-white/30 font-mono truncate">{it.target}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10.5px] text-amber-200/75 font-mono tabular-nums">{it.metric}</span>
                <span className="inline-flex items-center gap-1 text-[10.5px] text-white/35 tabular-nums">
                  <Users size={10} />
                  {it.userCount} 人 · {it.eventCount} 次
                </span>
                {it.defectTitle ? (
                  <span className="inline-flex items-center gap-1 text-[10.5px] text-rose-200/70 truncate">
                    <Bug size={10} />
                    {it.defectTitle}
                  </span>
                ) : null}
                {it.requirementNo ? (
                  <span className="inline-flex items-center gap-1 text-[10.5px] text-cyan-200/80">
                    <ClipboardList size={10} />
                    需求 #{it.requirementNo}
                  </span>
                ) : null}
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
      <span className="text-[13px] font-semibold text-white/85 inline-flex items-center gap-2.5">
        声道看板
        <span className="text-[11px] text-white/35 font-normal inline-flex items-center gap-1.5">
          <Megaphone size={12} className="text-cyan-300/70" />
          行为之声 + 用户之声 · 两边对齐
        </span>
      </span>
    </div>
  );
}
