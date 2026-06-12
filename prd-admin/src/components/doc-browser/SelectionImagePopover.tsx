import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ImagePlus } from 'lucide-react';
import { VisualCreationMiniPanel } from '@/components/visual-creation/VisualCreationMiniPanel';

// 划词「配图」浮层：右侧悬浮卡片内嵌真实视觉创作 mini 面板（appKey=visual-agent），
// 以选中片段 + 文档上下文为提示词生成配图，插入到选区所在段落之后。
// 布局遵 frontend-modal.md：createPortal 到 body + inline style 高度 + min-h-0 滚动。

/** 以选中片段为核心、带上下文的配图提示词（与 ReprocessChatDrawer 的文学配图同思路） */
export function buildSelectionIllustrationPrompt(selectedText: string, docTitle: string): string {
  const excerpt = selectedText.trim().slice(0, 1800);
  return [
    `基于文档《${docTitle}》中的这段内容生成一张配图：`,
    excerpt,
    '画面要求：提炼这段文字的核心意象与情绪，做成可直接插入文档的横版配图；避免复刻具体 UI 截图，文字元素只保留必要标题或短句。',
  ].filter(Boolean).join('\n\n');
}

export function SelectionImagePopover({
  docTitle,
  docContent,
  selectedText,
  onInsertImage,
  onClose,
}: {
  docTitle: string;
  docContent: string;
  selectedText: string;
  /** 把生成的图插入选区后（父级负责拼 markdown + 写回） */
  onInsertImage: (url: string, name?: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const node = (
    <div
      className="fixed z-[120] flex flex-col"
      style={{
        top: 64,
        right: 16,
        width: 420,
        maxWidth: 'calc(100vw - 32px)',
        height: Math.min(680, window.innerHeight - 96),
        borderRadius: 14,
        background: 'linear-gradient(180deg, rgba(30,28,46,0.97), rgba(20,19,28,0.98))',
        border: '1px solid rgba(168,85,247,0.4)',
        boxShadow: '0 18px 44px -10px rgba(0,0,0,0.6)',
        backdropFilter: 'blur(40px)',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-2 shrink-0">
        <span className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: 'rgba(216,180,254,0.9)' }}>
          <ImagePlus size={12} />
          为选中内容配图
        </span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded-[6px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors"
          style={{ color: 'var(--text-muted)' }}
          title="关闭"
        >
          <X size={13} />
        </button>
      </div>
      <div className="px-3 pb-3 overflow-y-auto" style={{ flex: 1, minHeight: 0, overscrollBehavior: 'contain' }}>
        {/* 不传 onInsertImageWithText：划词场景原文已在文档里，「插入原文+配图」语义不成立，隐藏该按钮（Codex P2） */}
        <VisualCreationMiniPanel
          appKey="visual-agent"
          docTitle={docTitle}
          docContent={docContent}
          initialPrompt={buildSelectionIllustrationPrompt(selectedText, docTitle)}
          onInsertImage={(url, name) => onInsertImage(url, name)}
        />
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
