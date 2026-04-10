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

  useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }

    const handleMouseUp = () => {
      // 延迟一帧，等浏览器把 selection 计算好
      setTimeout(() => {
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
        // 验证选中范围在容器内
        const range = sel.getRangeAt(0);
        const container = containerRef.current;
        if (!container) return;
        if (!container.contains(range.commonAncestorContainer)) {
          return;
        }
        // 定位到 rawContent 里的字符偏移（使用 indexOf 兜底）
        const raw = rawContentRef.current ?? '';
        const startOffset = raw.indexOf(text);
        if (startOffset < 0) {
          // 完全找不到（可能是 markdown 符号被 render 隐藏了），放弃
          setSelection(null);
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
      }, 0);
    };

    const handleMouseDown = (e: MouseEvent) => {
      // 点击在容器外 → 清除
      const container = containerRef.current;
      if (!container) return;
      if (!container.contains(e.target as Node)) {
        setSelection(null);
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [enabled, containerRef]);

  return {
    selection,
    clear: () => setSelection(null),
  };
}
