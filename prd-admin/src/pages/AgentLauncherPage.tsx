import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Sparkles,
  Loader2,
  ArrowRight,
  ChevronDown,
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
import { motion, useMotionValue, useSpring, useTransform, AnimatePresence } from 'motion/react';
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

// ── Animated Quick Link Card (with glow + tilt) ──

const QUICK_LINKS = [
  { icon: Store, label: '海鲜市场', desc: '发现和 Fork 优质提示词与配置', path: '/marketplace', accent: '#F59E0B', gradient: 'linear-gradient(135deg, #F59E0B, #F97316)' },
  { icon: GraduationCap, label: '使用教程', desc: '从入门到进阶的操作指南', path: '/tutorials', accent: '#3B82F6', gradient: 'linear-gradient(135deg, #3B82F6, #6366F1)' },
  { icon: ClipboardList, label: '缺陷管理', desc: '快速提交和跟踪缺陷报告', path: '/defect', accent: '#F43F5E', gradient: 'linear-gradient(135deg, #F43F5E, #A855F7)' },
] as const;

function QuickLinkCard({ link, onClick }: { link: typeof QUICK_LINKS[number]; onClick: () => void }) {
  const mouseX = useMotionValue(0.5);
  const mouseY = useMotionValue(0.5);

  const rotateX = useSpring(useTransform(mouseY, [0, 1], [6, -6]), { stiffness: 300, damping: 30 });
  const rotateY = useSpring(useTransform(mouseX, [0, 1], [-6, 6]), { stiffness: 300, damping: 30 });
  const glowX = useTransform(mouseX, (v) => `${v * 100}%`);
  const glowY = useTransform(mouseY, (v) => `${v * 100}%`);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mouseX.set((e.clientX - rect.left) / rect.width);
    mouseY.set((e.clientY - rect.top) / rect.height);
  }, [mouseX, mouseY]);

  const handleMouseLeave = useCallback(() => {
    mouseX.set(0.5);
    mouseY.set(0.5);
  }, [mouseX, mouseY]);

  const Icon = link.icon;

  return (
    <motion.button
      type="button"
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="group relative text-left rounded-2xl overflow-hidden cursor-pointer"
      style={{
        rotateX,
        rotateY,
        transformPerspective: 800,
        height: 140,
      }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      {/* Animated glow that follows cursor */}
      <motion.div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
        style={{
          background: useTransform(
            [glowX, glowY],
            ([x, y]) => `radial-gradient(circle 120px at ${x} ${y}, ${link.accent}40 0%, transparent 70%)`
          ),
        }}
      />

      {/* Background with subtle gradient */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse at 80% 20%, ${link.accent}12 0%, transparent 50%),
            var(--bg-elevated, rgba(255,255,255,0.03))
          `,
          border: `1px solid ${link.accent}20`,
          borderRadius: 16,
        }}
      />

      {/* Animated border glow on hover */}
      <div
        className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{
          boxShadow: `inset 0 0 0 1px ${link.accent}40, 0 4px 24px ${link.accent}15`,
        }}
      />

      {/* Content */}
      <div className="relative z-10 h-full flex flex-col justify-between p-5">
        <div className="flex items-start justify-between">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110"
            style={{
              background: `linear-gradient(135deg, ${link.accent}25, ${link.accent}10)`,
              border: `1px solid ${link.accent}30`,
              boxShadow: `0 0 0 0 ${link.accent}00`,
            }}
          >
            <Icon size={22} style={{ color: link.accent }} />
          </div>
          <ArrowRight
            size={16}
            className="mt-1 opacity-0 group-hover:opacity-70 transition-all duration-300 group-hover:translate-x-1"
            style={{ color: link.accent }}
          />
        </div>
        <div>
          <div className="text-[14px] font-semibold mb-1" style={{ color: 'var(--text-primary, #fff)' }}>
            {link.label}
          </div>
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted, rgba(255,255,255,0.45))' }}>
            {link.desc}
          </div>
        </div>
      </div>

      {/* Bottom accent line */}
      <div
        className="absolute bottom-0 left-0 right-0 h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ background: link.gradient }}
      />
    </motion.button>
  );
}

// ── Featured Agent Card (large, with cover image) ──

function FeaturedCard({ item, onClick }: { item: ToolboxItem; onClick: () => void }) {
  const accent = getAccent(item.icon);
  const coverUrl = getCoverUrl(item.agentKey);
  const [coverFailed, setCoverFailed] = useState(false);
  const Icon = getIcon(item.icon);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative w-full text-left rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-1"
      style={{
        background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
        border: '1px solid rgba(255,255,255,0.06)',
        height: 200,
      }}
    >
      {/* Cover image or gradient background */}
      {coverUrl && !coverFailed ? (
        <img
          src={coverUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          draggable={false}
          onError={() => setCoverFailed(true)}
        />
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

const AUTO_GRID_QUICK: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
};

// ── Compact Quick Link Pill (collapsed state) ──

function QuickLinkPill({ link, onClick }: { link: typeof QUICK_LINKS[number]; onClick: () => void }) {
  const Icon = link.icon;
  return (
    <motion.button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-2 px-3.5 py-2 rounded-lg transition-colors duration-150 cursor-pointer"
      style={{
        background: `${link.accent}10`,
        border: `1px solid ${link.accent}18`,
      }}
      whileHover={{ scale: 1.04, backgroundColor: `${link.accent}20` }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      <Icon size={15} style={{ color: link.accent }} />
      <span className="text-[12px] font-medium whitespace-nowrap" style={{ color: 'var(--text-primary, #fff)' }}>
        {link.label}
      </span>
      <ArrowRight
        size={12}
        className="opacity-0 group-hover:opacity-60 transition-opacity duration-150 -ml-0.5"
        style={{ color: link.accent }}
      />
    </motion.button>
  );
}

// ── Main Page ──

export default function AgentLauncherPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [quickLinksExpanded, setQuickLinksExpanded] = useState(false);
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

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ background: 'var(--bg-base)' }}>
      <div className="flex-1 min-h-0 overflow-auto">
        <div className={isMobile ? 'px-4 pt-6 pb-8' : 'px-8 pt-8 pb-12'}>
          {/* ── Hero: greeting left + quick links right ── */}
          <div className={`flex ${isMobile ? 'flex-col gap-4 mb-5' : 'items-end justify-between gap-8 mb-8'}`}>
            {/* Left: greeting */}
            <div className="shrink-0">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles size={16} style={{ color: 'var(--accent-primary, #818CF8)' }} />
                <span
                  className="text-xs font-medium tracking-wide uppercase"
                  style={{ color: 'var(--text-muted, rgba(255,255,255,0.4))' }}
                >
                  AI Agent Platform
                </span>
              </div>
              <h1
                className={`font-semibold tracking-tight ${isMobile ? 'text-xl' : 'text-[28px]'}`}
                style={{ color: 'var(--text-primary, #fff)' }}
              >
                {greeting}
                {displayName ? `，${displayName}` : ''}
              </h1>
              <p
                className="mt-1.5 text-sm"
                style={{ color: 'var(--text-muted, rgba(255,255,255,0.45))' }}
              >
                选择一个智能助手，开始你的创作
              </p>
            </div>

            {/* Right: quick link pills (collapsed) */}
            {!searchQuery.trim() && !isMobile && (
              <div className="flex items-center gap-2 shrink-0 pb-1">
                {QUICK_LINKS.map((link) => (
                  <QuickLinkPill key={link.path} link={link} onClick={() => navigate(link.path)} />
                ))}
                <button
                  type="button"
                  onClick={() => setQuickLinksExpanded((v) => !v)}
                  className="ml-1 w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-150"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                  title={quickLinksExpanded ? '收起' : '展开'}
                >
                  <ChevronDown
                    size={14}
                    className="transition-transform duration-200"
                    style={{
                      color: 'var(--text-muted, rgba(255,255,255,0.4))',
                      transform: quickLinksExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    }}
                  />
                </button>
              </div>
            )}
          </div>

          {/* Mobile: quick link pills inline */}
          {!searchQuery.trim() && isMobile && (
            <div className="flex items-center gap-2 flex-wrap mb-4">
              {QUICK_LINKS.map((link) => (
                <QuickLinkPill key={link.path} link={link} onClick={() => navigate(link.path)} />
              ))}
              <button
                type="button"
                onClick={() => setQuickLinksExpanded((v) => !v)}
                className="w-7 h-7 rounded-lg flex items-center justify-center"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <ChevronDown
                  size={14}
                  style={{
                    color: 'var(--text-muted)',
                    transform: quickLinksExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s',
                  }}
                />
              </button>
            </div>
          )}

          {/* ── Quick Links expanded (animated cards) ── */}
          <AnimatePresence>
            {!searchQuery.trim() && quickLinksExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                className="overflow-hidden"
              >
                <div className={isMobile ? 'mb-5' : 'mb-8'} style={AUTO_GRID_QUICK}>
                  {QUICK_LINKS.map((link) => (
                    <QuickLinkCard key={link.path} link={link} onClick={() => navigate(link.path)} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Search ── */}
          <div className={`relative ${isMobile ? 'mb-5' : 'mb-8'}`} style={{ maxWidth: 480 }}>
            <Search
              size={16}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--text-muted, rgba(255,255,255,0.3))' }}
            />
            <input
              type="text"
              placeholder="搜索 Agent..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-10 pl-10 pr-4 rounded-xl text-[13px] outline-none transition-colors duration-150"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'var(--text-primary, #fff)',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent-primary, #818CF8)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
              }}
            />
          </div>

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
