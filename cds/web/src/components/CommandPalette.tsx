import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CornerDownLeft,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Loader2,
  Network,
  Search,
  Settings,
} from 'lucide-react';

import { apiRequest } from '@/lib/api';
import {
  PROJECT_SETTINGS_INDEX,
  PROJECT_TAB_LABELS,
  SYSTEM_SETTINGS_INDEX,
  SYSTEM_TAB_LABELS,
} from '@/lib/settingsSearchIndex';

/*
 * CommandPalette — global Cmd/Ctrl+K palette（苹果聚焦式全局搜索）。
 *
 * Search across projects + tracked branches + 字段级设置/配置；pick a row to
 * navigate. This is the "convenience layer" Railway / Linear users expect: any
 * resource — 包括藏在某个设置 tab 里的某个配置项 —— is one keystroke + a few
 * characters away.
 *
 * Open: Cmd/Ctrl + K, or programmatic via the dispatch hook in AppShell.
 * Close: Esc, click backdrop, pick a result.
 *
 * Data sources:
 *   GET /api/projects         — list of projects
 *   GET /api/branches?project — branches per project (lazy-loaded after open)
 *   settingsSearchIndex.ts    — 系统级 + 项目级字段配置静态索引（带同义词），
 *                               让「保活/探活/240/镜像加速」等口语词都能命中
 */

interface ProjectRow {
  id: string;
  name?: string;
  aliasName?: string;
  slug?: string;
  branchCount?: number;
}

interface BranchRow {
  id: string;
  projectId: string;
  branch: string;
  status?: string;
  isFavorite?: boolean;
}

interface PaletteData {
  projects: ProjectRow[];
  branches: BranchRow[];
}

interface ResultItem {
  key: string;
  type: 'project' | 'branch' | 'action' | 'setting';
  label: string;
  hint?: string;
  href?: string;
  icon: 'project' | 'branch' | 'settings' | 'topology';
  /**
   * 面包屑路径，告诉用户这条结果在哪（如「CDS 系统设置 / 调度器」、
   * 「prd-agent / 项目设置 / 项目配置」、分支的「prd-agent」）。带路径是为了
   * 让用户搜一次就记住它的位置。用 ' / ' 分段，与全局 Crumb 一致。
   */
  path?: string;
  /** 额外的同义词集合，参与模糊匹配但不展示（来自 settingsSearchIndex） */
  keywords?: string[];
}

const PATH_SEP = ' / ';

function projectDisplay(project: ProjectRow): string {
  return project.aliasName || project.name || project.slug || project.id;
}

function projectsToRows(projects: ProjectRow[]): ResultItem[] {
  return projects.map((project) => ({
    key: `project:${project.id}`,
    type: 'project' as const,
    label: projectDisplay(project),
    path: 'CDS',
    hint: project.branchCount != null ? `${project.branchCount} 分支` : '项目',
    href: `/branches/${encodeURIComponent(project.id)}`,
    icon: 'project' as const,
  }));
}

function branchesToRows(branches: BranchRow[], projectsById: Map<string, ProjectRow>): ResultItem[] {
  return branches.map((branch) => {
    const project = projectsById.get(branch.projectId);
    const projectLabel = project ? projectDisplay(project) : branch.projectId;
    const status = `${branch.status || ''}${branch.isFavorite ? ' · 收藏' : ''}`.trim();
    return {
      key: `branch:${branch.id}`,
      type: 'branch' as const,
      label: branch.branch,
      // 分支结果带上所属项目作路径，用户一眼知道这条分支归哪个项目（也好记）。
      path: projectLabel,
      hint: status || undefined,
      href: `/branch-panel/${encodeURIComponent(branch.id)}?project=${encodeURIComponent(branch.projectId)}`,
      icon: 'branch' as const,
    };
  });
}

