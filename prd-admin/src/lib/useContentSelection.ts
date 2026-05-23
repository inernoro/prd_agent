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
 *
 * B6 二次修复（blockquote / 标题 / 列表项 / 含 frontmatter 文档选区消失）：
 * 旧实现里 `raw.indexOf(text)` 一旦失败就直接 return，导致 selection 永远是
 * null、浮层不出现。失败场景非常常见：
 *   - blockquote：DOM 文本去掉了每行的 `> ` 前缀，且多行被合并，
 *     raw 里却带 `> ` 前缀与换行，indexOf 必然 miss
 *   - 标题 / 列表项：raw 带 `#` / `-` / `*` / 数字. 等行首标记
 *   - 文档带 YAML frontmatter：正文整体偏移、引号差异
 * 修复策略：offset 解析改为「分级回退」——精确 indexOf → 空白归一化匹配
 * → markdown 行首标记剥离后匹配 → 兜底 (-1)。**任何一种结果都照常产出
 * selection**，绝不因为定位失败而吞掉选区（offset 仅用于评论锚点提示，
 * 真正的高亮重定位走 DOM TreeWalker 按 selectedText 搜索，offset 容错）。
 */
export type ContentSelectionInfo = {
  selectedText: string;
  rect: DOMRect;
  startOffset: number;
  endOffset: number;
  contextBefore: string;
  contextAfter: string;
};

/**
 * 在 markdown 原文里定位选中文本的字符偏移，分级回退，永不抛错。
 * 返回 startOffset = -1 表示三级都没命中（评论锚点会走 DOM 文本兜底）。
 */
function resolveOffsetInRaw(raw: string, text: string): { startOffset: number; endOffset: number } {
  if (!raw || !text) return { startOffset: -1, endOffset: -1 };

  // 1) 精确匹配（普通段落 / 单行标题去掉 # 后通常仍能命中）
  const exact = raw.indexOf(text);
  if (exact >= 0) return { startOffset: exact, endOffset: exact + text.length };

  // 2) 空白归一化匹配：把连续空白（含换行、blockquote 合并产生的空隙）压成单空格
  //    然后在同样归一化的 raw 上找，再把命中位置映射回原始 raw 索引
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  const needle = collapse(text);
  if (needle) {
    // 构建归一化字符串 + 原始索引映射
    let normalized = '';
    const map: number[] = []; // normalized[i] 对应 raw 的原始下标
    let prevWasSpace = true; // 行首/起始处的空白整体跳过（等价 trim 头部）
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (/\s/.test(ch)) {
        if (!prevWasSpace) {
          normalized += ' ';
          map.push(i);
          prevWasSpace = true;
        }
      } else {
        normalized += ch;
        map.push(i);
        prevWasSpace = false;
      }
    }
    const normTrimmed = normalized.replace(/ $/, '');
    const hit = normTrimmed.indexOf(needle);
    if (hit >= 0) {
      const start = map[hit];
      const lastIdx = Math.min(hit + needle.length - 1, map.length - 1);
      const end = map[lastIdx] + 1;
      return { startOffset: start, endOffset: end };
    }
  }

  // 3) 行首 markdown 标记剥离后匹配（blockquote `>`、标题 `#`、列表 `-`/`*`/`数字.`）
  const strippedText = text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:>+\s?|#{1,6}\s+|[-*+]\s+|\d+\.\s+)/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (strippedText) {
    const strippedRaw = raw
      .split('\n')
      .map((l) => l.replace(/^\s*(?:>+\s?|#{1,6}\s+|[-*+]\s+|\d+\.\s+)/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    const hit2 = strippedRaw.indexOf(strippedText);
    if (hit2 >= 0) {
      // 粗略映射：用 strippedText 在 raw 里的近似锚点（首词）兜底定位
      const words = strippedText.split(' ');
      const firstWord = words[0];
      const approx = firstWord ? raw.indexOf(firstWord) : -1;
      if (approx >= 0) {
        // endOffset 不能用 approx + strippedText.length：strippedText 已剥掉
        // markdown 标记，比 raw 中对应跨度短，会落在选区中间甚至越界。
        // 优先用末词在 raw 中（approx 之后）的位置 + 末词长度；定位不到则退而
        // 求其次用原始可见文本长度。最终 clamp 到 [startOffset, raw.length]。
        const lastWord = words[words.length - 1];
        let end = -1;
        if (lastWord) {
          const lastIdx = raw.indexOf(lastWord, approx);
          if (lastIdx >= 0) end = lastIdx + lastWord.length;
        }
        if (end < 0) end = approx + text.length;
        const endOffset = Math.min(raw.length, Math.max(approx, end));
        return { startOffset: approx, endOffset };
      }
    }
  }

  // 4) 兜底：定位失败，offset 置 -1（不影响选区产出与浮层显示）
  return { startOffset: -1, endOffset: -1 };
}

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
      // 分级回退定位。即使 startOffset = -1（blockquote/标题/列表/含
      // frontmatter 等无法精确映射的情形），仍然照常产出 selection，
      // 保证浮层"添加评论"一定出现——评论锚点重定位走 DOM 文本搜索，
      // 不强依赖这里的字符偏移。
      const { startOffset, endOffset } = resolveOffsetInRaw(raw, text);
      const contextBefore =
        startOffset >= 0 ? raw.substring(Math.max(0, startOffset - 50), startOffset) : '';
      const contextAfter =
        endOffset >= 0 ? raw.substring(endOffset, Math.min(raw.length, endOffset + 50)) : '';
      const rect = range.getBoundingClientRect();
      // rect 全 0（极少数浏览器在选区刚成型时）→ 跳过这一拍，等下次
      // selectionchange/mouseup 再读，避免浮层定位到左上角
      if (rect.width === 0 && rect.height === 0) return;
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
