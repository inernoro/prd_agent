// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MessageContentRenderer } from './MessageContentRenderer';
import { ChatMessageItem } from './ChatMessageItem';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

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


describe('本地资源引用的既有地址契约', () => {
  const localSrc = '/local-assets/visual-agent/image/ab%20cd.png';
  it.each([false, true])('本地资源在画布存在=%s时仍显示缩略图', (onCanvas) => {
    const html = renderToStaticMarkup(createElement(MessageContentRenderer, {
      content: `[@image:#1:original:${localSrc}]`,
      canvasItems: onCanvas ? [{ key: 'original', refId: 1, src: localSrc }] : [],
    }));
    expect(html).toContain('<img');
    expect(html).toContain(localSrc);
  });

  it('真实点击本地引用卡片仍调用原预览入口', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onPreview = vi.fn();
    try {
      await act(async () => root.render(createElement(MessageContentRenderer, {
        content: `[@image:#1:original:${localSrc}]`, canvasItems: [], onPreview,
      })));
      const image = host.querySelector('img');
      expect(image).not.toBeNull();
      await act(async () => image!.parentElement!.click());
      expect(onPreview).toHaveBeenCalledWith(localSrc, '');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it.each(['//outside.example/image.png', 'javascript:alert(1)'])('继续拒绝非受支持图片地址 %s', (src) => {
    const html = renderToStaticMarkup(createElement(MessageContentRenderer, {
      content: `[@image:#1:original:${src}]`, canvasItems: [],
    }));
    expect(html).not.toContain('<img');
  });
});