// 系统级设置（/cds-settings#tab）→ ResultItem。每个 tab 内的字段级配置都登记
// 在 settingsSearchIndex 里，keywords 带丰富同义词，让「保活」「探活」「240」这类
// 用户脑子里的词也能命中 —— 这是「Cmd+K 能搜到所有配置」的关键。
function systemSettingsToRows(): ResultItem[] {
  return SYSTEM_SETTINGS_INDEX.map((entry) => ({
    key: `setting:${entry.id}`,
    type: 'setting' as const,
    label: entry.label,
    path: ['CDS 系统设置', SYSTEM_TAB_LABELS[entry.tab] || entry.tab].join(PATH_SEP),
    hint: entry.hint,
    href: `/cds-settings#${entry.tab}`,
    icon: 'settings' as const,
    keywords: entry.keywords,
  }));
}

// 项目级设置（/settings/<projectId>#tab）→ 对每个已加载项目展开一份，让用户
// 在面板里直接选「哪个项目的哪个配置」，落到精确深链。
function projectSettingsToRows(projects: ProjectRow[]): ResultItem[] {
  const rows: ResultItem[] = [];
  for (const project of projects) {
    const projectLabel = projectDisplay(project);
    for (const entry of PROJECT_SETTINGS_INDEX) {
      rows.push({
        key: `setting:${project.id}:${entry.id}`,
        type: 'setting',
        label: entry.label,
        // 项目级配置路径带上项目名：「prd-agent / 项目设置 / 项目配置」
        path: [projectLabel, '项目设置', PROJECT_TAB_LABELS[entry.tab] || entry.tab].join(PATH_SEP),
        hint: entry.hint,
        href: `/settings/${encodeURIComponent(project.id)}#${entry.tab}`,
        icon: 'settings',
        // 把项目名也并进 keywords，这样「prd-agent 探活」能一次命中到该项目
        keywords: [...entry.keywords, projectLabel, project.slug || '', project.name || ''].filter(Boolean),
      });
    }
  }
  return rows;
}

// 同义词参与匹配但不展示。给单条 entry 算匹配分。
// Codex P2「Tokenize combined project setting queries」：多词查询（如「prd-agent 探活」=
// 项目名 + 字段）原先把整串拿去跟单个 keyword 比，永远命不中。改为按空白分词：每个词都要
// 在某个 keyword 命中，整条分取各词最佳分的均值；任一词没命中则整条不匹配。单词时与原逻辑等价。
function keywordScore(keywords: string[] | undefined, trimmed: string): number {
  if (!keywords) return -1;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return -1;
  let total = 0;
  for (const token of tokens) {
    let bestForToken = -1;
    for (const word of keywords) {
      const idx = word.toLowerCase().indexOf(token);
      if (idx < 0) continue;
      const score = word.toLowerCase().startsWith(token) ? 70 - idx : 40 - idx;
      if (score > bestForToken) bestForToken = score;
    }
    if (bestForToken < 0) return -1;
    total += bestForToken;
  }
  return Math.round(total / tokens.length);
}

