import { useState } from 'react';
import { Send } from 'lucide-react';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import type { DocumentInlineComment } from '@/services/contracts/documentStore';
import { MapSpinner } from '@/components/ui/VideoLoader';

// 划词评论各布局（右侧批注栏 / 内联展开 / 抽屉）共用的小部件：
// 时间格式化、头像、单条评论行、就地回复输入框。避免三处各写一份。

export function formatRelative(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso).getTime();
  const diff = Date.now() - date;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

/** 把同一段被批注文字归一化为分组 key（去多余空白）。overlay 与批注栏必须用同一函数，hover 联动才对得上。 */
export function groupKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 用户头像：走可配置 CDN 前缀，加载失败回退内联 SVG，永不裂图。 */
export function CommentAvatar({
  name,
  avatar,
  size = 26,
}: {
  name?: string;
  avatar?: string | null;
  size?: number;
}) {
  return (
    <img
      className="rounded-full object-cover flex-none"
      width={size}
      height={size}
      src={resolveAvatarUrl({ avatarFileName: avatar })}
      alt={name ?? ''}
      onError={(e) => {
        const t = e.currentTarget;
        if (t.src !== DEFAULT_AVATAR_FALLBACK) t.src = DEFAULT_AVATAR_FALLBACK;
      }}
    />
  );
}

/** 单条评论行：头像 + 名字 + 相对时间 + 内容（+ 可选删除）。 */
export function CommentLine({
  comment,
  canDelete,
  onDelete,
}: {
  comment: DocumentInlineComment;
  canDelete?: boolean;
  onDelete?: (c: DocumentInlineComment) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <CommentAvatar name={comment.authorDisplayName} avatar={comment.authorAvatar} size={26} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {comment.authorDisplayName}
          </span>
          <span className="text-[9.5px] flex-none" style={{ color: 'var(--text-muted)' }}>
            {formatRelative(comment.createdAt)}
          </span>
          {canDelete && onDelete && (
            <button
              onClick={() => onDelete(comment)}
              className="ml-auto text-[9.5px] cursor-pointer opacity-50 hover:opacity-100 transition-opacity flex-none"
              style={{ color: 'rgba(239,68,68,0.85)' }}
              title="删除评论"
            >
              删除
            </button>
          )}
        </div>
        <p className="text-[12px] whitespace-pre-wrap break-words mt-0.5" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.78))' }}>
          {comment.content}
        </p>
      </div>
    </div>
  );
}

/** 就地回复输入框：写完回车或点发送，调 onSubmit；成功后自清空。 */
export function ReplyBox({
  placeholder = '回复…',
  onSubmit,
}: {
  placeholder?: string;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const submit = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    const ok = await onSubmit(t);
    setSending(false);
    if (ok) setText('');
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        className="flex-1 h-7 rounded-[8px] px-2.5 text-[11.5px] outline-none"
        style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', color: 'var(--text-primary)' }}
      />
      <button
        onClick={submit}
        disabled={sending || !text.trim()}
        className="h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex-none"
        style={{ background: 'rgba(168,85,247,0.18)', border: '1px solid rgba(168,85,247,0.32)', color: 'rgba(216,180,254,0.97)' }}
        title="发送回复"
      >
        {sending ? <MapSpinner size={12} /> : <Send size={12} />}
      </button>
    </div>
  );
}
