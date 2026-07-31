import { describe, expect, it } from 'vitest';
import {
  DOC_DOWNLOAD_FORMATS,
  isTextDownloadType,
  resolveTextExtension,
  shouldFetchOriginalFile,
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
