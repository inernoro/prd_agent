import React, { useMemo } from 'react';
import { ReadOnlyImageChip } from '@/components/RichComposer/ReadOnlyImageChip';
import { parseVisualMessageDisplay, cleanChipLabel } from '@/lib/visualMessageDisplay';

interface CanvasItemSubset {
  refId?: number;
  src: string;
  prompt?: string;
  key: string;
}

interface MessageContentRendererProps {
  content: string;
  canvasItems: CanvasItemSubset[];
  onPreview?: (src: string, prompt: string) => void;
}

/**
 * 统一正则：匹配 @imgN（画布引用）和 [IMG:url|label]（嵌入式图片 URL）
 *
 * 支持的格式：
 * - @img1, @img2, ...          → 从 canvasItems 按 refId 查找
 * - [IMG:https://...|参考图]    → 直接使用嵌入的 URL
 * - [IMG:https://...]           → 无 label 时使用默认 "图片"
 *
 * (?!\d) 防止 @img1 命中 @img12 的前缀。
 */
const COMBINED_REGEX = /@img(\d+)(?!\d)|\[IMG:(https?:\/\/[^|\]\s]+)(?:\|([^\]]*))?\]/g;

/**
 * 引用无法在画布中解析出缩略图时的中性 chip：
 * 只显示"图N"短标签，绝不显示原始文件名。
 */
function NeutralRefChip({ refId }: { refId: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 20,
        padding: '0 6px',
        margin: '0 2px',
        background: 'rgba(156, 163, 175, 0.18)',
        border: '1px solid rgba(156, 163, 175, 0.35)',
        borderRadius: 4,
        verticalAlign: 'middle',
        userSelect: 'none',
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--text-secondary)',
        whiteSpace: 'nowrap',
      }}
    >
      {refId > 0 ? `图${refId}` : '图片'}
    </span>
  );
}

/**
 * 视觉创作消息内容渲染器：
 * - 先经 parseVisualMessageDisplay 剥离模型层泄漏（生图前缀 / 【引用图片】文字块 / 文件名行），
 *   历史污染消息也能干净展示（存储不动，只清展示层）；
 * - 正文中的 @imgN / [IMG:url|label] 就地渲染为视觉 chip；
 * - 仅存在于被剥离引用块中的 refId，以 chip 行渲染在正文上方，杜绝任何文字版引用。
 */
export function MessageContentRenderer({ content, canvasItems, onPreview }: MessageContentRendererProps) {
  const { parts, blockChips } = useMemo(() => {
    const parsed = parseVisualMessageDisplay(content);

    const renderRefChip = (refId: number, keyPrefix: string, index: number): React.ReactNode => {
      const item = canvasItems.find((it) => it.refId === refId);
      if (item && item.src) {
        return (
          <ReadOnlyImageChip
            key={`${keyPrefix}-${index}`}
            refId={refId}
            src={item.src}
            label={cleanChipLabel(item.prompt, refId)}
            style={{ margin: '0 2px', verticalAlign: 'middle', cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              onPreview?.(item.src, item.prompt || '');
            }}
          />
        );
      }
      // 无缩略图可解析 → 中性 chip（绝不落回原始文本/文件名）
      return <NeutralRefChip key={`${keyPrefix}-${index}`} refId={refId} />;
    };

    // 顶部 chip 行：引用块里有、正文里没有的引用
    const blockChips: React.ReactNode[] = parsed.blockRefIds.map((refId, i) =>
      renderRefChip(refId, 'blk', i)
    );

    const text = parsed.text;
    const result: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    COMBINED_REGEX.lastIndex = 0;

    while ((match = COMBINED_REGEX.exec(text)) !== null) {
      const fullMatch = match[0];
      const index = match.index;

      // 添加前面的文本
      if (index > lastIndex) {
        result.push(text.slice(lastIndex, index));
      }

      if (match[1]) {
        // @imgN 引用 → 从 canvas 查找；找不到渲染中性 chip
        const refId = parseInt(match[1], 10);
        result.push(renderRefChip(refId, 'chip', index));
      } else if (match[2]) {
        // [IMG:url|label] → 嵌入式图片 URL
        const imgUrl = match[2];
        const imgLabel = cleanChipLabel(match[3] || '', 0);

        result.push(
          <ReadOnlyImageChip
            key={`emb-${index}`}
            refId={0}
            src={imgUrl}
            label={imgLabel}
            style={{ margin: '0 2px', verticalAlign: 'middle', cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              onPreview?.(imgUrl, imgLabel);
            }}
          />
        );
      }

      lastIndex = index + fullMatch.length;
    }

    // 添加剩余文本
    if (lastIndex < text.length) {
      result.push(text.slice(lastIndex));
    }

    return { parts: result, blockChips };
  }, [content, canvasItems, onPreview]);

  return (
    <>
      {blockChips.length > 0 ? (
        <span style={{ display: 'block', marginBottom: parts.length > 0 ? 4 : 0 }}>{blockChips}</span>
      ) : null}
      {parts}
    </>
  );
}
