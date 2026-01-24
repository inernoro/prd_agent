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
  $getRoot,
  $getSelection,
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
  /** 插入图片 chip */
  insertImageChip: (option: ImageOption) => void;
  /** 插入文本 */
  insertText: (text: string) => void;
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
  style,
  className,
  minHeight = 40,
  maxHeight = '50%',
  composerRef,
}: RichComposerProps & { composerRef: React.Ref<RichComposerRef> }) {
  const [editor] = useLexicalComposerContext();
  const contentEditableRef = useRef<HTMLDivElement>(null);

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
        return text;
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
        return { text: text.trim(), imageRefs };
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
      insertImageChip: (option: ImageOption) => {
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const chipNode = $createImageChipNode({
            canvasKey: option.key,
            refId: option.refId,
            src: option.src,
            label: option.label,
          });
          selection.insertNodes([chipNode]);
          selection.insertText(' ');
        });
      },
      insertText: (text: string) => {
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText(text);
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
