/**
 * 双链悬停预览卡：浮在鼠标右下方，展示目标文档标题 + 摘要。
 *
 * 数据来源：lookupWikilinkTitle（lib/wikilinkCache.ts），由 DocumentStorePage 在
 * entries 加载时通过 setWikilinkEntries 注入。同步查询不闪烁。
 *
 * 触发：MarkdownViewer 在 wikilink 元素上 mouseenter 时派发 wikilink:hover 事件。
 *
 * MVP 假设：当前画面只有一个活跃库；跨库引用 v2 时需要按 storeId 分桶。
 */
import { useEffect, useState } from 'react';
import { lookupWikilinkTitle } from '@/lib/wikilinkCache';

interface HoverState {
  title: string;
  x: number;
  y: number;
  exists: boolean;
}

export function WikilinkHoverCard() {
  const [hover, setHover] = useState<HoverState | null>(null);

  useEffect(() => {
    const onHover = (e: Event) => {
      const ce = e as CustomEvent<HoverState>;
      if (!ce.detail?.title) return;
      setHover(ce.detail);
    };
    const onUnhover = () => setHover(null);
    document.addEventListener('wikilink:hover', onHover);
    document.addEventListener('wikilink:unhover', onUnhover);
    return () => {
      document.removeEventListener('wikilink:hover', onHover);
      document.removeEventListener('wikilink:unhover', onUnhover);
    };
  }, []);

  if (!hover) return null;
  const cached = lookupWikilinkTitle(hover.title);

  // 卡片尺寸常量；超出视口右下时回弹到鼠标左上方
  const cardW = 300;
  const cardH = 140;
  const margin = 16;
  let left = hover.x + 14;
  let top = hover.y + 18;
  if (left + cardW + margin > window.innerWidth) left = hover.x - cardW - 14;
  if (top + cardH + margin > window.innerHeight) top = hover.y - cardH - 14;

  if (!hover.exists || !cached) {
    return (
      <div
        style={{
          position: 'fixed',
          left,
          top,
          width: cardW,
          background: 'rgba(28,28,44,0.96)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,156,77,0.4)',
          borderRadius: 10,
          padding: '12px 14px',
          color: '#fff',
          fontSize: 13,
          zIndex: 9000,
          pointerEvents: 'none',
          boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ color: 'rgba(255,156,77,0.95)', fontSize: 11, marginBottom: 6 }}>文档不存在</div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>「{hover.title}」</div>
        <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, lineHeight: 1.6 }}>
          这个标题在当前知识库找不到对应文档。点击不会跳转。
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        left,
        top,
        width: cardW,
        background: 'rgba(28,28,44,0.96)',
        backdropFilter: 'blur(10px)',
        border: '1px solid rgba(124,156,255,0.35)',
        borderRadius: 10,
        padding: '12px 14px',
        color: '#fff',
        fontSize: 13,
        zIndex: 9000,
        pointerEvents: 'none',
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: 'rgba(124,156,255,0.95)',
          background: 'rgba(124,156,255,0.12)',
          padding: '2px 8px',
          borderRadius: 8,
          display: 'inline-block',
          marginBottom: 6,
          fontWeight: 600,
        }}
      >
        双链目标
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, lineHeight: 1.4 }}>{cached.title}</div>
      {cached.summary && (
        <div
          style={{
            fontSize: 12,
            color: 'rgba(255,255,255,0.6)',
            lineHeight: 1.55,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {cached.summary}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>点击跳转 · 鼠标移开关闭</div>
    </div>
  );
}
