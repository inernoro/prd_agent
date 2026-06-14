/**
 * 编辑器双链自动补全 + `@` mention 触发：
 *
 * 触发条件（光标前若匹配以下之一，弹下拉框）：
 *   - `\[\[([^\[\]\n]*)$`  — Obsidian 风格 [[ 前缀
 *   - `(?:^|\s)@([^\s@]*)$` — 中文输入法友好的 @ 触发
 *
 * 数据：调 `/api/mentions/stores/{storeId}/suggest?q=` 拉前 10 候选。
 *
 * 交互：
 *   - 上下键导航 / Enter 选中 / Esc / Tab 关闭
 *   - 鼠标点击选中
 *   - 选中后把触发段（含 [[ 或 @）替换为标准 [[标题]]
 *   - 输入"找不到"的标题时下拉底部出现「+ 创建新文档」CTA（MVP 不真建，只关掉下拉，让用户继续打 ]]）
 *
 * 受控接口：由 DocBrowser 在 edit 模式下挂载，传入 textarea ref + storeId + 当前 editContent。
 * 父组件提供 onInsert callback 接收"替换后的整段 editContent"。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { suggestLinks, type SuggestItem } from '@/services/real/mentions';

interface Trigger {
  /** 触发起点（包括 [[ 或 @）在 editContent 中的字符索引 */
  start: number;
  /** 输入的查询关键字（已剥掉 [[ 或 @） */
  query: string;
  /** 触发类型：决定插入时是包成 [[]] 还是别的 */
  kind: 'bracket' | 'at';
}

