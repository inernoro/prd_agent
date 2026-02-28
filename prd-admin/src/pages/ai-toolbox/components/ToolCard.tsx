import type { ToolboxItem } from '@/services';
import { useToolboxStore } from '@/stores/toolboxStore';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import {
  ArrowUpRight,
  FileText,
  Palette,
  PenTool,
  Bug,
  Code2,
  Languages,
  FileSearch,
  BarChart3,
  Bot,
  Lightbulb,
  Target,
  Wrench,
  Sparkles,
  Rocket,
  MessageSquare,
  Zap,
  Brain,
  Cpu,
  Database,
  Globe,
  Image,
  Music,
  Video,
  BookOpen,
  GraduationCap,
  Briefcase,
  Heart,
  Star,
  Shield,
  Lock,
  Search,
  Layers,
  Swords,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface ToolCardProps {
  item: ToolboxItem;
}

// 图标组件映射
const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare, Zap,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers, Swords,
};

const ACCENT_PALETTE: Record<string, { from: string; soft: string }> = {
  FileText:     { from: '#3B82F6', soft: '#93C5FD' },
  Palette:      { from: '#A855F7', soft: '#D8B4FE' },
  PenTool:      { from: '#F59E0B', soft: '#FDE68A' },
  Bug:          { from: '#EF4444', soft: '#FCA5A5' },
  Code2:        { from: '#10B981', soft: '#6EE7B7' },
  Languages:    { from: '#06B6D4', soft: '#67E8F9' },
  FileSearch:   { from: '#EAB308', soft: '#FDE68A' },
  BarChart3:    { from: '#8B5CF6', soft: '#C4B5FD' },
  Bot:          { from: '#6366F1', soft: '#A5B4FC' },
  Lightbulb:    { from: '#F59E0B', soft: '#FDE68A' },
  Target:       { from: '#EF4444', soft: '#FCA5A5' },
  Wrench:       { from: '#78716C', soft: '#D6D3D1' },
  Sparkles:     { from: '#A855F7', soft: '#D8B4FE' },
  Rocket:       { from: '#3B82F6', soft: '#93C5FD' },
  MessageSquare:{ from: '#14B8A6', soft: '#5EEAD4' },
  Brain:        { from: '#D946EF', soft: '#F0ABFC' },
  Cpu:          { from: '#64748B', soft: '#94A3B8' },
  Database:     { from: '#0EA5E9', soft: '#7DD3FC' },
  Globe:        { from: '#22D3EE', soft: '#A5F3FC' },
  Image:        { from: '#EC4899', soft: '#F9A8D4' },
  Music:        { from: '#D946EF', soft: '#F0ABFC' },
  Video:        { from: '#F43F5E', soft: '#FDA4AF' },
  BookOpen:     { from: '#22C55E', soft: '#86EFAC' },
  GraduationCap:{ from: '#3B82F6', soft: '#93C5FD' },
  Briefcase:    { from: '#78716C', soft: '#A8A29E' },
  Heart:        { from: '#F43F5E', soft: '#FDA4AF' },
  Star:         { from: '#F59E0B', soft: '#FCD34D' },
  Shield:       { from: '#3B82F6', soft: '#93C5FD' },
  Lock:         { from: '#64748B', soft: '#94A3B8' },
  Search:       { from: '#14B8A6', soft: '#5EEAD4' },
  Layers:       { from: '#8B5CF6', soft: '#C4B5FD' },
  Swords:       { from: '#F97316', soft: '#FDBA74' },
};

/** Agent 封面图 CDN 路径映射 */
const AGENT_COVER_PATHS: Record<string, string> = {
  'prd-agent': 'icon/backups/agent/prd-agent.png',
  'visual-agent': 'icon/backups/agent/visual-agent.png',
  'literary-agent': 'icon/backups/agent/literary-agent.png',
  'defect-agent': 'icon/backups/agent/defect-agent.png',
};

function getCoverImageUrl(agentKey?: string): string | null {
  if (!agentKey) return null;
  const path = AGENT_COVER_PATHS[agentKey];
  if (!path) return null;
  const base = (useAuthStore.getState().cdnBaseUrl ?? '').replace(/\/+$/, '');
  return base ? `${base}/${path}` : `/${path}`;
}

function getIconComponent(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Bot;
}

function getPalette(iconName: string) {
  return ACCENT_PALETTE[iconName] ?? ACCENT_PALETTE.Bot;
}

