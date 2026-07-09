/**
 * 阅读面板：点星/点节点弹出的正文预览悬浮玻璃卡,复用系统 MarkdownViewer。
 * 从 DocumentGalaxyView 提取为独立组件,供知识星球(3D)与 Obsidian 双链图(2D)共用。
 * 只依赖 entryId + loadContent(默认 getDocumentContent),内部自管 loading/error/ESC 关闭/左缘拖宽。
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { X } from 'lucide-react';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
import { getDocumentContent } from '@/services/real/documentStore';
import { GalaxyConstellationLoader } from './GalaxyConstellationLoader';

/**
 * 阅读面板正文去重：面板头部已显示标题，正文若以同名标题(H1/H2)开头会出现「两个标题」。
 * 跳过 frontmatter 块与空行，取首个标题行；其文本规范化后等于头部标题、或以之结尾
 *（兼容「{文件名} — {真标题}」式 H1），则连同紧随空行一并剥掉。否则原样返回。
 */
export function stripDuplicateLeadingHeading(md: string, title: string): string {
  if (!md || !title) return md;
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const want = norm(title);
  if (!want) return md;
  const lines = md.split('\n');
  let i = 0;
  // 跳过 YAML frontmatter
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  const m = lines[i]?.match(/^#{1,2}\s+(.+?)\s*#*\s*$/);
  if (m) {
    const h = norm(m[1]);
    if (h === want || (want.length >= 4 && h.endsWith(want))) {
      lines.splice(i, 1);
      if (lines[i]?.trim() === '') lines.splice(i, 1);
      return lines.join('\n');
    }
  }
  return md;
}

export interface ReaderPanelProps {
  entryId: string;
  displayTitle?: string;
  pathNames?: string[];
  width: number;
  onResize: (w: number) => void;
  loadContent?: (entryId: string) => ReturnType<typeof getDocumentContent>;
  onClose: () => void;
}

// ── 阅读面板：点星弹出，复用系统 MarkdownViewer。玻璃质感悬浮卡（拉宽 + 通透 + 圆润）──
export function ReaderPanel({
  entryId,
  displayTitle,
  pathNames,
  width,
  onResize,
  loadContent,
  onClose,
}: ReaderPanelProps) {
  const [content, setContent] = useState<string | null>(null);
  const [title, setTitle] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    const loadContentFn = loadContent ?? getDocumentContent;
    loadContentFn(entryId)
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setError(res.error?.message || '加载文档失败');
          return;
        }
        setTitle(res.data.title || '');
        setContent(res.data.hasContent ? (res.data.content ?? '') : '');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, loadContent]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 左缘拖拽改宽：按指针 x 反推宽度 = 视口宽 - x - 右边距(12)，夹 [360, 94vw]。
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      onResizeRef.current(window.innerWidth - ev.clientX - 12);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        (e.target as HTMLElement).releasePointerCapture(ev.pointerId);
      } catch {
        /* 已释放 */
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const shownTitle = displayTitle || title || '文档';
  const crumbLine = (pathNames ?? []).join(' / ');
  // 去重：面板头部已经显示标题，正文若以同名 H1/H2 开头会变成「两个标题」（用户反馈）。
  // 正文首个标题文本 ≈ 头部标题（或以其结尾，兼容「文件名 — 真标题」式 H1）时，剥掉该行。
  const bodyForView = content ? stripDuplicateLeadingHeading(content, shownTitle) : content;

  return (
    // 悬浮玻璃卡：四周留白 + 全圆角，比贴边硬面板更圆润通透
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        bottom: 12,
        width: `min(${Math.round(width)}px, 94vw)`,
        // 玻璃质感但保证可读：底色足够实（0.92），blur 只做轻微通透，正文不被背景星点干扰
        background: 'rgba(17,18,26,0.92)',
        backdropFilter: 'blur(20px) saturate(130%)',
        WebkitBackdropFilter: 'blur(20px) saturate(130%)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 18,
        boxShadow: '0 18px 60px rgba(0,0,0,0.6)',
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {/* 左缘拖拽手柄：改阅读面板宽度（投影偏移随之同步，聚焦星保持左半居中）。 */}
      <div
        onPointerDown={startResize}
        title="拖拽调整阅读面板宽度"
        style={{
          position: 'absolute',
          left: -3,
          top: 0,
          bottom: 0,
          width: 10,
          cursor: 'ew-resize',
          zIndex: 2,
          touchAction: 'none',
        }}
      >
        <div style={{ position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)', width: 3, height: 42, borderRadius: 3, background: 'rgba(255,255,255,0.22)' }} />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          padding: '16px 20px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          {crumbLine && (
            <div style={{ fontSize: 11, color: '#8a8c9c', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {crumbLine}
            </div>
          )}
          <div style={{ fontSize: 17, fontWeight: 700, color: '#f1f2f7', lineHeight: 1.35, wordBreak: 'break-word' }}>
            {shownTitle}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="关闭"
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 9,
            width: 30,
            height: 30,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#c8c8d0',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <X size={15} />
        </button>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          padding: '22px 28px 32px',
        }}
      >
        {/* 正文限宽居中，长行不顶到边，阅读更舒适（容器仍撑满，靠 padding 收口） */}
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          {loading && <div style={{ padding: '32px 0' }}><GalaxyConstellationLoader text="正在加载文档…" size={140} /></div>}
          {error && !loading && <div style={{ color: '#ffb0b0', fontSize: 13 }}>加载失败：{error}</div>}
          {!loading && !error && content !== null && content.trim() !== '' && <MarkdownViewer content={bodyForView ?? content} />}
          {!loading && !error && (content === null || content.trim() === '') && (
            <div style={{ color: '#888', fontSize: 13 }}>该文档暂无可预览的正文内容。</div>
          )}
        </div>
      </div>
    </div>
  );
}
