import { useEffect, useState, useRef } from 'react';

/**
 * 检测某个 ref 容器内的文本选中状态。
 *
 * 当用户在容器里用鼠标选中了一段文本时：
 * - selectedText：当前选中的纯文本
 * - rect：选中区域的 bounding rect（用于定位浮层按钮）
 * - anchorOffset：选中起点在 rawContent 里的字符偏移（通过 indexOf 定位）
 *
 * 没选中或选中被清空时，state 重置为 null。
 *
 * 注意：rawContent 是完整的 markdown 源码。浏览器 selection 的 anchorOffset
 * 是针对 DOM text node 的偏移，和 markdown 原文对不上，所以这里用 indexOf 兜底。
 * 如果 selectedText 在 rawContent 里唯一出现，直接定位；多次出现则取第一处。
 *
 * B6 修复：双击/三击选词或选行时，部分浏览器在 mouseup 之后才应用整词/整行
 * 选区，单靠 mouseup 会捕获到空选区导致浮层不出现或瞬间消失。
 * 改为以 selectionchange 为主信号（防抖到选择稳定后再读），
 * 并补 dblclick 兜底；mousedown 仅在"点击容器外"时清空，
 * 容器内的 mousedown 不再清空（避免选词过程被打断）。
 */
export type ContentSelectionInfo = {
  selectedText: string;
  rect: DOMRect;
  startOffset: number;
  endOffset: number;
  contextBefore: string;
  contextAfter: string;
};

export function useContentSelection(
  containerRef: React.RefObject<HTMLElement>,
  rawContent: string | null | undefined,
  enabled: boolean,
): {
  selection: ContentSelectionInfo | null;
  clear: () => void;
} {
  const [selection, setSelection] = useState<ContentSelectionInfo | null>(null);
  const rawContentRef = useRef(rawContent);
  rawContentRef.current = rawContent;
  // 用户是否正在按住鼠标拖拽选择（拖拽过程中不读，松手 / 选区稳定后再读）
  const pointerDownRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // 真正读取并定位选区。只有当选区落在容器内、且能在原文里 indexOf 命中才记录。
    const captureSelection = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = containerRef.current;
      if (!container) return;
      // 选区折叠（无实际选中）或不在容器内 → 不处理，但不强行清空
      // （避免点击浮层按钮时把已捕获的选区抹掉）
      if (range.collapsed) return;
      if (!container.contains(range.commonAncestorContainer)) return;

      const raw = rawContentRef.current ?? '';
      const startOffset = raw.indexOf(text);
      if (startOffset < 0) {
        // 完全找不到（markdown 符号被 render 隐藏等），放弃但不清空已有选区
        return;
      }
      const endOffset = startOffset + text.length;
      const contextBefore = raw.substring(Math.max(0, startOffset - 50), startOffset);
      const contextAfter = raw.substring(endOffset, Math.min(raw.length, endOffset + 50));
      const rect = range.getBoundingClientRect();
      setSelection({
        selectedText: text,
        rect,
        startOffset,
        endOffset,
        contextBefore,
        contextAfter,
      });
    };

    const scheduleCapture = (delay = 120) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // 拖拽进行中先不读，等 mouseup 再读，避免抖动
        if (pointerDownRef.current) return;
        captureSelection();
      }, delay);
    };

    // selectionchange：双击选词 / 三击选行 / 键盘选区都会触发，是最稳的主信号
    const handleSelectionChange = () => {
      scheduleCapture();
    };

    const handleMouseDown = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      // 只有点击在容器外才清空（点击浮层"添加评论"按钮时不会走到这里，
      // 因为浮层 onMouseDown 已 preventDefault + 在 body 层）
      if (!container.contains(e.target as Node)) {
        setSelection(null);
        return;
      }
      pointerDownRef.current = true;
    };

    const handleMouseUp = () => {
      pointerDownRef.current = false;
      // 松手后立即读一次（拖拽选择 / 单击折叠）
      scheduleCapture(0);
    };

    // 双击 / 三击：浏览器在事件后才应用整词/整行选区，延迟再读一次兜底
    const handleDblClick = () => {
      scheduleCapture(10);
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('dblclick', handleDblClick);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      document.removeEventListener('selectionchange', handleSelectionChange);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('dblclick', handleDblClick);
    };
  }, [enabled, containerRef]);

  return {
    selection,
    clear: () => setSelection(null),
  };
}
