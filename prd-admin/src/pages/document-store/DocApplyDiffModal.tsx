import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { X, Replace, FileDown, FilePlus2, AlertTriangle, Check } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { buildApplyPreview, applyModeMeta, buildFolderOptions, type ApplyMode, type FolderNode } from './docApplyPreview';

// AI 文档对话「写回前确认」弹窗 —— diff 预览闸。
//
// 让用户在 AI 覆盖/追加/另存之前看清「改成什么样」，确认才落库（CLAUDE.md「让用户感知改动」）。
// 布局遵守 .claude/rules/frontend-modal.md 三硬约束：createPortal 到 body + 关键尺寸 inline style
// + 滚动区 min-h:0 + overscroll-contain。

// diff / 正文渲染行数上限：超大文档只渲染前 N 行，避免一次塞几千个 DOM 卡顿。
const MAX_RENDER_LINES = 800;

export interface DocApplyDiffModalProps {
  mode: ApplyMode;
  entryTitle: string;
  docContent: string;
  aiContent: string;
  /** replace 预览基于前 4 万字时给出提示 */
  docTruncated?: boolean;
  /** 写回进行中（确认按钮转圈 + 禁止重复点击） */
  applying: boolean;
  /** Phase 2：当前知识库的文件夹列表（mode=new 时渲染「落到哪个目录」选择器） */
  folders?: FolderNode[];
  onConfirm: (opts: { title?: string; parentId?: string }) => void;
  onCancel: () => void;
}

const MODE_ICON = {
  replace: Replace,
  append: FileDown,
  new: FilePlus2,
} as const;

