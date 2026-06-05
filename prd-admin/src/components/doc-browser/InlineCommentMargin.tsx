import { useMemo } from 'react';
import { MessageSquareText, AlertTriangle, PanelRightClose } from 'lucide-react';
import type { DocumentInlineComment } from '@/services/contracts/documentStore';
import { CommentLine, ReplyBox, groupKey } from './inlineCommentShared';

// 右侧「批注栏」——飞书 / Google Docs 式：评论卡片常驻正文右侧，边读边看，不用点气泡。
// 与 InlineCommentOverlay（高亮层）双向联动：hover 某条卡片 → 对应正文高亮加亮。
// 有评论时这条栏取代「本页章节导航」，点右上角收起按钮切回 TOC。

type Group = { key: string; comments: DocumentInlineComment[]; orphaned: boolean };

export function InlineCommentMargin({
  comments,
  canCreate,
  hoveredKey,
  onHoverKey,
  onLocate,
  onCreate,
  onDelete,
  onClose,
  width = 300,
}: {
  comments: DocumentInlineComment[];
  canCreate: boolean;
  hoveredKey: string | null;
  onHoverKey: (key: string | null) => void;
  onLocate: (selectedText: string) => void;
  onCreate: (input: {
    selectedText: string;
    contextBefore?: string;
    contextAfter?: string;
    startOffset: number;
    endOffset: number;
    content: string;
  }) => Promise<boolean>;
  onDelete: (comment: DocumentInlineComment) => void;
  onClose?: () => void;
  width?: number;
}) {
  const { anchored, orphaned, wholeDoc } = useMemo(() => {
    const map = new Map<string, DocumentInlineComment[]>();
    const whole: DocumentInlineComment[] = [];
    for (const c of comments) {
      if (c.isWholeDocument || !c.selectedText) { whole.push(c); continue; }
      const k = groupKey(c.selectedText);
      if (!k) continue;
      const g = map.get(k) ?? [];
      g.push(c);
      map.set(k, g);
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

  const renderGroup = (g: Group, dim?: boolean) => (
    <div
      key={g.key}
      onMouseEnter={() => onHoverKey(g.key)}
      onMouseLeave={() => onHoverKey(null)}
      className="p-3 rounded-[11px] transition-colors"
      style={{
        background: hoveredKey === g.key ? 'rgba(168,85,247,0.10)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${hoveredKey === g.key ? 'rgba(168,85,247,0.32)' : 'rgba(255,255,255,0.06)'}`,
        opacity: dim ? 0.7 : 1,
      }}
    >
      <div
        className="mb-2 pl-2 py-0.5 text-[11px] line-clamp-2"
        style={{
          borderLeft: dim ? '2px dashed rgba(245,158,11,0.5)' : '2px solid rgba(168,85,247,0.45)',
          color: 'var(--text-muted)',
          cursor: dim ? 'default' : 'pointer',
        }}
        onClick={() => { if (!dim) onLocate(g.comments[0].selectedText); }}
        title={dim ? undefined : '点击定位到正文位置'}
      >
        {g.comments[0].selectedText.length > 120
          ? g.comments[0].selectedText.slice(0, 120) + '…'
          : g.comments[0].selectedText}
      </div>
      <div className="space-y-2.5">
        {g.comments.map((c) => (
          <CommentLine key={c.id} comment={c} canDelete={canCreate} onDelete={onDelete} />
        ))}
      </div>
      {canCreate && !dim && (
        <div className="mt-2.5">
          <ReplyBox
            onSubmit={async (text) => {
              const base = g.comments[0];
              return onCreate({
                selectedText: base.selectedText,
                contextBefore: base.contextBefore,
                contextAfter: base.contextAfter,
                startOffset: base.startOffset,
                endOffset: base.endOffset,
                content: text,
              });
            }}
          />
        </div>
      )}
    </div>
  );

  return (
    <div
      className="flex-none flex flex-col min-h-0"
      style={{ width, borderLeft: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.012)' }}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-3.5 py-3 flex-none" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
          <MessageSquareText size={13} style={{ color: 'rgba(216,180,254,0.95)' }} />
          本页批注 · {total}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-[7px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors flex-none"
            style={{ color: 'var(--text-muted)' }}
            title="收起批注栏，显示章节导航"
          >
            <PanelRightClose size={14} />
          </button>
        )}
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3" style={{ overscrollBehavior: 'contain' }}>
        {total === 0 ? (
          <div className="px-3 py-10 text-center">
            <MessageSquareText size={20} className="mx-auto mb-2" style={{ color: 'rgba(255,255,255,0.18)' }} />
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>还没有批注</p>
            <p className="text-[10px] mt-1" style={{ color: 'rgba(255,255,255,0.3)' }}>
              在正文里选中一段文字即可批注
            </p>
          </div>
        ) : (
          <>
            {anchored.map((g) => renderGroup(g))}

            {wholeDoc.length > 0 && (
              <div className="pt-1">
                <div className="text-[10px] font-semibold mb-2 px-0.5" style={{ color: 'rgba(147,197,253,0.9)' }}>
                  全文评论
                </div>
                <div className="p-3 rounded-[11px] space-y-2.5"
                  style={{ background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.16)' }}>
                  {wholeDoc.map((c) => (
                    <CommentLine key={c.id} comment={c} canDelete={canCreate} onDelete={onDelete} />
                  ))}
                  {canCreate && (
                    <ReplyBox
                      placeholder="写对整篇文档的评论…"
                      onSubmit={async (text) =>
                        onCreate({ selectedText: '', startOffset: 0, endOffset: 0, content: text })
                      }
                    />
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
                <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
                  文档更新后，以下批注的原文已不存在
                </p>
                <div className="space-y-3">
                  {orphaned.map((g) => renderGroup(g, true))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
