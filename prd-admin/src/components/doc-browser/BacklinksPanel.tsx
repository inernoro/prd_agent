/**
 * 文档底部「被以下文档引用」面板。
 *
 * 数据来源：GET /api/mentions/documents/:entryId/links
 * 渲染：折叠面板 + 每条卡片含源标题、源摘要、引用上下文（高亮 anchorText）、源更新时间。
 *
 * 用户点击卡片 → 派发 wikilink:click 事件（与 MarkdownViewer 内蓝链一致），
 * 由消费页面（DocumentStorePage）监听并跳转到对应 entry。
 *
 * 详见 doc/design.knowledge-base.mention-network.md。
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Link2, Sparkles } from 'lucide-react';
import { getDocumentLinks, type BacklinkCard, type ForwardLinkCard } from '@/services/real/mentions';

interface Props {
  entryId: string;
  /** 当面板状态变化或数据刷新时回调（可选，外部可统计 / 自动滚动等） */
  onLoaded?: (counts: { backlinks: number; forwardLinks: number }) => void;
  /** 点击卡片跳转目标条目时回调（不传走默认 dispatchEvent） */
  onJumpToEntry?: (entryId: string) => void;
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/** 在上下文里把 anchorText 高亮成黄色，类似 ::mark:: 风格 */
function highlightContext(context: string, anchor: string): JSX.Element {
  if (!context || !anchor) return <>{context}</>;
  const idx = context.indexOf(anchor);
  if (idx < 0) return <>{context}</>;
  return (
    <>
      {context.slice(0, idx)}
      <mark
        style={{
          background: 'var(--semantic-warning-bg)',
          color: 'inherit',
          padding: '0 2px',
          borderRadius: 2,
        }}
      >
        {context.slice(idx, idx + anchor.length)}
      </mark>
      {context.slice(idx + anchor.length)}
    </>
  );
}

export function BacklinksPanel({ entryId, onLoaded, onJumpToEntry }: Props) {
  const [loading, setLoading] = useState(false);
  const [backlinks, setBacklinks] = useState<BacklinkCard[]>([]);
  const [forwardLinks, setForwardLinks] = useState<ForwardLinkCard[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [forwardExpanded, setForwardExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDocumentLinks(entryId)
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setError(res.error?.message || '加载失败');
          setBacklinks([]);
          setForwardLinks([]);
          return;
        }
        setBacklinks(res.data.backlinks);
        setForwardLinks(res.data.forwardLinks);
        onLoaded?.({ backlinks: res.data.backlinksCount, forwardLinks: res.data.forwardLinksCount });
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, onLoaded]);

  const handleJump = (targetId: string, title: string) => {
    if (onJumpToEntry) {
      onJumpToEntry(targetId);
    } else {
      // 默认派发全局事件，由 DocumentStorePage 等消费方处理
      document.dispatchEvent(new CustomEvent('wikilink:click', { detail: { title, entryId: targetId } }));
    }
  };

  if (loading && backlinks.length === 0 && forwardLinks.length === 0) {
    return (
      <div
        style={{
          marginTop: 48,
          paddingTop: 24,
          borderTop: '2px solid var(--border-faint)',
          color: 'var(--text-muted)',
          fontSize: 13,
        }}
      >
        正在加载反向链接...
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          marginTop: 48,
          paddingTop: 24,
          borderTop: '2px solid var(--border-faint)',
          color: 'var(--semantic-danger-text)',
          fontSize: 13,
        }}
      >
        反向链接加载失败：{error}
      </div>
    );
  }

  const total = backlinks.length + forwardLinks.length;
  if (total === 0) {
    return (
      <div
        style={{
          marginTop: 48,
          paddingTop: 24,
          borderTop: '2px solid var(--border-faint)',
          color: 'var(--text-muted)',
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Link2 size={14} />
        还没有文档引用这篇，也没有指向其他文档的链接。在正文里输入 <code style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-faint)', color: 'var(--text-secondary)', padding: '1px 6px', borderRadius: 3 }}>[[标题]]</code> 试试。
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: 48,
        paddingTop: 24,
        borderTop: '2px solid var(--border-faint)',
      }}
    >
      {/* 反向链接 */}
      {backlinks.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text-primary)',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              padding: 0,
              marginBottom: 12,
            }}
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <Link2 size={14} />
            被以下文档引用
            <span
              style={{
                background: 'var(--selection-bg)',
                color: 'var(--selection-text)',
                padding: '2px 8px',
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 500,
              }}
            >
              {backlinks.length}
            </span>
          </button>
          {expanded && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {backlinks.map((bl) => (
                <button
                  key={bl.mentionId}
                  type="button"
                  onClick={() => handleJump(bl.fromEntryId, bl.fromTitle)}
                  style={{
                    background: 'var(--bg-nested)',
                    border: '1px solid var(--border-faint)',
                    borderRadius: 8,
                    padding: '14px 16px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s',
                    color: 'inherit',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-focus)';
                    (e.currentTarget as HTMLButtonElement).style.background = 'var(--selection-bg)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-faint)';
                    (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-nested)';
                  }}
                >
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      marginBottom: 6,
                      color: 'var(--text-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    {bl.fromTitle}
                    {bl.isAutoDetected && (
                      <span
                        title="AI 自动识别的链接"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 2,
                          fontSize: 10,
                          color: 'var(--semantic-purple-text)',
                          background: 'var(--semantic-purple-bg)',
                          padding: '1px 6px',
                          borderRadius: 8,
                          fontWeight: 500,
                        }}
                      >
                        <Sparkles size={10} />
                        AI
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      color: 'var(--text-secondary)',
                      lineHeight: 1.6,
                    }}
                  >
                    {highlightContext(bl.context, bl.anchorText)}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      marginTop: 8,
                    }}
                  >
                    {bl.fromUpdatedByName ?? '匿名'} · {formatRelativeTime(bl.fromUpdatedAt)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 出链 */}
      {forwardLinks.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setForwardExpanded(!forwardExpanded)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              padding: 0,
              marginBottom: 8,
            }}
          >
            {forwardExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            本文档引用了
            <span
              style={{
                background: 'var(--bg-nested)',
                color: 'var(--text-muted)',
                padding: '1px 6px',
                borderRadius: 8,
                fontSize: 10,
                fontWeight: 500,
              }}
            >
              {forwardLinks.length}
            </span>
          </button>
          {forwardExpanded && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {forwardLinks.map((fl) => (
                <button
                  key={fl.mentionId}
                  type="button"
                  onClick={() => handleJump(fl.toEntryId, fl.toTitle)}
                  style={{
                    background: 'var(--semantic-info-bg)',
                    border: '1px solid var(--semantic-info-border)',
                    borderRadius: 6,
                    padding: '4px 10px',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: 'var(--semantic-info-text)',
                  }}
                >
                  {fl.toTitle}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