export function DocApplyDiffModal({
  mode,
  entryTitle,
  docContent,
  aiContent,
  docTruncated,
  applying,
  folders,
  onConfirm,
  onCancel,
}: DocApplyDiffModalProps) {
  const preview = useMemo(
    () => buildApplyPreview(mode, docContent, aiContent, entryTitle),
    [mode, docContent, aiContent, entryTitle],
  );
  const meta = applyModeMeta(mode);
  const [title, setTitle] = useState(preview.defaultTitle ?? '');
  // mode=new 的目标目录：空 = 与原文同目录（后端默认）
  const [parentId, setParentId] = useState('');
  const folderOptions = useMemo(() => buildFolderOptions(folders ?? []), [folders]);

  // ESC 关闭（写回中不允许关，避免误判已取消）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applying) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applying, onCancel]);

  const noChange = mode === 'replace'
    && preview.stats?.added === 0
    && preview.stats?.removed === 0;

  const ModeIcon = MODE_ICON[mode];

  const handleConfirm = () => {
    if (applying) return;
    if (mode === 'new') {
      onConfirm({ title: title.trim() || preview.defaultTitle, parentId: parentId || undefined });
      return;
    }
    onConfirm({});
  };

  const modal = (
    <motion.div
      className="surface-backdrop fixed inset-0 z-[1220] flex items-center justify-center px-4"
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
      exit={{ backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.16 }}
      onClick={(e) => { if (e.target === e.currentTarget && !applying) onCancel(); }}
    >
      <motion.div
        className="surface-popover flex flex-col rounded-[14px] border border-token-subtle"
        style={{ width: 'min(720px, 96vw)', height: '82vh', maxHeight: '82vh', minHeight: 0 }}
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-token-subtle shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
              style={{
                background: meta.danger ? 'rgba(248,113,113,0.16)' : 'rgba(96,165,250,0.16)',
                color: meta.danger ? 'rgba(252,165,165,0.95)' : 'rgba(147,197,253,0.95)',
                border: meta.danger
                  ? '1px solid rgba(248,113,113,0.30)'
                  : '1px solid rgba(96,165,250,0.30)',
              }}
            >
              <ModeIcon size={16} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-token-primary">{meta.title}</p>
              <p className="truncate text-[10px] text-token-muted mt-0.5">
                《{entryTitle}》
                {preview.kind === 'diff' && (
                  <span className="ml-2 font-mono">
                    <span style={{ color: 'rgba(110,231,158,0.95)' }}>+{preview.stats?.added ?? 0}</span>
                    {' '}
                    <span style={{ color: 'rgba(252,165,165,0.95)' }}>-{preview.stats?.removed ?? 0}</span>
                  </span>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={() => { if (!applying) onCancel(); }}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-token-muted hover:bg-white/8 transition-colors disabled:opacity-40"
            disabled={applying}
          >
            <X size={16} />
          </button>
        </div>

        {/* 破坏性写回的醒目提示 */}
        {meta.danger && !noChange && (
          <div className="px-5 pt-3 shrink-0">
            <div
              className="flex items-start gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[10.5px]"
              style={{
                background: 'rgba(248,113,113,0.10)',
                border: '1px solid rgba(248,113,113,0.22)',
                color: 'rgba(252,165,165,0.95)',
              }}
            >
              <AlertTriangle size={11} className="shrink-0 mt-0.5" />
              <span>替换会用下方「绿色」内容整体覆盖原文，「红色」部分将被删除。确认前请核对改动。</span>
            </div>
          </div>
        )}

        {/* new 模式：标题编辑 + 落点说明 */}
        {preview.kind === 'new' && (
          <div className="px-5 pt-3 shrink-0 space-y-2">
            <div>
              <label className="block mb-1 text-[11px] font-semibold text-token-muted">新文档标题</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                placeholder={preview.defaultTitle}
                disabled={applying}
                className="prd-field w-full rounded-[8px] px-3 py-2 text-[12px] outline-none disabled:opacity-60"
              />
            </div>
            {folderOptions.length > 0 && (
              <div>
                <label className="block mb-1 text-[11px] font-semibold text-token-muted">落到哪个目录</label>
                <select
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                  disabled={applying}
                  className="prd-field w-full rounded-[8px] px-3 py-2 text-[12px] outline-none disabled:opacity-60"
                >
                  <option value="">（与原文同目录）</option>
                  {folderOptions.map((f) => (
                    <option key={f.id} value={f.id}>
                      {`${'　'.repeat(f.depth)}${f.label}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <p className="text-[10px] text-token-muted">
              {folderOptions.length > 0
                ? '可选择落到知识库的某个目录；不选则与原文同目录。原文不会被修改。'
                : '将与《' + entryTitle + '》落在同一目录，原文不会被修改。'}
            </p>
          </div>
        )}

        {/* 内容区（唯一滚动层） */}
        <div
          className="flex-1 px-5 py-3"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {noChange ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-2 py-12">
              <div
                className="flex h-11 w-11 items-center justify-center rounded-[12px]"
                style={{ background: 'rgba(148,163,184,0.14)', color: 'rgba(203,213,225,0.9)' }}
              >
                <Check size={20} />
              </div>
              <p className="text-[12.5px] font-semibold text-token-primary">AI 输出与原文一致</p>
              <p className="text-[11px] text-token-muted max-w-[360px] leading-relaxed">
                没有任何行发生变化，无需替换。可以直接取消，或换个指令再试。
              </p>
            </div>
          ) : preview.kind === 'diff' ? (
            <DiffView lines={preview.diff ?? []} docTruncated={docTruncated} />
          ) : (
            <BodyView body={preview.body ?? ''} kind={preview.kind} />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-token-subtle shrink-0">
          <span className="text-[10px] text-token-muted">
            {applying ? '正在写入文档…' : '确认后才会写入，写入前原文保持不变'}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={applying}>取消</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleConfirm}
              disabled={applying || noChange}
            >
              {applying ? <MapSpinner size={12} /> : <Check size={12} />}
              {applying ? '写入中…' : meta.confirmLabel}
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );

  return createPortal(modal, document.body);
}

function DiffView({ lines, docTruncated }: { lines: { type: 'eq' | 'add' | 'del'; text: string }[]; docTruncated?: boolean }) {
  const shown = lines.slice(0, MAX_RENDER_LINES);
  const hidden = lines.length - shown.length;
  return (
    <div>
      {docTruncated && (
        <p className="mb-2 text-[10px]" style={{ color: 'rgba(251,191,36,0.95)' }}>
          原文较长，diff 预览基于前 4 万字；实际替换以完整内容为准。
        </p>
      )}
      <pre
        className="text-[11.5px] leading-relaxed font-mono whitespace-pre-wrap break-words rounded-[10px] p-3"
        style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        {shown.map((l, i) => {
          const bg = l.type === 'add'
            ? 'rgba(34,197,94,0.12)'
            : l.type === 'del' ? 'rgba(248,113,113,0.12)' : 'transparent';
          const color = l.type === 'add'
            ? 'rgba(134,239,172,0.98)'
            : l.type === 'del' ? 'rgba(252,165,165,0.96)' : 'rgba(255,255,255,0.62)';
          const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
          return (
            <div key={i} style={{ background: bg, color }} className="px-1 -mx-1">
              <span className="select-none opacity-60 mr-2">{sign}</span>
              {l.text || ' '}
            </div>
          );
        })}
      </pre>
      {hidden > 0 && (
        <p className="mt-2 text-[10px] text-token-muted">
          为保证流畅，仅展示前 {MAX_RENDER_LINES} 行差异，另有 {hidden} 行未显示（写入不受影响）。
        </p>
      )}
    </div>
  );
}

function BodyView({ body, kind }: { body: string; kind: 'append' | 'new' }) {
  const lines = body.split('\n');
  const shown = lines.slice(0, MAX_RENDER_LINES);
  const hidden = lines.length - shown.length;
  return (
    <div>
      <p className="mb-2 text-[10.5px] text-token-muted">
        {kind === 'append' ? '将把以下内容追加到原文末尾：' : '新文档正文预览：'}
      </p>
      <pre
        className="text-[11.5px] leading-relaxed font-mono whitespace-pre-wrap break-words rounded-[10px] p-3"
        style={{
          background: kind === 'append' ? 'rgba(34,197,94,0.08)' : 'rgba(0,0,0,0.22)',
          border: kind === 'append'
            ? '1px solid rgba(34,197,94,0.20)'
            : '1px solid rgba(255,255,255,0.06)',
          color: 'rgba(255,255,255,0.82)',
        }}
      >
        {shown.join('\n')}
      </pre>
      {hidden > 0 && (
        <p className="mt-2 text-[10px] text-token-muted">
          仅展示前 {MAX_RENDER_LINES} 行，另有 {hidden} 行未显示（写入不受影响）。
        </p>
      )}
    </div>
  );
}
