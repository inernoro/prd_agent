/**
 * RichComposer - 富文本输入组件
 * 支持图片 chip 内嵌在文本中
 */
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { EditorState, LexicalEditor } from 'lexical';
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
} from 'lexical';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { ImageChipNode, $createImageChipNode, $isImageChipNode } from './ImageChipNode';
import { ImageMentionPlugin, type ImageOption } from './ImageMentionPlugin';

export type { ImageOption } from './ImageMentionPlugin';

export interface RichComposerRef {
  /** 获取纯文本内容（chip 转为 @imgN） */
  getPlainText: () => string;
  /** 获取结构化内容（文本 + 引用的图片列表） */
  getStructuredContent: () => { text: string; imageRefs: Array<{ canvasKey: string; refId: number }> };
  /** 清空编辑器 */
  clear: () => void;
  /** 聚焦编辑器 */
  focus: () => void;
  /** 插入图片 chip（默认灰色待选，ready: true 为蓝色就绪，preserveFocus: true 保持当前焦点） */
  insertImageChip: (option: ImageOption, opts?: { ready?: boolean; preserveFocus?: boolean }) => void;
  /** 插入文本 */
  insertText: (text: string) => void;
  /** 将所有待选 chip 标记为就绪（灰→蓝） */
  markChipsReady: () => void;
  /** 移除指定 key 的 chip */
  removeChipByKey: (canvasKey: string) => void;
}

interface RichComposerProps {
  /** 占位符 */
  placeholder?: string;
  /** 可选的图片列表（用于 @ 下拉） */
  imageOptions: ImageOption[];
  /** 内容变化回调 */
  onChange?: (text: string) => void;
  /** Enter 发送回调（返回 true 阻止默认换行） */
  onSubmit?: () => boolean | void;
  /** 粘贴图片回调（返回 true 表示已处理，阻止默认行为） */
  onPasteImage?: (file: File) => boolean | void;
  /** 样式 */
  style?: React.CSSProperties;
  /** 类名 */
  className?: string;
  /** 最小高度 */
  minHeight?: number;
  /** 最大高度 */
  maxHeight?: number | string;
}

