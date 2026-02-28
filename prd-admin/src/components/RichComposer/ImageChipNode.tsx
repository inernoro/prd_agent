/**
 * ImageChipNode - 图片引用的不可编辑内联节点
 * 在富文本编辑器中显示为带缩略图和名称的 chip
 */
import type {
  DOMConversionMap,
  DOMExportOutput,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical';
import { $applyNodeReplacement, DecoratorNode } from 'lexical';

export interface ImageChipPayload {
  /** 图片在画布中的 key */
  canvasKey: string;
  /** 引用 ID（如 1, 2, 3...） */
  refId: number;
  /** 图片 URL */
  src: string;
  /** 显示名称（可选） */
  label?: string;
  /** 是否已就绪（蓝色显示），默认 false = 待选（灰色） */
  ready?: boolean;
}

export type SerializedImageChipNode = Spread<
  {
    canvasKey: string;
    refId: number;
    src: string;
    label?: string;
    ready?: boolean;
  },
  SerializedLexicalNode
>;

export class ImageChipNode extends DecoratorNode<JSX.Element> {
  __canvasKey: string;
  __refId: number;
  __src: string;
  __label: string;
  __ready: boolean;

  static getType(): string {
    return 'image-chip';
  }

  static clone(node: ImageChipNode): ImageChipNode {
    return new ImageChipNode(
      node.__canvasKey,
      node.__refId,
      node.__src,
      node.__label,
      node.__ready,
      node.__key
    );
  }

  isInline(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return false;
  }

  constructor(
    canvasKey: string,
    refId: number,
    src: string,
    label?: string,
    ready?: boolean,
    key?: NodeKey
  ) {
    super(key);
    this.__canvasKey = canvasKey;
    this.__refId = refId;
    this.__src = src;
    this.__label = label || `img${refId}`;
    this.__ready = ready ?? false; // 默认 false = 待选（灰色）
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'image-chip-node';
    // ready = 蓝色（就绪），!ready = 灰色（待选）
    const bgColor = this.__ready ? 'rgba(96, 165, 250, 0.18)' : 'rgba(156, 163, 175, 0.18)';
    const borderColor = this.__ready ? 'rgba(96, 165, 250, 0.35)' : 'rgba(156, 163, 175, 0.35)';
    span.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 20px;
      padding: 0 6px 0 4px;
      margin: 0 2px;
      background: ${bgColor};
      border: 1px solid ${borderColor};
      border-radius: 4px;
      vertical-align: middle;
      cursor: default;
      user-select: none;
    `;
    span.contentEditable = 'false';
    if (this.__ready) {
      span.setAttribute('data-ready', 'true');
    }
    return span;
  }

  updateDOM(prevNode: ImageChipNode, dom: HTMLElement): boolean {
    // 如果 ready 状态改变，需要更新 DOM 样式
    if (prevNode.__ready !== this.__ready) {
      const bgColor = this.__ready ? 'rgba(96, 165, 250, 0.18)' : 'rgba(156, 163, 175, 0.18)';
      const borderColor = this.__ready ? 'rgba(96, 165, 250, 0.35)' : 'rgba(156, 163, 175, 0.35)';
      dom.style.background = bgColor;
      dom.style.borderColor = borderColor;
      if (this.__ready) {
        dom.setAttribute('data-ready', 'true');
      } else {
        dom.removeAttribute('data-ready');
      }
      return false;
    }
    return false;
  }

  static importJSON(serializedNode: SerializedImageChipNode): ImageChipNode {
    return $createImageChipNode({
      canvasKey: serializedNode.canvasKey,
      refId: serializedNode.refId,
      src: serializedNode.src,
      label: serializedNode.label,
      ready: serializedNode.ready,
    });
  }

  exportJSON(): SerializedImageChipNode {
    return {
      type: 'image-chip',
      version: 1,
      canvasKey: this.__canvasKey,
      refId: this.__refId,
      src: this.__src,
      label: this.__label,
      ready: this.__ready,
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span');
    element.setAttribute('data-lexical-image-chip', 'true');
    element.setAttribute('data-canvas-key', this.__canvasKey);
    element.setAttribute('data-ref-id', String(this.__refId));
    element.textContent = `@img${this.__refId}`;
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  getCanvasKey(): string {
    return this.__canvasKey;
  }

  getRefId(): number {
    return this.__refId;
  }

  getSrc(): string {
    return this.__src;
  }

  getLabel(): string {
    return this.__label;
  }

  getReady(): boolean {
    return this.__ready;
  }

  /** 设置就绪状态 */
  setReady(ready: boolean): ImageChipNode {
    const writable = this.getWritable();
    writable.__ready = ready;
    return writable;
  }

  /** 转为纯文本格式（用于发送） */
  getTextContent(): string {
    return `@img${this.__refId}`;
  }

  decorate(): JSX.Element {
    return (
      <ImageChipComponent
        canvasKey={this.__canvasKey}
        refId={this.__refId}
        src={this.__src}
        label={this.__label}
        ready={this.__ready}
      />
    );
  }
}

function ImageChipComponent({
  src,
  label,
  ready,
}: {
  canvasKey: string;
  refId: number;
  src: string;
  label: string;
  ready: boolean;
}) {
  // 截断标签
  const displayLabel = label.length > 8 ? `${label.slice(0, 6)}...` : label;

  // ready = 蓝色（就绪），!ready = 灰色（待选）
  const textOpacity = ready ? 0.88 : 0.6;
  const imgOpacity = ready ? 1 : 0.6;

  return (
    <>
      {/* 缩略图 */}
      <img
        src={src}
        alt=""
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          objectFit: 'cover',
          flexShrink: 0,
          border: '1px solid rgba(255,255,255,0.22)',
          opacity: imgOpacity,
        }}
      />
      {/* 标签 */}
      <span
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: `rgba(255,255,255,${textOpacity})`,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: 80,
        }}
      >
        {displayLabel}
      </span>
    </>
  );
}

export function $createImageChipNode(payload: ImageChipPayload): ImageChipNode {
  return $applyNodeReplacement(
    new ImageChipNode(payload.canvasKey, payload.refId, payload.src, payload.label, payload.ready)
  );
}

export function $isImageChipNode(
  node: LexicalNode | null | undefined
): node is ImageChipNode {
  return node instanceof ImageChipNode;
}
