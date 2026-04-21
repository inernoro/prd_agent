import { useEffect, useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Sparkles, Calendar, Tag, RefreshCw, Filter, X, FileText,
  Wrench, Zap, Gauge, Shuffle, Shield, Package, FlaskConical, UploadCloud, Cog,
  Github, GitCommit, ExternalLink, Brain, Wand2,
} from 'lucide-react';
import { useChangelogStore } from '@/stores/changelogStore';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { SparkleButton } from '@/components/effects/SparkleButton';
import { SseTypingBlock } from '@/components/sse/SseTypingBlock';
import { glassPanel } from '@/lib/glassStyles';
import { getChangelogGitHubLogs } from '@/services';
import type { ChangelogEntry, CurrentWeekView, GitHubLogEntry, GitHubLogsView, ReleasesView } from '@/services';
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
type HistorySummaryStatus = 'idle' | 'loading' | 'ready' | 'error';

const GITHUB_LOGS_CACHE_KEY = 'changelog:github-logs:v1';
const GITHUB_LOGS_CACHE_TTL_MS = 5 * 60 * 1000;
const GITHUB_LOGS_FETCH_LIMIT = 30;

interface GitHubLogsCachePayload {
  cachedAt: number;
  data: GitHubLogsView;
}

interface HistorySummaryResult {
  title: string;
  headline: string;
  bullets: string[];
  stats: string[];
  insight: string;
  thinkingTrace: string;
  generatedAt: number;
}

