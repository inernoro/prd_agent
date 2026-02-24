import React, { useMemo } from 'react';
import { ReadOnlyImageChip } from '@/components/RichComposer/ReadOnlyImageChip';

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
 */
const COMBINED_REGEX = /@img(\d+)|\[IMG:(https?:\/\/[^|\]\s]+)(?:\|([^\]]*))?\]/g;

export function MessageContentRenderer({ content, canvasItems, onPreview }: MessageContentRendererProps) {
  const parts = useMemo(() => {
    const result: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    COMBINED_REGEX.lastIndex = 0;

    while ((match = COMBINED_REGEX.exec(content)) !== null) {
      const fullMatch = match[0];
      const index = match.index;

      // 添加前面的文本
      if (index > lastIndex) {
        result.push(content.slice(lastIndex, index));
      }

      if (match[1]) {
        // @imgN 引用 → 从 canvas 查找
        const refId = parseInt(match[1], 10);
        const item = canvasItems.find(it => it.refId === refId);

        if (item && item.src) {
          result.push(
            <ReadOnlyImageChip
              key={`chip-${index}`}
              refId={refId}
              src={item.src}
              label={item.prompt || '未命名'}
              style={{ margin: '0 2px', verticalAlign: 'middle', cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                onPreview?.(item.src, item.prompt || '');
              }}
            />
          );
        } else {
          result.push(fullMatch);
        }
      } else if (match[2]) {
        // [IMG:url|label] → 嵌入式图片 URL
        const imgUrl = match[2];
        const imgLabel = match[3] || '图片';

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
    if (lastIndex < content.length) {
      result.push(content.slice(lastIndex));
    }

    return result;
  }, [content, canvasItems, onPreview]);

  return <>{parts}</>;
}