export function ToolCard({ item }: ToolCardProps) {
  const { selectItem, toggleFavorite, isFavorite } = useToolboxStore();
  const navigate = useNavigate();
  const palette = getPalette(item.icon);
  const IconComponent = getIconComponent(item.icon);
  const isCustomized = !!item.routePath;
  const favorited = isFavorite(item.id);
  const coverUrl = getCoverImageUrl(item.agentKey);

  const handleClick = () => {
    if (isCustomized && item.routePath) {
      navigate(item.routePath);
    } else {
      selectItem(item);
    }
  };

  const handleToggleFavorite = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFavorite(item.id);
  };

  return (
    <div
      onClick={handleClick}
      className="group relative rounded-2xl overflow-hidden cursor-pointer transition-all duration-300 hover:-translate-y-1"
      style={{
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        aspectRatio: '3 / 4',
      }}
    >
      {/* Cover visual — CDN 图片 or 渐变 + 大图标 */}
      {coverUrl ? (
        <img
          src={coverUrl}
          alt={item.name}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.06]"
          draggable={false}
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(ellipse at 30% 20%, ${palette.from}30 0%, transparent 60%),
              radial-gradient(ellipse at 70% 80%, ${palette.from}20 0%, transparent 50%),
              linear-gradient(145deg, rgba(20, 22, 35, 0.98) 0%, rgba(12, 14, 22, 0.99) 100%)
            `,
          }}
        >
          {/* 大图标/emoji 作为视觉焦点 */}
          <div
            className="absolute inset-0 flex items-center justify-center transition-transform duration-500 ease-out group-hover:scale-[1.08]"
            style={{ paddingBottom: '30%' }}
          >
            {item.emoji ? (
              <span className="text-[56px] leading-none select-none opacity-90">{item.emoji}</span>
            ) : (
              <IconComponent
                size={64}
                strokeWidth={1.2}
                style={{ color: palette.soft, opacity: 0.7 }}
              />
            )}
          </div>
          {/* 装饰性光点 */}
          <div
            className="absolute w-24 h-24 rounded-full blur-2xl opacity-30"
            style={{
              background: palette.from,
              top: '15%',
              right: '10%',
            }}
          />
        </div>
      )}

      {/* 底部渐变遮罩 — 加强，让文字区有足够对比 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `linear-gradient(0deg, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.7) 35%, rgba(0,0,0,0.25) 55%, transparent 70%)`,
        }}
      />

      {/* Hover 时顶部主题色光晕 */}
      <div
        className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-400"
        style={{
          background: `linear-gradient(180deg, ${palette.from}15 0%, transparent 40%)`,
        }}
      />

      {/* 顶部高光边缘 */}
      <div
        className="absolute top-0 left-3 right-3 h-[1px] pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          background: `linear-gradient(90deg, transparent, ${palette.from}70, transparent)`,
        }}
      />

      {/* 底部信息区 — 毛玻璃底板 */}
      <div
        className="absolute bottom-0 left-0 right-0 p-3.5 backdrop-blur-md"
        style={{
          background: 'rgba(0, 0, 0, 0.25)',
          borderTop: '1px solid rgba(255, 255, 255, 0.06)',
        }}
      >
        {/* 标题行 */}
        <div className="flex items-center gap-1.5 mb-1.5">
          <div
            className="font-bold text-[15px] truncate flex-1"
            style={{
              color: '#fff',
              textShadow: '0 1px 4px rgba(0,0,0,0.6)',
              letterSpacing: '0.01em',
            }}
          >
            {item.name}
          </div>
          <ArrowUpRight
            size={13}
            className="shrink-0 opacity-0 group-hover:opacity-80 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            style={{ color: palette.soft }}
          />
        </div>

        {/* 描述 */}
        <div
          className="text-[11px] line-clamp-2 leading-relaxed mb-2.5"
          style={{
            color: 'rgba(255, 255, 255, 0.65)',
            textShadow: '0 1px 2px rgba(0,0,0,0.4)',
            minHeight: '2.2em',
          }}
        >
          {item.description}
        </div>

        {/* Tags */}
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2.5">
            {item.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded-md backdrop-blur-sm"
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  color: 'rgba(255, 255, 255, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
              >
                {tag}
              </span>
            ))}
            {item.tags.length > 3 && (
              <span className="text-[10px] px-1" style={{ color: 'rgba(255, 255, 255, 0.35)' }}>
                +{item.tags.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Footer */}
        <div
          className="flex items-center justify-between pt-2"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}
        >
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1 backdrop-blur-sm"
            style={{
              background: isCustomized ? `${palette.from}25` : 'rgba(255, 255, 255, 0.08)',
              color: isCustomized ? palette.soft : 'rgba(255, 255, 255, 0.5)',
              border: isCustomized ? `1px solid ${palette.from}30` : '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            {isCustomized ? (
              <>
                <Sparkles size={8} />
                定制版
              </>
            ) : item.type === 'builtin' ? '内置' : '自定义'}
          </span>

          <div className="flex items-center gap-2">
            {item.usageCount > 0 && (
              <span
                className="flex items-center gap-0.5 text-[10px]"
                style={{ color: 'rgba(255, 255, 255, 0.45)' }}
              >
                <Zap size={8} style={{ color: palette.soft, opacity: 0.8 }} />
                {item.usageCount}
              </span>
            )}
            <button
              onClick={handleToggleFavorite}
              className="flex items-center justify-center w-6 h-6 rounded-md transition-all duration-200 hover:scale-110"
              style={{
                background: favorited ? `${palette.from}25` : 'transparent',
              }}
              title={favorited ? '取消收藏' : '收藏'}
            >
              <Star
                size={13}
                fill={favorited ? '#FBBF24' : 'none'}
                style={{
                  color: favorited ? '#FBBF24' : 'rgba(255, 255, 255, 0.3)',
                  transition: 'all 0.2s ease',
                }}
              />
            </button>
          </div>
        </div>
      </div>

      {/* Hover border glow */}
      <div
        className="absolute inset-0 rounded-2xl pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          boxShadow: `inset 0 0 0 1px ${palette.from}40, 0 0 20px ${palette.from}20`,
        }}
      />
    </div>
  );
}