// 编辑器内部组件
function EditorInner({
  placeholder,
  imageOptions,
  onChange,
  onSubmit,
  onPasteImage,
  style,
  className,
  minHeight = 40,
  maxHeight = '50%',
  composerRef,
}: RichComposerProps & { composerRef: React.Ref<RichComposerRef> }) {
  const [editor] = useLexicalComposerContext();
  const contentEditableRef = useRef<HTMLDivElement>(null);

  // 处理粘贴图片
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!onPasteImage) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find((it) => it.type.startsWith('image/'));
      if (imageItem) {
        const file = imageItem.getAsFile();
        if (file && onPasteImage(file)) {
          e.preventDefault();
        }
      }
    },
    [onPasteImage]
  );

  // 暴露 ref 方法
  useImperativeHandle(
    composerRef,
    () => ({
      getPlainText: () => {
        let text = '';
        editor.getEditorState().read(() => {
          const root = $getRoot();
          text = root.getTextContent();
        });
        // 过滤零宽度空格（用于光标锚点）
        return text.replace(/\u200B/g, '');
      },
      getStructuredContent: () => {
        let text = '';
        const imageRefs: Array<{ canvasKey: string; refId: number }> = [];
        editor.getEditorState().read(() => {
          const root = $getRoot();
          text = root.getTextContent();
          // 遍历所有节点（只收集 image refs，避免重复拼接文本）
          const traverse = (node: any) => {
            if ($isImageChipNode(node)) {
              imageRefs.push({
                canvasKey: node.getCanvasKey(),
                refId: node.getRefId(),
              });
              return;
            }
            if ($isTextNode(node)) return;
            if (node.getChildren) {
              for (const child of node.getChildren()) {
                traverse(child);
              }
            }
          };
          traverse(root);
        });
        // 过滤零宽度空格（用于光标锚点）
        return { text: text.replace(/\u200B/g, '').trim(), imageRefs };
      },
      clear: () => {
        editor.update(() => {
          const root = $getRoot();
          root.clear();
        });
      },
      focus: () => {
        editor.focus();
      },
      insertImageChip: (option: ImageOption, opts?: { ready?: boolean; preserveFocus?: boolean }) => {
        // 保存当前焦点元素（用于 preserveFocus 模式）
        const prevActiveElement = opts?.preserveFocus ? document.activeElement as HTMLElement | null : null;
        
        editor.update(() => {
          const root = $getRoot();
          const chipNode = $createImageChipNode({
            canvasKey: option.key,
            refId: option.refId,
            src: option.src,
            label: option.label,
            ready: opts?.ready, // 默认 undefined/false = 灰色待选
          });
          
          // 直接在编辑器末尾追加节点
          const lastChild = root.getLastChild();
          if ($isParagraphNode(lastChild)) {
            // 先清理末尾的零宽度空格（避免累积）
            const children = lastChild.getChildren();
            for (let i = children.length - 1; i >= 0; i--) {
              const child = children[i];
              if ($isTextNode(child) && child.getTextContent() === '\u200B') {
                child.remove();
              } else {
                break; // 遇到非零宽度空格节点就停止
              }
            }
            // 在最后一个段落末尾追加 chip
            // 注意：不再追加 \u200B 锚点，这会导致光标移动时出现“卡顿”（需要多按一次方向键才能跨过）
            // 依赖 CSS (.rich-composer-paragraph { display: block; min-height: 1.5em; }) 来保证点击聚焦体验
            lastChild.append(chipNode);
          } else {
            // 创建新段落
            const para = $createParagraphNode();
            para.append(chipNode);
            root.append(para);
          }
        }, { discrete: true }); // discrete: 避免触发不必要的副作用
        
        // 恢复焦点：requestAnimationFrame 确保在 Lexical 内部调度完成后执行
        if (prevActiveElement) {
          requestAnimationFrame(() => {
            if (document.activeElement !== prevActiveElement) {
              try {
                prevActiveElement.focus({ preventScroll: true });
              } catch {
                // ignore
              }
            }
          });
        }
      },
      insertText: (text: string) => {
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText(text);
          }
        });
      },
      markChipsReady: () => {
        editor.update(() => {
          const root = $getRoot();
          // 遍历所有节点，找到未就绪的 ImageChipNode 并标记为就绪
          const allNodes = root.getChildren();
          for (const para of allNodes) {
            if (!$isElementNode(para)) continue;
            const children = para.getChildren();
            for (const node of children) {
              if ($isImageChipNode(node) && !node.getReady()) {
                // 创建新节点替换旧节点，确保 DOM 和 React 组件都更新
                const newNode = $createImageChipNode({
                  canvasKey: node.getCanvasKey(),
                  refId: node.getRefId(),
                  src: node.getSrc(),
                  label: node.getLabel(),
                  ready: true,
                });
                node.replace(newNode);
              }
            }
          }
        });
      },
      removeChipByKey: (canvasKey: string) => {
        editor.update(() => {
          const root = $getRoot();
          const allNodes = root.getChildren();
          for (const para of allNodes) {
            if (!$isElementNode(para)) continue;
            const children = para.getChildren();
            for (const node of children) {
              if ($isImageChipNode(node) && node.getCanvasKey() === canvasKey) {
                node.remove();
              }
            }
          }
        });
      },
    }),
    [editor]
  );

  // 处理 Enter 发送
  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (event?.shiftKey) {
          // Shift+Enter 换行，不拦截
          return false;
        }
        // Enter 发送
        if (onSubmit?.()) {
          event?.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, onSubmit]);

  // 内容变化回调
  const handleChange = useCallback(
    (_editorState: EditorState, editor: LexicalEditor) => {
      editor.getEditorState().read(() => {
        const root = $getRoot();
        onChange?.(root.getTextContent());
      });
    },
    [onChange]
  );

  return (
    <>
      <RichTextPlugin
        contentEditable={
          <ContentEditable
            ref={contentEditableRef}
            className={className}
            onPaste={handlePaste}
            style={{
              outline: 'none',
              minHeight,
              maxHeight,
              overflowY: 'auto',
              padding: 0,
              background: 'transparent',
              color: 'var(--text-primary, rgba(255,255,255,0.9))',
              fontSize: 12,
              lineHeight: '1.125rem',
              ...style,
            }}
          />
        }
        placeholder={
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              pointerEvents: 'none',
              color: 'var(--text-muted, rgba(255,255,255,0.4))',
              fontSize: 12,
              lineHeight: '1.125rem',
              userSelect: 'none',
            }}
          >
            {placeholder}
          </div>
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <OnChangePlugin onChange={handleChange} />
      <ImageMentionPlugin imageOptions={imageOptions} />
    </>
  );
}

// 主组件
export const RichComposer = forwardRef<RichComposerRef, RichComposerProps>(
  function RichComposer(props, ref) {
    const initialConfig = {
      namespace: 'VisualAgentComposer',
      theme: {
        paragraph: 'rich-composer-paragraph',
      },
      nodes: [ImageChipNode],
      onError: (error: Error) => {
        console.error('[RichComposer] Error:', error);
      },
    };

    return (
      <LexicalComposer initialConfig={initialConfig}>
        <div style={{ position: 'relative' }}>
          <EditorInner {...props} composerRef={ref} />
        </div>
      </LexicalComposer>
    );
  }
);

export { ImageChipNode, $createImageChipNode, $isImageChipNode };

// 导出两阶段选择组件
export { TwoPhaseRichComposer, type TwoPhaseRichComposerProps, type TwoPhaseRichComposerRef } from './TwoPhaseRichComposer';
