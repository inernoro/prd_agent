import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Loader2,
  ArrowRight,
  FileText,
  Palette,
  PenTool,
  Bug,
  Video,
  Swords,
  FileBarChart,
  Code2,
  Languages,
  FileSearch,
  BarChart3,
  Bot,
  Store,
  GraduationCap,
  ClipboardList,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useToolboxStore } from '@/stores/toolboxStore';
import { useAuthStore } from '@/stores/authStore';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { ToolboxItem } from '@/services';

// ── Icon & Color mapping (self-contained, doesn't touch ToolCard) ──

const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Video, Swords, FileBarChart, Code2, Languages, FileSearch, BarChart3, Bot, Workflow, Zap,
};

/** Agent 封面图 CDN 路径 */
const AGENT_COVERS: Record<string, string> = {
  'prd-agent': 'icon/backups/agent/prd-agent.png',
  'visual-agent': 'icon/backups/agent/visual-agent.png',
  'literary-agent': 'icon/backups/agent/literary-agent.png',
  'defect-agent': 'icon/backups/agent/defect-agent.png',
  'video-agent': 'icon/backups/agent/video-agent.png',
  'report-agent': 'icon/backups/agent/report-agent.png',
  'arena': 'icon/backups/agent/arena.png',
  'shortcuts-agent': 'icon/backups/agent/shortcuts-agent.png',
  'workflow-agent': 'icon/backups/agent/workflow-agent.png',
};

/** Agent 封面视频 CDN 路径 */
const AGENT_VIDEOS: Record<string, string> = {
  'prd-agent': 'icon/backups/agent/prd-agent.mp4',
  'visual-agent': 'icon/backups/agent/visual-agent.mp4',
  'literary-agent': 'icon/backups/agent/literary-agent.mp4',
  'defect-agent': 'icon/backups/agent/defect-agent.mp4',
  'video-agent': 'icon/backups/agent/video-agent.mp4',
  'report-agent': 'icon/backups/agent/report-agent.mp4',
  'arena': 'icon/backups/agent/arena.mp4',
  'shortcuts-agent': 'icon/backups/agent/shortcuts-agent.mp4',
  'workflow-agent': 'icon/backups/agent/workflow-agent.mp4',
};

/** 每个图标对应的主题色 */
const ACCENT: Record<string, { from: string; to: string }> = {
  FileText:  { from: '#3B82F6', to: '#60A5FA' },
  Palette:   { from: '#A855F7', to: '#C084FC' },
  PenTool:   { from: '#10B981', to: '#34D399' },
  Bug:       { from: '#F97316', to: '#FB923C' },
  Video:     { from: '#F43F5E', to: '#FB7185' },
  Swords:    { from: '#F59E0B', to: '#FBBF24' },
  Code2:     { from: '#10B981', to: '#6EE7B7' },
  Languages: { from: '#06B6D4', to: '#67E8F9' },
  FileSearch:{ from: '#EAB308', to: '#FDE68A' },
  BarChart3: { from: '#8B5CF6', to: '#C4B5FD' },
  Bot:       { from: '#6366F1', to: '#A5B4FC' },
  FileBarChart: { from: '#6366F1', to: '#818CF8' },
  Workflow:  { from: '#14B8A6', to: '#5EEAD4' },
  Zap:       { from: '#F59E0B', to: '#FCD34D' },
};

function getAccent(icon: string) {
  return ACCENT[icon] ?? { from: '#6366F1', to: '#A5B4FC' };
}

function getCoverUrl(agentKey?: string): string | null {
  if (!agentKey) return null;
  const path = AGENT_COVERS[agentKey];
  if (!path) return null;
  const base = (useAuthStore.getState().cdnBaseUrl ?? '').replace(/\/+$/, '');
  return base ? `${base}/${path}` : `/${path}`;
}

function getVideoUrl(agentKey?: string): string | null {
  if (!agentKey) return null;
  const path = AGENT_VIDEOS[agentKey];
  if (!path) return null;
  const base = (useAuthStore.getState().cdnBaseUrl ?? '').replace(/\/+$/, '');
  return base ? `${base}/${path}` : `/${path}`;
}

function getHeroBgUrl(): string {
  const base = (useAuthStore.getState().cdnBaseUrl ?? '').replace(/\/+$/, '');
  const path = 'icon/title/home.png';
  return base ? `${base}/${path}` : `/${path}`;
}

function getIcon(name: string): LucideIcon {
  return ICON_MAP[name] || Bot;
}

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

