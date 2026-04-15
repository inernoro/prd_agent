import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Calendar, Tag, RefreshCw, Filter, X } from 'lucide-react';
import { useChangelogStore } from '@/stores/changelogStore';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { glassPanel } from '@/lib/glassStyles';
import type { ChangelogEntry } from '@/services';

/** 类型徽章配色（注册表，禁止 switch / if-else） */
const TYPE_BADGE_REGISTRY: Record<string, { label: string; color: string; bg: string; border: string }> = {
  feat: { label: '新功能', color: '#86efac', bg: 'rgba(34, 197, 94, 0.10)', border: 'rgba(34, 197, 94, 0.32)' },
  fix: { label: '修复', color: '#fdba74', bg: 'rgba(251, 146, 60, 0.10)', border: 'rgba(251, 146, 60, 0.32)' },
  refactor: { label: '重构', color: '#93c5fd', bg: 'rgba(59, 130, 246, 0.10)', border: 'rgba(59, 130, 246, 0.32)' },
  perf: { label: '优化', color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.10)', border: 'rgba(139, 92, 246, 0.32)' },
  docs: { label: '文档', color: '#67e8f9', bg: 'rgba(6, 182, 212, 0.10)', border: 'rgba(6, 182, 212, 0.32)' },
  chore: { label: '杂项', color: '#d4d4d8', bg: 'rgba(161, 161, 170, 0.10)', border: 'rgba(161, 161, 170, 0.32)' },
};

const FALLBACK_BADGE = {
  label: '其他',
  color: '#d4d4d8',
  bg: 'rgba(161, 161, 170, 0.10)',
  border: 'rgba(161, 161, 170, 0.32)',
};

function getTypeBadge(type: string) {
  return TYPE_BADGE_REGISTRY[type.toLowerCase()] ?? { ...FALLBACK_BADGE, label: type };
}

interface FlatEntry extends ChangelogEntry {
  date: string;
  source: 'fragment' | 'release';
  releaseVersion?: string;
  fileName?: string;
}

