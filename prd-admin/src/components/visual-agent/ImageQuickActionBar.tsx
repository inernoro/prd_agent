import { useState, useRef, useEffect, useCallback } from 'react';
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
 * 确认气泡（二次确认，防误触）
 */
function ConfirmBubble({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部自动取消
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [onCancel]);

  return (
    <div
      ref={ref}
      className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg whitespace-nowrap z-50"
      style={{
        background: 'rgba(32, 32, 38, 0.98)',
        border: '1px solid rgba(255,255,255,0.18)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      }}
    >
      <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.65)' }}>
        确认执行「{label}」？
      </span>
      <button
        type="button"
        className="px-2 py-0.5 rounded text-[11px] font-medium transition-colors"
        style={{ background: 'rgba(59,130,246,0.3)', color: '#93c5fd' }}
        onClick={onConfirm}
      >
        确认
      </button>
      <button
        type="button"
        className="px-1.5 py-0.5 rounded text-[11px] transition-colors hover:bg-white/10"
        style={{ color: 'rgba(255,255,255,0.45)' }}
        onClick={onCancel}
      >
        取消
      </button>
    </div>
  );
}

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
  // 二次确认状态：记录待确认的 action id
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  const handleCancel = useCallback(() => setPendingActionId(null), []);

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
        const isPending = pendingActionId === action.id;
        return (
          <div key={action.id} className="relative">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-2 h-[28px] rounded-[7px] text-[12px] font-medium whitespace-nowrap transition-colors hover:bg-white/10"
              style={{
                color: isPending
                  ? 'rgba(59,130,246,0.95)'
                  : action.isDiy
                    ? 'rgba(250, 204, 21, 0.92)'
                    : 'rgba(255, 255, 255, 0.88)',
                border: isPending
                  ? '1px solid rgba(59,130,246,0.3)'
                  : action.isDiy
                    ? '1px solid rgba(250, 204, 21, 0.20)'
                    : '1px solid transparent',
                background: isPending
                  ? 'rgba(59,130,246,0.12)'
                  : action.isDiy
                    ? 'rgba(250, 204, 21, 0.06)'
                    : 'transparent',
              }}
              title={action.isDiy ? `DIY: ${action.name}` : action.name}
              onClick={() => {
                if (isPending) {
                  // 已展开确认 → 再点按钮本身也执行
                  setPendingActionId(null);
                  onAction(action);
                } else {
                  setPendingActionId(action.id);
                }
              }}
            >
              <Icon size={14} className="shrink-0" />
              <span>{action.name}</span>
            </button>
            {/* 确认气泡 */}
            {isPending && (
              <ConfirmBubble
                label={action.name}
                onConfirm={() => {
                  setPendingActionId(null);
                  onAction(action);
                }}
                onCancel={handleCancel}
              />
            )}
          </div>
        );
      })}

      {/* 分隔线 */}
      <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.14)' }} />

      {/* 局部重绘 */}
      {onInpaint ? (
        <button
          type="button"
          className="inline-flex items-center justify-center w-[28px] h-[28px] rounded-[7px] transition-colors hover:bg-white/10"
          style={{ color: 'rgba(255, 255, 255, 0.72)' }}
          title="局部重绘"
          onClick={onInpaint}
        >
          <Paintbrush size={14} />
        </button>
      ) : null}

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
