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

const IMG_REF_REGEX = /@img(\d+)/g;

export function MessageContentRenderer({ content, canvasItems, onPreview }: MessageContentRendererProps) {
  const parts = useMemo(() => {
    const result: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    // 重置正则索引
    IMG_REF_REGEX.lastIndex = 0;

    while ((match = IMG_REF_REGEX.exec(content)) !== null) {
      const fullMatch = match[0]; // @img1
      const refIdStr = match[1];
      const refId = parseInt(refIdStr, 10);
      const index = match.index;

      // 添加前面的文本
      if (index > lastIndex) {
        result.push(content.slice(lastIndex, index));
      }

      // 查找对应的图片
      const item = canvasItems.find(it => it.refId === refId);

      if (item && item.src) {
        result.push(
          <ReadOnlyImageChip
            key={`chip-${index}`}
            refId={refId}
            src={item.src}
            label={item.prompt || '未命名'}
            // 微调样式以匹配文本行高
            style={{ margin: '0 2px', verticalAlign: 'middle', cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              onPreview?.(item.src, item.prompt || '');
            }}
          />
        );
      } else {
        // 找不到图片，原样显示文本
        result.push(fullMatch);
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
