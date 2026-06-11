import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Sparkles, Calendar, Tag, RefreshCw, Filter, X, FileText,
  Wrench, Zap, Gauge, Shuffle, Shield, Package, FlaskConical, Cog,
  Github, GitCommit, ExternalLink, Brain, Wand2, Radio, UserCheck, Flame,
} from 'lucide-react';
import { useChangelogStore } from '@/stores/changelogStore';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { SseTypingBlock } from '@/components/sse/SseTypingBlock';
import { glassPanel } from '@/lib/glassStyles';
import { getChangelogGitHubLogs, postChangelogAiSummary } from '@/services';
import type { ChangelogEntry, ChangelogRelease, GitHubLogEntry, GitHubLogsView } from '@/services';
import { api } from '@/services/api';
import { useSseStream } from '@/lib/useSseStream';
import { TabBar } from '@/components/design/TabBar';
import {
  WeeklyReportsTab,
  WeeklyReportSourceChips,
  WeeklyReportSourceDialog,
} from './components/WeeklyReportsTab';
import { WeeklyReportSourcesProvider } from './components/weeklyReportSourcesContext';
import { AiNewsTimeline } from '@/components/ai-news/AiNewsTimeline';
import { groupGitHubLogsByWeek } from './lib/groupGitHubLogsByWeek';
import { burstParticles } from './lib/burstParticles';
import { AnimatedNumber } from './components/AnimatedNumber';
import './changelog-dynamic.css';


interface TypeBadgeMeta {
  label: string;
  color: string;
  bg: string;
  border: string;
  icon: LucideIcon;
}

/** 更新类型枚举：changelogs/*.md 第一列只允许这些 key，UI 只展示中文 label。 */
const TYPE_BADGE_REGISTRY: Record<string, TypeBadgeMeta> = {
  feat: { label: '新功能', color: '#86efac', bg: 'rgba(34, 197, 94, 0.10)', border: 'rgba(34, 197, 94, 0.32)', icon: Sparkles },
  fix: { label: '修复', color: '#fdba74', bg: 'rgba(251, 146, 60, 0.10)', border: 'rgba(251, 146, 60, 0.32)', icon: Wrench },
  perf: { label: '优化', color: '#c4b5fd', bg: 'rgba(139, 92, 246, 0.10)', border: 'rgba(139, 92, 246, 0.32)', icon: Gauge },
  refactor: { label: '重构', color: '#93c5fd', bg: 'rgba(59, 130, 246, 0.10)', border: 'rgba(59, 130, 246, 0.32)', icon: Shuffle },
  docs: { label: '文档', color: '#67e8f9', bg: 'rgba(6, 182, 212, 0.10)', border: 'rgba(6, 182, 212, 0.32)', icon: FileText },
  chore: { label: '杂项', color: '#d4d4d8', bg: 'rgba(161, 161, 170, 0.10)', border: 'rgba(161, 161, 170, 0.32)', icon: Package },
  test: { label: '测试', color: '#34d399', bg: 'rgba(52, 211, 153, 0.10)', border: 'rgba(52, 211, 153, 0.32)', icon: FlaskConical },
  ci: { label: '构建', color: '#cbd5e1', bg: 'rgba(203, 213, 225, 0.10)', border: 'rgba(203, 213, 225, 0.32)', icon: Cog },
  build: { label: '构建', color: '#cbd5e1', bg: 'rgba(203, 213, 225, 0.10)', border: 'rgba(203, 213, 225, 0.32)', icon: Cog },
  release: { label: '发布', color: '#fde68a', bg: 'rgba(245, 158, 11, 0.10)', border: 'rgba(245, 158, 11, 0.30)', icon: Calendar },
  security: { label: '安全', color: '#fda4af', bg: 'rgba(244, 63, 94, 0.10)', border: 'rgba(244, 63, 94, 0.30)', icon: Shield },
  ops: { label: '运维', color: '#fcd34d', bg: 'rgba(234, 179, 8, 0.10)', border: 'rgba(234, 179, 8, 0.30)', icon: Cog },
  style: { label: '样式', color: '#f0abfc', bg: 'rgba(217, 70, 239, 0.10)', border: 'rgba(217, 70, 239, 0.30)', icon: Package },
  polish: { label: '润色', color: '#f472b6', bg: 'rgba(244, 114, 182, 0.10)', border: 'rgba(244, 114, 182, 0.32)', icon: Zap },
  rule: { label: '规范', color: '#e879f9', bg: 'rgba(232, 121, 249, 0.10)', border: 'rgba(232, 121, 249, 0.32)', icon: Shield },
  merge: { label: '合并', color: '#a5b4fc', bg: 'rgba(99, 102, 241, 0.10)', border: 'rgba(99, 102, 241, 0.28)', icon: GitCommit },
  revert: { label: '回滚', color: '#fca5a5', bg: 'rgba(248, 113, 113, 0.10)', border: 'rgba(248, 113, 113, 0.30)', icon: Shuffle },
};

const CHANGELOG_TYPE_ORDER = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'chore',
  'test',
  'ci',
  'build',
  'release',
  'security',
  'ops',
  'style',
  'polish',
  'rule',
  'merge',
  'revert',
];

const FALLBACK_BADGE: TypeBadgeMeta = {
  label: '其他',
  color: '#d4d4d8',
  bg: 'rgba(161, 161, 170, 0.10)',
  border: 'rgba(161, 161, 170, 0.32)',
  icon: Tag as LucideIcon,
};

function getTypeBadge(type: string) {
  return TYPE_BADGE_REGISTRY[type.toLowerCase()] ?? FALLBACK_BADGE;
}

