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
  COPY_COMMAND,
  CUT_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
} from 'lexical';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import {
  hasChipToken,
  inlineMarksToTokens,
  parseChipTokenText,
} from '@/lib/chipTokenText';
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
  /** 仅移除指定 key 的非 ready chip（保留已确认的 chip） */
  removePendingChipByKey: (canvasKey: string) => void;
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
      removePendingChipByKey: (canvasKey: string) => {
        editor.update(() => {
          const root = $getRoot();
          const allNodes = root.getChildren();
          for (const para of allNodes) {
            if (!$isElementNode(para)) continue;
            const children = para.getChildren();
            for (const node of children) {
              if ($isImageChipNode(node) && node.getCanvasKey() === canvasKey && !node.getReady()) {
                node.remove();
              }
            }
          }
        });
      },
    }),
    [editor]
  );

  // Lovart 式 chip 文本 token（对齐 BrandAI ChatPanel）：
  // - 复制/剪切：选区含 chip 时序列化为 "[@image:#N:canvasKey:src]" 纯文本，可跨输入框/外部应用携带；
  // - 粘贴：token 的 canvasKey 命中当前 imageOptions 才还原为就绪 chip（refId/src 以当前集合为准，
  //   防陈旧 token 造幻觉引用），未命中保持纯文本；图片文件粘贴仍走既有 onPasteImage 通道。
  useEffect(() => {
    const $serializeSelection = (): string | null => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return null;
      const chipMeta = new Map<number, { canvasKey: string; src: string }>();
      let hasChip = false;
      for (const node of selection.getNodes()) {
        if ($isImageChipNode(node)) {
          hasChip = true;
          chipMeta.set(node.getRefId(), {
            canvasKey: node.getCanvasKey(),
            src: node.getSrc(),
          });
        }
      }
      if (!hasChip) return null; // 纯文本选区走浏览器默认复制
      // 选区纯文本里 chip 呈现为 @imgN（getTextContent），升级为完整 token
      return inlineMarksToTokens(selection.getTextContent(), chipMeta);
    };
    const handleCopyLike = (payload: unknown, cut: boolean): boolean => {
      const event = payload instanceof ClipboardEvent ? payload : null;
      if (!event?.clipboardData) return false;
      const text = $serializeSelection();
      if (text == null) return false;
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      if (cut) {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) selection.removeText();
      }
      return true;
    };
    const unCopy = editor.registerCommand(
      COPY_COMMAND,
      (payload) => handleCopyLike(payload, false),
      COMMAND_PRIORITY_HIGH
    );
    const unCut = editor.registerCommand(
      CUT_COMMAND,
      (payload) => handleCopyLike(payload, true),
      COMMAND_PRIORITY_HIGH
    );
    const unPaste = editor.registerCommand(
      PASTE_COMMAND,
      (payload) => {
        const event = payload instanceof ClipboardEvent ? payload : null;
        const dt = event?.clipboardData;
        if (!event || !dt) return false;
        // 图片文件优先交给既有 onPasteImage（ContentEditable onPaste）
        const items = Array.from(dt.items ?? []);
        if (items.some((it) => it.type.startsWith('image/'))) return false;
        const text = dt.getData('text/plain');
        if (!text || !hasChipToken(text)) return false;
        event.preventDefault();
        const optionByKey = new Map(imageOptions.map((o) => [o.key, o]));
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return true;
        for (const seg of parseChipTokenText(text)) {
          if (seg.type === 'text') {
            if (seg.text) selection.insertText(seg.text);
            continue;
          }
          const opt = optionByKey.get(seg.canvasKey);
          if (!opt) {
            // 不在当前画布可选集 → 原样保留 token 文本，不构造幻觉引用
            selection.insertText(seg.raw);
            continue;
          }
          selection.insertNodes([
            $createImageChipNode({
              canvasKey: opt.key,
              refId: opt.refId,
              src: opt.src,
              label: opt.label,
              ready: true, // 粘贴还原即就绪（实体色），同 BrandAI 语义
            }),
          ]);
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
    return () => {
      unCopy();
      unCut();
      unPaste();
    };
  }, [editor, imageOptions]);

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
              color: 'var(--text-primary, var(--text-primary))',
              fontSize: 14,
              lineHeight: '20px',
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
              color: 'var(--text-muted, var(--text-muted))',
              fontSize: 14,
              lineHeight: '20px',
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
