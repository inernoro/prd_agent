import { useEffect, useMemo, useState } from 'react';
import { Filter } from 'lucide-react';
import { getTeamIssuesView } from '@/services';
import type { IssueOption, TeamIssueItem, TeamIssuesViewData } from '@/services/contracts/reportAgent';
import { useDataTheme } from '../hooks/useDataTheme';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { RichTextMarkdownContent } from './RichTextMarkdownContent';

interface TeamIssuesPanelProps {
  teamId: string;
  weekYear: number;
  weekNumber: number;
}

/** 团队 Tab 内的「问题」视图:外层 TeamDashboard 已锁定 teamId/week,
    本面板只负责按分类/状态筛选并按成员分组展示已提交周报中的 IssueList 章节条目。
    与旧 TeamIssuesView 的差异:不自带团队/周选择器(职责上交)。 */
export function TeamIssuesPanel({ teamId, weekYear, weekNumber }: TeamIssuesPanelProps) {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';

  const [categoryKey, setCategoryKey] = useState<string>('');
  const [statusKey, setStatusKey] = useState<string>('');
  const [data, setData] = useState<TeamIssuesViewData | null>(null);
  const [loading, setLoading] = useState(false);

  // 切换团队/周时清空筛选,避免旧 categoryKey 在新团队的选项里失效
  useEffect(() => {
    setCategoryKey('');
    setStatusKey('');
  }, [teamId, weekYear, weekNumber]);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await getTeamIssuesView({
        teamId,
        weekYear,
        weekNumber,
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
  }, [teamId, weekYear, weekNumber, categoryKey, statusKey]);

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

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-3">
      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedFilter
          label="分类"
          options={data?.categories ?? []}
          value={categoryKey}
          onChange={setCategoryKey}
          isLight={isLight}
        />
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
