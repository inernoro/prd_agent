import { describe, expect, it } from 'vitest';
import { advanceDocumentUploadProgress, beginDocumentUploadProgress, describeDocumentUploadProgress } from './documentUploadProgress';

describe('文件传输与解析展示', () => {
  it('99% 的字节进度不能推断正文已开始解析', () => {
    const initial = beginDocumentUploadProgress('中文文件.txt', 1, 2);
    const progress = advanceDocumentUploadProgress(initial, { ...initial, percent: 99.4 }, 1000);
    expect(progress.phase).toBe('uploading');
    expect(progress.parsingStartedAt).toBeUndefined();
    expect(describeDocumentUploadProgress(progress, 5000)).toMatchObject({ title: '正在上传 中文文件.txt', status: '99%', barPercent: 99 });
  });

  it('显式传输结束后持续显示解析等待时间，不编造解析百分比', () => {
    const initial = beginDocumentUploadProgress('中文文件.txt', 1, 1);
    const parsing = advanceDocumentUploadProgress(initial, { ...initial, phase: 'parsing', percent: 99 }, 0);
    expect(describeDocumentUploadProgress(parsing, 1000)).toMatchObject({ title: '正在解析 中文文件.txt', status: '解析中 · 已等待 1 秒', barPercent: 100 });
    const completed = advanceDocumentUploadProgress(parsing, { ...parsing, percent: 100 }, 3500);
    expect(describeDocumentUploadProgress(completed, 3500).parsingSeconds).toBe(3);
  });

  it('同名下一份文件不沿用上一份的解析时钟', () => {
    const first = advanceDocumentUploadProgress(null, { name: '同名.txt', index: 1, total: 2, percent: 99, phase: 'parsing' }, 1000);
    const second = advanceDocumentUploadProgress(first, { name: '同名.txt', index: 2, total: 2, percent: 99, phase: 'parsing' }, 5000);
    expect(second.parsingStartedAt).toBe(5000);
    expect(describeDocumentUploadProgress(second, 6000).parsingSeconds).toBe(1);
  });

  it('完成或失败后重新选择文件从零开始，不残留解析状态', () => {
    const restarted = beginDocumentUploadProgress('重试.txt', 1, 1);
    expect(restarted).toEqual({ name: '重试.txt', percent: 0, index: 1, total: 1, phase: 'uploading' });
    expect(describeDocumentUploadProgress(restarted, 100_000).parsingSeconds).toBe(0);
  });

  it('返回上传阶段时清除解析时钟', () => {
    const parsing = advanceDocumentUploadProgress(null, { name: '文件.txt', index: 1, total: 1, percent: 99, phase: 'parsing' }, 1000);
    const uploading = advanceDocumentUploadProgress(parsing, { name: '文件.txt', index: 1, total: 1, percent: 10, phase: 'uploading' }, 2000);
    expect(uploading.parsingStartedAt).toBeUndefined();
  });
});
