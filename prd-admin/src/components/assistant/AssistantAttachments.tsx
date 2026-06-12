/**
 * AI 助手「上传附件作为上下文」共享件（项目管理 / 产品管理智能体共用）。
 *
 * 流程：选择 .md / .pdf → POST {extractUrl}（multipart，后端提取纯文本）→ 文本驻留前端，
 * 随提问通过 ask body 的 attachments 回传给后端拼进上下文。无状态设计，服务端不存附件。
 *
 * 两个导出：
 * - AttachmentUploadButton：输入框左下角的回形针按钮（含隐藏 input、上传中转圈、错误 toast）
 * - AttachmentChips：已添加附件的胶囊行（文件名 + 字数 + 截断标记 + 移除）
 */
import { useRef, useState } from 'react';
import { Paperclip, FileText, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';

export interface AssistantAttachment {
  name: string;
  text: string;
  chars: number;
  truncated?: boolean;
}

export const MAX_ASSISTANT_ATTACHMENTS = 3;

const ACCEPT = '.md,.markdown,.pdf';

export function AttachmentUploadButton({
  extractUrl,
  attachments,
  onAdd,
  disabled,
}: {
  /** 附件解析端点（如 /api/pm/assistant/attachments） */
  extractUrl: string;
  attachments: AssistantAttachment[];
  onAdd: (item: AssistantAttachment) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const full = attachments.length >= MAX_ASSISTANT_ATTACHMENTS;

  const pick = () => {
    if (full) {
      toast.error('附件已达上限', `一次提问最多携带 ${MAX_ASSISTANT_ATTACHMENTS} 个文档`);
      return;
    }
    inputRef.current?.click();
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    setUploading(true);
    try {
      // FormData 上传不能走 apiRequest（会被 JSON 序列化），必须直接 fetch
      const token = useAuthStore.getState().token;
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(extractUrl, {
        method: 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: fd,
        credentials: 'include',
      });
      const json = (await res.json()) as ApiResponse<AssistantAttachment>;
      if (json.success) {
        onAdd(json.data);
        if (json.data.truncated) toast.info('文档较长已截断', `「${json.data.name}」仅保留前 ${json.data.chars} 字`);
      } else {
        toast.error('附件解析失败', json.error?.message || '');
      }
    } catch {
      toast.error('附件上传失败', '网络异常，请重试');
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={onFile} />
      <button
        onClick={pick}
        disabled={disabled || uploading}
        className="flex items-center justify-center w-8 h-8 rounded-lg border bg-white/5 text-white/55 border-white/10 hover:text-white hover:bg-white/10 disabled:opacity-40 transition-colors"
        title={full ? `最多 ${MAX_ASSISTANT_ATTACHMENTS} 个附件` : '上传附件作为上下文（支持 md / pdf）'}
      >
        {uploading ? <MapSpinner size={14} /> : <Paperclip size={15} />}
      </button>
    </>
  );
}

export function AttachmentChips({
  items,
  onRemove,
  accent = '#22D3EE',
}: {
  items: AssistantAttachment[];
  onRemove: (index: number) => void;
  /** 强调色（产品=青 #22D3EE，项目=蓝 #3B82F6） */
  accent?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((f, i) => (
        <span
          key={`${f.name}-${i}`}
          className="inline-flex items-center gap-1.5 max-w-full text-[11px] px-2 py-1 rounded-lg border"
          style={{ color: 'rgba(255,255,255,0.75)', borderColor: `${accent}40`, background: `${accent}14` }}
          title={`${f.name} · 已提取 ${f.chars} 字${f.truncated ? '（已截断）' : ''}`}
        >
          <FileText size={11} className="shrink-0" style={{ color: accent }} />
          <span className="truncate" style={{ maxWidth: 180 }}>{f.name}</span>
          <span className="text-white/35 shrink-0">{f.chars}字{f.truncated ? '·截断' : ''}</span>
          <button onClick={() => onRemove(i)} className="shrink-0 text-white/40 hover:text-white" title="移除附件">
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}
