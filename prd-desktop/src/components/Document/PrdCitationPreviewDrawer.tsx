import { useEffect } from 'react';
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
  const close = usePrdCitationPreviewStore((s) => s.close);

  const openWithCitations = usePrdPreviewNavStore((s) => s.openWithCitations);
  const openPrdPreviewPage = useSessionStore((s) => s.openPrdPreviewPage);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      {/* 透明遮罩（仅用于捕获点击关闭，不影响底层视觉） */}
      <div className="absolute inset-0 pointer-events-auto" onClick={close} />

      <div className="absolute right-0 top-0 h-full w-[420px] max-w-[92vw] bg-surface-light dark:bg-surface-dark border-l border-border shadow-2xl pointer-events-auto flex flex-col">
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