const QUICK_LINKS = [
  { icon: Store, label: '海鲜市场', desc: '发现和 Fork 优质提示词与配置', path: '/marketplace', accent: '#F59E0B', gradient: 'linear-gradient(135deg, #F59E0B, #F97316)' },
  { icon: GraduationCap, label: '使用教程', desc: '从入门到进阶的操作指南', path: '/tutorials', accent: '#3B82F6', gradient: 'linear-gradient(135deg, #3B82F6, #6366F1)' },
  { icon: ClipboardList, label: '缺陷管理', desc: '快速提交和跟踪缺陷报告', path: '/defect', accent: '#F43F5E', gradient: 'linear-gradient(135deg, #F43F5E, #A855F7)' },
] as const;

// ── Featured Agent Card (large, with cover image) ──

function FeaturedCard({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = getAccent(item.icon);
  const coverUrl = getCoverUrl(item.agentKey);
  const videoUrl = getVideoUrl(item.agentKey);
  const [coverFailed, setCoverFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [hovering, setHovering] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const Icon = getIcon(item.icon);

  const handleMouseEnter = () => {
    setHovering(true);
    if (videoRef.current && videoReady) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  };

  const handleMouseLeave = () => {
    setHovering(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="group relative w-full text-left rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-1"
      style={{
        background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
        border: '1px solid rgba(255,255,255,0.06)',
        height: 200,
      }}
    >
      {/* Cover image or gradient background */}
      {coverUrl && !coverFailed ? (
        <>
          <img
            src={coverUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            draggable={false}
            onError={() => setCoverFailed(true)}
          />
          {videoUrl && (
            <video
              ref={videoRef}
              src={videoUrl}
              muted
              loop
              playsInline
              preload="metadata"
              onCanPlayThrough={() => setVideoReady(true)}
              className="absolute inset-0 w-full h-full object-cover transition-opacity duration-500"
              style={{ opacity: hovering && videoReady ? 1 : 0 }}
            />
          )}
        </>
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(ellipse at 70% 20%, ${accent.from}18 0%, transparent 60%),
              radial-gradient(ellipse at 20% 80%, ${accent.from}10 0%, transparent 50%)
            `,
          }}
        />
      )}

      {/* Bottom gradient overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,0.7) 70%, rgba(0,0,0,0.9) 100%)',
        }}
      />

      {/* Hover border glow */}
      <div
        className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
        style={{ boxShadow: `inset 0 0 0 1px ${accent.from}40, 0 0 20px ${accent.from}10` }}
      />

      {/* Content */}
      <div className="absolute bottom-0 left-0 right-0 p-5 z-10">
        <div className="flex items-start gap-3">
          <div
            className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center"
            style={{
              background: `linear-gradient(135deg, ${accent.from}30, ${accent.from}10)`,
              border: `1px solid ${accent.from}30`,
            }}
          >
            <Icon size={20} style={{ color: accent.to }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3
                className="text-[15px] font-semibold truncate"
                style={{ color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,0.5)' }}
              >
                {item.name}
              </h3>
              <ArrowRight
                size={14}
                className="shrink-0 opacity-0 group-hover:opacity-80 transition-all duration-200 group-hover:translate-x-0.5"
                style={{ color: accent.to }}
              />
            </div>
            <p
              className="text-[12px] leading-relaxed mt-1 line-clamp-2"
              style={{ color: 'rgba(255,255,255,0.55)' }}
            >
              {item.description}
            </p>
            {item.tags.length > 0 && (
              <div className="flex gap-1.5 mt-2.5">
                {item.tags.slice(0, 3).map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-2 py-0.5 rounded-md"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      color: 'rgba(255,255,255,0.5)',
                      border: '1px solid rgba(255,255,255,0.04)',
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

// ── Compact Agent Card (smaller, for utility agents) ──

function CompactCard({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = getAccent(item.icon);
  const Icon = getIcon(item.icon);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative w-full text-left rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5 flex items-center gap-3.5 px-4 py-3.5"
      style={{
        background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {/* Hover glow */}
      <div
        className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
        style={{ boxShadow: `inset 0 0 0 1px ${accent.from}30` }}
      />

      <div
        className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
        style={{
          background: `linear-gradient(135deg, ${accent.from}20, ${accent.from}08)`,
          border: `1px solid ${accent.from}20`,
        }}
      >
        <Icon size={18} style={{ color: accent.to }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary, #fff)' }}>
          {item.name}
        </div>
        <div
          className="text-[11px] truncate mt-0.5"
          style={{ color: 'var(--text-muted, rgba(255,255,255,0.4))' }}
        >
          {item.description}
        </div>
      </div>
      <ArrowRight
        size={14}
        className="shrink-0 opacity-0 group-hover:opacity-60 transition-all duration-200 group-hover:translate-x-0.5"
        style={{ color: 'var(--text-muted)' }}
      />
    </button>
  );
}

// ── Auto-fill grid style helper ──

const AUTO_GRID_FEATURED: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
};

const AUTO_GRID_COMPACT: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
};

// ── Main Page ──

export default function AgentLauncherPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const { items, itemsLoading, loadItems } = useToolboxStore();
  const { isMobile } = useBreakpoint();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // Split into featured (customized agents with routePath) and compact (utility agents)
  const { featured, utilities, filtered } = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      const matched = items.filter(
        (item) =>
          item.name.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query) ||
          item.tags.some((tag) => tag.toLowerCase().includes(query))
      );
      return { featured: [], utilities: [], filtered: matched };
    }
    const feat: ToolboxItem[] = [];
    const util: ToolboxItem[] = [];
    for (const item of items) {
      if (item.routePath) feat.push(item);
      else util.push(item);
    }
    return { featured: feat, utilities: util, filtered: [] };
  }, [items, searchQuery]);

  const handleClick = (item: ToolboxItem) => {
    if (item.routePath) {
      navigate(item.routePath);
    } else {
      // Navigate to toolbox and select this item
      useToolboxStore.getState().selectItem(item);
      navigate('/ai-toolbox');
    }
  };

  const greeting = getGreeting();
  const displayName = user?.displayName || '';

  const heroBgUrl = useMemo(() => getHeroBgUrl(), []);

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ background: 'var(--bg-base)' }}>
      <div className="flex-1 min-h-0 overflow-auto">

          {/* ── Hero banner with background image — full width ── */}
          <div
            className="relative overflow-hidden"
            style={{
              marginBottom: 0,
            }}
          >
            {/* Background image — positioned right, like 文心 reference */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `url(${heroBgUrl})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center top',
                backgroundRepeat: 'no-repeat',
                opacity: 0.85,
              }}
            />
            {/* Left fade overlay — text readability */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: isMobile
                  ? 'linear-gradient(180deg, var(--bg-base) 0%, rgba(20,20,24,0.85) 40%, rgba(20,20,24,0.5) 100%)'
                  : 'linear-gradient(90deg, var(--bg-base) 0%, var(--bg-base) 30%, rgba(20,20,24,0.7) 55%, rgba(20,20,24,0.15) 80%, transparent 100%)',
              }}
            />
            {/* Bottom fade — blend with page */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: 'linear-gradient(180deg, transparent 50%, var(--bg-base) 100%)',
              }}
            />

            {/* Hero content */}
            <div className={`relative z-10 ${isMobile ? 'px-5 pt-8 pb-6' : 'px-8 pt-10 pb-8'}`}>
              <div className={`flex ${isMobile ? 'flex-col gap-4' : 'items-start justify-between gap-8'}`}>
                <div className="shrink-0">
                  <h1
                    className={`font-semibold tracking-tight ${isMobile ? 'text-xl' : 'text-[26px]'}`}
                    style={{ color: 'var(--text-primary, #fff)', textShadow: '0 1px 8px rgba(0,0,0,0.3)' }}
                  >
                    {greeting}
                    {displayName ? `，${displayName}` : ''}
                  </h1>
                  <p
                    className="mt-1 text-sm"
                    style={{ color: 'var(--text-muted, rgba(255,255,255,0.55))', textShadow: '0 1px 4px rgba(0,0,0,0.2)' }}
                  >
                    选择一个智能助手，开始你的创作
                  </p>
                </div>

                {/* Search (top-right) */}
                <div className="relative shrink-0" style={{ width: isMobile ? '100%' : 260 }}>
                  <Search
                    size={15}
                    className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }}
                  />
                  <input
                    type="text"
                    placeholder="搜索 Agent..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full h-9 pl-9 pr-4 rounded-lg text-[13px] outline-none transition-colors duration-150"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: 'var(--text-primary, #fff)',
                      backdropFilter: 'blur(12px)',
                      WebkitBackdropFilter: 'blur(12px)',
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = 'var(--accent-primary, #818CF8)';
                      e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                      e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                    }}
                  />
                </div>
              </div>
            </div>
            {/* end hero content */}
          </div>
          {/* end hero banner */}

        <div className={isMobile ? 'px-4 pt-4 pb-8' : 'px-8 pt-5 pb-12'}>
          {/* ── Quick Links — outside hero, same width as card grid ── */}
          {!searchQuery.trim() && (
            <div
              className="rounded-xl"
              style={{
                marginBottom: isMobile ? 16 : 24,
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              <div
                className={`flex items-stretch ${isMobile ? 'flex-col' : ''}`}
                style={{ minHeight: isMobile ? undefined : 80 }}
              >
                {QUICK_LINKS.map((link, i) => {
                  const Icon = link.icon;
                  return (
                    <button
                      key={link.path}
                      type="button"
                      onClick={() => navigate(link.path)}
                      className={`group flex-1 flex items-center gap-4 transition-colors duration-200 hover:bg-white/[0.03] ${
                        isMobile ? 'px-5 py-4' : 'px-6 py-5'
                      }`}
                      style={{
                        borderRight: !isMobile && i < QUICK_LINKS.length - 1
                          ? '1px solid rgba(255,255,255,0.06)'
                          : undefined,
                        borderBottom: isMobile && i < QUICK_LINKS.length - 1
                          ? '1px solid rgba(255,255,255,0.06)'
                          : undefined,
                        borderRadius: isMobile
                          ? (i === 0 ? '12px 12px 0 0' : i === QUICK_LINKS.length - 1 ? '0 0 12px 12px' : '0')
                          : (i === 0 ? '12px 0 0 12px' : i === QUICK_LINKS.length - 1 ? '0 12px 12px 0' : '0'),
                      }}
                    >
                      <div
                        className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-transform duration-200 group-hover:scale-105"
                        style={{
                          background: `${link.accent}12`,
                          border: `1px solid ${link.accent}20`,
                        }}
                      >
                        <Icon size={20} style={{ color: link.accent }} />
                      </div>
                      <div className="text-left min-w-0">
                        <div
                          className="text-[13px] font-medium"
                          style={{ color: 'var(--text-primary, #fff)' }}
                        >
                          {link.label}
                        </div>
                        <div
                          className="text-[11px] mt-0.5 truncate"
                          style={{ color: 'var(--text-muted, rgba(255,255,255,0.4))' }}
                        >
                          {link.desc}
                        </div>
                      </div>
                      <ArrowRight
                        size={14}
                        className="shrink-0 ml-auto opacity-0 group-hover:opacity-50 transition-all duration-200 group-hover:translate-x-0.5"
                        style={{ color: 'var(--text-muted)' }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Loading ── */}
          {itemsLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2
                size={24}
                className="animate-spin"
                style={{ color: 'var(--accent-primary)' }}
              />
            </div>
          ) : searchQuery.trim() ? (
            /* ── Search results ── */
            filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 gap-2">
                <Search size={24} style={{ color: 'var(--text-muted, rgba(255,255,255,0.2))' }} />
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  没有找到匹配的 Agent
                </span>
              </div>
            ) : (
              <div style={AUTO_GRID_FEATURED}>
                {filtered.map((item) =>
                  item.routePath ? (
                    <FeaturedCard key={item.id} item={item} onClick={() => handleClick(item)} />
                  ) : (
                    <CompactCard key={item.id} item={item} onClick={() => handleClick(item)} />
                  )
                )}
              </div>
            )
          ) : (
            /* ── Default layout: featured + utilities ── */
            <>
              {/* Featured Agents */}
              {featured.length > 0 && (
                <section className={isMobile ? 'mb-6' : 'mb-8'}>
                  <div
                    className="text-[11px] font-medium tracking-widest uppercase mb-3"
                    style={{ color: 'var(--text-muted, rgba(255,255,255,0.35))' }}
                  >
                    智能助手
                  </div>
                  <div style={AUTO_GRID_FEATURED}>
                    {featured.map((item) => (
                      <FeaturedCard key={item.id} item={item} onClick={() => handleClick(item)} />
                    ))}
                  </div>
                </section>
              )}

              {/* Utility Agents */}
              {utilities.length > 0 && (
                <section>
                  <div
                    className="text-[11px] font-medium tracking-widest uppercase mb-3"
                    style={{ color: 'var(--text-muted, rgba(255,255,255,0.35))' }}
                  >
                    实用工具
                  </div>
                  <div style={AUTO_GRID_COMPACT}>
                    {utilities.map((item) => (
                      <CompactCard key={item.id} item={item} onClick={() => handleClick(item)} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
