import { useState } from 'react';
import { Eye, PencilLine } from 'lucide-react';
import { RichTextMarkdownContent } from '../components/RichTextMarkdownContent';

/** 章节正文输入：文本框 + 预览切换（预览复用周报的 Markdown 渲染） */
export function MarkdownField({
  value,
  onChange,
  placeholder,
  minRows = 5,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  minRows?: number;
  testId?: string;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-end">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded hover-bg-soft"
          style={{ color: 'var(--text-muted)' }}
          onClick={() => setPreview((p) => !p)}
        >
          {preview ? <PencilLine size={11} /> : <Eye size={11} />}
          {preview ? '继续编辑' : '预览'}
        </button>
      </div>
      {preview ? (
        <div
          className="rounded-lg px-3 py-2.5 min-h-[96px]"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          {value.trim() ? (
            <RichTextMarkdownContent content={value} />
          ) : (
            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>（还没有内容）</span>
          )}
        </div>
      ) : (
        <textarea
          className="w-full text-[13px] leading-relaxed px-3 py-2.5 rounded-lg resize-y"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' }}
          rows={minRows}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
      )}
    </div>
  );
}
