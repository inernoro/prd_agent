import { useRef } from 'react';
import { InlineCommentOverlay } from '@/components/doc-browser/InlineCommentOverlay';
import type { DocumentInlineComment } from '@/services/contracts/documentStore';

// 自测专用：把真实的 InlineCommentOverlay 挂在固定假正文 + 假评论上，
// 用来无登录情形下直接 Playwright 验证头像 img 真实渲染尺寸（CLAUDE.md §8.1 自测优先）。
// 公开路由，不需要登录。
const fakeComments: DocumentInlineComment[] = [
  {
    id: 'c1',
    storeId: 's', entryId: 'e', documentId: '',
    selectedText: '需要被高亮的关键短语', contextBefore: '', contextAfter: '',
    startOffset: 0, endOffset: 0, isWholeDocument: false,
    content: '第一条批注', authorUserId: 'u1', authorDisplayName: '小米',
    authorAvatar: undefined, status: 'active',
    createdAt: new Date().toISOString(),
  } as DocumentInlineComment,
  {
    id: 'c2',
    storeId: 's', entryId: 'e', documentId: '',
    selectedText: '另一段被框选的话', contextBefore: '', contextAfter: '',
    startOffset: 0, endOffset: 0, isWholeDocument: false,
    content: '第二条批注', authorUserId: 'u2', authorDisplayName: '王同学',
    authorAvatar: undefined, status: 'active',
    createdAt: new Date().toISOString(),
  } as DocumentInlineComment,
];

export default function InlineCommentOverlayProbe() {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div style={{ background: '#131314', color: '#e8e8ec', padding: 32, minHeight: '100vh', fontFamily: '-apple-system, "PingFang SC", sans-serif' }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>InlineCommentOverlay 头像气泡尺寸自测</h1>
      <p style={{ fontSize: 12, color: '#8a8a8e', marginBottom: 16 }}>
        Playwright 取此页 img[alt="小米"]、img[alt="王同学"] 的 getBoundingClientRect，
        断言 width=18 height=18（含 2px border 后视觉直径 22）。
      </p>
      <div ref={containerRef} style={{ position: 'relative', background: '#1e1f20', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16, fontSize: 14, lineHeight: 1.8 }}>
        <p>这是一段假正文，其中有一段<span>需要被高亮的关键短语</span>会被画上气泡；后面再来一句<span>另一段被框选的话</span>也带评论。</p>
        <InlineCommentOverlay
          containerRef={containerRef}
          comments={fakeComments}
          reflowKey="probe"
          mode="margin"
        />
      </div>
    </div>
  );
}
