import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { countTranscriptSentences, splitPartialTranscript } from '../recordingVault';

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('countTranscriptSentences', () => {
  it('数的是整篇，不受预览截断影响', () => {
    const text = Array.from({ length: 132 }, (_, i) => `第 ${i + 1} 句`).join('\n');
    expect(countTranscriptSentences(text)).toBe(132);
    // 预览走的是同一套切句，只是截断——两者不能混用
    expect(splitPartialTranscript(text).length).toBe(3);
  });

  it('切句口径与预览同源：空行、首尾空白都不算一句', () => {
    const text = '  开场白  \n\n\n   \n收尾\n';
    expect(countTranscriptSentences(text)).toBe(2);
    expect(splitPartialTranscript(text, 99)).toEqual(['开场白', '收尾']);
  });

  it('没有原文时是 0，不是 NaN 也不是 1', () => {
    expect(countTranscriptSentences(null)).toBe(0);
    expect(countTranscriptSentences(undefined)).toBe(0);
    expect(countTranscriptSentences('')).toBe(0);
    expect(countTranscriptSentences('\n \n')).toBe(0);
  });
});

/*
 * 接线守卫（predicate-and-wiring-discipline 形状 2）：句数这一路删掉不会有测试变红——
 * 界面照样渲染，只是「原文 132 句」悄悄退化成「原文 3 句」。所以在这里钉住：
 * 摆句数的两处都不许拿预览数组的长度当计数。
 */
describe('句数接线', () => {
  it('DocBrowser 的 generatedSentences 取整篇句数，不取预览长度', () => {
    const source = read('components/doc-browser/DocBrowser.tsx');
    expect(source).toContain('generatedSentences={transcribeRun?.transcriptSentenceCount}');
    expect(source).not.toContain('transcriptPreview?.length');
  });

  it('状态卡的兜底不退回预览长度', () => {
    const source = read('components/doc-browser/TranscribeStatusCard.tsx');
    expect(source).toContain('generatedSentences ?? activeRun?.transcriptSentenceCount ?? 0');
    expect(source).not.toContain('generatedSentences ?? transcriptPreview?.length');
  });

  it('有整篇原文的那一层负责数，并把结果交下去', () => {
    const source = read('pages/document-store/DocumentStorePage.tsx');
    expect(source).toContain('transcriptSentenceCount: countTranscriptSentences(activeTranscribeRun.transcriptText)');
  });
});
