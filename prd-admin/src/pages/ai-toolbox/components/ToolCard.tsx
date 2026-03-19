import { useState } from 'react';
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
  Users,
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
  'video-agent': 'icon/backups/agent/video-agent.png',
  'report-agent': 'icon/backups/agent/report-agent.png',
  'arena': 'icon/backups/agent/arena.png',
  'shortcuts-agent': 'icon/backups/agent/shortcuts-agent.png',
  'workflow-agent': 'icon/backups/agent/workflow-agent.png',
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

import { SpotlightEffect } from './SpotlightEffect';

export function ToolCard({ item }: ToolCardProps) {
  const { selectItem, toggleFavorite, isFavorite } = useToolboxStore();
  const navigate = useNavigate();
  const palette = getPalette(item.icon);
  const IconComponent = getIconComponent(item.icon);
  const isCustomized = !!item.routePath;
  const favorited = isFavorite(item.id);
  const coverUrl = getCoverImageUrl(item.agentKey);
  const [coverFailed, setCoverFailed] = useState(false);

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
    <SpotlightEffect
      spotlightColor={`${palette.from}33`} // 20% opacity of the main color
      onClick={handleClick}
      className="group relative rounded-xl overflow-hidden cursor-pointer transition-all duration-500 hover:-translate-y-1"
      style={{
        background: 'rgba(15, 23, 42, 0.4)',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.1)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        aspectRatio: '3 / 4',
      }}
    >
      {/* 噪点纹理涂层 */}
      <div 
        className="absolute inset-0 z-0 opacity-[0.03] mix-blend-overlay pointer-events-none" 
        style={{ backgroundImage: 'var(--glass-noise)' }} 
      />
      {/* Cover visual — CDN 图片 or 渐变 + 大图标 */}
      {coverUrl && !coverFailed ? (
        <img
          src={coverUrl}
          alt={item.name}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-110 z-0"
          draggable={false}
          onError={() => setCoverFailed(true)}
        />
      ) : (
        <div
          className="absolute inset-0 z-0"
          style={{
            background: `
              radial-gradient(circle at 50% 0%, ${palette.from}25 0%, transparent 60%),
              radial-gradient(ellipse at 80% 80%, ${palette.from}15 0%, transparent 50%),
              linear-gradient(180deg, rgba(20, 22, 35, 0.8) 0%, rgba(12, 14, 22, 1) 100%)
            `,
          }}
        >
          {/* 图标视觉焦点 + 光晕 */}
          <div
            className="absolute inset-x-0 top-[18%] flex justify-center transition-transform duration-700 ease-out group-hover:scale-110 group-hover:-translate-y-1"
          >
            {/* 图标背后的柔光圈 */}
            <div
              className="absolute rounded-full blur-2xl transition-opacity duration-500 group-hover:opacity-100 opacity-60"
              style={{
                width: 64,
                height: 64,
                background: `radial-gradient(circle, ${palette.from}60 0%, ${palette.from}20 50%, transparent 100%)`,
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
              }}
            />
            <IconComponent
              size={28}
              strokeWidth={1.4}
              className="relative drop-shadow-2xl"
              style={{ color: palette.soft, opacity: 0.95 }}
            />
          </div>
          {/* 装饰性光点 */}
          <div
            className="absolute w-16 h-16 rounded-full blur-[20px] opacity-20 group-hover:opacity-40 transition-opacity duration-500"
            style={{
              background: palette.from,
              top: '5%',
              right: '5%',
            }}
          />
        </div>
      )}

      {/* 底部渐变遮罩 — 无缝衔接信息区 */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          background: `linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.85) 75%, rgba(0,0,0,0.95) 100%)`,
        }}
      />

      {/* Hover 时顶部边框流光高光边缘 */}
      <div
        className="absolute top-0 inset-x-0 h-[1px] pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500 z-20"
        style={{
          background: `linear-gradient(90deg, transparent 10%, ${palette.from}90 50%, transparent 90%)`,
        }}
      />

      {/* 底部信息区 */}
      <div
        className="absolute bottom-0 left-0 right-0 px-2.5 pb-2 pt-1 z-20"
      >
        {/* 标题行 */}
        <div className="flex items-center gap-1 mb-0.5">
          <div
            className="font-semibold text-[11px] truncate flex-1"
            style={{
              color: '#ffffff',
              textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            }}
          >
            {item.name}
          </div>
          <ArrowUpRight
            size={11}
            className="shrink-0 opacity-0 group-hover:opacity-100 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            style={{ color: palette.soft }}
          />
        </div>

        {/* 描述 */}
        <div
          className="text-[9px] line-clamp-2 leading-snug mb-1.5 transition-colors duration-300 group-hover:text-white/85"
          style={{
            color: 'rgba(255, 255, 255, 0.55)',
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            minHeight: '2em',
          }}
        >
          {item.description}
        </div>

        {/* Tags */}
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {item.tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="text-[8px] px-1.5 py-px rounded backdrop-blur-md transition-colors duration-300"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: 'rgba(255, 255, 255, 0.7)',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                }}
              >
                {tag}
              </span>
            ))}
            {item.tags.length > 2 && (
              <span className="text-[8px] px-0.5 font-medium" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>
                +{item.tags.length - 2}
              </span>
            )}
          </div>
        )}

        {/* Footer — 内置: 徽章 + 收藏; 自定义: 作者 + 统计 */}
        <div
          className="flex items-center justify-between pt-1.5"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}
        >
          {item.type === 'custom' ? (
            <>
              {/* 作者头像 + 名字 */}
              <div className="flex items-center gap-1 min-w-0">
                <div
                  className="w-3.5 h-3.5 rounded-full shrink-0 flex items-center justify-center text-[7px] font-bold"
                  style={{
                    background: `linear-gradient(135deg, ${palette.from}, ${palette.soft})`,
                    color: 'rgba(0, 0, 0, 0.7)',
                  }}
                >
                  {(item.createdByName || '?')[0]}
                </div>
                <span
                  className="text-[8px] truncate"
                  style={{ color: 'rgba(255, 255, 255, 0.5)' }}
                >
                  {item.createdByName || '未知'}
                </span>
              </div>
              {/* 使用次数 */}
              <div className="flex items-center gap-1.5 shrink-0">
                {item.usageCount > 0 && (
                  <span
                    className="flex items-center gap-0.5 text-[8px]"
                    style={{ color: 'rgba(255, 255, 255, 0.45)' }}
                  >
                    <Zap size={8} style={{ color: palette.soft }} />
                    {item.usageCount >= 1000 ? `${(item.usageCount / 1000).toFixed(1)}k` : item.usageCount}
                  </span>
                )}
                <button
                  onClick={handleToggleFavorite}
                  className="flex items-center justify-center transition-all duration-300 hover:scale-125"
                  title={favorited ? '取消收藏' : '收藏'}
                >
                  <Star
                    size={10}
                    fill={favorited ? '#FBBF24' : 'none'}
                    style={{
                      color: favorited ? '#FBBF24' : 'rgba(255, 255, 255, 0.25)',
                      filter: favorited ? 'drop-shadow(0 0 4px rgba(251, 191, 36, 0.5))' : 'none',
                    }}
                  />
                </button>
              </div>
            </>
          ) : (
            <>
              {/* 内置工具: 徽章 */}
              <span
                className="text-[8px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-1"
                style={{
                  background: isCustomized ? `${palette.from}25` : 'transparent',
                  color: isCustomized ? palette.soft : 'rgba(255, 255, 255, 0.4)',
                  border: isCustomized ? `1px solid ${palette.from}40` : '1px solid rgba(255, 255, 255, 0.1)',
                }}
              >
                {isCustomized ? (
                  <>
                    <Sparkles size={8} />
                    定制版
                  </>
                ) : '系统内置'}
              </span>
              <button
                onClick={handleToggleFavorite}
                className="flex items-center justify-center transition-all duration-300 hover:scale-125"
                title={favorited ? '取消收藏' : '收藏'}
              >
                <Star
                  size={10}
                  fill={favorited ? '#FBBF24' : 'none'}
                  style={{
                    color: favorited ? '#FBBF24' : 'rgba(255, 255, 255, 0.25)',
                    filter: favorited ? 'drop-shadow(0 0 4px rgba(251, 191, 36, 0.5))' : 'none',
                  }}
                />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Hover inner border glow */}
      <div
        className="absolute inset-0 rounded-xl pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500 z-30"
        style={{
          boxShadow: `inset 0 0 0 1px ${palette.from}60`,
        }}
      />
    </SpotlightEffect>
  );
}
