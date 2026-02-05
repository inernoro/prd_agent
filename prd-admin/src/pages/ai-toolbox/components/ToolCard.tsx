import type { ToolboxItem } from '@/services';
import { useToolboxStore } from '@/stores/toolboxStore';
import { GlassCard } from '@/components/design/GlassCard';
import {
  Zap,
  Sparkles,
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
  Rocket,
  MessageSquare,
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

// 图标名称到色相的映射
const ICON_HUE_MAP: Record<string, number> = {
  FileText: 210, Palette: 330, PenTool: 45, Bug: 0, Code2: 180, Languages: 200,
  FileSearch: 50, BarChart3: 270, Bot: 210, Lightbulb: 45, Target: 0, Wrench: 30,
  Sparkles: 280, Rocket: 210, MessageSquare: 180, Zap: 45, Brain: 270, Cpu: 200,
  Database: 220, Globe: 180, Image: 330, Music: 300, Video: 0, BookOpen: 140,
  GraduationCap: 220, Briefcase: 30, Heart: 350, Star: 45, Shield: 210, Lock: 200,
  Search: 180, Layers: 240,
};

// 获取图标组件
function getIconComponent(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Bot;
}

// 获取强调色色相
function getAccentHue(iconName: string): number {
  return ICON_HUE_MAP[iconName] ?? 210;
}

export function ToolCard({ item }: ToolCardProps) {
  const { selectItem } = useToolboxStore();
  const accentHue = getAccentHue(item.icon);
  const IconComponent = getIconComponent(item.icon);

  return (
    <GlassCard
      variant="subtle"
      accentHue={accentHue}
      glow
      padding="none"
      interactive
      onClick={() => selectItem(item)}
      className="group"
    >
      <div className="p-3">
        {/* Icon with glow effect */}
        <div className="relative mb-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300 group-hover:scale-110"
            style={{
              background: `linear-gradient(135deg, hsla(${accentHue}, 70%, 60%, 0.18) 0%, hsla(${accentHue}, 70%, 40%, 0.1) 100%)`,
              boxShadow: `0 3px 12px -3px hsla(${accentHue}, 70%, 50%, 0.35), inset 0 1px 0 0 rgba(255,255,255,0.12)`,
              border: `1px solid hsla(${accentHue}, 60%, 60%, 0.25)`,
            }}
          >
            <IconComponent
              size={20}
              style={{ color: `hsla(${accentHue}, 70%, 70%, 1)` }}
            />
          </div>
          {/* Subtle glow behind icon */}
          <div
            className="absolute inset-0 -z-10 blur-lg opacity-40 group-hover:opacity-60 transition-opacity"
            style={{
              background: `radial-gradient(circle, hsla(${accentHue}, 70%, 50%, 0.5) 0%, transparent 70%)`,
            }}
          />
        </div>

        {/* Name */}
        <div
          className="font-semibold text-[13px] mb-1 truncate"
          style={{ color: 'rgba(255, 255, 255, 0.95)' }}
        >
          {item.name}
        </div>

        {/* Description */}
        <div
          className="text-[11px] line-clamp-2 mb-2.5 leading-relaxed"
          style={{ color: 'rgba(255, 255, 255, 0.55)', minHeight: '2.2em' }}
        >
          {item.description}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between">
          {/* Type badge */}
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium flex items-center gap-0.5"
            style={{
              background: item.type === 'builtin'
                ? `hsla(${accentHue}, 60%, 50%, 0.15)`
                : 'rgba(34, 197, 94, 0.15)',
              color: item.type === 'builtin'
                ? `hsla(${accentHue}, 70%, 70%, 1)`
                : 'rgb(74, 222, 128)',
              border: item.type === 'builtin'
                ? `1px solid hsla(${accentHue}, 60%, 50%, 0.25)`
                : '1px solid rgba(34, 197, 94, 0.25)',
            }}
          >
            {item.type === 'builtin' && <Sparkles size={8} />}
            {item.type === 'builtin' ? '内置' : '自定义'}
          </span>

          {/* Usage count */}
          {item.usageCount > 0 && (
            <span
              className="flex items-center gap-0.5 text-[10px]"
              style={{ color: 'rgba(255, 255, 255, 0.5)' }}
            >
              <Zap size={9} style={{ color: `hsla(${accentHue}, 70%, 65%, 0.9)` }} />
              {item.usageCount}
            </span>
          )}
        </div>

        {/* Tags */}
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2.5 pt-2.5 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
            {item.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: 'rgba(255, 255, 255, 0.55)',
                  border: '1px solid rgba(255, 255, 255, 0.04)',
                }}
              >
                {tag}
              </span>
            ))}
            {item.tags.length > 3 && (
              <span
                className="text-[10px] px-1.5 py-0.5"
                style={{ color: 'rgba(255, 255, 255, 0.4)' }}
              >
                +{item.tags.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </GlassCard>
  );
}