function isUnarchivedRelease(release: ChangelogRelease): boolean {
  return release.version === '未发布' || release.sourceScope === 'changelog-unreleased-block';
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

// v4：新增 repoTotalCommitCount / matched* / coAuthors 字段，bump key 使旧缓存自然失效
const GITHUB_LOGS_CACHE_KEY = 'changelog:github-logs:v4';
const GITHUB_LOGS_CACHE_TTL_MS = 5 * 60 * 1000;
/** 首屏只拉 80 条（与 visible=80 对齐），后续走 cursor 续接 */
const GITHUB_LOGS_INITIAL_FETCH = 80;
/** 续接每批拉 80 条 */
const GITHUB_LOGS_PAGE_SIZE = 80;
const GITHUB_LOGS_LIVE_POLL_MS = 35 * 1000;
const GITHUB_LOGS_NEW_HIGHLIGHT_MS = 5200;
const RELEASES_INITIAL_VISIBLE = 4;
const RELEASES_VISIBLE_STEP = 3;
const FRAGMENT_GROUPS_INITIAL_VISIBLE = 6;
const FRAGMENT_GROUPS_VISIBLE_STEP = 5;
const GITHUB_LOGS_INITIAL_VISIBLE = 80;
const GITHUB_LOGS_VISIBLE_STEP = 80;

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

interface PublishedTimelineGroup {
  date: string;
  versionEvents: string[];
  rows: FlatEntry[];
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

function formatRelativeTime(iso?: string | null): string {
  const d = parseIsoDate(iso);
  if (!d) return '';
  const diff = Math.max(0, Date.now() - d.getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
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

function useIncrementalVisible(
  enabled: boolean,
  total: number,
  initial: number,
  step: number,
  rootRef: { current: HTMLElement | null }
) {
  const [visibleCount, setVisibleCount] = useState(initial);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // 关键：total 增长（瀑布加载新批次）时**保留**当前 visibleCount，不重置回 initial，
  // 否则用户滚动到第 8 组后触发的 backend loadMore 会把视图缩回第 6 组。
  useEffect(() => {
    setVisibleCount((current) => Math.min(Math.max(current, initial), total));
  }, [enabled, initial, total]);

  useEffect(() => {
    if (!enabled || visibleCount >= total) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisibleCount((current) => Math.min(total, current + step));
      },
      {
        root: rootRef.current,
        rootMargin: '420px 0px',
        threshold: 0.01,
      }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, rootRef, step, total, visibleCount]);

  return {
    visibleCount: Math.min(visibleCount, total),
    sentinelRef,
    hasMore: visibleCount < total,
  };
}

export default function ChangelogPage() {
  const currentWeek = useChangelogStore((s) => s.currentWeek);
  const releases = useChangelogStore((s) => s.releases);
  const loadingCurrent = useChangelogStore((s) => s.loadingCurrent);
  const loadingReleases = useChangelogStore((s) => s.loadingReleases);
  const error = useChangelogStore((s) => s.error);
  const loadCurrentWeek = useChangelogStore((s) => s.loadCurrentWeek);
  const loadMoreFragments = useChangelogStore((s) => s.loadMoreFragments);
  const loadReleases = useChangelogStore((s) => s.loadReleases);
  const loadReleaseDetail = useChangelogStore((s) => s.loadReleaseDetail);
  const markAsSeen = useChangelogStore((s) => s.markAsSeen);

  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('update_center');
  const [historySubtab, setHistorySubtab] = useState<HistorySubtab>('releases');
  const [githubLogs, setGitHubLogs] = useState<GitHubLogsView | null>(() => readGitHubLogsCache());
  const [loadingGitHubLogs, setLoadingGitHubLogs] = useState(false);
  const [gitHubLogsError, setGitHubLogsError] = useState<string | null>(null);
  const [newGitHubLogShas, setNewGitHubLogShas] = useState<Set<string>>(() => new Set());
  const [liveFetchedAt, setLiveFetchedAt] = useState<string | null>(() => githubLogs?.fetchedAt ?? null);
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
  /** 各子 tab 独立世代，避免切 tab 后先发起的请求被后一次全局 runId 误判为过期而永久卡在 loading */
  const summaryRunByTab = useRef<Record<HistorySubtab, number>>({
    releases: 0,
    fragments: 0,
    github_logs: 0,
  });
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const githubLogsRef = useRef<GitHubLogsView | null>(githubLogs);
  const githubLogsRefreshInFlightRef = useRef(false);
  // 在途刷新期间又被请求一次（如 35s 轮询在跑时 SSE update 到达）→ 标记 pending，
  // 在途请求结束后补跑一次，避免「服务器 push 的更新被在途请求吞掉」（Bugbot #722 Medium）。
  // pendingForce 取或：保留在途期间任一次硬刷新意图，补跑不把 force=true 降级为只读重读。
  const githubLogsPendingRef = useRef(false);
  const githubLogsPendingForceRef = useRef(false);
  const refreshGitHubLogsRef = useRef<((opts?: { force?: boolean; foreground?: boolean; showError?: boolean }) => Promise<void>) | null>(null);
  const newGitHubLogClearTimerRef = useRef<number | null>(null);

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

  // 进入页面：瀑布式首屏三件套
  // - currentWeek 只拉 4 个日期组（daysLimit=4），更多走 loadMoreFragments 增量补
  // - releases 走 summary 模式：只元数据 + 计数，体积 <5kB；每个版本详情靠 IntersectionObserver 进入视口时按需补
  // - githubLogs 只拉首批 80 条，cursor 分页续接
  useEffect(() => {
    void loadCurrentWeek({ daysLimit: 4 });
    void loadReleases({ limit: 100, summary: true });
    markAsSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // releases summary 到位后：只对【第一个版本】立刻拉详情；
  // 其余 release 走 IntersectionObserver — 滚动到可视区才拉，避免一次性 700kB 详情压栈
  //
  // 注意：不再用本地 triggeredRef 缓存「已请求」状态。SSE / 刷新会重新调用
  // loadReleases({summary:true})，把所有版本的 days 清空（entriesOmitted=true），
  // 若 ref 还记着「已请求过」就永远不会重拉，卡片留空（Bugbot #2）。
  // 改为：以 `release.entriesOmitted` 本身作为「是否需要拉」的信号；store 端
  // 用 `loadingReleaseVersions` 做并发去重，本端无需再缓存。
  useEffect(() => {
    if (!releases || releases.releases.length === 0) return;
    const firstUnarchived = releases.releases.find(isUnarchivedRelease);
    const firstPublished = releases.releases.find((release) => !isUnarchivedRelease(release));
    for (const release of [firstUnarchived, firstPublished]) {
      if (release?.entriesOmitted) void loadReleaseDetail(release.version);
    }
  }, [releases, loadReleaseDetail]);

  // 其他 release：IntersectionObserver 监视 data-release-version 元素，进视口才拉
  useEffect(() => {
    if (activeTab !== 'update_center' || historySubtab !== 'releases') return;
    if (!releases) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const v = (entry.target as HTMLElement).dataset.releaseVersion;
          if (!v) continue;
          // 让 store 自己判断「是否需要拉」+ 并发去重（loadingReleaseVersions / entriesOmitted）
          void loadReleaseDetail(v);
        }
      },
      { rootMargin: '300px 0px', threshold: 0.01 },
    );
    const nodes = document.querySelectorAll<HTMLElement>('[data-release-version]');
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [activeTab, historySubtab, releases, loadReleaseDetail]);

  // GitHub logs：首屏拉一次 80 条让 chip 计数准确（不是 0），不进入轮询
  useEffect(() => {
    if (githubLogsRef.current) return; // sessionStorage cache 已有，跳过
    void refreshGitHubLogs({ force: false, foreground: false, showError: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    githubLogsRef.current = githubLogs;
  }, [githubLogs]);

  // 离开 GitHub 提交子 tab 或离开更新中心主 tab 时清错误，返回时可重新拉取
  useEffect(() => {
    if (activeTab !== 'update_center' || historySubtab !== 'github_logs') {
      setGitHubLogsError(null);
    }
  }, [activeTab, historySubtab]);

  const refreshGitHubLogs = useCallback(async ({
    force = false,
    foreground = false,
    showError = false,
  }: {
    force?: boolean;
    foreground?: boolean;
    showError?: boolean;
  } = {}) => {
    if (githubLogsRefreshInFlightRef.current) {
      // 在途时不丢弃：记一个 pending，待在途请求结束后补跑一次（拿到 SSE push 的最新数据）。
      // force 取或：保留在途期间任一次硬刷新意图。
      githubLogsPendingRef.current = true;
      githubLogsPendingForceRef.current = githubLogsPendingForceRef.current || force;
      return;
    }
    githubLogsRefreshInFlightRef.current = true;
    if (foreground) {
      setLoadingGitHubLogs(true);
      setGitHubLogsError(null);
    }

    try {
      const previous = githubLogsRef.current;
      // 刷新永远只拉首批 80 条（最新的）。续接更老的走 loadMoreGitHubLogs（cursor）。
      const res = await getChangelogGitHubLogs({ limit: GITHUB_LOGS_INITIAL_FETCH, force });
      if (res.success) {
        // 成功就清错误横幅（无论 foreground/trailing/SSE 触发）：否则前一次前台失败留下的
        // 红色「注意」横幅会在后台成功更新后仍挂着，与实际状态不符（Bugbot Medium）。
        setGitHubLogsError(null);
        const newShas = new Set(res.data.logs.map((log) => log.sha));
        const previousShas = new Set((previous?.logs ?? []).map((log) => log.sha));
        const insertedShas = previous
          ? res.data.logs.filter((log) => !previousShas.has(log.sha)).map((log) => log.sha)
          : [];

        // 保留用户已通过 cursor 续接到的更老 logs（不在 newShas 里的）。
        // 否则 35s 轮询 / 手动刷新 / SSE 会用 first-page 80 条覆盖整个列表，
        // 用户正在看的更老内容直接消失（Bugbot #3 + Codex P2）。
        const preservedTail = (previous?.logs ?? []).filter((log) => !newShas.has(log.sha));
        // ⚠️ 关键：合并 tail 时也要保留 previous 的 hasMore / nextCursor。
        // 否则用 res.data 的 nextCursor（first-page 最后一条 sha）去续接，
        // 会拉回已经在 preservedTail 里的同一批，产生重复（Bugbot High #1 + Codex P2）
        const merged: GitHubLogsView = preservedTail.length > 0 && previous
          ? {
              ...res.data,
              logs: [...res.data.logs, ...preservedTail],
              hasMore: previous.hasMore,
              nextCursor: previous.nextCursor,
            }
          : res.data;

        setGitHubLogs(merged);
        setLiveFetchedAt(res.data.fetchedAt);
        writeGitHubLogsCache(merged);

        if (insertedShas.length > 0) {
          setNewGitHubLogShas((current) => new Set([...current, ...insertedShas]));
          if (newGitHubLogClearTimerRef.current !== null) {
            window.clearTimeout(newGitHubLogClearTimerRef.current);
          }
          newGitHubLogClearTimerRef.current = window.setTimeout(() => {
            setNewGitHubLogShas(new Set());
            newGitHubLogClearTimerRef.current = null;
          }, GITHUB_LOGS_NEW_HIGHLIGHT_MS);
        }
      } else {
        if (showError) setGitHubLogsError(res.error?.message || '加载 GitHub 提交失败');
      }
    } catch (error: unknown) {
      if (showError) {
        setGitHubLogsError(error instanceof Error ? error.message : '加载 GitHub 提交失败');
      }
    } finally {
      githubLogsRefreshInFlightRef.current = false;
      if (foreground) setLoadingGitHubLogs(false);
      // 在途期间被合并掉的请求补跑一次（trailing-edge），确保 SSE push 的更新最终落到页面，
      // 保留 force 意图（避免用户硬刷新被降级为只读重读）
      if (githubLogsPendingRef.current) {
        githubLogsPendingRef.current = false;
        const f = githubLogsPendingForceRef.current;
        githubLogsPendingForceRef.current = false;
        void refreshGitHubLogsRef.current?.({ force: f });
      }
    }
  }, []);

  // refreshGitHubLogs 自身稳定（[] deps）；用 ref 持有它，供 finally 里的 trailing-edge 补跑调用，
  // 避免 useCallback 自引用导致的依赖环。
  useEffect(() => {
    refreshGitHubLogsRef.current = refreshGitHubLogs;
  }, [refreshGitHubLogs]);

  // cursor 分页续接 GitHub 提交（向更老的方向）
  const loadingMoreLogsRef = useRef(false);
  const loadMoreGitHubLogs = useCallback(async () => {
    if (loadingMoreLogsRef.current) return;
    const startSnapshot = githubLogsRef.current;
    if (!startSnapshot || !startSnapshot.hasMore || !startSnapshot.nextCursor) return;
    loadingMoreLogsRef.current = true;
    const requestedCursor = startSnapshot.nextCursor;
    try {
      const res = await getChangelogGitHubLogs({
        limit: GITHUB_LOGS_PAGE_SIZE,
        before: requestedCursor,
      });
      if (!res.success || !res.data) return;
      // ⚠️ 关键：读最新 ref，而不是用 startSnapshot —— refresh 可能在我们等待期间到达。
      // 若 latest 已不包含 requestedCursor（=refresh 已用新数据完全覆盖），
      // 本次返回的旧 cursor 数据是过时的，直接丢弃，避免用 stale 数据覆盖新列表（Bugbot #2）。
      const latest = githubLogsRef.current;
      if (!latest) return;
      const latestHasCursor = latest.logs.some((l) => l.sha === requestedCursor);
      if (!latestHasCursor) return;
      const merged: GitHubLogsView = {
        ...res.data,
        // 累积保留头部已展示的（最新），追加新批次（更老）
        logs: [...latest.logs, ...res.data.logs],
      };
      setGitHubLogs(merged);
      writeGitHubLogsCache(merged);
    } finally {
      loadingMoreLogsRef.current = false;
    }
  }, []);

  // 只在用户进入「GitHub 提交」子 tab 时才启动 35s 轮询；
  // 默认子 tab 是「已发布」，否则首屏 mount 时 requestIdleCallback 会与初始渲染抢主线程
  // 实时性兜底：handleServerUpdate (SSE push) 仍在常驻，后端有更新会主动推。
  useEffect(() => {
    if (activeTab !== 'update_center') return;
    if (historySubtab !== 'github_logs') return;
    let stopped = false;

    const run = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      void refreshGitHubLogs({
        force: true,
        foreground: !githubLogsRef.current,
        showError: true,
      });
    };

    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(run, { timeout: 1500 });
      const intervalId = window.setInterval(run, GITHUB_LOGS_LIVE_POLL_MS);
      return () => {
        stopped = true;
        window.cancelIdleCallback(idleId);
        window.clearInterval(intervalId);
      };
    }

    const timerId = globalThis.setTimeout(run, 800);
    const intervalId = globalThis.setInterval(run, GITHUB_LOGS_LIVE_POLL_MS);
    return () => {
      stopped = true;
      globalThis.clearTimeout(timerId);
      globalThis.clearInterval(intervalId);
    };
  }, [activeTab, historySubtab, refreshGitHubLogs]);

  useEffect(() => () => {
    if (newGitHubLogClearTimerRef.current !== null) {
      window.clearTimeout(newGitHubLogClearTimerRef.current);
    }
  }, []);

  const handleRefresh = () => {
    void loadCurrentWeek({ daysLimit: 4, force: true });
    void loadReleases({ limit: 100, summary: true, force: true });
    void refreshGitHubLogs({ force: true, foreground: historySubtab === 'github_logs', showError: historySubtab === 'github_logs' });
  };

  // ── 实时推送（SSE）：服务器后台刷新有更新时主动推到本页，无需用户手动刷新 ──
  // 设计：加载只读存量（绝不空白），服务器固定周期刷新，有更新 push 过来后只做后台静默重读。
  const [refreshIntervalHours, setRefreshIntervalHours] = useState<number>(4);
  const [liveConnected, setLiveConnected] = useState(false);
  const [justUpdatedAt, setJustUpdatedAt] = useState<number | null>(null);
  // 最近一次收到服务器信号（meta/ping/update）的时间戳，watchdog 据此判断连接是否静默掉线
  const lastBeatRef = useRef<number>(Date.now());

  const handleServerUpdate = useCallback((data: unknown) => {
    lastBeatRef.current = Date.now();
    const viewType = (data as { viewType?: string })?.viewType;
    // 服务器已把新数据落库，这里只做 force=false 的后台静默重读（读存量，不打 GitHub、不闪 loading）
    if (viewType === 'current-week') void loadCurrentWeek({ daysLimit: 4 });
    else if (viewType === 'releases') void loadReleases({ limit: 100, summary: true });
    else if (viewType === 'github-logs') void refreshGitHubLogs({ force: false });
    setJustUpdatedAt(Date.now());
  }, [loadCurrentWeek, loadReleases, refreshGitHubLogs]);

  const { start: startChangelogStream, abort: abortChangelogStream, phase: changelogStreamPhase } = useSseStream({
    url: api.changelog.stream(),
    onEvent: {
      meta: (d) => {
        lastBeatRef.current = Date.now();
        const h = (d as { refreshIntervalHours?: number })?.refreshIntervalHours;
        if (typeof h === 'number' && h > 0) setRefreshIntervalHours(h);
        setLiveConnected(true);
      },
      update: handleServerUpdate,
      ping: () => { lastBeatRef.current = Date.now(); },
    },
    onError: () => setLiveConnected(false),
  });

  // 流「干净结束」（代理超时/网络掉线但没触发 onError，hook 把 phase 置 done）或出错（phase error）时，
  // 都说明连接已断：立刻清掉「实时同步」徽标（不虚标连接健康，Bugbot #722 Low），
  // 并把 lastBeat 清零，让 watchdog 下一个 tick 立即重连。
  useEffect(() => {
    if (changelogStreamPhase === 'done' || changelogStreamPhase === 'error') {
      setLiveConnected(false);
      lastBeatRef.current = 0;
    }
  }, [changelogStreamPhase]);

  // 进页面即建立实时连接，离开时断开（仅断本订阅，不影响服务器后台刷新任务）。
  // watchdog：心跳 15s/次，若 45s 内无任何信号则判定掉线并自动重连（start 内部会 abort 旧连接）。
  useEffect(() => {
    void startChangelogStream();
    lastBeatRef.current = Date.now();
    const watchdog = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastBeatRef.current > 45000) {
        setLiveConnected(false);
        lastBeatRef.current = Date.now();
        void startChangelogStream();
      }
    }, 20000);
    return () => {
      window.clearInterval(watchdog);
      abortChangelogStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 「已更新」短暂高亮 3 秒后回落为「实时同步」
  useEffect(() => {
    if (justUpdatedAt == null) return;
    const t = window.setTimeout(() => setJustUpdatedAt(null), 3000);
    return () => window.clearTimeout(t);
  }, [justUpdatedAt]);

  const summarizeCurrentTab = async () => {
    const tab = historySubtab;
    summaryRunByTab.current[tab] += 1;
    const runId = summaryRunByTab.current[tab];
    setSummaryError((prev) => ({ ...prev, [tab]: null }));
    setSummaryStatus((prev) => ({ ...prev, [tab]: 'loading' }));
    setSummaryThinking((prev) => ({
      ...prev,
      [tab]: '正在请求服务端：ILlmGateway · prd-admin.changelog.aiSummary::chat …',
    }));

    try {
      const res = await postChangelogAiSummary({
        subtab: tab,
        typeFilter: typeFilter ?? undefined,
      });
      if (summaryRunByTab.current[tab] !== runId) return;
      if (!res.success || !res.data) {
        throw new Error(res.error?.message || 'AI 总结失败');
      }
      const data = res.data;
      const completed: HistorySummaryResult = {
        title: data.title,
        headline: data.headline,
        bullets: data.bullets,
        stats: data.stats,
        insight: data.insight,
        thinkingTrace: data.thinkingTrace,
        generatedAt: data.generatedAt,
      };
      setSummaryCache((prev) => ({ ...prev, [tab]: completed }));
      setSummaryThinking((prev) => ({ ...prev, [tab]: data.thinkingTrace || '' }));
      setSummaryStatus((prev) => ({ ...prev, [tab]: 'ready' }));
    } catch (error) {
      if (summaryRunByTab.current[tab] !== runId) return;
      setSummaryStatus((prev) => ({ ...prev, [tab]: 'error' }));
      setSummaryError((prev) => ({
        ...prev,
        [tab]: error instanceof Error ? error.message : '总结失败',
      }));
      setSummaryThinking((prev) => ({ ...prev, [tab]: '' }));
    }
  };

  const counts = useMemo(() => {
    const released = releases?.totalEntries
      ?? releases?.releases.reduce((sum, release) => (
        sum + (release.entryCount ?? release.days.reduce((daySum, day) => daySum + day.entries.length, 0))
      ), 0)
      ?? 0;
    const unpublished = currentWeek?.totalEntries
      ?? currentWeek?.fragments.reduce((sum, fragment) => sum + fragment.entries.length, 0)
      ?? 0;
    // chip 显示仓库全历史提交总数（用户关心的是「这个仓库一共提交了多少次」），
    // 统计失败时降级为「最近一周」窗口内条数
    const logs = githubLogs?.repoTotalCommitCount ?? githubLogs?.totalCount ?? githubLogs?.logs.length ?? 0;
    return { releases: released, fragments: unpublished, github_logs: logs };
  }, [currentWeek, githubLogs, releases]);

  // 收集 release / fragment 中出现过的 type 用于筛选 chip
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
    return { availableTypes: CHANGELOG_TYPE_ORDER.filter((type) => types.has(type)) };
  }, [currentWeek, releases]);

  // 每个类型的条目数（热度）：releases + fragments 合并统计，驱动筛选 chip 的热度角标
  const typeCounts = useMemo(() => {
    const result: Record<string, number> = {};
    const add = (type: string) => {
      const key = type.toLowerCase();
      if (!key) return;
      result[key] = (result[key] ?? 0) + 1;
    };
    if (releases) {
      for (const r of releases.releases) for (const d of r.days) for (const e of d.entries) add(e.type);
    }
    if (currentWeek) {
      for (const f of currentWeek.fragments) for (const e of f.entries) add(e.type);
    }
    return result;
  }, [currentWeek, releases]);

  // 热度排名（仅条目数 >= 5 的类型参与发光，避免小样本也戴火焰）
  const hotTypeRanking = useMemo(() => (
    availableTypes
      .filter((t) => (typeCounts[t] ?? 0) >= 5)
      .sort((a, b) => (typeCounts[b] ?? 0) - (typeCounts[a] ?? 0))
  ), [availableTypes, typeCounts]);

  const matchFilter = useCallback((e: ChangelogEntry): boolean => {
    if (typeFilter && e.type.toLowerCase() !== typeFilter) return false;
    return true;
  }, [typeFilter]);

  const allReleaseRenderItems = useMemo(() => {
    if (!releases) return [];
    // 去重：CHANGELOG.md 文末有第二个 `## [未发布]` 模板锚点，parser 会重复匹配
    const seenVersions = new Set<string>();
    return releases.releases
      .filter((r) => {
        if (seenVersions.has(r.version)) return false;
        seenVersions.add(r.version);
        return true;
      })
      .map((release) => {
        const visibleDays = release.days
          .map((d) => ({
            ...d,
            entries: d.entries.filter(matchFilter),
          }))
          .filter((d) => d.entries.length > 0);
        const totalCount = visibleDays.reduce((s, d) => s + d.entries.length, 0);
        // summary 模式（entriesOmitted=true）下 days 故意为空——仍然要渲染卡片，让 IntersectionObserver
        // 能挂到 dom 上触发详情拉取。只有当 release 真的「无 entries + 无 highlights + 非 summary」时才隐藏。
        if (totalCount === 0 && release.highlights.length === 0 && !release.entriesOmitted) {
          return null;
        }
        const entryCount = release.entryCount ?? release.days.reduce((sum, day) => sum + day.entries.length, 0);
        return { release, visibleDays, totalCount, entryCount };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [releases, matchFilter]);

  const publishedTimelineGroups = useMemo(() => {
    const groups = new Map<string, PublishedTimelineGroup>();
    const ensureGroup = (date: string) => {
      const existing = groups.get(date);
      if (existing) return existing;
      const created: PublishedTimelineGroup = { date, versionEvents: [], rows: [] };
      groups.set(date, created);
      return created;
    };

    for (const { release, visibleDays } of allReleaseRenderItems) {
      if (!isUnarchivedRelease(release) && release.releaseDate) {
        ensureGroup(release.releaseDate).versionEvents.push(`v${release.version}`);
      }
      for (const day of visibleDays) {
        const group = ensureGroup(day.date);
        group.rows.push(...day.entries.map((entry) => ({
          ...entry,
          date: day.date,
          commitTimeUtc: day.commitTimeUtc ?? null,
          source: 'release' as const,
          releaseVersion: release.version,
        })));
      }
    }

    return Array.from(groups.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [allReleaseRenderItems]);

  const fragmentGroups = useMemo(() => {
    if (!currentWeek) return [];
    return currentWeek.fragments.reduce<Array<{
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
  }, [currentWeek, matchFilter]);

  const githubLogRows = githubLogs?.logs ?? [];
  const releaseList = useIncrementalVisible(
    activeTab === 'update_center' && historySubtab === 'releases',
    publishedTimelineGroups.length,
    RELEASES_INITIAL_VISIBLE,
    RELEASES_VISIBLE_STEP,
    scrollRootRef
  );
  const fragmentList = useIncrementalVisible(
    activeTab === 'update_center' && historySubtab === 'fragments',
    fragmentGroups.length,
    FRAGMENT_GROUPS_INITIAL_VISIBLE,
    FRAGMENT_GROUPS_VISIBLE_STEP,
    scrollRootRef
  );
  const githubLogList = useIncrementalVisible(
    activeTab === 'update_center' && historySubtab === 'github_logs',
    githubLogRows.length,
    GITHUB_LOGS_INITIAL_VISIBLE,
    GITHUB_LOGS_VISIBLE_STEP,
    scrollRootRef
  );

  const githubLogVisibleCount = githubLogList.visibleCount;
  // 当前可见的提交按自然周分组；startIndex 用于保持入场动画的全局 stagger 次序
  const githubLogWeekGroups = useMemo(() => {
    const rows = githubLogs?.logs ?? [];
    const groups = groupGitHubLogsByWeek(rows.slice(0, githubLogVisibleCount));
    let offset = 0;
    return groups.map((group) => {
      const withOffset = { ...group, startIndex: offset };
      offset += group.logs.length;
      return withOffset;
    });
  }, [githubLogs, githubLogVisibleCount]);

  useEffect(() => {
    if (activeTab !== 'update_center' || historySubtab !== 'releases') return;
    if (!releases) return;
    const visibleDates = new Set(
      publishedTimelineGroups.slice(0, releaseList.visibleCount).map((group) => group.date)
    );
    for (const release of releases.releases) {
      if (!release.entriesOmitted) continue;
      if (release.releaseDate && visibleDates.has(release.releaseDate)) {
        void loadReleaseDetail(release.version);
      }
    }
  }, [activeTab, historySubtab, loadReleaseDetail, publishedTimelineGroups, releaseList.visibleCount, releases]);

  // ── 瀑布式 backend loadMore 触发器 ──
  // 当用户已渲染到本地数据末尾 1 组之内 且 backend 还有更多 → preemptive fetch 下一批
  useEffect(() => {
    if (activeTab !== 'update_center') return;
    if (historySubtab !== 'fragments') return;
    if (!currentWeek?.hasMore) return;
    if (fragmentList.visibleCount < fragmentGroups.length - 1) return;
    void loadMoreFragments();
  }, [activeTab, historySubtab, currentWeek, fragmentList.visibleCount, fragmentGroups.length, loadMoreFragments]);

  useEffect(() => {
    if (activeTab !== 'update_center') return;
    if (historySubtab !== 'github_logs') return;
    if (!githubLogs?.hasMore) return;
    if (githubLogList.visibleCount < githubLogRows.length - 10) return;
    void loadMoreGitHubLogs();
  }, [activeTab, historySubtab, githubLogs, githubLogList.visibleCount, githubLogRows.length, loadMoreGitHubLogs]);

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
  const liveFetchedAtRelative = (() => {
    if (!liveFetchedAt) return '';
    try {
      const diff = Date.now() - new Date(liveFetchedAt).getTime();
      const seconds = Math.floor(diff / 1000);
      if (seconds < 45) return '刚刚同步';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes} 分钟前同步`;
      const hours = Math.floor(minutes / 60);
      return `${hours} 小时前同步`;
    } catch {
      return '';
    }
  })();
  const activeSummary = summaryCache[historySubtab];
  const activeSummaryStatus = summaryStatus[historySubtab];
  const activeSummaryThinking = summaryThinking[historySubtab];
  const activeSummaryError = summaryError[historySubtab];
  const activeSummaryLabel = historySubtab === 'releases'
    ? '已发布'
    : historySubtab === 'fragments'
      ? '未发布'
      : 'GitHub 提交';
  const activeTotal = counts[historySubtab];

  // 新提交/新条目到达时给「共 N 次提交」chip 一道扫光（同页签内数值增长才触发，切页签不闪）
  const [totalFlash, setTotalFlash] = useState(false);
  const prevTotalRef = useRef<{ tab: HistorySubtab; value: number } | null>(null);
  useEffect(() => {
    const prev = prevTotalRef.current;
    prevTotalRef.current = { tab: historySubtab, value: activeTotal };
    if (prev && prev.tab === historySubtab && activeTotal > prev.value) {
      setTotalFlash(true);
      const timer = setTimeout(() => setTotalFlash(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [activeTotal, historySubtab]);

  return (
    <WeeklyReportSourcesProvider>
    <div className="flex flex-col gap-5 h-full min-h-0">
      {/* ── 顶部切换导航（周报 tab 下把来源 chip 合并到右侧 actions 槽，省一行） ── */}
      <TabBar
        items={[
          { key: 'update_center', label: '更新中心', icon: <Sparkles size={14} /> },
          { key: 'weekly_reports', label: '周报', icon: <FileText size={14} /> },
          { key: 'ai_news', label: 'AI 大事', icon: <Radio size={14} /> },
        ]}
        activeKey={activeTab}
        onChange={setActiveTab}
        variant="gold"
        actions={activeTab === 'weekly_reports' ? <WeeklyReportSourceChips /> : undefined}
      />
      <WeeklyReportSourceDialog />

      {activeTab === 'update_center' && (
      <div ref={scrollRootRef} className="flex flex-col gap-5 flex-1 min-h-0 overflow-y-auto pr-1"
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
              <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[10px]">
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
                  <span style={{ color: 'var(--text-muted)' }} title={fetchedAt ? new Date(fetchedAt).toLocaleString() : undefined}>
                    更新于 {fetchedAtRelative}
                  </span>
                )}
                {/* 更新规则：终身缓存 + 固定周期自动刷新（红框区诉求） */}
                <span
                  className="px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                  style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    color: 'var(--text-muted)',
                    border: '1px solid rgba(255, 255, 255, 0.10)',
                  }}
                  title="数据终身缓存在服务器，打开即读存量、绝不空白；服务器每隔固定周期自动刷新，有更新自动推送到本页，无需手动刷新。"
                >
                  <RefreshCw size={9} />
                  每 {refreshIntervalHours} 小时自动刷新 · 终身缓存
                </span>
                {/* 实时连接状态：连上后有更新会自动 push 过来 */}
                {liveConnected && (
                  <span
                    className="px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                    style={{
                      background: justUpdatedAt != null ? 'rgba(34, 197, 94, 0.16)' : 'rgba(34, 197, 94, 0.10)',
                      color: '#86efac',
                      border: '1px solid rgba(34, 197, 94, 0.30)',
                    }}
                    title="已与服务器建立实时连接，有更新会自动推送到本页"
                  >
                    <span
                      style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }}
                    />
                    {justUpdatedAt != null ? '已更新' : '实时同步'}
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loadingReleases || loadingCurrent || loadingGitHubLogs}
            className="h-9 px-3 rounded-lg inline-flex items-center gap-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              border: '1px solid rgba(255, 255, 255, 0.12)',
              color: 'var(--text-secondary)',
              background: 'rgba(255, 255, 255, 0.04)',
            }}
            title="刷新（绕过服务端缓存并重新拉取）"
          >
            {(loadingReleases || loadingCurrent || loadingGitHubLogs) ? <MapSpinner size={14} /> : <RefreshCw size={14} />}
            <span>刷新</span>
          </button>
        </div>

        {/* 筛选器 */}
        {availableTypes.length > 0 && (
          <div data-tour-id="changelog-filter" className="flex flex-wrap items-center gap-2 pt-1">
            <div className="inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              <Filter size={14} />
              筛选
            </div>
            
            <div className="flex flex-wrap ml-1" style={{ gap: '12px 10px', paddingTop: '6px' }}>
              {availableTypes.map((t) => {
                const meta = getTypeBadge(t);
                const active = typeFilter === t;
                const Icon = meta.icon;
                const count = typeCounts[t] ?? 0;
                const hotRank = hotTypeRanking.indexOf(t);
                const hotClass = hotRank === 0 ? ' clg-chip-hot1' : hotRank === 1 || hotRank === 2 ? ' clg-chip-hot2' : '';
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={(e) => {
                      setTypeFilter(active ? null : t);
                      if (!active) burstParticles(e.clientX, e.clientY, meta.color);
                    }}
                    title={`${meta.label} · ${count} 条${hotRank === 0 ? ' · 最热' : ''}`}
                    className={`clg-chip h-8 pl-2.5 pr-3 rounded-lg text-[13px] font-medium cursor-pointer inline-flex items-center gap-1.5${hotClass}`}
                    style={{
                      background: meta.bg,
                      border: `1px solid ${meta.border}`,
                      color: meta.color,
                      lineHeight: '1',
                      boxShadow: active ? `0 0 0 2px ${meta.border}` : undefined,
                      filter: active ? 'brightness(1.15)' : undefined,
                    }}
                  >
                    {hotRank === 0 && (
                      <span className="clg-flame">
                        <Flame size={9} strokeWidth={2.5} />
                      </span>
                    )}
                    <Icon size={13} />
                    {meta.label}
                    {count > 0 && (
                      <span className="clg-badge" style={{ background: meta.color }}>
                        {count}
                      </span>
                    )}
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
          注意：本地仓库与 GitHub 都没拉到数据。可能是网络受限、GitHub API 限流，或仓库未配置正确的 owner/repo/branch（详见后端 <code>Changelog:GitHub*</code> 配置项）。
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
          注意：{error}
        </div>
      )}

      {/* ── 更新区：已发布流水 / 未发布碎片 / GitHub 提交 ───────────────────── */}
      <section style={glassPanel} className="rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-4 flex-wrap">
            <h2 className="text-[18px] font-semibold tracking-wide" style={{ color: 'var(--text-primary)' }}>
              更新记录
            </h2>
            {([
              { key: 'releases', label: '已发布', icon: <Calendar size={13} /> },
              { key: 'fragments', label: '未发布', icon: <FileText size={13} /> },
              {
                key: 'github_logs',
                label: 'GitHub 提交',
                // GitHub 提交 icon 上叠加一颗"动态刷新"指示点（呼吸 + 旋转），强调内容是近实时的
                icon: (
                  <span className="relative inline-flex">
                    <Github size={13} />
                    <span
                      className="absolute -top-0.5 -right-0.5 inline-flex h-2 w-2 items-center justify-center"
                      aria-hidden
                    >
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    </span>
                  </span>
                ),
              },
            ] as const).map((tab) => {
              const active = historySubtab === tab.key;
              const count = counts[tab.key];
              const fragmentFileCount = currentWeek?.totalDays ?? currentWeek?.fragments.length ?? 0;
              const tabTitle = tab.key === 'fragments' && currentWeek
                ? `${fragmentFileCount} 个碎片文件 · ${count} 条未发布改动\n来源：changelogs/*.md\n进入已发布流水：发布到 admin 生产环境后合入 CHANGELOG.md`
                : undefined;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setHistorySubtab(tab.key)}
                  title={tabTitle}
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
                  <span
                    className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold"
                    style={{
                      background: active ? 'rgba(199, 210, 254, 0.14)' : 'rgba(255, 255, 255, 0.05)',
                      color: active ? '#e0e7ff' : 'var(--text-muted)',
                      border: `1px solid ${active ? 'rgba(199, 210, 254, 0.22)' : 'rgba(255, 255, 255, 0.08)'}`,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    <AnimatedNumber value={count} />
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3 flex-wrap justify-end">
            <span
              className={`clg-sweep h-7 px-2.5 rounded-lg inline-flex items-center gap-1.5 text-[12px] font-medium${totalFlash ? ' clg-sweep-on' : ''}`}
              style={{
                color: 'var(--text-secondary)',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                fontVariantNumeric: 'tabular-nums',
              }}
              title={`${activeSummaryLabel}总数量`}
            >
              共 <AnimatedNumber value={activeTotal} /> {historySubtab === 'github_logs' ? '次提交' : '条'}
            </span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {historySubtab === 'releases' && '来自 admin 生产发布流水'}
              {historySubtab === 'fragments' && '来自已合并但未上生产的 changelogs/*.md 碎片'}
              {historySubtab === 'github_logs' && (
                <span className="inline-flex items-center gap-1">
                  {githubLogs?.source === 'local' ? '来自本地 git log' : '来自 GitHub commits API'}
                  {githubLogs?.repoTotalCommitCount != null
                    ? <> · 仓库总提交 <AnimatedNumber value={githubLogs.repoTotalCommitCount} style={{ color: 'var(--text-secondary)', fontWeight: 600 }} /> 次 · 下方列出最近一周 {githubLogs.totalCount ?? githubLogs.logs.length} 条</>
                    : ' · 最近一周'}
                  {' · 35 秒自动同步 · '}
                  <span className="relative inline-flex h-1.5 w-1.5 shrink-0" aria-hidden>
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  </span>
                  {liveFetchedAtRelative ? ` ${liveFetchedAtRelative}` : ' 实时同步中'}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => { void summarizeCurrentTab(); }}
              disabled={activeSummaryStatus === 'loading'}
              className={`h-8 px-3 rounded-lg inline-flex items-center gap-1.5 text-[12px] font-medium transition-all disabled:cursor-not-allowed${activeSummaryStatus === 'loading' ? '' : ' clg-ai-shimmer'}`}
              style={{
                background: activeSummaryStatus === 'loading'
                  ? 'rgba(99, 102, 241, 0.10)'
                  : 'rgba(255, 255, 255, 0.04)',
                border: `1px solid ${activeSummaryStatus === 'loading' ? 'rgba(99, 102, 241, 0.24)' : 'rgba(255, 255, 255, 0.08)'}`,
                color: activeSummaryStatus === 'loading' ? '#c7d2fe' : 'var(--text-secondary)',
                boxShadow: activeSummaryStatus === 'loading' ? '0 0 0 1px rgba(99, 102, 241, 0.08)' : 'none',
              }}
              title="总结当前页签的更新内容"
            >
              {activeSummaryStatus === 'loading' ? <MapSpinner size={12} /> : <Wand2 size={13} />}
              {activeSummaryStatus === 'loading' ? '总结中' : 'AI 总结'}
            </button>
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
                    ? '正在通过网关生成摘要（非本地规则拼装）。'
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
                注意：{activeSummaryError}
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
            {loadingReleases && !releases && <MapSectionLoader text="正在加载已发布流水…" />}

            {!loadingReleases && releases && publishedTimelineGroups.length === 0 && (
              <div
                className="rounded-xl px-4 py-6 text-center text-[12px]"
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px dashed rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-muted)',
                }}
              >
                暂无已发布流水
              </div>
            )}

            {releases && publishedTimelineGroups.length > 0 && (
              <div className="flex flex-col gap-6">
                {publishedTimelineGroups.slice(0, releaseList.visibleCount).map((group, groupIdx) => (
                    <div
                      key={group.date}
                      {...(groupIdx === 0 ? { 'data-tour-id': 'changelog-latest' } : {})}
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
                        {group.versionEvents.map((version) => (
                          <span
                            key={version}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold font-mono"
                            style={{
                              background: 'rgba(99, 102, 241, 0.12)',
                              border: '1px solid rgba(99, 102, 241, 0.32)',
                              color: '#a5b4fc',
                            }}
                          >
                            <Tag size={11} />
                            版本发布 {version}
                          </span>
                        ))}
                      </div>
                      {group.rows.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          {group.rows.map((entry, idx) => (
                            <EntryRow
                              key={`${group.date}-${entry.releaseVersion ?? ''}-${idx}`}
                              entry={entry}
                              newCutoff={newBadgeCutoff}
                            />
                          ))}
                        </div>
                      )}
                      {group.rows.length === 0 && group.versionEvents.length > 0 && (
                        <div
                          className="rounded-xl px-4 py-3 text-[12px]"
                          style={{
                            background: 'rgba(99, 102, 241, 0.06)',
                            border: '1px dashed rgba(99, 102, 241, 0.18)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          该版本详情按需加载中，继续滚动会补齐同一流水中的改动条目。
                        </div>
                      )}
                    </div>
                  ))}
                <IncrementalSentinel
                  refEl={releaseList.sentinelRef}
                  show={releaseList.hasMore}
                  text={`继续加载已发布流水 ${Math.min(RELEASES_VISIBLE_STEP, publishedTimelineGroups.length - releaseList.visibleCount)} 个日期…`}
                />
              </div>
            )}
          </>
        )}

        {historySubtab === 'fragments' && (
          <>
            {!currentWeek && <MapSectionLoader text="正在加载未发布改动…" />}

            {currentWeek && currentWeek.fragments.length === 0 && (
              <div
                className="rounded-xl px-4 py-6 text-center text-[12px]"
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px dashed rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-muted)',
                }}
              >
                暂无未发布改动
              </div>
            )}

            {currentWeek && currentWeek.fragments.length > 0 && fragmentGroups.length === 0 && (
              <div
                className="rounded-xl px-4 py-6 text-center text-[12px]"
                style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px dashed rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-muted)',
                }}
              >
                当前筛选条件下暂无未发布改动
              </div>
            )}

            {currentWeek && fragmentGroups.length > 0 && (
              <div className="flex flex-col gap-4">
                {fragmentGroups.slice(0, fragmentList.visibleCount).map((group) => (
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
                  ))}
                <IncrementalSentinel
                  refEl={fragmentList.sentinelRef}
                  show={fragmentList.hasMore || (currentWeek?.hasMore ?? false)}
                  text={
                    fragmentList.hasMore
                      ? `继续加载未发布日期 ${Math.min(FRAGMENT_GROUPS_VISIBLE_STEP, fragmentGroups.length - fragmentList.visibleCount)} 组…`
                      : `从服务器加载更多日期组…`
                  }
                />
              </div>
            )}
          </>
        )}

        {historySubtab === 'github_logs' && (
          <>
            {loadingGitHubLogs && !githubLogs && <MapSectionLoader text="正在加载 GitHub 提交…" />}

            {gitHubLogsError && (
              <div
                className="rounded-xl px-4 py-3 text-[12px]"
                style={{
                  background: 'rgba(248, 113, 113, 0.08)',
                  border: '1px solid rgba(248, 113, 113, 0.32)',
                  color: '#fca5a5',
                }}
              >
                注意：{gitHubLogsError}
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
                暂无 GitHub 提交
              </div>
            )}

            {githubLogs && githubLogRows.length > 0 && (
              <div className="flex flex-col gap-4">
                {githubLogWeekGroups.map((group) => (
                  <div
                    key={group.weekStart}
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
                        {group.label}
                      </div>
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        · {group.logs.length} 条提交
                      </span>
                    </div>
                    <div className="flex flex-col gap-2">
                      <AnimatePresence initial={false}>
                        {group.logs.map((log, idx) => (
                          <GitHubLogRow
                            key={log.sha}
                            log={log}
                            index={group.startIndex + idx}
                            isLiveNew={newGitHubLogShas.has(log.sha)}
                          />
                        ))}
                      </AnimatePresence>
                    </div>
                  </div>
                ))}
                <IncrementalSentinel
                  refEl={githubLogList.sentinelRef}
                  show={githubLogList.hasMore || (githubLogs.hasMore ?? false)}
                  text={
                    githubLogList.hasMore
                      ? `继续加载 GitHub 提交 ${Math.min(GITHUB_LOGS_VISIBLE_STEP, githubLogRows.length - githubLogList.visibleCount)} 条…`
                      : `从服务器加载更多日志…`
                  }
                />
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

      {activeTab === 'ai_news' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <AiNewsTimeline />
        </div>
      )}

    </div>
    </WeeklyReportSourcesProvider>
  );
}

function IncrementalSentinel({
  refEl,
  show,
  text,
}: {
  refEl: RefObject<HTMLDivElement>;
  show: boolean;
  text: string;
}) {
  return (
    <div
      ref={refEl}
      className="h-12 flex items-center justify-center text-[12px]"
      style={{
        color: 'var(--text-muted)',
        opacity: show ? 0.78 : 0,
        pointerEvents: 'none',
      }}
      aria-hidden={!show}
    >
      {show && (
        <span className="inline-flex items-center gap-2">
          <MapSpinner size={12} />
          {text}
        </span>
      )}
    </div>
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
    <motion.div
      layout
      initial={{ opacity: 0, y: 10, scale: 0.995 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
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
    </motion.div>
  );
}

function GitHubLogRow({ log, index, isLiveNew }: { log: GitHubLogEntry; index: number; isLiveNew: boolean }) {
  const commitDateTime = formatCommitDateTime(log.commitTimeUtc) ?? log.commitTimeUtc;
  const relativeTime = formatRelativeTime(log.commitTimeUtc);
  const avatarLetter = (log.authorName || '?').trim().charAt(0).toUpperCase() || '?';
  // 彩蛋：匹配到系统用户时，作者名直接显示系统显示名（GitHub 原名进 tooltip），不再单列两个名字
  const isMatched = Boolean(log.matchedDisplayName);
  const primaryAuthorLabel = log.matchedDisplayName ?? log.authorName;
  const coAuthors = log.coAuthors ?? [];
  const authorTooltip = [
    `GitHub 作者：${log.authorName}`,
    isMatched
      ? `已匹配系统用户：${log.matchedDisplayName}${log.matchedUsername && log.matchedUsername !== log.matchedDisplayName ? `（${log.matchedUsername}）` : ''}`
      : null,
    coAuthors.length > 0
      ? `联合作者：${coAuthors.map((co) => (co.matchedDisplayName ? `${co.name} = ${co.matchedDisplayName}` : co.name)).join('、')}`
      : null,
  ].filter(Boolean).join('\n');
  return (
    <motion.a
      layout
      initial={{ opacity: 0, y: isLiveNew ? -18 : 10, scale: isLiveNew ? 0.985 : 0.995 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.99 }}
      transition={{
        duration: isLiveNew ? 0.44 : 0.28,
        delay: isLiveNew ? Math.min(index, 6) * 0.035 : 0,
        ease: [0.25, 0.46, 0.45, 0.94],
      }}
      href={log.htmlUrl}
      target="_blank"
      rel="noreferrer"
      className="rounded-lg px-3.5 py-3 flex items-center gap-3 transition-colors hover:bg-white/5"
      style={{
        background: isLiveNew
          ? 'linear-gradient(90deg, rgba(34, 197, 94, 0.13), rgba(99, 102, 241, 0.07), rgba(255, 255, 255, 0.025))'
          : 'rgba(255, 255, 255, 0.025)',
        border: `1px solid ${isLiveNew ? 'rgba(74, 222, 128, 0.30)' : 'rgba(255, 255, 255, 0.06)'}`,
        boxShadow: isLiveNew ? '0 0 0 1px rgba(74, 222, 128, 0.08), 0 18px 42px rgba(16, 185, 129, 0.10)' : 'none',
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
        className="shrink-0 inline-flex items-center gap-1.5 h-[26px] px-2 rounded-md text-[12px]"
        style={{
          color: isMatched ? '#86efac' : 'var(--text-secondary)',
          background: isMatched ? 'rgba(34, 197, 94, 0.08)' : 'rgba(255, 255, 255, 0.04)',
          border: `1px solid ${isMatched ? 'rgba(34, 197, 94, 0.28)' : 'rgba(255, 255, 255, 0.08)'}`,
        }}
        title={authorTooltip}
      >
        {log.authorAvatarUrl ? (
          <img
            src={log.authorAvatarUrl}
            alt=""
            className="h-4 w-4 rounded-full"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ) : (
          <span
            className="h-4 w-4 rounded-full inline-flex items-center justify-center text-[9px] font-semibold"
            style={{
              background: 'rgba(99, 102, 241, 0.18)',
              color: '#c7d2fe',
            }}
          >
            {avatarLetter}
          </span>
        )}
        {primaryAuthorLabel}
        {isMatched && <UserCheck size={11} style={{ flexShrink: 0 }} />}
        {coAuthors.map((co) => (
          <span
            key={co.name}
            className="inline-flex items-center gap-0.5"
            style={{ color: co.matchedDisplayName ? '#86efac' : 'var(--text-muted)' }}
          >
            <span style={{ opacity: 0.55 }}>+</span>
            {co.matchedDisplayName ?? co.name}
            {co.matchedDisplayName && <UserCheck size={10} style={{ flexShrink: 0 }} />}
          </span>
        ))}
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
        {relativeTime || formatDisplayDate('', log.commitTimeUtc)}
      </div>
      <ExternalLink size={13} style={{ color: 'var(--text-muted)', opacity: 0.65, flexShrink: 0 }} />
    </motion.a>
  );
}
