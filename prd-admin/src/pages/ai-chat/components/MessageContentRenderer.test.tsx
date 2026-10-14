import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContentRenderer } from './MessageContentRenderer';
import { ChatMessageItem } from './ChatMessageItem';

describe('图片引用的消息回读', () => {
  it('复制占位符显示为图片卡片，画布删除后仍保留原引用', () => {
    const html = renderToStaticMarkup(createElement(MessageContentRenderer, {
      content: '请把 [@image:#1:original:https://example.com/original.png] 改为水彩。', canvasItems: [],
    }));
    expect(html).toContain('<img');
    expect(html).toContain('https://example.com/original.png');
    expect(html).toContain('改为水彩');
    expect(html).not.toContain('[@image:');
  });

  it('历史引用不会因为相同数字编号指向另一张图片', () => {
    const html = renderToStaticMarkup(createElement(MessageContentRenderer, {
      content: '[@image:#1:original:https://example.com/original.png]',
      canvasItems: [{ key: 'replacement', refId: 1, src: 'https://example.com/replacement.png' }],
    }));
    expect(html).toContain('https://example.com/original.png');
    expect(html).not.toContain('replacement.png');
  });

  it.each([
    { kind: '结构化', content: '[GEN_ERROR]' + JSON.stringify({ msg: '参考图 @img2 无法使用。其他输入已保留，请重新上传这张参考图后再生成。' }) },
    { kind: '旧文本', content: '生成失败：参考图 @img2 无法使用。其他输入已保留，请重新上传这张参考图后再生成。' },
  ])('$kind 失败说明使用可读引用，不把后台图片标记显示给用户', ({ content }) => {
    const html = renderToStaticMarkup(createElement(ChatMessageItem, {
      msg: { id: 'failure', role: 'Assistant', ts: 0, content },
      allMessages: [], canvas: [], sizeToAspectMap: new Map(), onPreview: () => {}, onRetry: () => {},
    }));
    expect(html).toContain('生成失败');
    expect(html).toContain('其他输入已保留');
    expect(html).toContain('图2');
    expect(html).not.toContain('@img2');
  });
});
