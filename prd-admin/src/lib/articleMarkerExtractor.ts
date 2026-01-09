import React from 'react';

export type ArticleMarker = {
  index: number;
  text: string;
  startPos: number;
  endPos: number;
};

/**
 * 从文章内容中提取所有 [插图] : ... 标记
 */
export function extractMarkers(content: string): ArticleMarker[] {
  const regex = /\[插图\]\s*:\s*(.+?)(?=\n|$)/gm;
  const markers: ArticleMarker[] = [];
  let match;
  let index = 0;

  while ((match = regex.exec(content)) !== null) {
    const text = match[1].trim();
    // 跳过空标记（流式输出时可能只有 [插图] : 但还没有描述内容）
    if (text.length === 0) {
      continue;
    }
    markers.push({
      index: index++,
      text,
      startPos: match.index,
      endPos: match.index + match[0].length,
    });
  }

  return markers;
}

/**
 * 高亮显示文章中的 [插图] : ... 标记
 */
export function highlightMarkers(content: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const regex = /\[插图\]\s*:\s*(.+?)(?=\n|$)/gm;
  let match;

  while ((match = regex.exec(content)) !== null) {
    // 普通文本
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    // 高亮标记
    parts.push(
      React.createElement(
        'mark',
        {
          key: match.index,
          className: 'bg-yellow-200 dark:bg-yellow-800 px-1 rounded',
        },
        `[插图] : ${match[1].trim()}`
      )
    );
    lastIndex = match.index + match[0].length;
  }

  // 剩余文本
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return React.createElement(React.Fragment, null, ...parts);
}

/**
 * 替换文章中的 [插图] : ... 标记为图片 Markdown 链接
 */
export function replaceMarkersWithImages(
  content: string,
  images: Array<{ url: string; alt?: string }>
): string {
  const regex = /\[插图\]\s*:\s*(.+?)(?=\n|$)/gm;
  let result = content;
  let offset = 0;

  images.forEach((img) => {
    const match = regex.exec(content);
    if (!match) return;

    const replacement = `![${img.alt || match[1].trim()}](${img.url})`;
    const startPos = match.index + offset;
    const endPos = startPos + match[0].length;

    result = result.slice(0, startPos) + replacement + result.slice(endPos);
    offset += replacement.length - match[0].length;
  });

  return result;
}
