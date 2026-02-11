import type { ToolboxItem } from '@/services';
import { useToolboxStore } from '@/stores/toolboxStore';
import { useNavigate } from 'react-router-dom';
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

/**
 * 精心策划的色彩调色板 —— 柔和有机的渐变，避免金属质感
 * 每个 agent 类型有独特的 from→to 渐变和对应的柔和文字色
 */
const ACCENT_PALETTE: Record<string, { from: string; to: string; soft: string }> = {
  FileText:     { from: '#3B82F6', to: '#818CF8', soft: '#93C5FD' },  // 天蓝 → 薰衣草
  Palette:      { from: '#A855F7', to: '#EC4899', soft: '#D8B4FE' },  // 紫 → 粉
  PenTool:      { from: '#F59E0B', to: '#FB923C', soft: '#FDE68A' },  // 琥珀 → 橘
  Bug:          { from: '#EF4444', to: '#F97316', soft: '#FCA5A5' },  // 红 → 橙
  Code2:        { from: '#10B981', to: '#06B6D4', soft: '#6EE7B7' },  // 翠绿 → 青
  Languages:    { from: '#06B6D4', to: '#3B82F6', soft: '#67E8F9' },  // 青 → 蓝
  FileSearch:   { from: '#EAB308', to: '#84CC16', soft: '#FDE68A' },  // 黄 → 绿
  BarChart3:    { from: '#8B5CF6', to: '#6366F1', soft: '#C4B5FD' },  // 紫罗兰 → 靛
  Bot:          { from: '#6366F1', to: '#8B5CF6', soft: '#A5B4FC' },  // 靛 → 紫罗兰
  Lightbulb:    { from: '#F59E0B', to: '#FBBF24', soft: '#FDE68A' },  // 暖金
  Target:       { from: '#EF4444', to: '#DC2626', soft: '#FCA5A5' },  // 正红
  Wrench:       { from: '#78716C', to: '#A8A29E', soft: '#D6D3D1' },  // 石墨
  Sparkles:     { from: '#A855F7', to: '#7C3AED', soft: '#D8B4FE' },  // 魔法紫
  Rocket:       { from: '#3B82F6', to: '#1D4ED8', soft: '#93C5FD' },  // 深蓝
  MessageSquare:{ from: '#14B8A6', to: '#0D9488', soft: '#5EEAD4' },  // 碧绿
  Brain:        { from: '#D946EF', to: '#A855F7', soft: '#F0ABFC' },  // 品红 → 紫
  Cpu:          { from: '#64748B', to: '#475569', soft: '#94A3B8' },  // 钢灰
  Database:     { from: '#0EA5E9', to: '#0284C7', soft: '#7DD3FC' },  // 海蓝
  Globe:        { from: '#22D3EE', to: '#06B6D4', soft: '#A5F3FC' },  // 天青
  Image:        { from: '#EC4899', to: '#F43F5E', soft: '#F9A8D4' },  // 玫瑰
  Music:        { from: '#D946EF', to: '#C026D3', soft: '#F0ABFC' },  // 品红
  Video:        { from: '#F43F5E', to: '#E11D48', soft: '#FDA4AF' },  // 玫瑰红
  BookOpen:     { from: '#22C55E', to: '#16A34A', soft: '#86EFAC' },  // 翠绿
  GraduationCap:{ from: '#3B82F6', to: '#2563EB', soft: '#93C5FD' }, // 学院蓝
  Briefcase:    { from: '#78716C', to: '#57534E', soft: '#A8A29E' },  // 商务灰
  Heart:        { from: '#F43F5E', to: '#E11D48', soft: '#FDA4AF' },  // 心红
  Star:         { from: '#F59E0B', to: '#D97706', soft: '#FCD34D' },  // 金星
  Shield:       { from: '#3B82F6', to: '#1E40AF', soft: '#93C5FD' },  // 守护蓝
  Lock:         { from: '#64748B', to: '#334155', soft: '#94A3B8' },  // 安全灰
  Search:       { from: '#14B8A6', to: '#0D9488', soft: '#5EEAD4' },  // 探索青
  Layers:       { from: '#8B5CF6', to: '#6D28D9', soft: '#C4B5FD' },  // 层叠紫
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
    <div
      className="group relative rounded-2xl cursor-pointer transition-all duration-300 ease-out hover:-translate-y-1"
      style={{
        background: 'var(--glass-bg-end, #111114)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        boxShadow: '0 2px 8px -2px rgba(0, 0, 0, 0.3)',
      }}
      onClick={handleClick}
    >
      {/* Hover border glow */}
      <div
        className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
        style={{
          border: `1px solid ${palette.from}25`,
          boxShadow: `0 8px 32px -8px ${palette.from}20, 0 0 0 1px ${palette.from}10`,
        }}
      />

      {/* Aurora gradient header */}
      <div
        className="relative h-[52px] rounded-t-2xl overflow-hidden"
      >
        {/* Multi-layer gradient - creates organic aurora feel */}
        <div
          className="absolute inset-0 opacity-[0.35] group-hover:opacity-[0.55] transition-opacity duration-500"
          style={{
            background: `
              radial-gradient(ellipse 80% 120% at 80% 10%, ${palette.from}80 0%, transparent 60%),
              radial-gradient(ellipse 60% 100% at 20% 80%, ${palette.to}60 0%, transparent 50%),
              linear-gradient(135deg, ${palette.from}30 0%, ${palette.to}20 100%)
            `,
          }}
        />
        {/* Noise texture overlay for organic feel */}
        <div
          className="absolute inset-0"
          style={{
            background: 'radial-gradient(ellipse 100% 100% at 50% 0%, rgba(255,255,255,0.04) 0%, transparent 70%)',
          }}
        />
        {/* Icon floating on the gradient */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center transition-transform duration-300 group-hover:scale-110"
            style={{
              background: 'rgba(0, 0, 0, 0.25)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <IconComponent size={18} style={{ color: palette.soft }} />
          </div>
        </div>
      </div>

      {/* Content area */}
      <div className="px-3 pb-3 pt-2.5">
        {/* Name + arrow */}
        <div className="flex items-center gap-1.5 mb-1">
          <div
            className="font-semibold text-[13px] truncate flex-1"
            style={{ color: 'var(--text-primary, rgba(255, 255, 255, 0.95))' }}
          >
            {item.name}
          </div>
          <ArrowUpRight
            size={12}
            className="shrink-0 opacity-0 group-hover:opacity-60 transition-all duration-200 -translate-x-1 group-hover:translate-x-0"
            style={{ color: palette.soft }}
          />
        </div>

        {/* Description */}
        <div
          className="text-[11px] line-clamp-2 leading-relaxed mb-3"
          style={{ color: 'var(--text-muted, rgba(255, 255, 255, 0.45))', minHeight: '2.2em' }}
        >
          {item.description}
        </div>

        {/* Tags */}
        {item.tags.length > 0 && (
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

        {/* Footer divider + info */}
        <div
          className="flex items-center justify-between pt-2"
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
    </div>
  );
}
