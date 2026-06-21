/**
 * 声道看板（行为洞察视图之一）：双声道并排，回答「机器说的 + 人说的，两边对齐」。
 *  - 左「行为之声」：遥测自动发现的痛点（apirequestlogs 聚合，即 insights），按严重度排序，从 insights.items 现算
 *  - 右「用户之声」：用户主动提交的真实缺陷（DefectReport，人写的吐槽），拉最近提交按时间倒序
 * 点行为之声卡片 → onSelectTarget 下钻（与热力图同一抽屉联动）；点用户之声卡片 → 跳缺陷管理页。
 * 冷色海主题，禁止 emoji，图标用 lucide。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, Megaphone, Bug, Users, Clock } from 'lucide-react';
import { GlassCard } from '@/components/design';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { listDefects } from '@/services';
import type { DefectReport } from '@/services/contracts/defectAgent';
import type { BehaviorInsight } from '@/services/contracts/teamActivity';
import { getInsightKindMeta } from './insightKinds';

const RED = '#f8717a';
const AMBER = '#fbbf24';

/** 真实缺陷严重度 → 标签 + 色（与缺陷管理一致口径） */
const SEVERITY_META: Record<string, { label: string; color: string }> = {
  critical: { label: '致命', color: RED },
  major: { label: '严重', color: RED },
  minor: { label: '一般', color: AMBER },
  trivial: { label: '轻微', color: 'rgba(94,234,212,0.7)' },
};

/** 严重度近似：报错 > 秒退 > 慢/横跳 > 停留；同档按影响人数 × log(频次) */
function score(i: BehaviorInsight): number {
  const w: Record<string, number> = { 'api-error': 3, 'quick-exit': 2.5, 'slow-endpoint': 2, 'route-oscillation': 2, 'long-dwell': 1.5 };
  return (w[i.kind] ?? 2) * Math.max(1, i.userCount) * Math.log10(Math.max(10, i.eventCount + 10));
}

function fmtRelTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  const navigate = useNavigate();
  // 行为之声：遥测痛点（未忽略），按严重度排序
  const behaviorVoice = useMemo(
    () => items.filter((i) => i.status !== 'ignored').sort((a, b) => score(b) - score(a)),
    [items]
  );

  // 用户之声：用户主动提交的真实缺陷（按创建时间倒序取前若干条）
  const [defects, setDefects] = useState<DefectReport[] | null>(null);
  const [defectsErr, setDefectsErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDefectsErr(null);
    void listDefects({ filter: 'all', limit: 30 }).then((res) => {
      if (!alive) return;
      if (res.success) {
        const sorted = [...res.data.items].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setDefects(sorted);
      } else {
        setDefectsErr(res.error?.message ?? '缺陷数据加载失败');
        setDefects([]);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const empty = behaviorVoice.length === 0 && (defects?.length ?? 0) === 0 && defects !== null;

  if (empty && !defectsErr) {
    return (
      <GlassCard className="overflow-hidden h-full flex flex-col voc-board-card" style={{ padding: 0, minHeight: 0 }}>
        <Header />
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2.5 text-center">
          <span className="w-3 h-3 rounded-full" style={{ background: '#34d399', boxShadow: '0 0 0 5px rgba(52,211,153,0.16)' }} />
          <span className="text-sm text-emerald-300/85">两个声道都很安静</span>
          <span className="text-[12px] text-white/40">既无遥测痛点也无用户提交的缺陷。可换时间范围，或</span>
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
    <GlassCard className="overflow-hidden h-full flex flex-col" style={{ padding: 0, minHeight: 320 }}>
      <Header />
      <div className="px-3 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-3 flex-1 min-h-0" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {/* 左声道：行为之声 = 遥测自动发现的痛点 */}
        <BehaviorChannel items={behaviorVoice} onSelectTarget={onSelectTarget} />
        {/* 右声道：用户之声 = 用户主动提交的真实缺陷 */}
        <UserChannel defects={defects} error={defectsErr} startIdx={behaviorVoice.length} onOpenDefect={() => navigate('/defect-agent')} />
      </div>
      <style>{`
        /* Bento 桌面：本格 row-span-1（≈220px），卡撑满格高、内容区内部滚动，不给硬 min-height 撑破矮格；
           窄屏单图视图无 grid 撑高，给 min-height 让声道看板有足够展开高度。 */
        @media (max-width: 1023px) { .voc-board-card { min-height: 320px; } }
        @keyframes voc-board-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </GlassCard>
  );
}

function ChannelHead({ icon: Icon, tint, title, subtitle }: { icon: typeof Activity; tint: string; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-2 px-1 sticky top-0 z-[1] py-1.5" style={{ background: 'rgba(16,17,19,0.72)', backdropFilter: 'blur(6px)' }}>
      <Icon size={14} style={{ color: tint }} />
      <span className="text-[12.5px] font-semibold text-white/80">{title}</span>
      <span className="text-[10.5px] text-white/35">{subtitle}</span>
    </div>
  );
}

/** 行为之声：遥测痛点（点痛点端点下钻） */
function BehaviorChannel({
  items,
  onSelectTarget,
}: {
  items: BehaviorInsight[];
  onSelectTarget?: (target: string, fallback: { label: string; metric: string }) => void;
}) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <ChannelHead icon={Activity} tint="rgba(94,234,212,0.85)" title="行为之声" subtitle={`遥测自动发现 · ${items.length} 项`} />
      {items.length === 0 ? (
        <div className="text-[11px] text-white/30 px-2 py-4 text-center border border-dashed border-white/[0.06] rounded-lg">
          遥测暂无痛点
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
                animationDelay: `${i * 35}ms`,
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
              </div>
            </button>
          );
        })
      )}
    </div>
  );
}

/** 用户之声：用户主动提交的真实缺陷（点击跳缺陷管理页跟进） */
function UserChannel({
  defects,
  error,
  startIdx,
  onOpenDefect,
}: {
  defects: DefectReport[] | null;
  error: string | null;
  startIdx: number;
  onOpenDefect: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <ChannelHead icon={Megaphone} tint="rgba(167,139,250,0.85)" title="用户之声" subtitle={`真实缺陷 · ${defects?.length ?? 0} 条`} />
      {defects === null ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-white/40">
          <MapSpinner size={12} />
          正在拉取用户提交的缺陷…
        </div>
      ) : error ? (
        <div className="text-[11px] text-amber-200/70 px-2 py-4 text-center border border-dashed border-white/[0.1] rounded-lg">
          需接入缺陷数据源（{error}）
        </div>
      ) : defects.length === 0 ? (
        <div className="text-[11px] text-white/30 px-2 py-4 text-center border border-dashed border-white/[0.06] rounded-lg">
          暂无用户提交的缺陷
        </div>
      ) : (
        defects.map((d, i) => {
          const sev = SEVERITY_META[d.severity] ?? { label: d.severity, color: AMBER };
          const title = d.title || d.rawContent?.split('\n').find((l) => l.trim())?.trim() || d.defectNo;
          return (
            <button
              key={d.id}
              type="button"
              onClick={onOpenDefect}
              title={`在缺陷管理中查看 ${d.defectNo}`}
              className="flex flex-col gap-1.5 rounded-lg px-2.5 py-2 text-left border transition-colors hover:border-white/20 cursor-pointer"
              style={{
                background: 'rgba(255,255,255,0.02)',
                borderColor: 'rgba(255,255,255,0.07)',
                animation: 'voc-board-in .35s ease both',
                animationDelay: `${(startIdx + i) * 35}ms`,
              }}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ background: `${sev.color}1f` }}>
                  <Bug size={11} style={{ color: sev.color }} />
                </span>
                <span className="text-[11px] font-semibold shrink-0" style={{ color: sev.color }}>{sev.label}</span>
                <span className="text-[11.5px] text-white/80 truncate">{title}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap text-[10.5px] text-white/35 tabular-nums">
                <span className="font-mono text-white/30">{d.defectNo}</span>
                {d.reporterName ? (
                  <span className="inline-flex items-center gap-1">
                    <Users size={10} />
                    {d.reporterName}
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1">
                  <Clock size={10} />
                  {fmtRelTime(d.createdAt)}
                </span>
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
      <span className="text-[13px] font-semibold text-white/85 inline-flex items-center gap-2.5 min-w-0 flex-wrap">
        <span className="whitespace-nowrap">声道看板</span>
        <span className="hidden sm:inline-flex text-[11px] text-white/35 font-normal items-center gap-1.5 whitespace-nowrap">
          <Megaphone size={12} className="text-cyan-300/70" />
          行为之声（遥测痛点）+ 用户之声（真实缺陷）
        </span>
      </span>
    </div>
  );
}
