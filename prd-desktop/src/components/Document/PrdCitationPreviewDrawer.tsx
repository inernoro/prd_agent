import { useEffect, useRef } from 'react';
import { usePrdCitationPreviewStore } from '../../stores/prdCitationPreviewStore';
import { usePrdPreviewNavStore } from '../../stores/prdPreviewNavStore';
import { useSessionStore } from '../../stores/sessionStore';
import PrdPreviewPage from './PrdPreviewPage';

export default function PrdCitationPreviewDrawer() {
  const isOpen = usePrdCitationPreviewStore((s) => s.isOpen);
  const documentId = usePrdCitationPreviewStore((s) => s.documentId);
  const groupId = usePrdCitationPreviewStore((s) => s.groupId);
  const targetHeadingId = usePrdCitationPreviewStore((s) => s.targetHeadingId);
  const targetHeadingTitle = usePrdCitationPreviewStore((s) => s.targetHeadingTitle);
  const citations = usePrdCitationPreviewStore((s) => s.citations);
  const activeCitationIndex = usePrdCitationPreviewStore((s) => s.activeCitationIndex);
  const drawerWidth = usePrdCitationPreviewStore((s) => s.drawerWidth);
  const setDrawerWidth = usePrdCitationPreviewStore((s) => s.setDrawerWidth);
  const close = usePrdCitationPreviewStore((s) => s.close);

  const openWithCitations = usePrdPreviewNavStore((s) => s.openWithCitations);
  const openPrdPreviewPage = useSessionStore((s) => s.openPrdPreviewPage);

  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    active: boolean;
    prevUserSelect: string;
    prevCursor: string;
  } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  useEffect(() => {
    // 窗口尺寸变化时，防止 drawer 宽度超过可视范围
    const onResize = () => {
      const max = Math.floor(window.innerWidth * 0.92);
      setDrawerWidth(Math.min(drawerWidth, Math.max(320, max)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [drawerWidth, setDrawerWidth]);

  useEffect(() => {
    // pointer move/up：全局监听，拖拽更稳定
    const onMove = (e: PointerEvent) => {
      const st = dragRef.current;
      if (!st?.active) return;
      const delta = st.startX - e.clientX; // 往左拖 => delta>0 => width 变大
      const max = Math.floor(window.innerWidth * 0.92);
      const next = Math.max(320, Math.min(max, st.startWidth + delta));
      setDrawerWidth(next);
    };
    const onUp = () => {
      const st = dragRef.current;
      if (!st?.active) return;
      st.active = false;
      document.body.style.userSelect = st.prevUserSelect;
      document.body.style.cursor = st.prevCursor;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [setDrawerWidth]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      {/* 透明遮罩（仅用于捕获点击关闭，不影响底层视觉） */}
      <div className="absolute inset-0 pointer-events-auto" onClick={close} />

      <div
        className="absolute right-0 top-0 h-full max-w-[92vw] bg-surface-light dark:bg-surface-dark border-l border-border shadow-2xl pointer-events-auto flex flex-col"
        style={{ width: `${drawerWidth}px` }}
      >
        {/* 可拖拽分隔条（拉左拉右调整宽度） */}
        <div
          className="absolute left-0 top-0 h-full w-2 cursor-col-resize"
          role="separator"
          aria-label="调整引用预览宽度"
          title="拖动调整宽度"
          onPointerDown={(e) => {
            // 只处理主指针，避免多指干扰
            try {
              (e.currentTarget as any)?.setPointerCapture?.(e.pointerId);
            } catch {
              // ignore
            }
            const prevUserSelect = document.body.style.userSelect;
            const prevCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
            dragRef.current = {
              startX: e.clientX,
              startWidth: drawerWidth,
              active: true,
              prevUserSelect,
              prevCursor,
            };
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border opacity-50 hover:opacity-90" />
        </div>

        <PrdPreviewPage
          compactMode
          overrideDocumentId={documentId}
          overrideGroupId={groupId}
          onRequestClose={close}
          onRequestOpenFullPreview={() => {
            // 重要：compact 模式下 PrdPreviewPage 会 consume target。
            // 打开全屏前重新写入 target/citations，确保全屏能再次跳转并显示引用浮层。
            openWithCitations({
              targetHeadingId,
              targetHeadingTitle,
              citations: citations ?? [],
              activeCitationIndex,
            });
            close();
            openPrdPreviewPage();
          }}
        />
      </div>
    </div>
  );
}


