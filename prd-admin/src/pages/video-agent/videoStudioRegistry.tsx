import type { LucideIcon } from 'lucide-react';
import {
  Aperture,
  Blocks,
  Brush,
  Camera,
  Clapperboard,
  Focus,
  ScanLine,
  Sparkles,
} from 'lucide-react';

export interface VideoStyleDefinition {
  key: string;
  label: string;
  description: string;
  color: string;
  icon: LucideIcon;
}

export const VIDEO_STYLE_DEFINITIONS: VideoStyleDefinition[] = [
  { key: 'auto', label: '智能匹配', description: '根据文学稿自动确定风格', color: '#38bdf8', icon: Sparkles },
  { key: 'cinematic', label: '电影叙事', description: '克制景深与电影级光影', color: '#f59e0b', icon: Clapperboard },
  { key: 'documentary', label: '写实纪录', description: '自然机位与真实材质', color: '#34d399', icon: Camera },
  { key: 'animation', label: '三维动画', description: '立体角色与柔和渲染', color: '#a78bfa', icon: Blocks },
  { key: 'ink', label: '东方水墨', description: '留白、墨色与写意运动', color: '#94a3b8', icon: Brush },
  { key: 'retro', label: '胶片影像', description: '颗粒、低饱和与复古镜头', color: '#fb7185', icon: Aperture },
  { key: 'minimal', label: '极简视觉', description: '干净构图与明确主体', color: '#e2e8f0', icon: Focus },
  { key: 'pixel', label: '像素动画', description: '像素材质与帧动画节奏', color: '#22d3ee', icon: ScanLine },
];
