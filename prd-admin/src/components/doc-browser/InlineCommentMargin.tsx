import { useEffect, useMemo, useRef } from 'react';
import { MessageSquareText, AlertTriangle, PanelRightClose } from 'lucide-react';
import type { DocumentInlineComment } from '@/services/contracts/documentStore';
import { CommentLine, CommentAvatar, ReplyBox, groupKey, threadColor, withAlpha } from './inlineCommentShared';

// 右侧「批注栏」——飞书 / Google Docs 式：评论卡片常驻正文右侧，边读边看。
// 强关联（业界做法）：
//   - 同色锚定：每条批注一个色，卡片左色条 = 正文高亮下划线同色（threadColor 一致）。
//   - 激活态：点正文气泡或点卡片 → activeKey 命中 → 该卡升起高亮环 + data-active-card（供连线层取锚点）+ 滚到眼前；
//             正文对应高亮加亮；一次只激活一条，其余淡化。双向联动。
//   - 密集折叠：批注 > 3 组时，非激活的压成一行（头像+首句+条数），点开才展开，密度立降。

type Group = { key: string; comments: DocumentInlineComment[]; orphaned: boolean };

export function InlineCommentMargin({
  comments,
  canCreate,
  canDelete,
  hoveredKey,
  activeKey,
  onHoverKey,
  onActivate,
  onCreate,
  onDelete,
  onClose,
  width = 300,
}: {
  comments: DocumentInlineComment[];
  canCreate: boolean;
  /** 逐条删除权限（库主 / 作者）；缺省不可删 */
  canDelete?: (comment: DocumentInlineComment) => boolean;
  hoveredKey: string | null;
  activeKey: string | null;
  onHoverKey: (key: string | null) => void;
  /** 点卡片 → 激活该分组（联动正文高亮 + 连线） */
  onActivate: (key: string, selectedText: string) => void;
  onCreate: (input: {
    selectedText: string;
    contextBefore?: string;
    contextAfter?: string;
    startOffset: number;
    endOffset: number;
    content: string;
  }, entryId?: string) => Promise<boolean>;
  onDelete: (comment: DocumentInlineComment) => void;
  onClose?: () => void;
  width?: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const { anchored, orphaned, wholeDoc } = useMemo(() => {
    const map = new Map<string, DocumentInlineComment[]>();
    const whole: DocumentInlineComment[] = [];
    for (const c of comments) {
      if (c.isWholeDocument || !c.selectedText) { whole.push(c); continue; }
      const k = groupKey(c.selectedText);
      if (!k) continue;
      const g = map.get(k) ?? [];
      g.push(c); map.set(k, g);
    }
    const groups: Group[] = [];
    map.forEach((list, key) => groups.push({ key, comments: list, orphaned: list.every((c) => c.status === 'orphaned') }));
    return {
      anchored: groups.filter((g) => !g.orphaned),
      orphaned: groups.filter((g) => g.orphaned),
      wholeDoc: whole,
    };
  }, [comments]);

  const total = comments.length;
  // 密集才折叠：≤3 组时全展开（边读边看不打折），>3 组时非激活折叠成一行
  const dense = anchored.length > 3;

  // 激活时把对应卡片滚到批注栏可视区
  useEffect(() => {
    if (!activeKey) return;
    const el = listRef.current?.querySelector('[data-active-card="1"]') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeKey]);

  const renderFull = (g: Group, dim?: boolean) => {
    const col = dim ? '#94a3b8' : threadColor(g.key);
    const isActive = activeKey === g.key;
    const isHover = hoveredKey === g.key;
    return (
      <div
        key={g.key}
        data-active-card={isActive && !dim ? '1' : undefined}
        onMouseEnter={() => onHoverKey(g.key)}
        onMouseLeave={() => onHoverKey(null)}
        onClick={() => { if (!dim) onActivate(g.key, g.comments[0].selectedText); }}
        className="relative rounded-[11px] p-3 pl-3.5 transition-all cursor-pointer"
        style={{
          background: isActive ? withAlpha(col, 0.1) : isHover ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.03)',
          border: `1px solid ${isActive ? withAlpha(col, 0.5) : 'rgba(255,255,255,0.06)'}`,
          boxShadow: isActive ? `0 10px 26px -12px ${withAlpha(col, 0.5)}` : 'none',
          opacity: dim ? 0.7 : 1,
        }}
      >
        <div style={{ position: 'absolute', left: 0, top: 10, bottom: 10, width: 3, borderRadius: 3, background: col }} />
        <div
          className="mb-2 pl-1.5 py-0.5 text-[11px] line-clamp-2"
          style={{ color: 'var(--text-muted)' }}
          title={g.comments[0].selectedText}
        >
          {g.comments[0].selectedText.length > 120 ? g.comments[0].selectedText.slice(0, 120) + '…' : g.comments[0].selectedText}
        </div>
        <div className="space-y-2.5">
          {g.comments.map((c) => <CommentLine key={c.id} comment={c} canDelete={canDelete?.(c)} onDelete={onDelete} />)}
        </div>
        {canCreate && !dim && (
          <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
            <ReplyBox onSubmit={async (text) => {
              const base = g.comments[0];
              // 回复落到该线程所属条目（base.entryId），防切档后写到别的文档（Bugbot Medium）
              return onCreate({ selectedText: base.selectedText, contextBefore: base.contextBefore, contextAfter: base.contextAfter, startOffset: base.startOffset, endOffset: base.endOffset, content: text }, base.entryId);
            }} />
          </div>
        )}
      </div>
    );
  };

  const renderCollapsed = (g: Group) => {
    const col = threadColor(g.key);
    const first = g.comments[0];
    return (
      <div
        key={g.key}
        onMouseEnter={() => onHoverKey(g.key)}
        onMouseLeave={() => onHoverKey(null)}
        onClick={() => onActivate(g.key, first.selectedText)}
        className="flex items-center gap-2 rounded-[10px] px-2.5 py-2 cursor-pointer transition-colors"
        style={{ background: hoveredKey === g.key ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}
        title={first.selectedText}
      >
        <div style={{ width: 3, alignSelf: 'stretch', borderRadius: 3, background: col, flex: 'none' }} />
        <CommentAvatar name={first.authorDisplayName} avatar={first.authorAvatar} size={20} />
        <span className="flex-1 min-w-0 truncate text-[11px]" style={{ color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>{first.content}</span>
        {g.comments.length > 1 && <span className="text-[10px] font-bold flex-none" style={{ color: 'var(--text-muted)' }}>{g.comments.length}</span>}
      </div>
    );
  };

  return (
    <div className="flex-none flex flex-col min-h-0" style={{ width, borderLeft: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.012)' }}>
      <div className="flex items-center justify-between px-3.5 py-3 flex-none" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
          <MessageSquareText size={13} style={{ color: 'rgba(216,180,254,0.95)' }} />
          本页批注 · {total}
        </div>
        {onClose && (
          <button onClick={onClose} className="w-6 h-6 rounded-[7px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors flex-none" style={{ color: 'var(--text-muted)' }} title="收起批注栏，显示章节导航">
            <PanelRightClose size={14} />
          </button>
        )}
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3" style={{ overscrollBehavior: 'contain' }}>
        {total === 0 ? (
          <div className="px-3 py-10 text-center">
            <MessageSquareText size={20} className="mx-auto mb-2" style={{ color: 'rgba(255,255,255,0.18)' }} />
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>还没有批注</p>
            <p className="text-[10px] mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>在正文里选中一段文字即可批注</p>
          </div>
        ) : (
          <>
            {anchored.map((g) => (dense && activeKey !== g.key ? renderCollapsed(g) : renderFull(g)))}

            {wholeDoc.length > 0 && (
              <div className="pt-1">
                <div className="text-[10px] font-semibold mb-2 px-0.5" style={{ color: 'rgba(147,197,253,0.9)' }}>全文评论</div>
                <div className="p-3 rounded-[11px] space-y-2.5" style={{ background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.16)' }}>
                  {wholeDoc.map((c) => <CommentLine key={c.id} comment={c} canDelete={canDelete?.(c)} onDelete={onDelete} />)}
                  {canCreate && (
                    <ReplyBox placeholder="写对整篇文档的评论…" onSubmit={async (text) => onCreate({ selectedText: '', startOffset: 0, endOffset: 0, content: text }, wholeDoc[0]?.entryId)} />
                  )}
                </div>
              </div>
            )}

            {orphaned.length > 0 && (
              <div className="pt-2 mt-1" style={{ borderTop: '1px dashed rgba(255,255,255,0.08)' }}>
                <div className="flex items-center gap-1.5 mb-2 mt-2">
                  <AlertTriangle size={11} style={{ color: 'rgba(245,158,11,0.9)' }} />
                  <span className="text-[10px] font-semibold" style={{ color: 'rgba(245,158,11,0.9)' }}>
                    {orphaned.reduce((n, g) => n + g.comments.length, 0)} 条失锚批注
                  </span>
                </div>
                <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>文档更新后，以下批注的原文已不存在</p>
                <div className="space-y-3">{orphaned.map((g) => renderFull(g, true))}</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
