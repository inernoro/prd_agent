/**
 * 产品管理智能体 — 对象动态/讨论时间线（评论 + 系统活动合流，参考 Jira / Linear）。
 *
 * 自加载 GET activities；底部评论输入（@ 提醒成员，微信式下拉选人）。系统活动(流转/指派/转化)与
 * 评论按时间正序混排。发表评论后会通知 @提醒人 / 处理人 / 负责人(后端负责)。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquare, ArrowRight, UserPlus, GitBranch, Sparkles, Send } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { MentionTextarea, extractMentionIds } from '@/components/MentionTextarea';
import { searchDirectoryUsers } from '@/services';
import { sanitizeHtml } from '@/lib/sanitizeHtml';
import { enrichContentWithMentions } from '@/lib/mentionRender';
import { listActivities, addComment, type ProductActivity } from '@/services/real/productAgent';
import './product-cards.css';

function fmt(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ActivityTimeline({
  entityType,
  entityId,
  filter = 'all',
}: {
  entityType: string;
  entityId: string;
  /** comment=仅评论；system=仅流转/指派等；all=全部 */
  filter?: 'all' | 'comment' | 'system';
}) {
  const [items, setItems] = useState<ProductActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [posting, setPosting] = useState(false);
  const [users, setUsers] = useState<Array<{ userId: string; displayName: string; username?: string; avatarFileName?: string | null }>>([]);

  const reload = useCallback(async () => {
    const res = await listActivities(entityType, entityId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [entityType, entityId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  // 干系人目录走 /api/teams/search-users（仅需登录），普通产品成员也能搜，
  // 不再误用管理员专用的 /api/users（非管理员会 403 → 列表空 → 无法 @ 提醒）。
  useEffect(() => {
    void searchDirectoryUsers('', 200).then((res) => {
      if (res.success) {
        setUsers(res.data.items.map((u) => ({
          userId: u.userId,
          username: u.username,
          displayName: u.displayName,
          avatarFileName: u.avatarFileName,
        })));
      }
    });
  }, []);

  const visibleItems = useMemo(() => {
    if (filter === 'comment') return items.filter((a) => a.type === 'comment');
    if (filter === 'system') return items.filter((a) => a.type !== 'comment');
    return items;
  }, [items, filter]);

  const empty = content.trim() === '';

  const submit = async () => {
    if (empty) return;
    setPosting(true);
    const mentions = extractMentionIds(content, users);
    const html = content.trim().replace(/\n/g, '<br>');
    const res = await addComment(entityType, entityId, { content: html, mentions });
    setPosting(false);
    if (res.success) {
      setContent('');
      setMentionIds([]);
      await reload();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {loading ? (
        <div className="text-[11px] text-white/30 py-2">加载动态…</div>
      ) : visibleItems.length === 0 ? (
        <div className="text-[11px] text-white/30">
          {filter === 'comment' ? '还没有评论。' : filter === 'system' ? '还没有变更记录。' : '还没有动态。状态流转、指派、评论都会出现在这里。'}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visibleItems.map((a) => (
            <ActivityRow key={a.id} a={a} />
          ))}
        </div>
      )}

      {/* 评论输入 */}
      {filter !== 'system' ? <div className="flex flex-col gap-2 pt-1 border-t border-white/5">
        <MentionTextarea
          value={content}
          onChange={setContent}
          users={users}
          onMentionIdsChange={setMentionIds}
          minHeight={90}
          placeholder="写下评论，输入 @ 提醒成员（支持上下键选择，回车确认）"
          disabled={posting}
        />
        <div className="flex items-center gap-2 flex-wrap">
          {mentionIds.length > 0 && (
            <span className="text-[11px] text-white/40">
              将提醒 {mentionIds.length} 人
            </span>
          )}
          <button
            onClick={submit}
            disabled={empty || posting}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
          >
            {posting ? <MapSpinner size={14} /> : <Send size={14} />} 评论
          </button>
        </div>
      </div> : null}
    </div>
  );
}

function ActivityRow({ a }: { a: ProductActivity }) {
  if (a.type === 'comment') {
    return (
      <div className="pa-row flex flex-col gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="flex items-center gap-2">
          <MessageSquare size={13} className="text-cyan-300/80" />
          <span className="text-xs text-white/80">{a.actorName || a.actorId}</span>
          <span className="text-[10px] text-white/35 ml-auto">{fmt(a.createdAt)}</span>
        </div>
        <div className="text-sm text-white/85 prose-product pl-5" dangerouslySetInnerHTML={{ __html: sanitizeHtml(enrichContentWithMentions(a.content ?? '')) }} />
      </div>
    );
  }
  // 系统活动一行式
  const meta = SYSTEM_META[a.type] ?? { icon: Sparkles, color: '#9ca3af' };
  const Icon = meta.icon;
  return (
    <div className="flex items-center gap-2 text-[12px] text-white/55 px-1">
      <Icon size={13} style={{ color: meta.color }} />
      <span className="text-white/70">{a.actorName || a.actorId}</span>
      {a.type === 'transition' && (
        <span className="flex items-center gap-1">
          将状态 <span className="text-white/45">{a.fromValue}</span> <ArrowRight size={11} /> <span className="text-white/80">{a.toValue}</span>
        </span>
      )}
      {a.type === 'assign' && <span>指派处理人为 <span className="text-white/80">{a.toValue}</span></span>}
      {a.type === 'convert' && <span>{a.content}</span>}
      {a.type === 'created' && <span>创建了该对象</span>}
      <span className="text-[10px] text-white/30 ml-auto">{fmt(a.createdAt)}</span>
    </div>
  );
}

const SYSTEM_META: Record<string, { icon: typeof ArrowRight; color: string }> = {
  transition: { icon: ArrowRight, color: '#38bdf8' },
  assign: { icon: UserPlus, color: '#f59e0b' },
  convert: { icon: GitBranch, color: '#a78bfa' },
  created: { icon: Sparkles, color: '#22c55e' },
};
