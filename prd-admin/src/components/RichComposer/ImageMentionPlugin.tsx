/**
 * ImageMentionPlugin - 处理 @img 提及逻辑
 * 监听输入，检测 @img 模式，显示下拉菜单
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  TextNode,
} from 'lexical';
import { useCallback, useEffect, useLayoutEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { $createImageChipNode } from './ImageChipNode';

export interface ImageOption {
  key: string;
  refId: number;
  src: string;
  label: string;
}

interface ImageMentionPluginProps {
  /** 可选的图片列表 */
  imageOptions: ImageOption[];
  /** 插入图片后回调 */
  onImageInserted?: (option: ImageOption) => void;
}

// 检测 @ 模式的正则：@、@i、@im、@img、@img1、@img12 等
const MENTION_REGEX = /@(i(m(g(\d*))?)?)?$/;

export function ImageMentionPlugin({
  imageOptions,
  onImageInserted,
}: ImageMentionPluginProps) {
  const [editor] = useLexicalComposerContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // 过滤匹配的图片
  const filteredOptions = imageOptions.filter((opt) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      opt.label.toLowerCase().includes(q) ||
      String(opt.refId).includes(q)
    );
  });

  // 重置选中索引当过滤结果变化时
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredOptions.length]);

  // 插入图片 chip
  const insertImageChip = useCallback(
    (option: ImageOption) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        // 删除 @img 前缀文本
        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        if (anchorNode instanceof TextNode) {
          const text = anchorNode.getTextContent();
          const offset = anchor.offset;
          // 找到 @ 的位置
          let atIndex = -1;
          for (let i = offset - 1; i >= 0; i--) {
            if (text[i] === '@') {
              atIndex = i;
              break;
            }
          }
          if (atIndex >= 0) {
            // 删除从 @ 到当前位置的文本
            const before = text.slice(0, atIndex);
            const after = text.slice(offset);
            anchorNode.setTextContent(before + after);
            selection.setTextNodeRange(anchorNode, before.length, anchorNode, before.length);
          }
        }

        // 插入 chip 节点
        const chipNode = $createImageChipNode({
          canvasKey: option.key,
          refId: option.refId,
          src: option.src,
          label: option.label,
        });
        selection.insertNodes([chipNode]);

        // 插入后添加空格
        selection.insertText(' ');
      });

      setMenuOpen(false);
      setQuery('');
      onImageInserted?.(option);
    },
    [editor, onImageInserted]
  );

  // 监听编辑器更新，检测 @ 模式
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          setMenuOpen(false);
          return;
        }

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        
        if (!(anchorNode instanceof TextNode)) {
          setMenuOpen(false);
          return;
        }

        const text = anchorNode.getTextContent();
        const offset = anchor.offset;
        const textBefore = text.slice(0, offset);

        // 检测 @ 模式
        const match = MENTION_REGEX.exec(textBefore);
        if (match) {
          // 提取数字部分作为查询（如果有的话）
          const fullMatch = match[0]; // e.g., "@", "@i", "@img", "@img1"
          const numMatch = fullMatch.match(/@img(\d+)$/);
          const q = numMatch ? numMatch[1] : '';
          setQuery(q);
          setMenuOpen(true);

          // 获取光标位置
          requestAnimationFrame(() => {
            const domSelection = window.getSelection();
            if (domSelection && domSelection.rangeCount > 0) {
              const range = domSelection.getRangeAt(0);
              const rect = range.getBoundingClientRect();
              setMenuPosition({ x: rect.left, y: rect.bottom + 4 });
            }
          });
        } else {
          setMenuOpen(false);
        }
      });
    });
  }, [editor]);

  // 键盘命令处理
  useEffect(() => {
    if (!menuOpen) return;

    const removeEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        setMenuOpen(false);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    const removeArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      () => {
        setSelectedIndex((i) => Math.min(i + 1, filteredOptions.length - 1));
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    const removeArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      () => {
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    const removeEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (filteredOptions[selectedIndex]) {
          event?.preventDefault();
          insertImageChip(filteredOptions[selectedIndex]);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH
    );

    const removeTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (filteredOptions[selectedIndex]) {
          event?.preventDefault();
          insertImageChip(filteredOptions[selectedIndex]);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH
    );

    return () => {
      removeEscape();
      removeArrowDown();
      removeArrowUp();
      removeEnter();
      removeTab();
    };
  }, [editor, menuOpen, selectedIndex, filteredOptions, insertImageChip]);

  // 点击外部关闭菜单
  useLayoutEffect(() => {
    if (!menuOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  if (!menuOpen || !menuPosition || filteredOptions.length === 0) {
    return null;
  }

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left: menuPosition.x,
        top: menuPosition.y,
        zIndex: 9999,
        background: 'var(--bg-elevated, #1a1a2e)',
        border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
        borderRadius: 12,
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        padding: 4,
        minWidth: 200,
        maxHeight: 240,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          padding: '4px 8px',
          fontSize: 10,
          color: 'var(--text-muted, rgba(255,255,255,0.5))',
          borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
          marginBottom: 4,
        }}
      >
        选择图片引用（{filteredOptions.length}）
      </div>
      {filteredOptions.map((opt, idx) => (
        <button
          key={opt.key}
          type="button"
          onClick={() => insertImageChip(opt)}
          onMouseEnter={() => setSelectedIndex(idx)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 8px',
            border: 'none',
            borderRadius: 8,
            background: idx === selectedIndex ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span
            style={{
              minWidth: 18,
              height: 18,
              borderRadius: 4,
              background: 'rgba(99, 102, 241, 0.25)',
              border: '1px solid rgba(99, 102, 241, 0.4)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              fontWeight: 700,
              color: 'rgba(99, 102, 241, 1)',
            }}
          >
            {opt.refId}
          </span>
          <img
            src={opt.src}
            alt=""
            style={{
              width: 24,
              height: 24,
              borderRadius: 4,
              objectFit: 'cover',
              border: '1px solid rgba(255,255,255,0.15)',
            }}
          />
          <span
            style={{
              flex: 1,
              fontSize: 12,
              color: 'var(--text-primary, rgba(255,255,255,0.9))',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {opt.label}
          </span>
        </button>
      ))}
    </div>,
    document.body
  );
}
