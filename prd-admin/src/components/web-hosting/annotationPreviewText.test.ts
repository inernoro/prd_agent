import { expect, it } from 'vitest';
import { annotationPreviewText } from './annotationPreviewText';
it('默认摘要有界、短文完整、截断不切开扩展汉字', () => {
  expect(annotationPreviewText('短意见')).toBe('短意见');
  expect(annotationPreviewText('汉'.repeat(100000))).toHaveLength(281);
  expect(annotationPreviewText('汉'.repeat(279) + '\u{20000}' + '后文')).toBe('汉'.repeat(279) + '…');
});
