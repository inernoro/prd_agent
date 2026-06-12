/**
 * 产品管理智能体 — 动态表单渲染 + 有效模板/流程解析（让全局设置真正驱动页面）。
 *
 * 字段控件：文本/数字/日期/下拉/用户/关联对象/富文本/附件等。
 *  - file 附件：多文件上传(uploadAttachment) + 图片缩略图/下载/删除，支持拖拽
 *  - richtext 富文本：contentEditable 排版工具栏(粗体/斜体/下划线/列表/标题) + 截图粘贴/拖拽上传
 *  - relation 对象关联：按 relationEntityType 拉本产品对象多选
 *  - user 用户选择：复用 UserSearchSelect
 * 值统一存 Record<string,string>（FormData）：附件=JSON数组、富文本=HTML、关系/多选=逗号 id、用户=userId。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, X, FileText, Bold, Italic, Underline, List, ListOrdered, Heading, RemoveFormatting } from 'lucide-react';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { sanitizeHtml, cleanPastedHtml } from '@/lib/sanitizeHtml';
import { uploadAttachment } from '@/services/real/aiToolbox';
import {
  listFormTemplates,
  listWorkflowDefinitions,
  listRequirements,
  listFeatures,
  listVersions,
  listCustomers,
} from '@/services/real/productAgent';
import type { FormField, FormTemplate, WorkflowDefinition, ProductEntityType } from './types';

export function useEffectiveTemplate(entityType: ProductEntityType, productId: string | null) {
  const [template, setTemplate] = useState<FormTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const res = await listFormTemplates({ entityType, productId: productId ?? undefined });
      if (!alive) return;
      if (res.success) {
        const items = res.data.items;
        const pick =
          items.find((t) => (t.productId ?? null) === productId && t.isDefault) ??
          items.find((t) => !t.productId && t.isDefault) ??
          items.find((t) => !t.productId) ??
          null;
        setTemplate(pick);
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [entityType, productId]);
  return { template, loading };
}

export function useEffectiveWorkflow(entityType: ProductEntityType, productId: string | null) {
  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      const res = await listWorkflowDefinitions({ entityType, productId: productId ?? undefined });
      if (!alive) return;
      if (res.success) {
        const items = res.data.items;
        const pick =
          items.find((w) => (w.productId ?? null) === productId && w.isDefault) ??
          items.find((w) => !w.productId && w.isDefault) ??
          items.find((w) => !w.productId) ??
          null;
        setWorkflow(pick);
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [entityType, productId]);
  return { workflow, loading };
}

/** 按模板字段渲染可编辑表单。productId 供关联对象字段拉取候选。 */
export function FormFieldsRenderer({
  fields,
  values,
  onChange,
  productId,
}: {
  fields: FormField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  productId?: string | null;
}) {
  if (fields.length === 0) return null;
  const sorted = [...fields].sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="flex flex-col gap-3">
      {sorted.map((f) => (
        <div key={f.key} className="flex flex-col gap-1">
          <label className="text-xs text-white/55">
            {f.label || f.key}
            {f.required && <span className="text-red-300/70 ml-1">*</span>}
          </label>
          <FieldControl field={f} value={values[f.key] ?? f.defaultValue ?? ''} onChange={(v) => onChange(f.key, v)} productId={productId ?? null} />
          {f.helpText && <span className="text-[11px] text-white/30">{f.helpText}</span>}
        </div>
      ))}
    </div>
  );
}

function FieldControl({ field, value, onChange, productId }: { field: FormField; value: string; onChange: (v: string) => void; productId: string | null }) {
  const base = 'px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40';
  switch (field.type) {
    case 'textarea':
      return <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={field.placeholder ?? ''} className={`${base} resize-none`} />;
    case 'richtext':
      return <RichTextField value={value} onChange={onChange} />;
    case 'file':
      return <FileField value={value} onChange={onChange} />;
    case 'relation':
      return <RelationField value={value} onChange={onChange} entityType={field.relationEntityType || inferRelationTarget(field.label)} productId={productId} />;
    case 'user':
      return <UserSearchSelect value={value} onChange={onChange} />;
    case 'number':
      return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? ''} className={base} />;
    case 'date':
      return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={base} />;
    case 'datetime':
      return <input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} className={base} />;
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 text-sm text-white/70">
          <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} className="accent-cyan-500" /> 是
        </label>
      );
    case 'select':
    case 'radio':
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={base}>
          <option value="">请选择</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case 'multiselect': {
      const selected = value ? value.split(',') : [];
      const toggle = (v: string) => {
        const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
        onChange(next.join(','));
      };
      return (
        <div className="flex flex-wrap gap-1.5">
          {(field.options ?? []).map((o) => (
            <button key={o.value} type="button" onClick={() => toggle(o.value)} className={`px-2.5 py-1 rounded-md text-xs border ${selected.includes(o.value) ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/50 border-white/10 hover:bg-white/5'}`}>
              {o.label}
            </button>
          ))}
        </div>
      );
    }
    default:
      return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? ''} className={base} />;
  }
}

