/**
 * 知识富文本编辑器 — contentEditable + 工具栏 + 图片（上传/粘贴/拖拽）+ 附件上传。
 * 产出 HTML（受控 value/onChange）；保存方负责把 contentType 置为 text/html。
 * 参考 product-agent/DynamicForm 的 RichTextField，额外支持附件（非图片文件插入为下载链接）。
 */
import { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Underline, Heading, List, ListOrdered, Link2, RemoveFormatting, Image as ImageIcon, Paperclip, Quote, Code } from 'lucide-react';
import { sanitizeHtml, cleanPastedHtml } from '@/lib/sanitizeHtml';
import { uploadAttachment } from '@/services/real/aiToolbox';
import { fileKindOf, fmtSize } from './shared';

export function RichKnowledgeEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  // 未聚焦时同步外部值（初次加载 / 切换条目），聚焦输入时不打断
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.innerHTML !== value) el.innerHTML = sanitizeHtml(value || '');
  }, [value]);

  const emit = () => { if (ref.current) onChange(ref.current.innerHTML); };
  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  };

  const insertHtmlAtCaret = (html: string) => {
    ref.current?.focus();
    document.execCommand('insertHTML', false, html);
    emit();
  };

  const insertImageFile = async (file: File) => {
    setUploading('图片');
    const res = await uploadAttachment(file);
    setUploading(null);
    if (res.success && res.data) {
      insertHtmlAtCaret(`<img src="${res.data.url}" alt="${res.data.fileName}" style="max-width:100%;border-radius:8px;margin:6px 0;" />`);
    }
  };

  const insertAttachmentFile = async (file: File) => {
    setUploading('附件');
    const res = await uploadAttachment(file);
    setUploading(null);
    if (res.success && res.data) {
      const { url, fileName, size } = res.data;
      // 附件以可点击下载块插入（contenteditable=false 防止误编辑内部结构）
      const kind = fileKindOf(res.data.mimeType);
      insertHtmlAtCaret(
        `<a href="${url}" target="_blank" rel="noreferrer" contenteditable="false" ` +
        `style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;margin:4px 0;border-radius:8px;` +
        `border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#cbd5e1;text-decoration:none;font-size:13px;">` +
        `${kind.label} · ${fileName}${size ? ` · ${fmtSize(size)}` : ''}</a>&nbsp;`
      );
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const img = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (img) {
      const file = img.getAsFile();
      if (file) { e.preventDefault(); void insertImageFile(file); return; }
    }
    const html = e.clipboardData.getData('text/html');
    if (html) { e.preventDefault(); insertHtmlAtCaret(cleanPastedHtml(html)); }
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
    if (url && url.trim()) exec('createLink', url.trim());
  };

  const clearFormatting = () => {
    if (!ref.current) return;
    ref.current.innerHTML = cleanPastedHtml(ref.current.innerHTML);
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

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden flex flex-col" style={{ minHeight: '60vh' }}>
      <input ref={imgInputRef} type="file" accept="image/*" multiple className="hidden" onChange={onPickImages} />
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onPickFiles} />
      <div className="shrink-0 flex items-center gap-0.5 px-2 py-1.5 border-b border-white/10 bg-white/[0.02] flex-wrap">
        <ToolBtn cls={btn} title="加粗" onClick={() => exec('bold')}><Bold size={14} /></ToolBtn>
        <ToolBtn cls={btn} title="斜体" onClick={() => exec('italic')}><Italic size={14} /></ToolBtn>
        <ToolBtn cls={btn} title="下划线" onClick={() => exec('underline')}><Underline size={14} /></ToolBtn>
        <ToolBtn cls={btn} title="标题" onClick={() => exec('formatBlock', 'H2')}><Heading size={14} /></ToolBtn>
        <ToolBtn cls={btn} title="引用" onClick={() => exec('formatBlock', 'BLOCKQUOTE')}><Quote size={14} /></ToolBtn>
        <ToolBtn cls={btn} title="代码块" onClick={() => exec('formatBlock', 'PRE')}><Code size={14} /></ToolBtn>
        <ToolBtn cls={btn} title="无序列表" onClick={() => exec('insertUnorderedList')}><List size={14} /></ToolBtn>
        <ToolBtn cls={btn} title="有序列表" onClick={() => exec('insertOrderedList')}><ListOrdered size={14} /></ToolBtn>
        <ToolBtn cls={btn} title="链接" onClick={addLink}><Link2 size={14} /></ToolBtn>
        <span className="w-px h-4 bg-white/10 mx-0.5" />
        <ToolBtn cls={btn} title="插入图片" onClick={() => imgInputRef.current?.click()}><ImageIcon size={14} /></ToolBtn>
        <ToolBtn cls={btn} title="上传附件" onClick={() => fileInputRef.current?.click()}><Paperclip size={14} /></ToolBtn>
        <ToolBtn cls={btn} title="清除格式" onClick={clearFormatting}><RemoveFormatting size={14} /></ToolBtn>
        <span className="ml-1 text-[10px] text-white/30">
          {uploading ? `${uploading}上传中…` : '可粘贴/拖拽图片、附件，粘贴自动去底色'}
        </span>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onPaste={onPaste}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="no-focus-ring flex-1 overflow-y-auto px-5 py-4 text-[14px] text-white/90 outline-none markdown-reading"
        style={{ lineHeight: 1.75, overscrollBehavior: 'contain' }}
      />
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
