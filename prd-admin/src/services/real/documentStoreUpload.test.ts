import { describe, expect, it, vi } from 'vitest';
import { classifyDocumentUploadFailure, uploadDocumentFileWithProgress } from './documentStore';

class FakeXhr {
  static latest: FakeXhr | null = null;
  upload: {
    onprogress: ((event: Pick<ProgressEvent, 'lengthComputable' | 'loaded' | 'total'>) => void) | null;
    onload: (() => void) | null;
  } = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 200;
  responseText = JSON.stringify({ success: true, data: {} });

  constructor() {
    FakeXhr.latest = this;
  }

  open() {}
  setRequestHeader() {}
  send() {}
}

describe('classifyDocumentUploadFailure', () => {
  it('把代理或 ASP.NET 提前返回的 413 归类为文件过大', () => {
    const error = classifyDocumentUploadFailure(413, '<html>request entity too large</html>');

    expect(error).toEqual({
      code: 'DOCUMENT_TOO_LARGE',
      message: '文件超过当前大小限制，请缩小文件后重新上传。',
    });
    expect(error.message).not.toMatch(/html|request entity/i);
  });

  it('其他上传失败仍走脱敏后的通用恢复动作', () => {
    const error = classifyDocumentUploadFailure(500, 'HTTP 500 provider traceId=secret');

    expect(error).toEqual({
      code: 'UPLOAD_FAILED',
      message: '文件上传未完成，请检查文件是否完整后重新上传。',
    });
  });

  it('保留后端明确给出的损坏文件结果与恢复动作', () => {
    const error = classifyDocumentUploadFailure(400, JSON.stringify({
      success: false,
      data: null,
      error: {
        code: 'INVALID_FORMAT',
        message: '文件无法解析，请确认文件未损坏并重新选择',
      },
    }));

    expect(error).toEqual({
      code: 'UPLOAD_FAILED',
      message: '文件无法解析，请确认文件未损坏并重新选择',
    });
  });
});

describe('uploadDocumentFileWithProgress', () => {
  it('请求体最后一帧到达时立即切到解析态，不依赖浏览器补发 upload load', async () => {
    const originalXhr = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const phases: Array<{ percent: number; phase: 'uploading' | 'parsing' }> = [];

    try {
      const uploadPromise = uploadDocumentFileWithProgress(
        'store-id',
        new File(['content'], 'sample.txt', { type: 'text/plain' }),
        (percent, phase) => phases.push({ percent, phase }),
      );
      await vi.waitFor(() => expect(FakeXhr.latest).not.toBeNull());
      const xhr = FakeXhr.latest;

      xhr?.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
      xhr?.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });

      expect(phases).toEqual([
        { percent: 50, phase: 'uploading' },
        { percent: 99, phase: 'parsing' },
      ]);
      xhr?.onload?.();
      await uploadPromise;
    } finally {
      globalThis.XMLHttpRequest = originalXhr;
    }
  });
});
