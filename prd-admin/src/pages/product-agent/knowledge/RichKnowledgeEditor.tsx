/**
 * 知识编辑器 — 富文本 / Markdown 双模式，统一外壳（同卡片 + 同工具栏布局）。
 *
 * 富文本：contentEditable + 工具栏（加粗/斜体/下划线/颜色/标题/引用/代码块/列表/链接）
 *         + 图片（上传/粘贴/拖拽）+ 附件上传，产出 HTML。
 * Markdown：等宽 textarea + md 语法工具栏（在光标处插入语法）+ 图片/附件上传（插入 md 语法）。
 * 工具栏右侧可切换模式，由父组件负责正文 HTML↔Markdown 转换。
 */
import { useEffect, useRef, useState } from 'react';
import {
  Bold, Italic, Underline, Heading, List, ListOrdered, Link2, RemoveFormatting,
  Image as ImageIcon, Paperclip, Quote, Code, Palette, FileText, FileCode,
} from 'lucide-react';
import { sanitizeHtml, cleanPastedHtml } from '@/lib/sanitizeHtml';
import { uploadAttachment } from '@/services/real/aiToolbox';
import { fileKindOf, fmtSize } from './shared';
import './knowledge.css';

export type EditorMode = 'rich' | 'md';

const COLOR_PALETTE = ['#f87171', '#fb923c', '#fbbf24', '#4ade80', '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6'];

interface Props {
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
  value: string;
  onChange: (v: string) => void;
}