function detectTrigger(text: string, cursor: number): Trigger | null {
  const before = text.slice(0, cursor);
  // 先匹配 `[[` —— Obsidian 风格；优先级最高
  const bracketMatch = before.match(/\[\[([^\][\n]*)$/);
  if (bracketMatch) {
    return { start: cursor - bracketMatch[0].length, query: bracketMatch[1], kind: 'bracket' };
  }
  // 再匹配 `@` —— 必须是行首或空白之后，避免邮箱误命中
  const atMatch = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (atMatch) {
    // 起点要跳过前导空白：atMatch[0] 第一个字符可能是空白
    const leadingSpace = atMatch[0].length > 1 && /\s/.test(atMatch[0][0]) ? 1 : 0;
    return { start: cursor - atMatch[0].length + leadingSpace, query: atMatch[1], kind: 'at' };
  }
  return null;
}

/** 用 mirror div 算 textarea 光标在屏幕上的坐标。够用即可，不追求完美。 */
function getCaretCoords(ta: HTMLTextAreaElement, cursorIdx: number): { x: number; y: number; lineHeight: number } {
  const style = window.getComputedStyle(ta);
  const mirror = document.createElement('div');
  // 复制影响排版的所有样式
  const props = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'padding', 'border', 'boxSizing', 'whiteSpace', 'wordWrap', 'wordBreak',
    'textTransform', 'tabSize',
  ];
  for (const p of props) (mirror.style as unknown as Record<string, string>)[p] = (style as unknown as Record<string, string>)[p];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.style.top = '0';
  mirror.style.left = '0';
  mirror.textContent = ta.value.substring(0, cursorIdx);
  const marker = document.createElement('span');
  marker.textContent = '|';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const markerRect = marker.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const taRect = ta.getBoundingClientRect();
  const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 18;
  const x = taRect.left + (markerRect.left - mirrorRect.left) - ta.scrollLeft;
  const y = taRect.top + (markerRect.top - mirrorRect.top) - ta.scrollTop + lh;
  document.body.removeChild(mirror);
  return { x, y, lineHeight: lh };
}

interface Props {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  storeId: string;
  onInsert: (nextValue: string, nextCursorPos: number) => void;
}

export function WikilinkAutocomplete({ textareaRef, value, storeId, onInsert }: Props) {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [items, setItems] = useState<SuggestItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number; lineHeight: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const queryToken = useRef(0);

  // 监听 textarea 输入：选区变化时检查触发条件
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const handle = () => {
      const cursor = ta.selectionStart ?? 0;
      const next = detectTrigger(ta.value, cursor);
      setTrigger((prev) => {
        if (!next) return null;
        // 触发点变了 → 重置选中索引
        if (!prev || prev.start !== next.start || prev.kind !== next.kind) {
          setSelectedIdx(0);
        }
        return next;
      });
      if (next) {
        try {
          setPos(getCaretCoords(ta, cursor));
        } catch {
          setPos(null);
        }
      }
    };
    ta.addEventListener('input', handle);
    ta.addEventListener('keyup', handle);
    ta.addEventListener('click', handle);
    return () => {
      ta.removeEventListener('input', handle);
      ta.removeEventListener('keyup', handle);
      ta.removeEventListener('click', handle);
    };
  }, [textareaRef, value]);

  // 触发时查接口
  useEffect(() => {
    if (!trigger) {
      setItems([]);
      return;
    }
    const token = ++queryToken.current;
    setLoading(true);
    suggestLinks(storeId, trigger.query, 10)
      .then((res) => {
        if (token !== queryToken.current) return;
        if (res.success) setItems(res.data.items);
        else setItems([]);
      })
      .catch(() => {
        if (token === queryToken.current) setItems([]);
      })
      .finally(() => {
        if (token === queryToken.current) setLoading(false);
      });
  }, [trigger?.query, trigger?.kind, trigger?.start, storeId]);

  // 键盘导航：在 textarea 上拦截
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !trigger) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, Math.max(0, items.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        if (items.length > 0) {
          e.preventDefault();
          insertItem(items[selectedIdx]);
        }
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        setTrigger(null);
      }
    };
    ta.addEventListener('keydown', onKey);
    return () => {
      ta.removeEventListener('keydown', onKey);
    };
  }, [trigger, items, selectedIdx]);

  const insertItem = (item: SuggestItem) => {
    if (!trigger) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart ?? 0;
    const before = value.slice(0, trigger.start);
    const after = value.slice(cursor);
    // 统一插入 [[标题]] —— 不管触发是 [[ 还是 @
    const inserted = `[[${item.title}]]`;
    const next = before + inserted + after;
    onInsert(next, before.length + inserted.length);
    setTrigger(null);
  };

  const visible = useMemo(() => trigger !== null, [trigger]);
  if (!visible || !pos) return null;

  // 位置：光标下方一行；溢出右边界时左收
  const dropdownW = 320;
  const margin = 12;
  let left = pos.x;
  if (left + dropdownW + margin > window.innerWidth) left = window.innerWidth - dropdownW - margin;
  if (left < margin) left = margin;
  const top = pos.y + 2;

  return (
    <div
      style={{
        position: 'fixed',
        left,
        top,
        width: dropdownW,
        background: 'rgba(36,36,52,0.97)',
        backdropFilter: 'blur(10px)',
        border: '1px solid rgba(124,156,255,0.35)',
        borderRadius: 10,
        boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
        zIndex: 9500,
        color: '#fff',
        fontSize: 13,
        overflow: 'hidden',
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        style={{
          padding: '8px 12px',
          fontSize: 11,
          color: 'rgba(255,255,255,0.55)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>
          {trigger?.kind === 'at' ? '@' : '[['} <strong style={{ color: '#fff' }}>{trigger?.query || '(空)'}</strong> · 找到 {items.length} 条
        </span>
        <span style={{ color: 'rgba(255,255,255,0.35)' }}>↑↓ 选 · Enter 确认 · Esc 关</span>
      </div>
      {loading && items.length === 0 && (
        <div style={{ padding: '12px', color: 'rgba(255,255,255,0.5)' }}>正在搜索…</div>
      )}
      {!loading && items.length === 0 && (
        <div style={{ padding: '16px 12px' }}>
          <div style={{ color: 'rgba(255,255,255,0.7)', marginBottom: 8, fontSize: 12 }}>
            没找到「{trigger?.query}」匹配的文档
          </div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>
            继续打 <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 3 }}>{trigger?.kind === 'at' ? '空格取消' : ']]'}</code> 当作普通文本；或换关键字
          </div>
        </div>
      )}
      {items.map((it, idx) => (
        <div
          key={it.entryId}
          onMouseDown={(e) => {
            e.preventDefault();
            insertItem(it);
          }}
          onMouseEnter={() => setSelectedIdx(idx)}
          style={{
            padding: '10px 12px',
            cursor: 'pointer',
            background: idx === selectedIdx ? 'rgba(124,156,255,0.18)' : 'transparent',
            borderBottom: idx < items.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
          }}
        >
          <div style={{ fontWeight: 500, color: '#fff', marginBottom: 2 }}>{it.title}</div>
          {it.summary && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {it.summary}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
