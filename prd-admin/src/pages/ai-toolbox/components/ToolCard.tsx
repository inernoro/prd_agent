import type { ToolboxItem } from '@/services';
import { useToolboxStore } from '@/stores/toolboxStore';
import { useNavigate } from 'react-router-dom';
import { GlassCard } from '@/components/design/GlassCard';
import { useBreakpoint } from '@/hooks/useBreakpoint';
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
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers,
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
};

function getIconComponent(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Bot;
}

function getPalette(iconName: string) {
  return ACCENT_PALETTE[iconName] ?? ACCENT_PALETTE.Bot;
}

export function ToolCard({ item }: ToolCardProps) {
  const { selectItem } = useToolboxStore();
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();
  const palette = getPalette(item.icon);
  const IconComponent = getIconComponent(item.icon);
  const isCustomized = !!item.routePath;

  const handleClick = () => {
    if (isCustomized && item.routePath) {
      navigate(item.routePath);
    } else {
      selectItem(item);
    }
  };

  return (
    <GlassCard
      variant="subtle"
      padding="none"
      interactive
      onClick={handleClick}
      className="group"
    >
      <div className="p-3 flex flex-col h-full">
        {/* Icon + Title row */}
        <div className="flex items-start gap-2.5 mb-2">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background: `${palette.from}15`,
              border: `1px solid ${palette.from}20`,
            }}
          >
            <IconComponent size={18} style={{ color: palette.soft }} />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="flex items-center gap-1">
              <div
                className="font-semibold text-[13px] truncate flex-1"
                style={{ color: 'var(--text-primary, rgba(255, 255, 255, 0.95))' }}
              >
                {item.name}
              </div>
              <ArrowUpRight
                size={12}
                className="shrink-0 opacity-0 group-hover:opacity-60 transition-opacity duration-200"
                style={{ color: palette.soft }}
              />
            </div>
          </div>
        </div>

        {/* Description */}
        <div
          className="text-[11px] line-clamp-2 leading-relaxed mb-3"
          style={{ color: 'var(--text-muted, rgba(255, 255, 255, 0.45))', minHeight: '2.2em' }}
        >
          {item.description}
        </div>

        {/* Tags — 移动端隐藏以节省空间 */}
        {!isMobile && item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2.5">
            {item.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded-md"
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  color: 'var(--text-muted, rgba(255, 255, 255, 0.5))',
                }}
              >
                {tag}
              </span>
            ))}
            {item.tags.length > 3 && (
              <span className="text-[10px] px-1" style={{ color: 'rgba(255, 255, 255, 0.3)' }}>
                +{item.tags.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Footer */}
        <div
          className="flex items-center justify-between pt-2 mt-auto"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}
        >
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1"
            style={{
              background: isCustomized ? `${palette.from}15` : 'rgba(255, 255, 255, 0.04)',
              color: isCustomized ? palette.soft : 'rgba(255, 255, 255, 0.4)',
              border: isCustomized ? `1px solid ${palette.from}20` : '1px solid rgba(255, 255, 255, 0.04)',
            }}
          >
            {isCustomized ? (
              <>
                <Sparkles size={8} />
                定制版
              </>
            ) : item.type === 'builtin' ? '内置' : '自定义'}
          </span>

          {item.usageCount > 0 && (
            <span
              className="flex items-center gap-0.5 text-[10px]"
              style={{ color: 'rgba(255, 255, 255, 0.35)' }}
            >
              <Zap size={8} style={{ color: palette.soft, opacity: 0.7 }} />
              {item.usageCount}
            </span>
          )}
        </div>
      </div>
    </GlassCard>
  );
}