// ════════════════════════ 附件字段 ════════════════════════
interface AttachItem { id: string; url: string; name: string; mime: string; size: number }

function parseAttachments(value: string): AttachItem[] {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function FileField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const items = parseAttachments(value);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    setUploading(true);
    const next = [...parseAttachments(value)];
    for (const file of Array.from(files)) {
      const res = await uploadAttachment(file);
      if (res.success && res.data) {
        next.push({ id: res.data.attachmentId, url: res.data.url, name: res.data.fileName, mime: res.data.mimeType, size: res.data.size });
      }
    }
    onChange(JSON.stringify(next));
    setUploading(false);
  }, [value, onChange]);

  const remove = (id: string) => onChange(JSON.stringify(parseAttachments(value).filter((x) => x.id !== id)));

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className="flex items-center justify-center gap-2 px-3 py-3 rounded-lg border border-dashed border-white/15 text-white/50 text-sm hover:border-cyan-500/40 hover:text-white/70 cursor-pointer"
      >
        {uploading ? <MapSpinner size={14} /> : <Upload size={15} />}
        {uploading ? '上传中…' : '点击或拖拽上传附件（图片/文档等）'}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {items.map((it) => (
            <div key={it.id} className="relative group rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden" style={{ width: 96 }}>
              <a href={it.url} target="_blank" rel="noreferrer" className="block">
                {it.mime?.startsWith('image/') ? (
                  <img src={it.url} alt={it.name} className="w-full h-20 object-cover" />
                ) : (
                  <div className="w-full h-20 flex items-center justify-center text-white/40"><FileText size={24} /></div>
                )}
                <div className="px-1.5 py-1 text-[10px] text-white/60 truncate">{it.name}</div>
              </a>
              <button onClick={() => remove(it.id)} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white/70 hover:text-red-300 flex items-center justify-center opacity-0 group-hover:opacity-100">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════ 富文本字段（排版 + 截图粘贴上传）════════════════════════
export function RichTextField({ value, onChange, minHeight = 120, placeholder }: { value: string; onChange: (v: string) => void; minHeight?: number; placeholder?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [uploading, setUploading] = useState(false);

  // 未聚焦时同步外部值（初次加载 / 切换对象），聚焦输入时不打断
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.innerHTML !== value) el.innerHTML = sanitizeHtml(value);
  }, [value]);

  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    if (ref.current) onChange(ref.current.innerHTML);
  };

  const insertImageFile = useCallback(async (file: File) => {
    setUploading(true);
    const res = await uploadAttachment(file);
    setUploading(false);
    if (res.success && res.data) {
      ref.current?.focus();
      document.execCommand('insertHTML', false, `<img src="${res.data.url}" alt="${res.data.fileName}" style="max-width:100%;border-radius:8px;margin:4px 0;" />`);
      if (ref.current) onChange(ref.current.innerHTML);
    }
  }, [onChange]);

  const onPaste = (e: React.ClipboardEvent) => {
    // 1) 截图 → 上传
    const img = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (img) {
      const file = img.getAsFile();
      if (file) {
        e.preventDefault();
        void insertImageFile(file);
        return;
      }
    }
    // 2) 富文本 → 清洗后再插入（剥离来源页的背景/颜色/字体，只留结构，融入当前主题）
    const html = e.clipboardData.getData('text/html');
    if (html) {
      e.preventDefault();
      document.execCommand('insertHTML', false, cleanPastedHtml(html));
      if (ref.current) onChange(ref.current.innerHTML);
    }
    // 3) 纯文本 → 走浏览器默认（已是无样式）
  };

  /** 一键清除整段格式：剥离已粘贴内容里的背景/颜色/字体等表现型样式，只留结构。 */
  const clearFormatting = () => {
    if (!ref.current) return;
    ref.current.innerHTML = cleanPastedHtml(ref.current.innerHTML);
    onChange(ref.current.innerHTML);
  };

  const btn = 'w-7 h-7 flex items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/10';
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-white/10 bg-white/[0.02]">
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('bold')} className={btn} title="加粗"><Bold size={14} /></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('italic')} className={btn} title="斜体"><Italic size={14} /></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('underline')} className={btn} title="下划线"><Underline size={14} /></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('formatBlock', 'H3')} className={btn} title="标题"><Heading size={14} /></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertUnorderedList')} className={btn} title="无序列表"><List size={14} /></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('insertOrderedList')} className={btn} title="有序列表"><ListOrdered size={14} /></button>
        <span className="w-px h-4 bg-white/10 mx-0.5" />
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={clearFormatting} className={btn} title="清除格式（去底色/颜色/字体，只留结构）"><RemoveFormatting size={14} /></button>
        <span className="ml-1 text-[10px] text-white/30">{uploading ? '图片上传中…' : '粘贴自动去底色 · 可直接粘贴截图'}</span>
      </div>
      <div className="relative">
        {placeholder && !value && (
          <div className="absolute top-2 left-3 text-sm text-white/25 pointer-events-none">{placeholder}</div>
        )}
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          onInput={() => onChange(ref.current?.innerHTML ?? '')}
          onPaste={onPaste}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('image/'));
            if (f) {
              e.preventDefault();
              void insertImageFile(f);
            }
          }}
          className="px-3 py-2 text-sm text-white/90 outline-none prose-product"
          style={{ lineHeight: 1.6, minHeight }}
        />
      </div>
    </div>
  );
}

