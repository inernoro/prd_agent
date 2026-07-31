import { describe, expect, it } from 'vitest';
import {
  DOC_DOWNLOAD_FORMATS,
  isTextDownloadType,
  resolveTextExtension,
  resolveInitialDownloadScope,
  shouldFetchOriginalFile,
  toPlainText,
} from '../downloadFormats';

describe('isTextDownloadType', () => {
  it('文字类：空 contentType / text/* / markdown / html', () => {
    expect(isTextDownloadType(undefined)).toBe(true);
    expect(isTextDownloadType('')).toBe(true);
    expect(isTextDownloadType('text/plain')).toBe(true);
    expect(isTextDownloadType('text/markdown')).toBe(true);
    expect(isTextDownloadType('text/html')).toBe(true);
  });

  it('二进制类：pdf / word / 图片即使抽出了正文也按原文件处理', () => {
    expect(isTextDownloadType('application/pdf')).toBe(false);
    expect(isTextDownloadType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
    expect(isTextDownloadType('image/png')).toBe(false);
  });
});

describe('resolveTextExtension — 用户选的格式说了算', () => {
  it('纯文本一律 .txt，不因原始类型而变', () => {
    expect(resolveTextExtension('text', 'text/markdown')).toBe('.txt');
    expect(resolveTextExtension('text', 'text/html')).toBe('.txt');
    expect(resolveTextExtension('text', 'application/pdf')).toBe('.txt');
  });

  it('Markdown 一律 .md', () => {
    expect(resolveTextExtension('markdown', 'text/html')).toBe('.md');
    expect(resolveTextExtension('markdown', undefined)).toBe('.md');
  });

  it('只有「原始文件」格式才保留 .html', () => {
    expect(resolveTextExtension('original', 'text/html')).toBe('.html');
    expect(resolveTextExtension('original', 'text/markdown')).toBe('.md');
  });
});

describe('shouldFetchOriginalFile — 只有真需要原文件时才去拉', () => {
  it('原始文件 + 二进制 + 有 fileUrl 才拉', () => {
    expect(shouldFetchOriginalFile('original', 'application/pdf', 'https://cdn/x.pdf')).toBe(true);
  });

  it('选了 markdown / 纯文本时不去拉二进制原文件', () => {
    expect(shouldFetchOriginalFile('markdown', 'application/pdf', 'https://cdn/x.pdf')).toBe(false);
    expect(shouldFetchOriginalFile('text', 'application/pdf', 'https://cdn/x.pdf')).toBe(false);
  });

  it('文字类条目或没有 fileUrl 时不拉', () => {
    expect(shouldFetchOriginalFile('original', 'text/markdown', 'https://cdn/x.md')).toBe(false);
    expect(shouldFetchOriginalFile('original', 'application/pdf', undefined)).toBe(false);
  });
});

describe('DOC_DOWNLOAD_FORMATS', () => {
  it('三种格式都有面向用户的说明，不留空文案', () => {
    expect(DOC_DOWNLOAD_FORMATS.map(f => f.value)).toEqual(['markdown', 'text', 'original']);
    for (const f of DOC_DOWNLOAD_FORMATS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.hint.length).toBeGreaterThan(0);
    }
  });
});

// Codex P2：「纯文本 (.txt)」的文案承诺「只留文字内容」，只换后缀等于骗人。
describe('toPlainText — 纯文本要真的是纯文本', () => {
  it('去掉 Markdown 标记但保留文字本身', () => {
    const md = [
      '# 标题',
      '',
      '> 引用一句',
      '',
      '- 列表项 **加粗** 和 `代码`',
      '',
      '[链接文字](https://example.com) 与 ![图片说明](a.png)',
      '',
      '[[双链条目|别名]]',
    ].join('\n');
    const out = toPlainText(md, 'text/markdown');

    expect(out).toContain('标题');
    expect(out).toContain('引用一句');
    expect(out).toContain('列表项 加粗 和 代码');
    expect(out).toContain('链接文字');
    expect(out).toContain('图片说明');
    expect(out).toContain('双链条目');
    // 标记符号不该留下
    expect(out).not.toContain('# ');
    expect(out).not.toContain('](');
    expect(out).not.toContain('**');
    expect(out).not.toContain('[[');
  });

  it('代码围栏行去掉，围栏内的代码正文保留（那也是用户的字）', () => {
    const out = toPlainText('```ts\nconst a = 1;\n```', 'text/markdown');
    expect(out).toContain('const a = 1;');
    expect(out).not.toContain('```');
  });

  it('HTML 去标签、丢脚本样式、解实体', () => {
    const html = '<style>.a{color:red}</style><p>第一段</p><script>bad()</script><p>第二段 &amp; 收尾</p>';
    const out = toPlainText(html, 'text/html');

    expect(out).toContain('第一段');
    expect(out).toContain('第二段 & 收尾');
    expect(out).not.toContain('bad()');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('<');
  });

  it('不吃掉普通正文里的星号/井号（不重排、不误删）', () => {
    const out = toPlainText('单价 3 * 4 元，编号 #1234', 'text/markdown');
    expect(out).toBe('单价 3 * 4 元，编号 #1234');
  });
});

describe('resolveInitialDownloadScope — 默认下载当前文章', () => {
  it('有正在读的文章：默认只下这一篇，不逼人下整库 ZIP', () => {
    expect(resolveInitialDownloadScope(true)).toBe('entry');
  });

  it('没打开文档：才回落整库', () => {
    expect(resolveInitialDownloadScope(false)).toBe('store');
  });
});
