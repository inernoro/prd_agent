import { useEffect, useMemo, useState } from 'react';
import { Users, Filter } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { getTeamIssuesView } from '@/services';
import type { IssueOption, TeamIssueItem, TeamIssuesViewData } from '@/services/contracts/reportAgent';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useDataTheme } from '../hooks/useDataTheme';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { RichTextMarkdownContent } from './RichTextMarkdownContent';

interface WeekRef {
  weekYear: number;
  weekNumber: number;
}

function getISOWeek(date: Date): WeekRef {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { weekYear: d.getUTCFullYear(), weekNumber };
}

/** 团队问题视图:按周聚合所有成员已提交周报的 IssueList 章节,
    可按分类/状态筛选。权限完全对齐 /teams/:id/reports/view。 */
export function TeamIssuesView() {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const { teams } = useReportAgentStore();

  const [selectedTeamId, setSelectedTeamId] = useState<string>(teams[0]?.id || '');
  const now = useMemo(() => getISOWeek(new Date()), []);
  const [week, setWeek] = useState<WeekRef>(now);
  const [categoryKey, setCategoryKey] = useState<string>('');
  const [statusKey, setStatusKey] = useState<string>('');
  const [data, setData] = useState<TeamIssuesViewData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedTeamId && teams.length > 0) setSelectedTeamId(teams[0].id);
  }, [teams, selectedTeamId]);

  useEffect(() => {
    if (!selectedTeamId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await getTeamIssuesView({
        teamId: selectedTeamId,
        weekYear: week.weekYear,
        weekNumber: week.weekNumber,
        categoryKey: categoryKey || undefined,
        statusKey: statusKey || undefined,
      });
      if (!cancelled) {
        if (res.success && res.data) setData(res.data);
        else setData(null);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeamId, week.weekYear, week.weekNumber, categoryKey, statusKey]);

  // 按成员分组（放在 early return 之前,遵守 Hooks 规则）
  const groupedByUser = useMemo(() => {
    const items = data?.items ?? [];
    const map = new Map<string, { userId: string; userName?: string; avatarFileName?: string; items: TeamIssueItem[] }>();
    for (const it of items) {
      if (!map.has(it.userId)) {
        map.set(it.userId, { userId: it.userId, userName: it.userName, avatarFileName: it.avatarFileName, items: [] });
      }
      map.get(it.userId)!.items.push(it);
    }
    return Array.from(map.values()).sort((a, b) => (a.userName || '').localeCompare(b.userName || ''));
  }, [data]);

  if (teams.length === 0) {
    return (
      <GlassCard variant="subtle" className="p-6">
        <div className="text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
          还没有加入任何团队，请先在「团队」中创建或加入团队。
        </div>
      </GlassCard>
    );
  }

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto pb-6" style={{ scrollbarWidth: 'thin' }}>
      {/* 顶部筛选区 */}
      <GlassCard variant="subtle" className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Users size={15} style={{ color: 'var(--text-muted)' }} />
            <select
              className="px-2.5 py-1.5 rounded-lg text-[12px]"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>周</span>
            <select
              className="px-2.5 py-1.5 rounded-lg text-[12px]"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
              value={`${week.weekYear}-${week.weekNumber}`}
              onChange={(e) => {
                const [y, w] = e.target.value.split('-').map(Number);
                setWeek({ weekYear: y, weekNumber: w });
              }}
            >
              {/* 最近 8 周选项 */}
              {Array.from({ length: 8 }).map((_, i) => {
                const n = now.weekNumber - i;
                let y = now.weekYear;
                let w = n;
                if (n < 1) { y = now.weekYear - 1; w = 52 + n; }
                return <option key={`${y}-${w}`} value={`${y}-${w}`}>{y} 年第 {w} 周</option>;
              })}
            </select>
          </div>

          {/* 分类 segmented */}
          <SegmentedFilter
            label="分类"
            options={data?.categories ?? []}
            value={categoryKey}
            onChange={setCategoryKey}
            isLight={isLight}
          />
          {/* 状态 segmented */}
          <SegmentedFilter
            label="状态"
            options={data?.statuses ?? []}
            value={statusKey}
            onChange={setStatusKey}
            isLight={isLight}
          />
          <div className="ml-auto text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
            {data?.totalCount ?? 0} 条
          </div>
        </div>
      </GlassCard>

      {loading && <MapSectionLoader text="正在加载团队问题…" />}

      {!loading && items.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Filter size={28} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
          <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            {data?.visibilityScope === 'self_only'
              ? '当前团队未公开成员周报，仅展示你本周已提交的问题条目'
              : '本周暂无符合筛选条件的问题'}
          </div>
        </div>
      )}

      {!loading && groupedByUser.length > 0 && (
        <div className="flex flex-col gap-4">
          {groupedByUser.map((grp) => (
            <div
              key={grp.userId}
              className="rounded-xl"
              style={{
                background: isLight ? '#FFFFFF' : 'var(--surface-glass)',
                border: '1px solid var(--hairline)',
                boxShadow: isLight ? 'var(--shadow-card-sm)' : undefined,
              }}
            >
              <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--hairline)' }}>
                <div
                  className="text-[15px] font-semibold"
                  style={{
                    color: 'var(--text-primary)',
                    fontFamily: isLight ? 'var(--font-serif)' : undefined,
                    letterSpacing: isLight ? '-0.005em' : undefined,
                  }}
                >
                  {grp.userName || grp.userId}
                </div>
                <div className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                  {grp.items.length} 条
                </div>
              </div>
              <div className="px-5 py-4 flex flex-col gap-3">
                {grp.items.map((it, i) => {
                  const cat = data?.categories.find((c) => c.key === it.categoryKey);
                  const st  = data?.statuses.find((s) => s.key === it.statusKey);
                  return (
                    <div
                      key={`${it.reportId}-${it.sectionIndex}-${it.itemIndex}-${i}`}
                      className="rounded-lg p-3"
                      style={{
                        background: isLight ? 'var(--bg-base)' : 'var(--bg-secondary)',
                        border: '1px solid var(--hairline)',
                      }}
                    >
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className="text-[10px] uppercase font-mono" style={{ color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
                          {it.sectionTitle}
                        </span>
                        {cat && <IssueChip option={cat} kind="category" />}
                        {st && <IssueChip option={st} kind="status" />}
                      </div>
                      <RichTextMarkdownContent content={it.content} imageMaxHeight={220} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 分类/状态 segmented 筛选器（包含"全部"首项） */
function SegmentedFilter({
  label, options, value, onChange, isLight,
}: {
  label: string;
  options: IssueOption[];
  value: string;
  onChange: (k: string) => void;
  isLight: boolean;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <div
        className="inline-flex items-center p-0.5 rounded-lg"
        style={{
          background: isLight ? 'rgba(15, 23, 42, 0.05)' : 'var(--bg-tertiary)',
          border: isLight ? '1px solid var(--hairline)' : '1px solid var(--border-primary)',
        }}
      >
        {[{ key: '', label: '全部' } as IssueOption, ...options].map((opt) => {
          const active = value === opt.key;
          return (
            <button
              key={opt.key || '__all__'}
              type="button"
              className="whitespace-nowrap px-2.5 py-1 rounded-md text-[11px] font-medium transition-all duration-200"
              style={{
                color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                background: active ? (isLight ? '#FFFFFF' : 'rgba(255, 255, 255, 0.08)') : 'transparent',
                boxShadow: active && isLight ? 'var(--shadow-card-active)' : 'none',
              }}
              onClick={() => onChange(opt.key)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function IssueChip({ option, kind }: { option: IssueOption; kind: 'category' | 'status' }) {
  const isCategory = kind === 'category';
  return (
    <span
      className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium"
      style={{
        color: option.color || (isCategory ? 'var(--text-secondary)' : 'var(--accent-claude)'),
        background: isCategory ? 'rgba(51,65,85,0.08)' : 'var(--accent-claude-soft)',
        border: `1px solid ${isCategory ? 'rgba(51,65,85,0.18)' : 'var(--accent-claude-border)'}`,
      }}
    >
      {option.label}
    </span>
  );
}
