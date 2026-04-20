import { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（红色按钮） */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * 通用确认弹窗：createPortal + ui-glass-modal，ESC 取消，Enter 确认。
 * 遵循 frontend-modal.md：inline style 固定宽度 + 避免被祖先 overflow/transform 影响。
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  danger,
  busy,
  onConfirm,
  onClose,
}: Props) {
  useEffect(() => {
    if (!open) return;
    // 仅监听 ESC 取消；Enter 不绑定——删除等危险操作要求用户显式点击按钮，
    // 避免上一次 click/context-menu 后的反射性 Enter 触发误删（Bugbot 反馈）。
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="ui-glass-modal rounded-xl border border-black/10 dark:border-white/10 shadow-xl flex flex-col overflow-hidden"
        style={{ width: 380, maxWidth: '90vw' }}
      >
        <div className="px-5 py-4 border-b border-black/10 dark:border-white/10">
          <h2 className="text-sm font-medium">{title}</h2>
        </div>
        <div className="px-5 py-4 text-sm text-text-secondary leading-relaxed">
          {message}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-black/10 dark:border-white/10">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`px-3 py-1.5 text-xs rounded-md text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              danger
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-primary-500 hover:bg-primary-600'
            }`}
          >
            {busy ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