// ════════════════════════ 对象关联字段 ════════════════════════
/** 模板未显式配置关联目标时，从字段标签兜底推断（兼容旧模板）。 */
function inferRelationTarget(label?: string): string | undefined {
  if (!label) return undefined;
  if (label.includes('客户')) return 'customer';
  if (label.includes('功能')) return 'feature';
  if (label.includes('需求')) return 'requirement';
  if (label.includes('版本')) return 'version';
  return undefined;
}

function RelationField({ value, onChange, entityType, productId }: { value: string; onChange: (v: string) => void; entityType?: string | null; productId: string | null }) {
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = value ? value.split(',').filter(Boolean) : [];

  useEffect(() => {
    if (!productId || !entityType) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      let opts: { id: string; label: string }[] = [];
      if (entityType === 'requirement') {
        const r = await listRequirements(productId);
        if (r.success) opts = r.data.items.map((x) => ({ id: x.id, label: x.title }));
      } else if (entityType === 'feature') {
        const r = await listFeatures(productId);
        if (r.success) opts = r.data.items.map((x) => ({ id: x.id, label: x.title }));
      } else if (entityType === 'version') {
        const r = await listVersions(productId);
        if (r.success) opts = r.data.items.map((x) => ({ id: x.id, label: x.versionName }));
      } else if (entityType === 'customer') {
        const r = await listCustomers();
        if (r.success) opts = r.data.items.map((x) => ({ id: x.id, label: x.name }));
      }
      if (alive) {
        setOptions(opts);
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [productId, entityType]);

  if (!entityType) return <div className="text-[11px] text-white/30">未配置关联对象类型</div>;
  const labelOf = (id: string) => options.find((o) => o.id === id)?.label ?? id;
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    onChange(next.join(','));
  };
  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  return (
    <div className="rounded-lg border border-white/10 bg-white/5">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-white/70">
        <span className="flex flex-wrap gap-1 min-w-0">
          {selected.length === 0 ? <span className="text-white/40">点击选择关联对象</span> : selected.map((id) => (
            <span key={id} className="text-[11px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-200 inline-flex items-center gap-1 max-w-[160px]">
              <span className="truncate">{labelOf(id)}</span>
              <X size={11} className="shrink-0 hover:text-white" onClick={(e) => { e.stopPropagation(); toggle(id); }} />
            </span>
          ))}
        </span>
        <span className="text-white/30 text-xs shrink-0">{open ? '收起' : selected.length > 0 ? `已选 ${selected.length}` : '展开'}</span>
      </button>
      {open && (
        <div className="border-t border-white/10">
          <div className="p-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`搜索${options.length > 0 ? `（共 ${options.length} 项）` : ''}…`}
              className="w-full px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white outline-none focus:border-cyan-500/40"
            />
          </div>
          <div className="max-h-60 overflow-y-auto px-1 pb-1" style={{ overscrollBehavior: 'contain' }}>
            {loading ? (
              <div className="text-[11px] text-white/40 py-3 text-center">加载中…</div>
            ) : filtered.length === 0 ? (
              <div className="text-[11px] text-white/30 py-3 text-center">{options.length === 0 ? '没有可选对象' : '无匹配结果'}</div>
            ) : (
              filtered.map((o) => (
                <label key={o.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5 cursor-pointer">
                  <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} className="accent-cyan-500 shrink-0" />
                  <span className="text-sm text-white/80 truncate">{o.label}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
