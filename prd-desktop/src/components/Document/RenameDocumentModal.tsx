import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import type { ApiResponse, Document } from '../../types';

interface Props {
  open: boolean;
  documentId: string;
  currentTitle: string;
  onClose: () => void;
  onRenamed?: (newTitle: string) => void;
}

const MAX_TITLE = 200;

export default function RenameDocumentModal({ open, documentId, currentTitle, onClose, onRenamed }: Props) {
  const { activeGroupId, sessionId } = useSessionStore();
  const [title, setTitle] = useState(currentTitle || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(currentTitle || '');
    setError('');
    setBusy(false);
    // 下一帧聚焦 + 全选，便于直接覆盖
    const id = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, currentTitle]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const trimmed = title.trim();
  const unchanged = trimmed === (currentTitle || '').trim();
  const tooLong = trimmed.length > MAX_TITLE;
  const empty = trimmed.length === 0;
  const canSubmit = !busy && !empty && !tooLong && !unchanged;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const resp = await invoke<ApiResponse<Document>>('update_document_title', {
        documentId,
        title: trimmed,
        groupId: activeGroupId || null,
        sessionId: sessionId || null,
      });
      if (!resp.success || !resp.data) {
        setError(resp.error?.message || '重命名失败');
        return;
      }
      const updatedTitle = resp.data.title || trimmed;
      useSessionStore.setState((s) => ({
        document: s.document && s.document.id === documentId ? { ...s.document, title: updatedTitle } : s.document,
        documents: s.documents.map((d) => (d.id === documentId ? { ...d, title: updatedTitle } : d)),
      }));
      onRenamed?.(updatedTitle);
      onClose();
    } catch (err) {
      setError('重命名失败：' + String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="ui-glass-modal rounded-xl border border-black/10 dark:border-white/10 shadow-xl flex flex-col overflow-hidden"
        style={{ width: 420, maxWidth: '90vw' }}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-black/10 dark:border-white/10">
          <h2 className="text-sm font-medium">重命名文档</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 inline-flex items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary"
            aria-label="关闭"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-2">
          <label className="block text-xs text-text-secondary">新文档名</label>
          <input
            ref={inputRef}
            type="text"
            value={title}
            maxLength={MAX_TITLE + 20}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="请输入文档名"
            className="w-full px-3 py-2 rounded-md border border-black/10 dark:border-white/10 bg-white/60 dark:bg-white/5 text-sm text-text-primary outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500/60 disabled:opacity-50"
          />
          <div className="flex items-center justify-between text-[11px]">
            <span className={tooLong ? 'text-red-500' : 'text-text-secondary/70'}>
              {trimmed.length}/{MAX_TITLE}
            </span>
            {error ? <span className="text-red-500">{error}</span> : null}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-black/10 dark:border-white/10">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => { void submit(); }}
            disabled={!canSubmit}
            className="px-3 py-1.5 text-xs rounded-md bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
