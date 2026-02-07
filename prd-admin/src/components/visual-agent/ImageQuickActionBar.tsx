import type { LucideIcon } from 'lucide-react';
import {
  Download,
  Expand,
  Eraser,
  Maximize,
  Paintbrush,
  Settings,
  Wand2,
} from 'lucide-react';
import type { QuickAction } from './quickActionTypes';

/** lucide icon 名称 → 组件映射 */
const ICON_MAP: Record<string, LucideIcon> = {
  Maximize,
  Eraser,
  Expand,
  Wand2,
  Download,
};

function resolveIcon(name?: string): LucideIcon {
  if (!name) return Wand2;
  return ICON_MAP[name] ?? Wand2;
}

export type ImageQuickActionBarProps = {
  /** 内置 + DIY 合并后的快捷操作列表 */
  actions: QuickAction[];
  /** 点击快捷操作 */
  onAction: (action: QuickAction) => void;
  /** 下载 */
  onDownload: () => void;
  /** 打开快捷指令配置 */
  onOpenConfig?: () => void;
  /** 局部重绘 */
  onInpaint?: () => void;
};

/**
 * 快捷操作工具栏（纯内容组件，由父级控制定位）
 */
export function ImageQuickActionBar({
  actions,
  onAction,
  onDownload,
  onOpenConfig,
  onInpaint,
}: ImageQuickActionBarProps) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-[10px] px-1 h-[36px]"
      style={{
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

      {/* 局部重绘按钮 */}
      {onInpaint ? (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2 h-[28px] rounded-[7px] text-[12px] font-medium whitespace-nowrap transition-colors hover:bg-white/10"
          style={{
            color: 'rgba(239, 147, 62, 0.92)',
            border: '1px solid rgba(239, 147, 62, 0.20)',
            background: 'rgba(239, 147, 62, 0.06)',
          }}
          title="选择图片区域进行局部重绘"
          onClick={onInpaint}
        >
          <Paintbrush size={14} className="shrink-0" />
          <span>局部重绘</span>
        </button>
      ) : null}

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

      {/* 快捷指令管理 */}
      {onOpenConfig ? (
        <button
          type="button"
          className="inline-flex items-center justify-center w-[28px] h-[28px] rounded-[7px] transition-colors hover:bg-white/10"
          style={{ color: 'rgba(255, 255, 255, 0.72)' }}
          title="管理快捷指令"
          onClick={onOpenConfig}
        >
          <Settings size={14} />
        </button>
      ) : null}
    </div>
  );
}
