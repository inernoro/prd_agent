import { describe, expect, it } from 'vitest';
import {
  advanceDocumentUploadProgress,
  beginDocumentUploadProgress,
  describeDocumentUploadProgress,
} from '../documentUploadProgress';

describe('documentUploadProgress', () => {
  it('上传未完成时显示真实百分比', () => {
    const initial = beginDocumentUploadProgress('样本.txt', 1, 2);
    const progress = advanceDocumentUploadProgress(initial, {
      name: '样本.txt', percent: 42, index: 1, total: 2,
    }, 1_000);

    expect(progress.phase).toBe('uploading');
    expect(describeDocumentUploadProgress(progress, 5_000)).toEqual({
      title: '正在上传 样本.txt',
      status: '42%',
      barPercent: 42,
      parsingSeconds: 0,
    });
  });

  it('字节传完后进入解析阶段并持续累计等待时间', () => {
    const initial = beginDocumentUploadProgress('样本.docx', 1, 1);
    const parsing = advanceDocumentUploadProgress(initial, {
      name: '样本.docx', percent: 99, index: 1, total: 1,
    }, 10_000);
    const repeated = advanceDocumentUploadProgress(parsing, {
      name: '样本.docx', percent: 100, index: 1, total: 1,
    }, 12_000);

    expect(repeated.phase).toBe('parsing');
    expect(repeated.parsingStartedAt).toBe(10_000);
    expect(describeDocumentUploadProgress(repeated, 13_400)).toEqual({
      title: '正在解析 样本.docx',
      status: '解析中 · 已等待 3 秒',
      barPercent: 100,
      parsingSeconds: 3,
    });
  });

  it('切换到下一个文件时重置解析起点', () => {
    const first = advanceDocumentUploadProgress(null, {
      name: '第一份.pdf', percent: 99, index: 1, total: 2,
    }, 2_000);
    const second = advanceDocumentUploadProgress(first, {
      name: '第二份.pdf', percent: 99, index: 2, total: 2,
    }, 8_000);

    expect(second.parsingStartedAt).toBe(8_000);
    expect(second.index).toBe(2);
  });
});
