import { useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Sparkles, Calendar, Tag, RefreshCw, Filter, X, FileText,
  Wrench, Zap, Gauge, Shuffle, Shield, Package, FlaskConical, UploadCloud, Cog,
  Github, GitCommit, ExternalLink,
} from 'lucide-react';
import { useChangelogStore } from '@/stores/changelogStore';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { glassPanel } from '@/lib/glassStyles';
import { getChangelogGitHubLogs } from '@/services';
import type { ChangelogEntry, GitHubLogEntry, GitHubLogsView } from '@/services';
import { TabBar } from '@/components/design/TabBar';
import {
  WeeklyReportsTab,
  WeeklyReportSourceChips,
  WeeklyReportSourceDialog,
} from './components/WeeklyReportsTab';
import { WeeklyReportSourcesProvider } from './components/weeklyReportSourcesContext';


/** 类型徽章注册表（禁止 switch / if-else） */
const TYPE_BADGE_REGISTRY: Record<string, { label: string; color: string; bg: string; border: string; icon: LucideIcon }> = {
  feat: { label: '新功能', color: '#86efac', bg: 'rgba(34, 197, 94, 0.10)', border: 'rgba(34, 197, 94, 0.32)', icon: Sparkles },
  fix: { label: '修复', color: '#fdba74', bg: 'rgba(251, 146, 60, 0.10)', border: 'rgba(251, 146, 60, 0.32)', icon: Wrench },
  refactor: { label: '重构', color: '#93c5fd', bg: 'rgba(59, 130, 246, 0.10)', border: 'rgba(59, 130, 246, 0.32)', icon: Shuffle },
  perf: { label: '优化', color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.10)', border: 'rgba(139, 92, 246, 0.32)', icon: Gauge },
  docs: { label: '文档', color: '#67e8f9', bg: 'rgba(6, 182, 212, 0.10)', border: 'rgba(6, 182, 212, 0.32)', icon: FileText },
  chore: { label: '杂项', color: '#d4d4d8', bg: 'rgba(161, 161, 170, 0.10)', border: 'rgba(161, 161, 170, 0.32)', icon: Package },
  enhance: { label: '增强', color: '#f472b6', bg: 'rgba(244, 114, 182, 0.10)', border: 'rgba(244, 114, 182, 0.32)', icon: Zap },
  rule: { label: '规范', color: '#e879f9', bg: 'rgba(232, 121, 249, 0.10)', border: 'rgba(232, 121, 249, 0.32)', icon: Shield },
  test: { label: '测试', color: '#34d399', bg: 'rgba(52, 211, 153, 0.10)', border: 'rgba(52, 211, 153, 0.32)', icon: FlaskConical },
  ci: { label: '构筑', color: '#cbd5e1', bg: 'rgba(203, 213, 225, 0.10)', border: 'rgba(203, 213, 225, 0.32)', icon: Cog },
  deploy: { label: '部署', color: '#6ee7b7', bg: 'rgba(110, 231, 183, 0.10)', border: 'rgba(110, 231, 183, 0.32)', icon: UploadCloud },
};

const FALLBACK_BADGE = {
  label: '其他',
  color: '#d4d4d8',
  bg: 'rgba(161, 161, 170, 0.10)',
  border: 'rgba(161, 161, 170, 0.32)',
  icon: Tag as LucideIcon,
};

function getTypeBadge(type: string) {
  return TYPE_BADGE_REGISTRY[type.toLowerCase()] ?? { ...FALLBACK_BADGE, label: type };
}

interface FlatEntry extends ChangelogEntry {
  date: string;
  /** ISO 8601 秒级时间（仅 github 源可用） */
  commitTimeUtc?: string | null;
  source: 'release' | 'fragment';
  releaseVersion?: string;
}

type HistorySubtab = 'releases' | 'fragments' | 'github_logs';

const GITHUB_LOGS_CACHE_KEY = 'changelog:github-logs:v1';
const GITHUB_LOGS_CACHE_TTL_MS = 5 * 60 * 1000;
const GITHUB_LOGS_FETCH_LIMIT = 30;

interface GitHubLogsCachePayload {
  cachedAt: number;
  data: GitHubLogsView;
}

function formatLocalDateValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatLocalDateTimeValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${formatLocalDateValue(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseIsoDate(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDisplayDate(date: string, commitTimeUtc?: string | null): string {
  const d = parseIsoDate(commitTimeUtc);
  return d ? formatLocalDateValue(d) : date;
}

function formatCommitDateTime(commitTimeUtc?: string | null): string | null {
  const d = parseIsoDate(commitTimeUtc);
  return d ? formatLocalDateTimeValue(d) : null;
}

function getReleaseDisplayDate(releaseDate: string | null, days: Array<{ date: string; commitTimeUtc?: string | null }>): string | null {
  const latestCommitDay = days
    .map((d) => parseIsoDate(d.commitTimeUtc))
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (latestCommitDay) {
    return formatLocalDateValue(latestCommitDay);
  }
  return releaseDate;
}

function readGitHubLogsCache(): GitHubLogsView | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(GITHUB_LOGS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GitHubLogsCachePayload;
    if (!parsed || typeof parsed.cachedAt !== 'number' || !parsed.data) return null;
    if (Date.now() - parsed.cachedAt > GITHUB_LOGS_CACHE_TTL_MS) {
      sessionStorage.removeItem(GITHUB_LOGS_CACHE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function writeGitHubLogsCache(data: GitHubLogsView) {
  if (typeof window === 'undefined') return;
  try {
    const payload: GitHubLogsCachePayload = { cachedAt: Date.now(), data };
    sessionStorage.setItem(GITHUB_LOGS_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore cache write failures
  }
}

export default function ChangelogPage() {
  const currentWeek = useChangelogStore((s) => s.currentWeek);
  const releases = useChangelogStore((s) => s.releases);
  const loadingReleases = useChangelogStore((s) => s.loadingReleases);
  const error = useChangelogStore((s) => s.error);
  const loadCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);
  const loadReleases = useChangelogStore((s) => s.loadReleases);
  const markAsSeen = useChangelogStore((s) => s.markAsSeen);

  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('update_center');
  const [historySubtab, setHistorySubtab] = useState<HistorySubtab>('releases');
  const [githubLogs, setGitHubLogs] = useState<GitHubLogsView | null>(() => readGitHubLogsCache());
  const [loadingGitHubLogs, setLoadingGitHubLogs] = useState(false);
  const [gitHubLogsError, setGitHubLogsError] = useState<string | null>(null);

  /**
   * NEW 徽章 cutoff：用户上次打开更新中心那天的 23:59:59.999。
   * useState 惰性初始化只跑一次，拿到的一定是"进入本次页面之前"的值——
   * ChangelogPage 进页后 markAsSeen() 会把 store 里的 lastSeenAt 更新为当前，
   * 但本 hook 冻结在 mount 瞬间的旧值，整场 session 稳定不变。
   */
  const [newBadgeCutoff] = useState<number | null>(() => {
    const iso = useChangelogStore.getState().lastSeenAt;
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  });

  // 进入页面：拉取数据 + 标记已读
  // 「本周更新」section 已下线；但仍拉 currentWeek 以驱动已读计数 & 顶部的数据源徽标
  useEffect(() => {
    void loadCurrentWeek();
    void loadReleases(20);
    markAsSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeTab !== 'update_center' || historySubtab !== 'github_logs' || loadingGitHubLogs || githubLogs) return;
    let alive = true;
    setLoadingGitHubLogs(true);
    setGitHubLogsError(null);
    void getChangelogGitHubLogs(GITHUB_LOGS_FETCH_LIMIT).then((res) => {
      if (!alive) return;
      if (res.success) {
        setGitHubLogs(res.data);
        writeGitHubLogsCache(res.data);
      } else {
        setGitHubLogsError(res.error?.message || '加载 GitHub 日志失败');
      }
    }).finally(() => {
      if (alive) setLoadingGitHubLogs(false);
    });
    return () => { alive = false; };
  }, [activeTab, historySubtab, loadingGitHubLogs, githubLogs]);

  useEffect(() => {
    if (activeTab !== 'update_center' || historySubtab === 'github_logs' || loadingGitHubLogs || githubLogs) return;
    let alive = true;
    const run = () => {
      setLoadingGitHubLogs(true);
      void getChangelogGitHubLogs(GITHUB_LOGS_FETCH_LIMIT).then((res) => {
        if (!alive) return;
        if (res.success) {
          setGitHubLogs(res.data);
          writeGitHubLogsCache(res.data);
        }
      }).finally(() => {
        if (alive) setLoadingGitHubLogs(false);
      });
    };

    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(run, { timeout: 1500 });
      return () => {
        alive = false;
        window.cancelIdleCallback(idleId);
      };
    }

    const timer = window.setTimeout(run, 800);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [activeTab, historySubtab, loadingGitHubLogs, githubLogs]);

  const handleRefresh = () => {
    void loadCurrentWeek(true);
    void loadReleases(20, true);
    if (historySubtab === 'github_logs' || githubLogs) {
      setLoadingGitHubLogs(true);
      setGitHubLogsError(null);
      void getChangelogGitHubLogs(GITHUB_LOGS_FETCH_LIMIT, true).then((res) => {
        if (res.success) {
          setGitHubLogs(res.data);
          writeGitHubLogsCache(res.data);
        } else {
          setGitHubLogsError(res.error?.message || '加载 GitHub 日志失败');
        }
      }).finally(() => setLoadingGitHubLogs(false));
    }
  };

  // 收集 release 中出现过的 type 用于筛选 chip
  const { availableTypes } = useMemo(() => {
    const types = new Set<string>();
    if (releases) {
      for (const r of releases.releases) {
        for (const d of r.days) {
          for (const e of d.entries) {
            if (e.type) types.add(e.type.toLowerCase());
          }
        }
      }
    }
    if (currentWeek) {
      for (const fragment of currentWeek.fragments) {
        for (const entry of fragment.entries) {
          if (entry.type) types.add(entry.type.toLowerCase());
        }
      }
    }
    return { availableTypes: Array.from(types).sort() };
  }, [currentWeek, releases]);

  const matchFilter = (e: ChangelogEntry): boolean => {
    if (typeFilter && e.type.toLowerCase() !== typeFilter) return false;
    return true;
  };

  // 数据源标签 + 拉取时间显示（github / local / none）
  const sourceLabel = (() => {
    const source = currentWeek?.source ?? releases?.source ?? 'none';
    if (source === 'github') return { text: 'GitHub', color: '#86efac' };
    if (source === 'local') return { text: '本地仓库', color: '#93c5fd' };
    return null;
  })();
  const fetchedAt = currentWeek?.fetchedAt || releases?.fetchedAt || '';
  const fetchedAtRelative = (() => {
    if (!fetchedAt) return '';
    try {
      const diff = Date.now() - new Date(fetchedAt).getTime();
      const minutes = Math.floor(diff / 60000);
      if (minutes < 1) return '刚刚拉取';
      if (minutes < 60) return `${minutes} 分钟前拉取`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时前拉取`;
      const days = Math.floor(hours / 24);
      return `${days} 天前拉取`;
    } catch {
      return '';
    }
  })();

  return (
    <WeeklyReportSourcesProvider>
    <div className="flex flex-col gap-5 h-full min-h-0">
      {/* ── 顶部切换导航（周报 tab 下把来源 chip 合并到右侧 actions 槽，省一行） ── */}
      <TabBar
        items={[
          { key: 'update_center', label: '更新中心', icon: <Sparkles size={14} /> },
          { key: 'weekly_reports', label: '周报', icon: <FileText size={14} /> },
        ]}
        activeKey={activeTab}
        onChange={setActiveTab}
        variant="gold"
        actions={activeTab === 'weekly_reports' ? <WeeklyReportSourceChips /> : undefined}
      />
      <WeeklyReportSourceDialog />

      {activeTab === 'update_center' && (
      <div className="flex flex-col gap-5 flex-1 min-h-0 overflow-y-auto pr-1"
        style={{ overscrollBehavior: 'contain' }}>
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
              {(sourceLabel || fetchedAtRelative) && (
                <div className="flex items-center gap-2 mt-1.5 text-[10px]">
                  {sourceLabel && (
                    <span
                      className="px-1.5 py-0.5 rounded font-mono"
                      style={{
                        background: `${sourceLabel.color}14`,
                        color: sourceLabel.color,
                        border: `1px solid ${sourceLabel.color}33`,
                      }}
                    >
                      {sourceLabel.text}
                    </span>
                  )}
                  {fetchedAtRelative && (
                    <span style={{ color: 'var(--text-muted)' }}>{fetchedAtRelative}</span>
                  )}
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loadingReleases}
            className="h-9 px-3 rounded-lg inline-flex items-center gap-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              border: '1px solid rgba(255, 255, 255, 0.12)',
              color: 'var(--text-secondary)',
              background: 'rgba(255, 255, 255, 0.04)',
            }}
            title="刷新（绕过 5 分钟服务端缓存）"
          >
            {loadingReleases ? <MapSpinner size={14} /> : <RefreshCw size={14} />}
            <span>刷新</span>
          </button>
        </div>

        {/* 筛选器 */}
        {availableTypes.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <div className="inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              <Filter size={14} />
              筛选
            </div>
            
            <div className="flex flex-wrap gap-1.5 ml-1">
              {availableTypes.map((t) => {
                const meta = getTypeBadge(t);
                const active = typeFilter === t;
                const Icon = meta.icon;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTypeFilter(active ? null : t)}
                    className="h-8 pl-2.5 pr-3 rounded-lg text-[13px] font-medium transition-all cursor-pointer inline-flex items-center gap-1.5"
                    style={{
                      background: active ? meta.bg : 'rgba(255, 255, 255, 0.04)',
                      border: `1px solid ${active ? meta.border : 'rgba(255, 255, 255, 0.10)'}`,
                      color: active ? meta.color : 'var(--text-muted)',
                      lineHeight: '1',
                    }}
                  >
                    <Icon size={13} />
                    {meta.label}
                  </button>
                );
              })}
            </div>
            
            {typeFilter && (
              <button
                type="button"
                onClick={() => setTypeFilter(null)}
                className="h-8 px-3 rounded-lg text-[13px] inline-flex items-center gap-1.5 ml-2 transition-all hover:bg-white/10 hover:text-white cursor-pointer"
                style={{
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  color: 'var(--text-secondary)',
                }}
              >
                <X size={13} />
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
          ⚠ 本地仓库与 GitHub 都没拉到数据。可能是网络受限、GitHub API 限流，或仓库未配置正确的 owner/repo/branch（详见后端 <code>Changelog:GitHub*</code> 配置项）。
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

      {/* ── 历史区：CHANGELOG / 碎片 / GitHub 日志 ───────────────────── */}
      <section style={glassPanel} className="rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-4 flex-wrap">
            <h2 className="text-[18px] font-semibold tracking-wide" style={{ color: 'var(--text-primary)' }}>
              历史发布
            </h2>
            {([
              { key: 'releases', label: 'CHANGELOG', icon: <Calendar size={13} /> },
              { key: 'fragments', label: '碎片补充', icon: <FileText size={13} /> },
              { key: 'github_logs', label: 'GitHub 日志', icon: <Github size={13} /> },
            ] as const).map((tab) => {
              const active = historySubtab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setHistorySubtab(tab.key)}
                  className="h-8 px-3 rounded-lg inline-flex items-center gap-1.5 text-[12px] font-medium transition-all"
                  style={{
                    background: active ? 'rgba(99, 102, 241, 0.14)' : 'rgba(255, 255, 255, 0.04)',
                    border: `1px solid ${active ? 'rgba(99, 102, 241, 0.32)' : 'rgba(255, 255, 255, 0.08)'}`,
                    color: active ? '#c7d2fe' : 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              );
            })}
          </div>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {historySubtab === 'releases' && '来自 CHANGELOG.md'}
            {historySubtab === 'fragments' && '来自 changelogs/*.md（当前周碎片）'}
            {historySubtab === 'github_logs' && (
              githubLogs?.source === 'local' ? '来自本地 git log' : '来自 GitHub commits API'
            )}
          </span>
        </div>

        {historySubtab === 'releases' && (
          <>
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
                  const releaseDisplayDate = getReleaseDisplayDate(release.releaseDate, visibleDays);
                  const releaseDateTitle = release.releaseDate && releaseDisplayDate && releaseDisplayDate !== release.releaseDate
                    ? `CHANGELOG 标注日期：${release.releaseDate}\nGitHub 本地日期：${releaseDisplayDate}`
                    : undefined;

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
                        {releaseDisplayDate && (
                          <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }} title={releaseDateTitle}>
                            {releaseDisplayDate}
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
                          {visibleDays.map((day, dayIdx) => {
                            const dayCommitDisplayDate = formatDisplayDate(day.date, day.commitTimeUtc);
                            const dayTitle = day.commitTimeUtc && dayCommitDisplayDate !== day.date
                              ? `CHANGELOG 日期：${day.date}\nGitHub commit 本地日期：${dayCommitDisplayDate}`
                              : undefined;
                            return (
                              <div key={`${day.date}-${dayIdx}`}>
                                <div className="flex items-center gap-2 mb-2.5 flex-wrap">
                                  <div
                                    className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md"
                                    style={{
                                      background: 'rgba(255, 255, 255, 0.04)',
                                      border: '1px solid rgba(255, 255, 255, 0.08)',
                                      color: 'var(--text-secondary)',
                                      fontSize: '13px',
                                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                                      fontWeight: 600,
                                      letterSpacing: '0.02em',
                                    }}
                                    title={dayTitle}
                                  >
                                    <Calendar size={13} />
                                    {day.date}
                                  </div>
                                  {day.commitTimeUtc && dayCommitDisplayDate !== day.date && (
                                    <span
                                      className="text-[11px] font-mono"
                                      style={{ color: 'var(--text-muted)' }}
                                      title={`GitHub commit 本地日期：${dayCommitDisplayDate}`}
                                    >
                                      提交落地 {dayCommitDisplayDate}
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-col gap-1.5">
                                  {day.entries.map((e, idx) => (
                                    <EntryRow
                                      key={`${day.date}-${idx}`}
                                      entry={{
                                        ...e,
                                        date: day.date,
                                        commitTimeUtc: day.commitTimeUtc ?? null,
                                        source: 'release',
                                        releaseVersion: release.version,
                                      }}
                                      newCutoff={newBadgeCutoff}
                                    />
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {historySubtab === 'fragments' && (
          <>
            {!currentWeek && <MapSectionLoader text="正在加载碎片补充…" />}

            {currentWeek && currentWeek.fragments.length === 0 && (
              <div
                className="rounded-xl px-4 py-6 text-center text-[12px]"
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px dashed rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-muted)',
                }}
              >
                当前周暂无碎片日志
              </div>
            )}

            {currentWeek && currentWeek.fragments.length > 0 && currentWeek.fragments.filter((f) => f.entries.some(matchFilter)).length === 0 && (
              <div
                className="rounded-xl px-4 py-6 text-center text-[12px]"
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px dashed rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-muted)',
                }}
              >
                当前筛选条件下暂无碎片条目
              </div>
            )}

            {currentWeek && currentWeek.fragments.filter((f) => f.entries.some(matchFilter)).length > 0 && (
              <div className="flex flex-col gap-4">
                {currentWeek.fragments.map((fragment) => {
                  const visibleEntries = fragment.entries.filter(matchFilter);
                  if (visibleEntries.length === 0) return null;
                  return (
                    <div
                      key={fragment.fileName}
                      className="rounded-xl px-4 py-3"
                      style={{
                        background: 'rgba(255, 255, 255, 0.025)',
                        border: '1px solid rgba(255, 255, 255, 0.06)',
                      }}
                    >
                      <div className="flex items-center gap-2 mb-3 flex-wrap">
                        <div
                          className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md"
                          style={{
                            background: 'rgba(255, 255, 255, 0.04)',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            color: 'var(--text-secondary)',
                            fontSize: '13px',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                            fontWeight: 600,
                          }}
                        >
                          <Calendar size={13} />
                          {fragment.date}
                        </div>
                        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                          {fragment.fileName}
                        </span>
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          · {visibleEntries.length} 条
                        </span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {visibleEntries.map((entry, idx) => (
                          <EntryRow
                            key={`${fragment.fileName}-${idx}`}
                            entry={{
                              ...entry,
                              date: fragment.date,
                              commitTimeUtc: null,
                              source: 'fragment',
                            }}
                            newCutoff={newBadgeCutoff}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {historySubtab === 'github_logs' && (
          <>
            {loadingGitHubLogs && !githubLogs && <MapSectionLoader text="正在加载 GitHub 日志…" />}

            {gitHubLogsError && (
              <div
                className="rounded-xl px-4 py-3 text-[12px]"
                style={{
                  background: 'rgba(248, 113, 113, 0.08)',
                  border: '1px solid rgba(248, 113, 113, 0.32)',
                  color: '#fca5a5',
                }}
              >
                ⚠ {gitHubLogsError}
              </div>
            )}

            {!loadingGitHubLogs && githubLogs && githubLogs.logs.length === 0 && (
              <div
                className="rounded-xl px-4 py-6 text-center text-[12px]"
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px dashed rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-muted)',
                }}
              >
                暂无 GitHub 日志
              </div>
            )}

            {githubLogs && githubLogs.logs.length > 0 && (
              <div className="flex flex-col gap-2">
                {githubLogs.logs.map((log) => (
                  <GitHubLogRow key={log.sha} log={log} />
                ))}
              </div>
            )}
          </>
        )}
      </section>
      </div>
      )}

      {activeTab === 'weekly_reports' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <WeeklyReportsTab />
        </div>
      )}

    </div>
    </WeeklyReportSourcesProvider>
  );
}

/** 单行更新条目 */
function EntryRow({ entry, newCutoff }: { entry: FlatEntry; newCutoff: number | null }) {
  const meta = getTypeBadge(entry.type);
  const Icon = meta.icon;
  const timeText = formatDisplayDate(entry.date, entry.commitTimeUtc);
  const commitDateTime = formatCommitDateTime(entry.commitTimeUtc);
  const timeTitle = commitDateTime
    ? `GitHub commit 时间：${commitDateTime}\n原始日期：${entry.date}`
    : `${entry.source === 'fragment' ? '碎片日期' : 'CHANGELOG 日期'}：${entry.date}`;
  const isFresh = (() => {
    if (newCutoff === null) return false;
    if (!entry.commitTimeUtc) return false;
    const t = Date.parse(entry.commitTimeUtc);
    if (Number.isNaN(t)) return false;
    return t > newCutoff;
  })();
  return (
    <div
      className="rounded-lg px-3.5 py-2.5 flex items-center gap-3 transition-colors"
      style={{
        background: 'rgba(255, 255, 255, 0.025)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
      }}
    >
      {isFresh && (
        <span
          className="shrink-0 text-[9px] font-bold tracking-wider px-1.5 h-[18px] rounded inline-flex items-center"
          style={{
            background: 'rgba(34, 197, 94, 0.18)',
            color: '#86efac',
            border: '1px solid rgba(34, 197, 94, 0.35)',
            lineHeight: '1.3',
          }}
          title="自上次查看更新中心以来有新提交"
        >
          NEW
        </span>
      )}
      <div
        className="shrink-0 inline-flex items-center gap-1 px-2 h-[24px] rounded-md text-[12px] font-semibold"
        style={{
          background: meta.bg,
          color: meta.color,
          border: `1px solid ${meta.border}`,
          letterSpacing: '0.02em',
        }}
      >
        <Icon size={11} />
        {meta.label}
      </div>
      <div
        className="shrink-0 inline-flex items-center gap-1 h-[24px] px-2 rounded-md text-[12px]"
        style={{
          color: 'var(--text-secondary)',
          background: 'rgba(255, 255, 255, 0.04)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontWeight: 500,
        }}
      >
        <Tag size={11} />
        {entry.module}
      </div>
      <div
        className="text-[13px] leading-relaxed flex-1 truncate"
        style={{ color: 'var(--text-secondary)', minWidth: 0 }}
        title={entry.description}
      >
        {entry.description}
      </div>
      <div
        className="shrink-0 text-[12px]"
        style={{
          color: 'var(--text-muted)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontVariantNumeric: 'tabular-nums',
        }}
        title={timeTitle}
      >
        {timeText}
      </div>
    </div>
  );
}

function GitHubLogRow({ log }: { log: GitHubLogEntry }) {
  const commitDate = formatDisplayDate('', log.commitTimeUtc);
  const commitDateTime = formatCommitDateTime(log.commitTimeUtc) ?? log.commitTimeUtc;
  return (
    <a
      href={log.htmlUrl}
      target="_blank"
      rel="noreferrer"
      className="rounded-lg px-3.5 py-3 flex items-center gap-3 transition-colors hover:bg-white/5"
      style={{
        background: 'rgba(255, 255, 255, 0.025)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        textDecoration: 'none',
      }}
      title={commitDateTime}
    >
      <div
        className="shrink-0 inline-flex items-center gap-1 px-2 h-[24px] rounded-md text-[12px] font-semibold"
        style={{
          background: 'rgba(99, 102, 241, 0.12)',
          color: '#c7d2fe',
          border: '1px solid rgba(99, 102, 241, 0.24)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        }}
      >
        <GitCommit size={11} />
        {log.shortSha}
      </div>
      <div
        className="shrink-0 inline-flex items-center gap-1 h-[24px] px-2 rounded-md text-[12px]"
        style={{
          color: 'var(--text-secondary)',
          background: 'rgba(255, 255, 255, 0.04)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        <Github size={11} />
        {log.authorName}
      </div>
      <div className="text-[13px] leading-relaxed flex-1 truncate" style={{ color: 'var(--text-secondary)', minWidth: 0 }}>
        {log.message}
      </div>
      <div
        className="shrink-0 text-[12px]"
        style={{
          color: 'var(--text-muted)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {commitDate}
      </div>
      <ExternalLink size={13} style={{ color: 'var(--text-muted)', opacity: 0.65, flexShrink: 0 }} />
    </a>
  );
}
