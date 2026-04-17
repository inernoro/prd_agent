import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchPublicProfile } from '@/services';
import type {
  PublicProfile,
  PublicSite,
  PublicSkill,
  PublicProfileDocumentStore,
  PublicLiteraryPrompt,
  PublicWorkspace,
  PublicEmergenceTree,
  PublicWorkflow,
} from '@/services';
import {
  Globe,
  Sparkles,
  FileText,
  Feather,
  Image as ImageIcon,
  Zap,
  Workflow as WorkflowIcon,
  ExternalLink,
  Eye,
  Download,
  Inbox,
  UserX,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { SitePreview } from '@/components/SitePreview';

function fmtDate(s: string | null | undefined) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type TabKey = 'sites' | 'skills' | 'documents' | 'prompts' | 'workspaces' | 'emergences' | 'workflows';

interface TabDef {
  key: TabKey;
  label: string;
  icon: LucideIcon;
}

const TAB_DEFS: TabDef[] = [
  { key: 'sites',       label: '网页',       icon: Globe },
  { key: 'skills',      label: '技能',       icon: Sparkles },
  { key: 'documents',   label: '文档',       icon: FileText },
  { key: 'prompts',     label: '文学提示词', icon: Feather },
  { key: 'workspaces',  label: '视觉创作',   icon: ImageIcon },
  { key: 'emergences',  label: '涌现',       icon: Zap },
  { key: 'workflows',   label: '工作流',     icon: WorkflowIcon },
];

export default function PublicProfilePage() {
  const { username } = useParams<{ username: string }>();
  const [data, setData] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('sites');

  useEffect(() => {
    let cancelled = false;
    if (!username) {
      setError('用户名无效');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetchPublicProfile(username)
      .then((res) => {
        if (cancelled) return;
        if (res.success) setData(res.data);
        else setError(res.error?.message || '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  const visibleTabs = useMemo(() => {
    if (!data) return TAB_DEFS;
    return TAB_DEFS.filter((t) => (data[t.key]?.total ?? 0) > 0);
  }, [data]);

  useEffect(() => {
    if (data && visibleTabs.length > 0 && !visibleTabs.find((t) => t.key === activeTab)) {
      setActiveTab(visibleTabs[0].key);
    }
  }, [data, visibleTabs, activeTab]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0b0f] text-white/70">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          <span>正在加载公开页…</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0b0f] text-white/70">
        <div className="flex flex-col items-center gap-3 text-center">
          <UserX size={48} strokeWidth={1.5} className="text-white/30" />
          <div className="text-lg font-medium text-white/85">用户不存在</div>
          <div className="text-sm text-white/50">{error || '找不到这个用户'}</div>
          <a
            href="/"
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:text-white hover:bg-white/10"
          >
            回到首页
          </a>
        </div>
      </div>
    );
  }

  const { user } = data;
  const totalPublic = TAB_DEFS.reduce((sum, t) => sum + (data[t.key]?.total ?? 0), 0);

  return (
    <div className="min-h-screen bg-[#0a0b0f] text-white">
      <div className="relative overflow-hidden border-b border-white/10">
        <div
          className="absolute inset-0 opacity-40"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 30% 0%, rgba(56,189,248,0.25) 0%, transparent 55%), radial-gradient(ellipse 60% 50% at 90% 20%, rgba(139,92,246,0.2) 0%, transparent 60%)',
          }}
        />
        <div className="relative mx-auto flex max-w-5xl items-center gap-5 px-6 py-10">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/30 to-violet-500/20 text-2xl font-bold text-white/90 ring-1 ring-white/15">
            {user.displayName?.[0]?.toUpperCase() || user.username[0]?.toUpperCase() || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm text-white/60">
              <Globe size={14} />
              <span>公开主页</span>
            </div>
            <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">
              {user.displayName}
            </h1>
            <div className="mt-1 text-sm text-white/50">@{user.username}</div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-white/50">
              <span className="inline-flex items-center gap-1">
                <Inbox size={12} />
                共 {totalPublic} 个公开资源
              </span>
              {visibleTabs.length > 0 && (
                <span className="inline-flex items-center gap-1 text-white/40">
                  · 分布在 {visibleTabs.length} 个领域
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {visibleTabs.length > 0 && (
        <div className="sticky top-0 z-10 border-b border-white/10 bg-[#0a0b0f]/85 backdrop-blur-xl">
          <div className="mx-auto flex max-w-5xl items-center gap-1 overflow-x-auto px-4 py-2 text-[13px]">
            {visibleTabs.map((t) => {
              const Icon = t.icon;
              const isActive = t.key === activeTab;
              const count = data[t.key]?.total ?? 0;
              return (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={[
                    'group inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 transition-all',
                    isActive
                      ? 'bg-white/10 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)]'
                      : 'text-white/55 hover:bg-white/5 hover:text-white/85',
                  ].join(' ')}
                >
                  <Icon size={14} />
                  <span>{t.label}</span>
                  <span
                    className={[
                      'inline-flex min-w-[18px] items-center justify-center rounded-full px-1 py-0.5 text-[10px] font-semibold',
                      isActive ? 'bg-sky-500/35 text-sky-50' : 'bg-white/10 text-white/60',
                    ].join(' ')}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mx-auto max-w-5xl px-6 py-8">
        {totalPublic === 0 ? (
          <EmptyState />
        ) : activeTab === 'sites' ? (
          <SitesGrid items={data.sites.items} />
        ) : activeTab === 'skills' ? (
          <SkillsGrid username={user.username} items={data.skills.items} />
        ) : activeTab === 'documents' ? (
          <DocumentsGrid items={data.documents.items} />
        ) : activeTab === 'prompts' ? (
          <PromptsGrid items={data.prompts.items} />
        ) : activeTab === 'workspaces' ? (
          <WorkspacesGrid items={data.workspaces.items} />
        ) : activeTab === 'emergences' ? (
          <EmergencesGrid items={data.emergences.items} />
        ) : (
          <WorkflowsGrid items={data.workflows.items} />
        )}
      </div>

      <div className="mx-auto max-w-5xl px-6 py-6 text-center text-[10px] text-white/30">
        由 PRD Agent · 拖资源到投放面板「公开」槽位即可发布到此页
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] py-20 text-center text-white/50">
      <Inbox size={48} strokeWidth={1.5} className="text-white/20" />
      <div className="text-base font-medium text-white/70">还没有公开资源</div>
      <div className="text-xs text-white/40">用户尚未公开任何内容</div>
    </div>
  );
}

function TagsList({ tags, max = 3 }: { tags: string[]; max?: number }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {tags.slice(0, max).map((t) => (
        <span key={t} className="rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] text-white/50">
          {t}
        </span>
      ))}
      {tags.length > max && <span className="text-[9px] text-white/30">+{tags.length - max}</span>}
    </div>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-auto flex items-center gap-3 pt-2 text-[10px] text-white/40">{children}</div>
  );
}

const GRID_CLS = 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]';

function SitesGrid({ items }: { items: PublicSite[] }) {
  return (
    <div className={GRID_CLS}>
      {items.map((s) => (
        <a
          key={s.id}
          href={s.siteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition-all hover:border-white/25 hover:bg-white/[0.06] hover:shadow-[0_0_24px_rgba(56,189,248,0.15)]"
        >
          <div className="relative overflow-hidden" style={{ aspectRatio: '16 / 9', background: '#0f1014' }}>
            {s.coverImageUrl ? (
              <img
                src={s.coverImageUrl}
                alt={s.title}
                className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
            ) : (
              <SitePreview url={s.siteUrl} className="h-full w-full" />
            )}
            <div className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] text-white/90 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
              <ExternalLink size={10} /> 访问
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-1 p-3">
            <h3 className="truncate text-sm font-medium text-white/90">{s.title}</h3>
            {s.description && (
              <p className="line-clamp-2 text-[11px] text-white/55">{s.description}</p>
            )}
            <Meta>
              <span className="inline-flex items-center gap-0.5">
                <Eye size={10} />
                {s.viewCount}
              </span>
              {s.publishedAt && <span>公开于 {fmtDate(s.publishedAt)}</span>}
            </Meta>
            <TagsList tags={s.tags} />
          </div>
        </a>
      ))}
    </div>
  );
}

function SkillsGrid({ username, items }: { username: string; items: PublicSkill[] }) {
  const download = (s: PublicSkill) => {
    const payload = {
      skillKey: s.skillKey,
      title: s.title,
      description: s.description,
      icon: s.icon,
      category: s.category,
      tags: s.tags,
      author: username,
      importHint: '通过 `/api/skills/:id/fork` 将此技能复制到你的技能库（需登录）',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${s.skillKey || s.id}.skill.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={GRID_CLS}>
      {items.map((s) => (
        <div
          key={s.id}
          className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-all hover:border-white/25 hover:bg-white/[0.06]"
        >
          <div className="mb-2 flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/30 to-fuchsia-500/20 text-xl ring-1 ring-white/10">
              {s.icon || '✨'}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-medium text-white/90">{s.title}</h3>
              <div className="truncate text-[10px] text-white/40">{s.category}</div>
            </div>
          </div>
          {s.description && (
            <p className="line-clamp-3 flex-1 text-[11px] text-white/60">{s.description}</p>
          )}
          <TagsList tags={s.tags} />
          <Meta>
            <span className="inline-flex items-center gap-0.5">
              <Sparkles size={10} />
              使用 {s.usageCount}
            </span>
            {s.publishedAt && <span>公开于 {fmtDate(s.publishedAt)}</span>}
            <button
              onClick={() => download(s)}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-violet-400/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-100 transition-all hover:bg-violet-500/20 hover:text-violet-50"
              title="下载技能描述文件（JSON）"
            >
              <Download size={10} /> 下载
            </button>
          </Meta>
        </div>
      ))}
    </div>
  );
}

function DocumentsGrid({ items }: { items: PublicProfileDocumentStore[] }) {
  return (
    <div className={GRID_CLS}>
      {items.map((d) => (
        <div
          key={d.id}
          className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition-all hover:border-white/25 hover:bg-white/[0.06]"
        >
          {d.coverImageUrl ? (
            <div
              className="relative overflow-hidden"
              style={{ aspectRatio: '16 / 9', background: '#0f1014' }}
            >
              <img
                src={d.coverImageUrl}
                alt={d.name}
                className="absolute inset-0 h-full w-full object-cover"
              />
            </div>
          ) : (
            <div className="flex h-28 items-center justify-center bg-gradient-to-br from-emerald-500/10 to-cyan-500/5">
              <FileText size={32} className="text-emerald-200/60" />
            </div>
          )}
          <div className="flex flex-1 flex-col gap-1 p-3">
            <h3 className="truncate text-sm font-medium text-white/90">{d.name}</h3>
            {d.description && (
              <p className="line-clamp-2 text-[11px] text-white/55">{d.description}</p>
            )}
            <TagsList tags={d.tags} />
            <Meta>
              <span className="inline-flex items-center gap-0.5">
                <FileText size={10} />
                {d.documentCount} 篇
              </span>
              <span className="inline-flex items-center gap-0.5">
                <Eye size={10} />
                {d.viewCount}
              </span>
            </Meta>
          </div>
        </div>
      ))}
    </div>
  );
}

function PromptsGrid({ items }: { items: PublicLiteraryPrompt[] }) {
  return (
    <div className={GRID_CLS}>
      {items.map((p) => (
        <div
          key={p.id}
          className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-all hover:border-white/25 hover:bg-white/[0.06]"
        >
          <div className="flex items-start gap-2">
            <Feather size={16} className="mt-0.5 shrink-0 text-amber-300/80" />
            <h3 className="line-clamp-2 text-sm font-medium text-white/90">{p.title}</h3>
          </div>
          <div className="mt-auto flex items-center gap-3 text-[10px] text-white/40">
            {p.scenarioType && (
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-200/80">
                {p.scenarioType}
              </span>
            )}
            <span>被 fork {p.forkCount} 次</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkspacesGrid({ items }: { items: PublicWorkspace[] }) {
  return (
    <div className={GRID_CLS}>
      {items.map((w) => (
        <div
          key={w.id}
          className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition-all hover:border-white/25 hover:bg-white/[0.06]"
        >
          <div className="flex aspect-[16/9] items-center justify-center bg-gradient-to-br from-rose-500/15 to-pink-500/5">
            <ImageIcon size={36} className="text-rose-200/60" />
          </div>
          <div className="flex flex-col gap-1 p-3">
            <h3 className="truncate text-sm font-medium text-white/90">{w.title}</h3>
            <div className="mt-auto pt-2 text-[10px] text-white/40">
              {w.publishedAt && <span>公开于 {fmtDate(w.publishedAt)}</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmergencesGrid({ items }: { items: PublicEmergenceTree[] }) {
  return (
    <div className={GRID_CLS}>
      {items.map((e) => (
        <div
          key={e.id}
          className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-all hover:border-white/25 hover:bg-white/[0.06]"
        >
          <div className="flex items-start gap-2">
            <Zap size={16} className="mt-0.5 shrink-0 text-indigo-300/80" />
            <h3 className="line-clamp-2 text-sm font-medium text-white/90">{e.title}</h3>
          </div>
          {e.description && (
            <p className="line-clamp-3 text-[11px] text-white/55">{e.description}</p>
          )}
          <div className="mt-auto flex items-center gap-3 text-[10px] text-white/40">
            <span>{e.nodeCount} 个节点</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkflowsGrid({ items }: { items: PublicWorkflow[] }) {
  return (
    <div className={GRID_CLS}>
      {items.map((w) => (
        <div
          key={w.id}
          className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-all hover:border-white/25 hover:bg-white/[0.06]"
        >
          <div className="flex items-start gap-2">
            {w.avatarUrl ? (
              <img
                src={w.avatarUrl}
                alt=""
                className="h-8 w-8 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
              />
            ) : (
              <WorkflowIcon size={16} className="mt-0.5 shrink-0 text-cyan-300/80" />
            )}
            <h3 className="line-clamp-2 text-sm font-medium text-white/90">{w.name}</h3>
          </div>
          {w.description && (
            <p className="line-clamp-2 text-[11px] text-white/55">{w.description}</p>
          )}
          <TagsList tags={w.tags} />
          <Meta>
            <span>运行 {w.executionCount} 次</span>
          </Meta>
        </div>
      ))}
    </div>
  );
}