export function KnowledgeEditor({ mode, onModeChange, value, onChange }: Props) {
  const richRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [colorOpen, setColorOpen] = useState(false);

  // ── 富文本：未聚焦时同步外部值 ──
  useEffect(() => {
    if (mode !== 'rich') return;
    const el = richRef.current;
    if (el && document.activeElement !== el && el.innerHTML !== value) el.innerHTML = sanitizeHtml(value || '');
  }, [value, mode]);

  const emit = () => { if (richRef.current) onChange(richRef.current.innerHTML); };

  const ensureCaret = () => {
    const el = richRef.current;
    if (!el) return;
    const sel = window.getSelection();
    const inEditor = sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer);
    el.focus();
    if (!inEditor) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  };

  const exec = (cmd: string, arg?: string, styleWithCss = false) => {
    ensureCaret();
    try { document.execCommand('styleWithCSS', false, styleWithCss ? 'true' : 'false'); } catch { /* ignore */ }
    document.execCommand(cmd, false, arg);
    emit();
  };

  const toggleBlock = (tag: string) => {
    ensureCaret();
    let cur = '';
    try { cur = (document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch { /* ignore */ }
    document.execCommand('formatBlock', false, cur === tag.toLowerCase() ? '<p>' : `<${tag}>`);
    emit();
  };

  const insertHtmlAtCaret = (htmlStr: string) => {
    ensureCaret();
    document.execCommand('insertHTML', false, htmlStr);
    emit();
  };

  // ── Markdown：在 textarea 光标处插入/包裹 ──
  const mdInsert = (before: string, after = '', placeholder = '') => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + before.length + selected.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  /** 行首插入（标题/引用/列表）：作用于光标所在行 */
  const mdLinePrefix = (prefix: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + prefix.length, start + prefix.length);
    });
  };

  // ── 图片 / 附件：两种模式共用上传，按模式产出 HTML 或 md 语法 ──
  const insertImageFile = async (file: File) => {
    setUploading('图片');
    const res = await uploadAttachment(file);
    setUploading(null);
    if (!res.success || !res.data) return;
    const { url, fileName } = res.data;
    if (mode === 'rich') insertHtmlAtCaret(`<img src="${url}" alt="${fileName}" style="max-width:100%;border-radius:8px;margin:6px 0;" />`);
    else mdInsert(`\n![${fileName}](${url})\n`);
  };

  const insertAttachmentFile = async (file: File) => {
    setUploading('附件');
    const res = await uploadAttachment(file);
    setUploading(null);
    if (!res.success || !res.data) return;
    const { url, fileName, size, mimeType } = res.data;
    if (mode === 'rich') {
      const kind = fileKindOf(mimeType);
      insertHtmlAtCaret(
        `<a href="${url}" target="_blank" rel="noreferrer" contenteditable="false" ` +
        `style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;margin:4px 0;border-radius:8px;` +
        `border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#cbd5e1;text-decoration:none;font-size:13px;">` +
        `${kind.label} · ${fileName}${size ? ` · ${fmtSize(size)}` : ''}</a>&nbsp;`
      );
    } else mdInsert(`\n[${fileName}](${url})\n`);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const img = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (img) {
      const file = img.getAsFile();
      if (file) { e.preventDefault(); void insertImageFile(file); return; }
    }
    if (mode === 'rich') {
      const htmlData = e.clipboardData.getData('text/html');
      if (htmlData) { e.preventDefault(); insertHtmlAtCaret(cleanPastedHtml(htmlData)); }
    }
  };

  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      if (f.type.startsWith('image/')) void insertImageFile(f);
      else void insertAttachmentFile(f);
    }
  };

  const addLink = () => {
    const url = window.prompt('输入链接地址（含 https://）');
    if (!url || !url.trim()) return;
    if (mode === 'rich') exec('createLink', url.trim());
    else mdInsert('[', `](${url.trim()})`, '链接文字');
  };

  const clearFormatting = () => {
    if (!richRef.current) return;
    richRef.current.innerHTML = cleanPastedHtml(richRef.current.innerHTML);
    emit();
  };

  const onPickImages = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fs = Array.from(e.target.files ?? []);
    e.currentTarget.value = '';
    for (const f of fs) void insertImageFile(f);
  };
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fs = Array.from(e.target.files ?? []);
    e.currentTarget.value = '';
    for (const f of fs) void insertAttachmentFile(f);
  };

  const btn = 'w-7 h-7 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/10';
  const isRich = mode === 'rich';

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden flex flex-col" style={{ minHeight: '64vh' }}>
      <input ref={imgInputRef} type="file" accept="image/*" multiple className="hidden" onChange={onPickImages} />
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onPickFiles} />

      <div className="shrink-0 flex items-center gap-0.5 px-2 py-1.5 border-b border-white/10 bg-white/[0.02] flex-wrap">
        {isRich ? (
          <>
            <ToolBtn cls={btn} title="加粗" onClick={() => exec('bold')}><Bold size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="斜体" onClick={() => exec('italic')}><Italic size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="下划线" onClick={() => exec('underline')}><Underline size={14} /></ToolBtn>
            <span className="relative">
              <ToolBtn cls={btn} title="文字颜色" onClick={() => setColorOpen((v) => !v)}><Palette size={14} /></ToolBtn>
              {colorOpen && (
                <div className="absolute top-8 left-0 z-20 flex items-center gap-1 p-1.5 rounded-lg border border-white/10 bg-[#1b1d22] shadow-xl">
                  {COLOR_PALETTE.map((c) => (
                    <button
                      key={c}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { exec('foreColor', c, true); setColorOpen(false); }}
                      className="w-5 h-5 rounded-full border border-white/20 hover:scale-110 transition-transform"
                      style={{ background: c }}
                      title={c}
                    />
                  ))}
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { exec('foreColor', 'rgba(255,255,255,0.9)', true); setColorOpen(false); }}
                    className="px-1.5 h-5 rounded text-[10px] text-white/60 border border-white/15 hover:bg-white/10"
                  >
                    默认
                  </button>
                </div>
              )}
            </span>
            <span className="w-px h-4 bg-white/10 mx-0.5" />
            <ToolBtn cls={btn} title="标题（再点回正文）" onClick={() => toggleBlock('h2')}><Heading size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="引用（再点回正文）" onClick={() => toggleBlock('blockquote')}><Quote size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="代码块（再点回正文）" onClick={() => toggleBlock('pre')}><Code size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="无序列表" onClick={() => exec('insertUnorderedList')}><List size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="有序列表" onClick={() => exec('insertOrderedList')}><ListOrdered size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="链接" onClick={addLink}><Link2 size={14} /></ToolBtn>
            <span className="w-px h-4 bg-white/10 mx-0.5" />
            <ToolBtn cls={btn} title="插入图片" onClick={() => imgInputRef.current?.click()}><ImageIcon size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="上传附件" onClick={() => fileInputRef.current?.click()}><Paperclip size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="清除格式" onClick={clearFormatting}><RemoveFormatting size={14} /></ToolBtn>
          </>
        ) : (
          <>
            <ToolBtn cls={btn} title="加粗" onClick={() => mdInsert('**', '**', '加粗文字')}><Bold size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="斜体" onClick={() => mdInsert('*', '*', '斜体文字')}><Italic size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="行内代码" onClick={() => mdInsert('`', '`', 'code')}><Code size={14} /></ToolBtn>
            <span className="w-px h-4 bg-white/10 mx-0.5" />
            <ToolBtn cls={btn} title="标题" onClick={() => mdLinePrefix('## ')}><Heading size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="引用" onClick={() => mdLinePrefix('> ')}><Quote size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="无序列表" onClick={() => mdLinePrefix('- ')}><List size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="有序列表" onClick={() => mdLinePrefix('1. ')}><ListOrdered size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="代码块" onClick={() => mdInsert('\n```\n', '\n```\n', '代码')}><FileCode size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="链接" onClick={addLink}><Link2 size={14} /></ToolBtn>
            <span className="w-px h-4 bg-white/10 mx-0.5" />
            <ToolBtn cls={btn} title="插入图片" onClick={() => imgInputRef.current?.click()}><ImageIcon size={14} /></ToolBtn>
            <ToolBtn cls={btn} title="上传附件" onClick={() => fileInputRef.current?.click()}><Paperclip size={14} /></ToolBtn>
          </>
        )}

        <span className="ml-1 text-[10px] text-white/30">
          {uploading ? `${uploading}上传中…` : isRich ? '可粘贴/拖拽图片、附件' : 'Markdown 语法 · 可粘贴/拖拽图片、附件'}
        </span>

        {/* 模式切换（父组件负责正文转换） */}
        <div className="ml-auto flex items-center rounded-lg border border-white/10 overflow-hidden">
          <button
            onClick={() => onModeChange('rich')}
            className={`flex items-center gap-1 px-2 py-1 text-[11px] ${isRich ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}
            title="富文本编辑"
          >
            <FileText size={12} /> 富文本
          </button>
          <button
            onClick={() => onModeChange('md')}
            className={`flex items-center gap-1 px-2 py-1 text-[11px] ${!isRich ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}
            title="Markdown 编辑"
          >
            <FileCode size={12} /> Markdown
          </button>
        </div>
      </div>

      {isRich ? (
        <div
          ref={richRef}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onPaste={onPaste}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className="no-focus-ring knowledge-rich flex-1 overflow-y-auto px-7 py-6 text-[14.5px] outline-none"
          style={{ lineHeight: 1.85, overscrollBehavior: 'contain' }}
        />
      ) : (
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          spellCheck={false}
          placeholder="用 Markdown 书写知识内容…"
          className="no-focus-ring flex-1 overflow-y-auto px-7 py-6 text-[13.5px] leading-relaxed text-white/90 font-mono bg-transparent outline-none resize-none"
          style={{ overscrollBehavior: 'contain' }}
        />
      )}
    </div>
  );
}

function ToolBtn({ cls, title, onClick, children }: { cls: string; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onClick} className={cls} title={title}>
      {children}
    </button>
  );
}

/** 文件类型图标徽标（详情头部 / 列表复用，避免重复 fileKindOf 调用样板） */
export function FileKindBadge({ contentType }: { contentType: string | undefined }) {
  const k = fileKindOf(contentType);
  const Icon = k.icon;
  return (
    <span className="text-[11px] px-1.5 py-0.5 rounded inline-flex items-center gap-1" style={{ color: k.color, background: `${k.color}1a` }}>
      <Icon size={11} /> {k.label}
    </span>
  );
}