// 2026-05-07 wave 3.3:命令面板强化 — STATIC_ACTIONS 从 2 项扩到 12 项,
// 涵盖 CDS 系统设置各 tab 的快速跳转 + 维护操作。模糊匹配靠 input value 的
// 子串包含(已有逻辑),用户输入"集群"/"webhook"/"快照"等中文关键词都能命中。
const STATIC_ACTIONS: ResultItem[] = [
  { key: 'action:project-list',     type: 'action', label: '所有项目',           path: 'CDS',           hint: '回到项目控制台',                href: '/project-list',                  icon: 'project' },
  { key: 'action:cds-settings',     type: 'action', label: 'CDS 系统设置',       path: 'CDS',           hint: '存储 / 集群 / GitHub / 维护',    href: '/cds-settings',                  icon: 'settings' },
  { key: 'action:maintenance',      type: 'action', label: '更新与重启',         path: 'CDS 系统设置',  hint: 'self-update / 强制更新 / 历史',  href: '/cds-settings#maintenance',      icon: 'settings' },
  { key: 'action:webhook-log',      type: 'action', label: 'GitHub Webhook 日志', path: 'CDS 系统设置',  hint: '每次 hook 投递详情 + payload',   href: '/cds-settings#webhook-log',      icon: 'settings' },
  { key: 'action:cluster',          type: 'action', label: '集群',               path: 'CDS 系统设置',  hint: '节点列表 / 调度策略 / 加入退出',  href: '/cds-settings#cluster',          icon: 'settings' },
  { key: 'action:remote-hosts',     type: 'action', label: '远程主机',           path: 'CDS 系统设置',  hint: 'shared-service 部署目标',        href: '/cds-settings#remote-hosts',     icon: 'settings' },
  { key: 'action:connections',      type: 'action', label: '对接 MAP',           path: 'CDS 系统设置',  hint: '配对密钥 / 连接管理',            href: '/cds-settings#connections',      icon: 'settings' },
  { key: 'action:snapshots',        type: 'action', label: '配置快照',           path: 'CDS 系统设置',  hint: '备份 / 回滚配置到任意时间点',    href: '/cds-settings#snapshots',        icon: 'settings' },
  { key: 'action:storage',          type: 'action', label: '存储后端',           path: 'CDS 系统设置',  hint: 'JSON / Mongo / 切换',            href: '/cds-settings#storage',          icon: 'settings' },
  { key: 'action:global-vars',      type: 'action', label: 'CDS 全局变量',       path: 'CDS 系统设置',  hint: '所有项目共享的环境变量',         href: '/cds-settings#global-vars',      icon: 'settings' },
  { key: 'action:auth',             type: 'action', label: '登录与认证',         path: 'CDS 系统设置',  hint: 'GitHub OAuth / basic auth',      href: '/cds-settings#auth',             icon: 'settings' },
  { key: 'action:access-keys',      type: 'action', label: 'AI Access Key',     path: 'CDS 系统设置',  hint: 'AI 访问密钥签发与撤销',          href: '/cds-settings#access-keys',      icon: 'settings' },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const routerNavigate = useNavigate();
  const [query, setQuery] = useState('');
  const [data, setData] = useState<PaletteData>({ projects: [], branches: [] });
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const projectRes = await apiRequest<{ projects: ProjectRow[] }>('/api/projects');
      const projects = projectRes.projects || [];
      const branchLists = await Promise.all(
        projects.map((project) =>
          apiRequest<{ branches: BranchRow[] }>(`/api/branches?project=${encodeURIComponent(project.id)}&live=false`).catch(
            () => ({ branches: [] as BranchRow[] }),
          ),
        ),
      );
      const branches = branchLists.flatMap((res, idx) =>
        (res.branches || []).map((branch) => ({ ...branch, projectId: projects[idx].id })),
      );
      setData({ projects, branches });
    } catch {
      // ignored — palette is best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    void reload();
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  const projectsById = useMemo(() => new Map(data.projects.map((project) => [project.id, project])), [data.projects]);

  const results = useMemo<ResultItem[]>(() => {
    const trimmed = query.trim().toLowerCase();
    const projectRows = projectsToRows(data.projects);
    const branchRows = branchesToRows(data.branches, projectsById);
    const systemSettingRows = systemSettingsToRows();

    if (!trimmed) {
      const favoriteBranches = data.branches.filter((branch) => branch.isFavorite);
      return [
        ...STATIC_ACTIONS,
        ...projectRows.slice(0, 6),
        ...branchesToRows(favoriteBranches.slice(0, 6), projectsById),
      ];
    }

    const score = (text: string) => {
      const idx = text.toLowerCase().indexOf(trimmed);
      if (idx < 0) return -1;
      return text.toLowerCase().startsWith(trimmed) ? 100 - idx : 50 - idx;
    };

    // 项目级设置只在用户实际输入时展开（避免空态污染），keywords 已并入项目名。
    const projectSettingRows = projectSettingsToRows(data.projects);
    const merged = [
      ...projectRows,
      ...branchRows,
      ...STATIC_ACTIONS,
      ...systemSettingRows,
      ...projectSettingRows,
    ];
    return merged
      .map((item) => ({
        item,
        rank: Math.max(
          score(item.label),
          item.hint ? score(item.hint) - 10 : -1,
          // 同义词命中略低于正标题但高于 hint，保证「保活/探活」也能排到前面
          keywordScore(item.keywords, trimmed) - 5,
        ),
      }))
      .filter((entry) => entry.rank >= 0)
      .sort((left, right) => right.rank - left.rank)
      .slice(0, 18)
      .map((entry) => entry.item);
  }, [data.projects, data.branches, projectsById, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(Math.max(0, results.length - 1));
  }, [results, activeIdx]);

  const navigate = useCallback(
    (item: ResultItem) => {
      if (!item.href) return;
      onClose();
      const hashIdx = item.href.indexOf('#');
      const targetPath = hashIdx >= 0 ? item.href.slice(0, hashIdx) : item.href;
      const samePage = hashIdx >= 0 && window.location.pathname === targetPath;
      routerNavigate(item.href);
      // react-router 的 history.pushState 不会触发 hashchange，已在目标设置页时
      // 切 tab 全靠该页监听 hashchange。手动补一发，确保面板内深链能切到目标 tab。
      // Bugbot Medium「Same-page hash sync race」：不能在下一 tick 直接 dispatch 裸
      // hashchange —— 若 router 尚未把 hash 落到 window.location，监听会读到旧 hash、切错
      // tab。改为 rAF 后核对：hash 未到目标值就直接 set（原生触发 hashchange 且值正确），
      // 已到则补发合成事件。
      if (samePage) {
        const targetHash = item.href.slice(hashIdx); // 含 '#'
        requestAnimationFrame(() => {
          if (window.location.hash !== targetHash) {
            window.location.hash = targetHash;
          } else {
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          }
        });
      }
    },
    [onClose, routerNavigate],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIdx((current) => Math.min(results.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIdx((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = results[activeIdx];
      if (item) navigate(item);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
    >
      <button
        type="button"
        className="cds-overlay-anim absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="关闭命令面板"
      />
      <div
        className="cds-surface-raised cds-hairline relative z-10 mx-4 flex max-h-[72vh] w-full max-w-[560px] flex-col overflow-hidden shadow-2xl"
        style={{ animation: 'cds-overlay-fade-in 160ms ease-out' }}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-[hsl(var(--hairline))] px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索项目、分支、设置或配置（如 保活 / 探活 / 镜像）"
            className="h-12 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
          {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : null}
          <kbd className="hidden rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
            ESC
          </kbd>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1 pb-3">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {loading ? '加载中…' : '没有匹配项'}
            </div>
          ) : (
            results.map((item, idx) => (
              <button
                key={item.key}
                type="button"
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => navigate(item)}
                data-active={idx === activeIdx ? 'true' : 'false'}
                className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[hsl(var(--surface-sunken))] data-[active=true]:bg-[hsl(var(--surface-sunken))]"
              >
                <PaletteIcon kind={item.icon} />
                <span className="min-w-0 flex-1">
                  {item.path ? (
                    <span className="mb-0.5 block truncate text-[11px] text-muted-foreground/70">{item.path}</span>
                  ) : null}
                  <span className="block truncate text-sm font-medium">{item.label}</span>
                  {item.hint ? <span className="block truncate text-[11px] text-muted-foreground">{item.hint}</span> : null}
                </span>
                {idx === activeIdx ? (
                  <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                )}
              </button>
            ))
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40 px-4 py-2 text-[11px] text-muted-foreground">
          <span>↑↓ 选择 · Enter 跳转 · Esc 关闭</span>
          <span>{results.length} 项</span>
        </div>
      </div>
    </div>
  );
}

function PaletteIcon({ kind }: { kind: ResultItem['icon'] }): JSX.Element {
  const className = 'h-4 w-4 shrink-0 text-muted-foreground group-data-[active=true]:text-foreground';
  if (kind === 'project') return <FolderGit2 className={className} />;
  if (kind === 'branch') return <GitBranch className={className} />;
  if (kind === 'topology') return <Network className={className} />;
  if (kind === 'settings') return <Settings className={className} />;
  return <ExternalLink className={className} />;
}
