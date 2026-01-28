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
  /** 是否为待确认状态（灰色显示） */
  pending?: boolean;
}

export type SerializedImageChipNode = Spread<
  {
    canvasKey: string;
    refId: number;
    src: string;
    label?: string;
    pending?: boolean;
  },
  SerializedLexicalNode
>;

export class ImageChipNode extends DecoratorNode<JSX.Element> {
  __canvasKey: string;
  __refId: number;
  __src: string;
  __label: string;
  __pending: boolean;

  static getType(): string {
    return 'image-chip';
  }

  static clone(node: ImageChipNode): ImageChipNode {
    return new ImageChipNode(
      node.__canvasKey,
      node.__refId,
      node.__src,
      node.__label,
      node.__pending,
      node.__key
    );
  }

  constructor(
    canvasKey: string,
    refId: number,
    src: string,
    label?: string,
    pending?: boolean,
    key?: NodeKey
  ) {
    super(key);
    this.__canvasKey = canvasKey;
    this.__refId = refId;
    this.__src = src;
    this.__label = label || `img${refId}`;
    this.__pending = pending ?? false;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'image-chip-node';
    // 根据 pending 状态使用不同的颜色
    const bgColor = this.__pending ? 'rgba(156, 163, 175, 0.18)' : 'rgba(96, 165, 250, 0.18)';
    const borderColor = this.__pending ? 'rgba(156, 163, 175, 0.35)' : 'rgba(96, 165, 250, 0.35)';
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
    if (this.__pending) {
      span.setAttribute('data-pending', 'true');
    }
    return span;
  }

  updateDOM(): false {
    return false;
  }

  static importJSON(serializedNode: SerializedImageChipNode): ImageChipNode {
    return $createImageChipNode({
      canvasKey: serializedNode.canvasKey,
      refId: serializedNode.refId,
      src: serializedNode.src,
      label: serializedNode.label,
      pending: serializedNode.pending,
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
      pending: this.__pending,
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

  getPending(): boolean {
    return this.__pending;
  }

  /** 确认 pending 状态（变为正常状态） */
  setPending(pending: boolean): ImageChipNode {
    const writable = this.getWritable();
    writable.__pending = pending;
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
        pending={this.__pending}
      />
    );
  }
}

function ImageChipComponent({
  refId,
  src,
  label,
  pending,
}: {
  canvasKey: string;
  refId: number;
  src: string;
  label: string;
  pending: boolean;
}) {
  // 截断标签
  const displayLabel = label.length > 8 ? `${label.slice(0, 6)}...` : label;

  // 根据 pending 状态选择颜色
  const accentColor = pending ? 'rgba(156, 163, 175, 1)' : 'rgba(99, 102, 241, 1)';
  const accentBg = pending ? 'rgba(156, 163, 175, 0.25)' : 'rgba(99, 102, 241, 0.25)';
  const accentBorder = pending ? 'rgba(156, 163, 175, 0.4)' : 'rgba(99, 102, 241, 0.4)';
  const textOpacity = pending ? 0.6 : 0.88;
  const imgOpacity = pending ? 0.6 : 1;

  return (
    <>
      {/* 序号 */}
      <span
        style={{
          minWidth: 14,
          height: 14,
          borderRadius: 3,
          background: accentBg,
          border: `1px solid ${accentBorder}`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 9,
          fontWeight: 700,
          color: accentColor,
          flexShrink: 0,
        }}
      >
        {refId}
      </span>
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
          fontSize: 11,
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
    new ImageChipNode(payload.canvasKey, payload.refId, payload.src, payload.label, payload.pending)
  );
}

export function $isImageChipNode(
  node: LexicalNode | null | undefined
): node is ImageChipNode {
  return node instanceof ImageChipNode;
}
