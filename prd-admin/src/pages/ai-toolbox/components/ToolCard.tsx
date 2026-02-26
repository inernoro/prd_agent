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
      animated
      variant="subtle"
      padding="none"
      interactive
      overflow="hidden"
      onClick={handleClick}
      className="group"
      style={{
        '--card-accent-border': `${palette.from}35`,
        '--card-accent-glow': `${palette.from}25`,
      } as React.CSSProperties}
    >
      {/* Accent top bar — gradient fade */}
      <div
        className="h-[2px]"
        style={{
          background: `linear-gradient(90deg, transparent 5%, ${palette.from}60 35%, ${palette.from}60 65%, transparent 95%)`,
        }}
      />

      {/* Accent gradient overlay at top of card */}
      <div
        className="absolute inset-x-0 top-0 h-20 pointer-events-none"
        style={{
          background: `linear-gradient(180deg, ${palette.from}0c 0%, transparent 100%)`,
        }}
      />

      <div className="p-3.5 flex flex-col h-full relative">
        {/* Icon + Title row */}
        <div className="flex items-start gap-3 mb-2.5">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: `linear-gradient(135deg, ${palette.from}22 0%, ${palette.from}0a 100%)`,
              border: `1px solid ${palette.from}28`,
              boxShadow: `0 2px 10px ${palette.from}12`,
            }}
          >
            <IconComponent size={19} style={{ color: palette.soft }} />
          </div>
          <div className="flex-1 min-w-0 pt-1">
            <div className="flex items-center gap-1">
              <div
                className="font-semibold text-[13px] truncate flex-1"
                style={{ color: 'var(--text-primary, rgba(255, 255, 255, 0.95))' }}
              >
                {item.name}
              </div>
              <ArrowUpRight
                size={12}
                className="shrink-0 opacity-0 group-hover:opacity-70 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                style={{ color: palette.soft }}
              />
            </div>
          </div>
        </div>

        {/* Description */}
        <div
          className="text-[11px] line-clamp-2 leading-relaxed mb-3"
          style={{ color: 'var(--text-muted, rgba(255, 255, 255, 0.5))', minHeight: '2.2em' }}
        >
          {item.description}
        </div>

        {/* Tags */}
        {!isMobile && item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2.5">
            {item.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded-md"
                style={{
                  background: 'rgba(255, 255, 255, 0.06)',
                  color: 'rgba(255, 255, 255, 0.55)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
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
          className="flex items-center justify-between pt-2.5 mt-auto"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}
        >
          <span
            className="text-[10px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1"
            style={{
              background: isCustomized ? `${palette.from}18` : 'rgba(255, 255, 255, 0.05)',
              color: isCustomized ? palette.soft : 'rgba(255, 255, 255, 0.45)',
              border: isCustomized ? `1px solid ${palette.from}25` : '1px solid rgba(255, 255, 255, 0.06)',
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
              style={{ color: 'rgba(255, 255, 255, 0.4)' }}
            >
              <Zap size={8} style={{ color: palette.soft, opacity: 0.8 }} />
              {item.usageCount}
            </span>
          )}
        </div>
      </div>
    </GlassCard>
  );
}
