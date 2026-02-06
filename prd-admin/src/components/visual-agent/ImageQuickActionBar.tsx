import type { LucideIcon } from 'lucide-react';
import {
  Download,
  Expand,
  Eraser,
  Maximize,
  Monitor,
  Wand2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuickAction } from './quickActionTypes';

/** lucide icon 名称 → 组件映射 */
const ICON_MAP: Record<string, LucideIcon> = {
  Maximize,
  Eraser,
  Monitor,
  Expand,
  Wand2,
  Download,
};

function resolveIcon(name?: string): LucideIcon {
  if (!name) return Wand2;
  return ICON_MAP[name] ?? Wand2;
}

export type ImageQuickActionBarProps = {
  /** 选中的图片在画布中的世界坐标 */
  imageRect: { x: number; y: number; w: number; h: number };
  /** 当前缩放比 */
  zoom: number;
  /** 摄像机偏移 */
  camera: { x: number; y: number };
  /** 舞台容器的 DOM 引用（用于获取 boundingRect） */
  stageEl: HTMLElement | null;
  /** 内置 + DIY 合并后的快捷操作列表 */
  actions: QuickAction[];
  /** 点击快捷操作 */
  onAction: (action: QuickAction) => void;
  /** 下载 */
  onDownload: () => void;
};

export function ImageQuickActionBar({
  imageRect,
  zoom,
  camera,
  stageEl,
  actions,
  onAction,
  onDownload,
}: ImageQuickActionBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const recalcPosition = useCallback(() => {
    if (!stageEl) return;
    const sr = stageEl.getBoundingClientRect();
    // 图片左上角的屏幕坐标
    const imgScreenX = imageRect.x * zoom + camera.x + sr.left;
    const imgScreenY = imageRect.y * zoom + camera.y + sr.top;
    const imgScreenW = imageRect.w * zoom;

    // 工具栏居中于图片上方
    const barW = barRef.current?.offsetWidth ?? 400;
    let left = imgScreenX + imgScreenW / 2 - barW / 2;
    const top = imgScreenY - 44; // 固定高度 36px + 8px 间距

    // 水平方向 clamp 到 stage 内
    left = Math.max(sr.left + 4, Math.min(left, sr.right - barW - 4));

    setPos({ left, top: Math.max(sr.top + 4, top) });
  }, [imageRect, zoom, camera, stageEl]);

  useEffect(() => {
    recalcPosition();
  }, [recalcPosition]);

  // 监听窗口 resize
  useEffect(() => {
    const handler = () => recalcPosition();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [recalcPosition]);

  if (!pos) return null;

  return (
    <div
      ref={barRef}
      className="fixed z-[8000] flex items-center gap-0.5 rounded-[10px] px-1 h-[36px]"
      style={{
        left: pos.left,
        top: pos.top,
        background: 'rgba(32, 32, 38, 0.95)',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06) inset',
        pointerEvents: 'auto',
      }}
    >
      {actions.map((action) => {
        const Icon = resolveIcon(action.icon);
        return (
          <button
            key={action.id}
            type="button"
            className="inline-flex items-center gap-1.5 px-2 h-[28px] rounded-[7px] text-[12px] font-medium whitespace-nowrap transition-colors hover:bg-white/10"
            style={{
              color: action.isDiy ? 'rgba(250, 204, 21, 0.92)' : 'rgba(255, 255, 255, 0.88)',
              border: action.isDiy ? '1px solid rgba(250, 204, 21, 0.20)' : '1px solid transparent',
              background: action.isDiy ? 'rgba(250, 204, 21, 0.06)' : 'transparent',
            }}
            title={action.isDiy ? `DIY: ${action.name}` : action.name}
            onClick={() => onAction(action)}
          >
            <Icon size={14} className="shrink-0" />
            <span>{action.name}</span>
          </button>
        );
      })}

      {/* 分隔线 */}
      <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.14)' }} />

      {/* 下载按钮 */}
      <button
        type="button"
        className="inline-flex items-center justify-center w-[28px] h-[28px] rounded-[7px] transition-colors hover:bg-white/10"
        style={{ color: 'rgba(255, 255, 255, 0.72)' }}
        title="下载图片"
        onClick={onDownload}
      >
        <Download size={14} />
      </button>
    </div>
  );
}