export default function ChangelogPage() {
  const currentWeek = useChangelogStore((s) => s.currentWeek);
  const releases = useChangelogStore((s) => s.releases);
  const loadingCurrent = useChangelogStore((s) => s.loadingCurrent);
  const loadingReleases = useChangelogStore((s) => s.loadingReleases);
  const error = useChangelogStore((s) => s.error);
  const loadCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);
  const loadReleases = useChangelogStore((s) => s.loadReleases);
  const markAsSeen = useChangelogStore((s) => s.markAsSeen);

  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [moduleFilter, setModuleFilter] = useState<string | null>(null);

  // 进入页面：拉取数据 + 标记已读
  useEffect(() => {
    void loadCurrentWeek();
    void loadReleases(20);
    markAsSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = () => {
    void loadCurrentWeek(true);
    void loadReleases(20, true);
  };

  // 收集所有出现过的 type / module 用于筛选 chip
  const { availableTypes, availableModules } = useMemo(() => {
    const types = new Set<string>();
    const modules = new Set<string>();
    const collect = (entries: ChangelogEntry[]) => {
      for (const e of entries) {
        if (e.type) types.add(e.type.toLowerCase());
        if (e.module) modules.add(e.module);
      }
    };
    if (currentWeek) {
      currentWeek.fragments.forEach((f) => collect(f.entries));
    }
    if (releases) {
      releases.releases.forEach((r) => r.days.forEach((d) => collect(d.entries)));
    }
    return {
      availableTypes: Array.from(types).sort(),
      availableModules: Array.from(modules).sort(),
    };
  }, [currentWeek, releases]);

  const matchFilter = (e: ChangelogEntry): boolean => {
    if (typeFilter && e.type.toLowerCase() !== typeFilter) return false;
    if (moduleFilter && e.module !== moduleFilter) return false;
    return true;
  };

  // 本周条目：按日期分组
  const currentWeekEntries: FlatEntry[] = useMemo(() => {
    if (!currentWeek) return [];
    const flat: FlatEntry[] = [];
    for (const fragment of currentWeek.fragments) {
      for (const entry of fragment.entries) {
        if (!matchFilter(entry)) continue;
        flat.push({ ...entry, date: fragment.date, source: 'fragment', fileName: fragment.fileName });
      }
    }
    return flat;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWeek, typeFilter, moduleFilter]);

  const currentWeekByDate = useMemo(() => {
    const map = new Map<string, FlatEntry[]>();
    for (const e of currentWeekEntries) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date)!.push(e);
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [currentWeekEntries]);

  const totalCurrentWeek = currentWeekEntries.length;

  // 友好周范围
  const weekRangeText = currentWeek
    ? `${currentWeek.weekStart} ~ ${currentWeek.weekEnd}`
    : '';

  return (
    <div className="flex flex-col gap-5">
      {/* ── Header ───────────────────────────────────────── */}
      <header
        style={glassPanel}
        className="rounded-2xl px-6 py-5 flex flex-col gap-3"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className="h-11 w-11 rounded-xl flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.18), rgba(168, 85, 247, 0.18))',
                border: '1px solid rgba(251, 191, 36, 0.32)',
              }}
            >
              <Sparkles size={22} style={{ color: 'var(--accent-gold, #fbbf24)' }} />
            </div>
            <div>
              <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                更新中心
              </h1>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                代码级周报 · 数据来自仓库 changelogs/ 与 CHANGELOG.md，每个 PR 都会更新
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loadingCurrent || loadingReleases}
            className="h-9 px-3 rounded-lg inline-flex items-center gap-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              border: '1px solid rgba(255, 255, 255, 0.12)',
              color: 'var(--text-secondary)',
              background: 'rgba(255, 255, 255, 0.04)',
            }}
            title="刷新（绕过 5 分钟服务端缓存）"
          >
            {loadingCurrent || loadingReleases ? <MapSpinner size={14} /> : <RefreshCw size={14} />}
            <span>刷新</span>
          </button>
        </div>

        {/* 筛选器 */}
        {(availableTypes.length > 0 || availableModules.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <div className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <Filter size={12} />
              筛选
            </div>
            {availableTypes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {availableTypes.map((t) => {
                  const meta = getTypeBadge(t);
                  const active = typeFilter === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTypeFilter(active ? null : t)}
                      className="h-6 px-2 rounded-md text-[11px] font-medium transition-all"
                      style={{
                        background: active ? meta.bg : 'rgba(255, 255, 255, 0.04)',
                        border: `1px solid ${active ? meta.border : 'rgba(255, 255, 255, 0.10)'}`,
                        color: active ? meta.color : 'var(--text-muted)',
                      }}
                    >
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            )}
            {availableModules.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {availableModules.map((m) => {
                  const active = moduleFilter === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setModuleFilter(active ? null : m)}
                      className="h-6 px-2 rounded-md text-[11px] font-mono transition-all"
                      style={{
                        background: active ? 'rgba(99, 102, 241, 0.14)' : 'rgba(255, 255, 255, 0.04)',
                        border: `1px solid ${active ? 'rgba(99, 102, 241, 0.36)' : 'rgba(255, 255, 255, 0.10)'}`,
                        color: active ? '#a5b4fc' : 'var(--text-muted)',
                      }}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            )}
            {(typeFilter || moduleFilter) && (
              <button
                type="button"
                onClick={() => { setTypeFilter(null); setModuleFilter(null); }}
                className="h-6 px-2 rounded-md text-[11px] inline-flex items-center gap-1"
                style={{
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: 'var(--text-secondary)',
                }}
              >
                <X size={11} />
                清除筛选
              </button>
            )}
          </div>
        )}
      </header>

      {/* 数据源不可用提示 */}
      {currentWeek && !currentWeek.dataSourceAvailable && (
        <div
          className="rounded-xl px-4 py-3 text-[12px]"
          style={{
            background: 'rgba(251, 146, 60, 0.08)',
            border: '1px solid rgba(251, 146, 60, 0.32)',
            color: '#fdba74',
          }}
        >
          ⚠ 服务端找不到 changelogs/ 目录与 CHANGELOG.md。开发环境下需从仓库根目录启动 API；生产环境可设置 <code>Changelog__RootPath</code> 环境变量指向仓库根。
        </div>
      )}

      {/* 全局错误 */}
      {error && (
        <div
          className="rounded-xl px-4 py-3 text-[12px]"
          style={{
            background: 'rgba(248, 113, 113, 0.08)',
            border: '1px solid rgba(248, 113, 113, 0.32)',
            color: '#fca5a5',
          }}
        >
          ⚠ {error}
        </div>
      )}

      {/* ── 本周更新 ───────────────────────────────────── */}
      <section style={glassPanel} className="rounded-2xl p-5">
        <div className="flex items-baseline justify-between gap-3 mb-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              本周更新
            </h2>
            {weekRangeText && (
              <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                {weekRangeText}
              </span>
            )}
          </div>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            共 {totalCurrentWeek} 条
          </span>
        </div>

        {loadingCurrent && !currentWeek && <MapSectionLoader text="正在加载本周更新…" />}

        {!loadingCurrent && totalCurrentWeek === 0 && (
          <div
            className="rounded-xl px-4 py-8 text-center text-[12px]"
            style={{
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px dashed rgba(255, 255, 255, 0.08)',
              color: 'var(--text-muted)',
            }}
          >
            {currentWeek?.dataSourceAvailable
              ? '本周还没有新的更新记录。每次 PR 合入时会自动出现在这里。'
              : '暂无数据'}
          </div>
        )}

        {totalCurrentWeek > 0 && (
          <div className="flex flex-col gap-5">
            {currentWeekByDate.map(([date, entries]) => (
              <div key={date}>
                <div
                  className="flex items-center gap-2 mb-2 text-[11px] font-mono"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Calendar size={12} />
                  {date}
                  <span style={{ opacity: 0.5 }}>· {entries.length} 条</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {entries.map((e, idx) => (
                    <EntryRow key={`${date}-${idx}`} entry={e} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 历史发布 ───────────────────────────────────── */}
      <section style={glassPanel} className="rounded-2xl p-5">
        <div className="flex items-baseline justify-between gap-3 mb-4">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            历史发布
          </h2>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            来自 CHANGELOG.md
          </span>
        </div>

        {loadingReleases && !releases && <MapSectionLoader text="正在加载历史发布…" />}

        {!loadingReleases && releases && releases.releases.length === 0 && (
          <div
            className="rounded-xl px-4 py-6 text-center text-[12px]"
            style={{
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px dashed rgba(255, 255, 255, 0.08)',
              color: 'var(--text-muted)',
            }}
          >
            暂无历史发布
          </div>
        )}

        {releases && releases.releases.length > 0 && (
          <div className="flex flex-col gap-6">
            {releases.releases.map((release) => {
              const visibleDays = release.days
                .map((d) => ({
                  ...d,
                  entries: d.entries.filter(matchFilter),
                }))
                .filter((d) => d.entries.length > 0);
              const totalCount = visibleDays.reduce((s, d) => s + d.entries.length, 0);
              if (totalCount === 0 && release.highlights.length === 0) {
                return null;
              }

              const isUnreleased = release.version === '未发布';

              return (
                <div key={`${release.version}-${release.releaseDate ?? ''}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <div
                      className="px-2.5 py-0.5 rounded-md text-[12px] font-semibold font-mono"
                      style={{
                        background: isUnreleased
                          ? 'rgba(251, 191, 36, 0.10)'
                          : 'rgba(99, 102, 241, 0.12)',
                        border: `1px solid ${isUnreleased ? 'rgba(251, 191, 36, 0.32)' : 'rgba(99, 102, 241, 0.32)'}`,
                        color: isUnreleased ? '#fbbf24' : '#a5b4fc',
                      }}
                    >
                      {isUnreleased ? '未发布' : `v${release.version}`}
                    </div>
                    {release.releaseDate && (
                      <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                        {release.releaseDate}
                      </span>
                    )}
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      · {totalCount} 条
                    </span>
                  </div>

                  {release.highlights.length > 0 && (
                    <div
                      className="mb-3 rounded-lg px-3 py-2.5 text-[12px]"
                      style={{
                        background: 'rgba(99, 102, 241, 0.06)',
                        border: '1px solid rgba(99, 102, 241, 0.18)',
                      }}
                    >
                      <div
                        className="text-[10px] font-semibold mb-1 tracking-wider"
                        style={{ color: '#a5b4fc' }}
                      >
                        🚀 用户更新项
                      </div>
                      <ul className="flex flex-col gap-0.5" style={{ color: 'var(--text-secondary)' }}>
                        {release.highlights.map((h, i) => (
                          <li key={i}>• {h}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {visibleDays.length > 0 && (
                    <div className="flex flex-col gap-3">
                      {visibleDays.map((day) => (
                        <div key={day.date}>
                          <div
                            className="flex items-center gap-2 mb-1.5 text-[11px] font-mono"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <Calendar size={11} />
                            {day.date}
                          </div>
                          <div className="flex flex-col gap-1.5">
                            {day.entries.map((e, idx) => (
                              <EntryRow
                                key={`${day.date}-${idx}`}
                                entry={{
                                  ...e,
                                  date: day.date,
                                  source: 'release',
                                  releaseVersion: release.version,
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/** 单行更新条目 */
function EntryRow({ entry }: { entry: FlatEntry }) {
  const meta = getTypeBadge(entry.type);
  return (
    <div
      className="rounded-lg px-3 py-2 flex items-start gap-2.5 transition-colors"
      style={{
        background: 'rgba(255, 255, 255, 0.025)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
      }}
    >
      <div
        className="shrink-0 px-1.5 h-5 rounded inline-flex items-center text-[10px] font-medium mt-0.5"
        style={{
          background: meta.bg,
          color: meta.color,
          border: `1px solid ${meta.border}`,
        }}
      >
        {meta.label}
      </div>
      <div
        className="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-mono mt-0.5"
        style={{
          color: 'var(--text-muted)',
          background: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
        }}
      >
        <Tag size={9} />
        {entry.module}
      </div>
      <div
        className="text-[12.5px] leading-relaxed flex-1"
        style={{ color: 'var(--text-secondary)' }}
      >
        {entry.description}
      </div>
    </div>
  );
}