const HISTORY_SUMMARY_STEPS: Record<HistorySubtab, string[]> = {
  releases: [
    '读取版本时间线、用户更新项和最近可见条目',
    '统计变更类型、模块热点与发布密度',
    '压缩成适合顶部快速阅读的发布摘要',
  ],
  fragments: [
    '聚合待发布功能并按日期合并重复上下文',
    '识别模块热点和最值得优先发布的条目',
    '整理成当前周的待发布功能摘要',
  ],
  github_logs: [
    '扫描最近提交、作者分布与提交主题',
    '识别重复推进方向和本轮研发热点',
    '整理成仓库节奏与趋势摘要',
  ],
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

function getLatestCommitDateTime(days: Array<{ commitTimeUtc?: string | null }>): string | null {
  const latestCommitDay = days
    .map((d) => parseIsoDate(d.commitTimeUtc))
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (latestCommitDay) {
    return formatLocalDateTimeValue(latestCommitDay);
  }
  return null;
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

function topCounts(values: string[], limit = 3): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const label = raw.trim();
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

function formatCountLabels(items: Array<{ label: string; count: number }>): string {
  return items.map((item) => `${item.label} (${item.count})`).join('、');
}

function shorten(text: string, max = 42): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function extractLogTopic(message: string): string {
  const moduleMatch = message.match(/^[a-z]+(?:\(([^)]+)\))?/i);
  if (moduleMatch?.[1]) return moduleMatch[1];
  if (moduleMatch?.[0]) return moduleMatch[0].replace(/\(.+$/, '');
  const head = message.split(/[:：]/)[0]?.trim();
  return shorten(head || message, 18);
}

function buildReleaseSummary(releases: ReleasesView, typeFilter: string | null): HistorySummaryResult {
  const visibleReleases = releases.releases
    .map((release) => ({
      ...release,
      days: release.days
        .map((day) => ({
          ...day,
          entries: day.entries.filter((entry) => !typeFilter || entry.type.toLowerCase() === typeFilter),
        }))
        .filter((day) => day.entries.length > 0),
    }))
    .filter((release) => release.days.length > 0 || release.highlights.length > 0);

  const entries = visibleReleases.flatMap((release) => release.days.flatMap((day) => day.entries));
  if (visibleReleases.length === 0 || entries.length === 0) {
    throw new Error('当前筛选条件下没有可总结的历史发布');
  }

  const latest = visibleReleases[0];
  const topTypes = topCounts(entries.map((entry) => getTypeBadge(entry.type).label));
  const topModules = topCounts(entries.map((entry) => entry.module));
  const latestHighlight = latest.highlights[0];

  return {
    title: 'CHANGELOG 发布摘要',
    headline: `当前最值得先看的版本是 ${latest.version === '未发布' ? '未发布' : `v${latest.version}`}，共整理 ${entries.length} 条可见更新。`,
    bullets: [
      latestHighlight
        ? `面向用户最值得先讲的是：${shorten(latestHighlight, 56)}`
        : `最近版本主要围绕 ${topModules.length ? formatCountLabels(topModules) : '多模块并行推进'} 展开。`,
      topTypes.length
        ? `变更类型以 ${formatCountLabels(topTypes)} 为主。`
        : '当前筛选下没有形成明显的类型集中趋势。',
      topModules.length
        ? `模块热点集中在 ${formatCountLabels(topModules)}。`
        : '模块分布较分散，适合按用户更新项来讲。',
    ],
    stats: [
      `${visibleReleases.length} 个版本`,
      `${entries.length} 条更新`,
      `${new Set(entries.map((entry) => entry.module)).size} 个模块`,
    ],
    insight: typeFilter
      ? `当前摘要已按「${getTypeBadge(typeFilter).label}」筛选，适合只看这一类变更。`
      : '适合先讲版本价值，再下钻到模块条目。',
    thinkingTrace: '',
    generatedAt: Date.now(),
  };
}

function buildFragmentSummary(currentWeek: CurrentWeekView, typeFilter: string | null): HistorySummaryResult {
  const rows = currentWeek.fragments.flatMap((fragment) =>
    fragment.entries
      .filter((entry) => !typeFilter || entry.type.toLowerCase() === typeFilter)
      .map((entry) => ({ ...entry, date: fragment.date, fileName: fragment.fileName })),
  );
  if (rows.length === 0) {
    throw new Error('当前筛选条件下没有可总结的待发布功能');
  }

  const topTypes = topCounts(rows.map((entry) => getTypeBadge(entry.type).label));
  const topModules = topCounts(rows.map((entry) => entry.module));
  const groupedDates = topCounts(rows.map((entry) => entry.date), 2);
  const samples = rows.slice(0, 3).map((entry) => shorten(entry.description, 48));

  return {
    title: '待发布功能摘要',
    headline: `当前待发布池里共有 ${rows.length} 条条目，覆盖 ${new Set(rows.map((row) => row.date)).size} 个日期批次。`,
    bullets: [
      topModules.length
        ? `模块热度最高的是 ${formatCountLabels(topModules)}。`
        : '目前没有明显的模块集中趋势。',
      topTypes.length
        ? `条目类型主要是 ${formatCountLabels(topTypes)}。`
        : '条目类型较分散，适合按日期逐组发布。',
      samples.length > 0
        ? `最值得优先讲的功能点包括：${samples.join('；')}`
        : '当前待发布功能仍需要进一步整理成发布话术。',
    ],
    stats: [
      `${rows.length} 条待发布`,
      `${new Set(rows.map((row) => row.module)).size} 个模块`,
      groupedDates.length ? `高频日期 ${formatCountLabels(groupedDates)}` : '日期分布较散',
    ],
    insight: '更适合当作“下一版准备发布什么”的预告区，而不是当历史记录看。',
    thinkingTrace: '',
    generatedAt: Date.now(),
  };
}

function buildGitHubLogSummary(logsView: GitHubLogsView): HistorySummaryResult {
  const logs = logsView.logs.slice(0, GITHUB_LOGS_FETCH_LIMIT);
  if (logs.length === 0) {
    throw new Error('当前没有可总结的 GitHub 日志');
  }

  const topAuthors = topCounts(logs.map((log) => log.authorName));
  const topTopics = topCounts(logs.map((log) => extractLogTopic(log.message)));
  const latestMessages = logs.slice(0, 3).map((log) => shorten(log.message, 46));

  return {
    title: 'GitHub 日志摘要',
    headline: `最近 ${logs.length} 条提交主要由 ${topAuthors.length ? formatCountLabels(topAuthors) : '多人协同'} 推进。`,
    bullets: [
      topTopics.length
        ? `提交主题集中在 ${formatCountLabels(topTopics)}。`
        : '当前提交主题较分散，没有形成单一热点。',
      latestMessages.length > 0
        ? `最近几条动作包括：${latestMessages.join('；')}`
        : '最近没有足够的提交内容可用于提炼。',
      logsView.source === 'local'
        ? '当前日志来自本地 git log，响应会更快，也更适合看实时推进节奏。'
        : '当前日志来自 GitHub commits API，适合看远端主线的最新推进。',
    ],
    stats: [
      `${logs.length} 条提交`,
      `${new Set(logs.map((log) => log.authorName)).size} 位作者`,
      `${logsView.source === 'local' ? '本地仓库' : 'GitHub API'} 源`,
    ],
    insight: '适合用来判断这轮开发是在收尾修补，还是在推进新的主线功能。',
    thinkingTrace: '',
    generatedAt: Date.now(),
  };
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
  const [summaryCache, setSummaryCache] = useState<Record<HistorySubtab, HistorySummaryResult | null>>({
    releases: null,
    fragments: null,
    github_logs: null,
  });
  const [summaryStatus, setSummaryStatus] = useState<Record<HistorySubtab, HistorySummaryStatus>>({
    releases: 'idle',
    fragments: 'idle',
    github_logs: 'idle',
  });
  const [summaryThinking, setSummaryThinking] = useState<Record<HistorySubtab, string>>({
    releases: '',
    fragments: '',
    github_logs: '',
  });
  const [summaryError, setSummaryError] = useState<Record<HistorySubtab, string | null>>({
    releases: null,
    fragments: null,
    github_logs: null,
  });
  const summaryRunRef = useRef(0);

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
    setLoadingGitHubLogs(true);
    setGitHubLogsError(null);
    void getChangelogGitHubLogs(GITHUB_LOGS_FETCH_LIMIT).then((res) => {
      if (res.success) {
        setGitHubLogs(res.data);
        writeGitHubLogsCache(res.data);
      } else {
        setGitHubLogsError(res.error?.message || '加载 GitHub 日志失败');
      }
    }).catch((error: unknown) => {
      setGitHubLogsError(error instanceof Error ? error.message : '加载 GitHub 日志失败');
    }).finally(() => {
      setLoadingGitHubLogs(false);
    });
  }, [activeTab, historySubtab, loadingGitHubLogs, githubLogs]);

  useEffect(() => {
    if (activeTab !== 'update_center' || historySubtab === 'github_logs' || loadingGitHubLogs || githubLogs) return;
    const run = () => {
      setLoadingGitHubLogs(true);
      void getChangelogGitHubLogs(GITHUB_LOGS_FETCH_LIMIT).then((res) => {
        if (res.success) {
          setGitHubLogs(res.data);
          writeGitHubLogsCache(res.data);
        }
      }).catch(() => {
        // 预取失败不打断当前页，用户切到 GitHub 日志时会显式重试
      }).finally(() => {
        setLoadingGitHubLogs(false);
      });
    };

    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(run, { timeout: 1500 });
      return () => window.cancelIdleCallback(idleId);
    }

    const timer = globalThis.setTimeout(run, 800);
    return () => globalThis.clearTimeout(timer);
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

  const summarizeCurrentTab = async () => {
    const tab = historySubtab;
    const runId = ++summaryRunRef.current;
    const startedAt = Date.now();
    setSummaryError((prev) => ({ ...prev, [tab]: null }));
    setSummaryStatus((prev) => ({ ...prev, [tab]: 'loading' }));
    setSummaryThinking((prev) => ({ ...prev, [tab]: '' }));

    let thinkingTrace = '';
    try {
      for (const [index, step] of HISTORY_SUMMARY_STEPS[tab].entries()) {
        thinkingTrace = `${thinkingTrace}${thinkingTrace ? '\n' : ''}${index + 1}. ${step}`;
        if (summaryRunRef.current !== runId) return;
        setSummaryThinking((prev) => ({ ...prev, [tab]: thinkingTrace }));
        await delay(420);
      }

      let summary: HistorySummaryResult;
      if (tab === 'releases') {
        if (!releases) throw new Error('历史发布还没加载完成');
        summary = buildReleaseSummary(releases, typeFilter);
      } else if (tab === 'fragments') {
        if (!currentWeek) throw new Error('待发布功能还没加载完成');
        summary = buildFragmentSummary(currentWeek, typeFilter);
      } else {
        let logs = githubLogs;
        if (!logs) {
          const res = await getChangelogGitHubLogs(GITHUB_LOGS_FETCH_LIMIT);
          if (!res.success) throw new Error(res.error?.message || '加载 GitHub 日志失败');
          logs = res.data;
          setGitHubLogs(res.data);
          writeGitHubLogsCache(res.data);
        }
        summary = buildGitHubLogSummary(logs);
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed < 2000) {
        await delay(2000 - elapsed);
      }
      if (summaryRunRef.current !== runId) return;

      const completed = {
        ...summary,
        thinkingTrace,
        generatedAt: Date.now(),
      };
      setSummaryCache((prev) => ({ ...prev, [tab]: completed }));
      setSummaryThinking((prev) => ({ ...prev, [tab]: thinkingTrace }));
      setSummaryStatus((prev) => ({ ...prev, [tab]: 'ready' }));
    } catch (error) {
      if (summaryRunRef.current !== runId) return;
      setSummaryStatus((prev) => ({ ...prev, [tab]: 'error' }));
      setSummaryError((prev) => ({
        ...prev,
        [tab]: error instanceof Error ? error.message : '总结失败',
      }));
      setSummaryThinking((prev) => ({ ...prev, [tab]: thinkingTrace }));
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
  const activeSummary = summaryCache[historySubtab];
  const activeSummaryStatus = summaryStatus[historySubtab];
  const activeSummaryThinking = summaryThinking[historySubtab];
  const activeSummaryError = summaryError[historySubtab];
  const activeSummaryLabel = historySubtab === 'releases'
    ? 'CHANGELOG'
    : historySubtab === 'fragments'
      ? '待发布功能'
      : 'GitHub 日志';

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
              { key: 'fragments', label: '待发布功能', icon: <FileText size={13} /> },
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
          <div className="flex items-center gap-3 flex-wrap justify-end">
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {historySubtab === 'releases' && '来自 CHANGELOG.md'}
              {historySubtab === 'fragments' && '来自 changelogs/*.md（待合入 CHANGELOG）'}
              {historySubtab === 'github_logs' && (
                githubLogs?.source === 'local' ? '来自本地 git log' : '来自 GitHub commits API'
              )}
            </span>
            <div
              style={{
                transform: 'scale(0.82)',
                transformOrigin: 'right center',
                opacity: activeSummaryStatus === 'loading' ? 0.76 : 1,
                pointerEvents: activeSummaryStatus === 'loading' ? 'none' : 'auto',
              }}
            >
              <SparkleButton
                text={activeSummaryStatus === 'loading' ? '总结中...' : 'AI 总结'}
                onClick={() => { void summarizeCurrentTab(); }}
              />
            </div>
          </div>
        </div>

        {(activeSummaryStatus !== 'idle' || activeSummary) && (
          <div
            className="mb-4 rounded-2xl px-4 py-4"
            style={{
              background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.10), rgba(14, 165, 233, 0.06))',
              border: '1px solid rgba(99, 102, 241, 0.18)',
              boxShadow: '0 18px 48px rgba(15, 23, 42, 0.22)',
            }}
          >
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div
                  className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-semibold mb-2"
                  style={{
                    background: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    color: '#c7d2fe',
                  }}
                >
                  <Wand2 size={12} />
                  AI 总结 · {activeSummaryLabel}
                </div>
                <div className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {activeSummary?.title ?? `正在总结 ${activeSummaryLabel}`}
                </div>
                <div className="text-[13px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  {activeSummaryStatus === 'loading'
                    ? '先在 2 秒内给出结构和方向，再补完整摘要。'
                    : activeSummary?.headline}
                </div>
              </div>
              <div
                className="inline-flex items-center gap-2 text-[12px]"
                style={{ color: 'var(--text-muted)' }}
              >
                <Brain size={13} />
                {activeSummaryStatus === 'loading' && (
                  <>
                    <MapSpinner size={12} />
                    <span>思考中…</span>
                  </>
                )}
                {activeSummaryStatus === 'ready' && activeSummary && (
                  <span>{new Date(activeSummary.generatedAt).toLocaleTimeString()}</span>
                )}
              </div>
            </div>

            {activeSummaryThinking && (
              <div className="mt-3">
                <SseTypingBlock
                  label={activeSummaryStatus === 'loading' ? '思考过程' : '分析轨迹'}
                  text={activeSummaryThinking}
                  tailChars={800}
                  maxHeight={140}
                  showCursor={activeSummaryStatus === 'loading'}
                />
              </div>
            )}

            {activeSummaryStatus === 'error' && activeSummaryError && (
              <div
                className="mt-3 rounded-xl px-3 py-2 text-[12px]"
                style={{
                  background: 'rgba(248, 113, 113, 0.08)',
                  border: '1px solid rgba(248, 113, 113, 0.22)',
                  color: '#fca5a5',
                }}
              >
                ⚠ {activeSummaryError}
              </div>
            )}

            {activeSummaryStatus === 'ready' && activeSummary && (
              <div className="mt-3 flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {activeSummary.stats.map((stat) => (
                    <span
                      key={stat}
                      className="px-2.5 py-1 rounded-full text-[11px] font-medium"
                      style={{
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {stat}
                    </span>
                  ))}
                </div>
                <div className="grid gap-2">
                  {activeSummary.bullets.map((bullet, index) => (
                    <div
                      key={`${activeSummary.title}-${index}`}
                      className="rounded-xl px-3 py-2 text-[13px] leading-relaxed"
                      style={{
                        background: 'rgba(255, 255, 255, 0.03)',
                        border: '1px solid rgba(255, 255, 255, 0.06)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {bullet}
                    </div>
                  ))}
                </div>
                <div
                  className="rounded-xl px-3 py-2 text-[12px] leading-relaxed"
                  style={{
                    background: 'rgba(99, 102, 241, 0.08)',
                    border: '1px solid rgba(99, 102, 241, 0.14)',
                    color: '#dbeafe',
                  }}
                >
                  {activeSummary.insight}
                </div>
              </div>
            )}
          </div>
        )}

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
                  const releaseDisplayDate = release.releaseDate;
                  const releaseCommitDateTime = getLatestCommitDateTime(visibleDays);
                  const releaseDateTitle = releaseCommitDateTime
                    ? `CHANGELOG 版本日期：${release.releaseDate ?? '未发布'}\n最近一次 CHANGELOG 合并提交：${releaseCommitDateTime}`
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
                            const dayCommitDateTime = formatCommitDateTime(day.commitTimeUtc);
                            const dayTitle = dayCommitDateTime
                              ? `CHANGELOG 日期：${day.date}\n最近一次 CHANGELOG 合并提交：${dayCommitDateTime}`
                              : undefined;
                            return (
                              <div key={`${day.date}-${dayIdx}`}>
                                <div
                                  className="inline-flex items-center gap-2 mb-2.5 px-2.5 py-1 rounded-md"
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
            {!currentWeek && <MapSectionLoader text="正在加载待发布功能…" />}

            {currentWeek && currentWeek.fragments.length === 0 && (
              <div
                className="rounded-xl px-4 py-6 text-center text-[12px]"
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px dashed rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-muted)',
                }}
              >
                当前周暂无待发布功能
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
                当前筛选条件下暂无待发布条目
              </div>
            )}

            {currentWeek && currentWeek.fragments.filter((f) => f.entries.some(matchFilter)).length > 0 && (
              <div className="flex flex-col gap-4">
                {(() => {
                  const grouped = currentWeek.fragments.reduce<Array<{
                    date: string;
                    rows: Array<FlatEntry & { fileName: string }>;
                  }>>((acc, fragment) => {
                    const visibleEntries = fragment.entries.filter(matchFilter);
                    if (visibleEntries.length === 0) return acc;
                    const bucket = acc.find((item) => item.date === fragment.date);
                    const rows = visibleEntries.map((entry) => ({
                      ...entry,
                      date: fragment.date,
                      commitTimeUtc: null,
                      source: 'fragment' as const,
                      fileName: fragment.fileName,
                    }));
                    if (bucket) bucket.rows.push(...rows);
                    else acc.push({ date: fragment.date, rows });
                    return acc;
                  }, []);

                  return grouped.map((group) => (
                    <div
                      key={group.date}
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
                          {group.date}
                        </div>
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          · {group.rows.length} 条
                        </span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {group.rows.map((entry, idx) => (
                          <EntryRow
                            key={`${group.date}-${entry.fileName}-${idx}`}
                            entry={entry}
                            newCutoff={newBadgeCutoff}
                          />
                        ))}
                      </div>
                    </div>
                  ));
                })()}
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
