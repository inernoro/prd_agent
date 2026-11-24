import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyDocumentUploadFailure, uploadDocumentFileWithProgress } from './documentStore';

vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ token: null }) } }));

class UploadRequest {
  static sent: UploadRequest[] = [];
  upload = {
    onprogress: null as ((event: Pick<ProgressEvent, 'lengthComputable' | 'loaded' | 'total'>) => void) | null,
    onload: null as (() => void) | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 200;
  responseText = JSON.stringify({ success: true, data: { entry: { id: 'own-entry' } } });
  open = vi.fn();
  setRequestHeader = vi.fn();
  send() { UploadRequest.sent.push(this); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  UploadRequest.sent = [];
});

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

  it('保留后端已确认损坏文件的完整结果与重新选择动作', () => {
    const message = '文件无法解析，请确认文件未损坏并重新选择';
    const error = classifyDocumentUploadFailure(400, JSON.stringify({
      success: false, error: { code: 'INVALID_FORMAT', message },
    }));

    expect(error).toEqual({ code: 'UPLOAD_FAILED', message });
  });
});

describe('uploadDocumentFileWithProgress 的实际 XHR 接线', () => {
  it('四舍五入到 99% 时仍为上传，只有请求体发送结束才进入解析', async () => {
    vi.stubGlobal('XMLHttpRequest', UploadRequest);
    const progress = vi.fn();
    const result = uploadDocumentFileWithProgress('own-store', new File(['正文'], '中文文件.txt'), progress);
    await vi.waitFor(() => expect(UploadRequest.sent).toHaveLength(1));
    const xhr = UploadRequest.sent[0];

    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 994, total: 1000 });
    expect(progress).toHaveBeenLastCalledWith(99, 'uploading');
    xhr.upload.onload?.();
    expect(progress).toHaveBeenLastCalledWith(99, 'parsing');
    xhr.onload?.();
    expect((await result).success).toBe(true);
    expect(progress).toHaveBeenLastCalledWith(100, 'parsing');
  });

  it('失败回执不发出完成百分比，损坏文件提示只返回一次', async () => {
    vi.stubGlobal('XMLHttpRequest', UploadRequest);
    const progress = vi.fn();
    const result = uploadDocumentFileWithProgress('own-store', new File(['坏文件'], '损坏.pdf'), progress);
    await vi.waitFor(() => expect(UploadRequest.sent).toHaveLength(1));
    const xhr = UploadRequest.sent[0];
    xhr.status = 400;
    xhr.responseText = JSON.stringify({
      success: false, error: { code: 'INVALID_FORMAT', message: '文件无法解析，请确认文件未损坏并重新选择' },
    });

    xhr.upload.onload?.();
    xhr.onload?.();
    expect(await result).toMatchObject({
      success: false, error: { message: '文件无法解析，请确认文件未损坏并重新选择' },
    });
    expect(progress.mock.calls).toEqual([[99, 'parsing']]);
  });

  it('网络中断返回可重传的错误，不伪造完成进度', async () => {
    vi.stubGlobal('XMLHttpRequest', UploadRequest);
    const progress = vi.fn();
    const result = uploadDocumentFileWithProgress('own-store', new File(['正文'], '中文文件.txt'), progress);
    await vi.waitFor(() => expect(UploadRequest.sent).toHaveLength(1));
    UploadRequest.sent[0].onerror?.();

    expect(await result).toMatchObject({ success: false, error: { code: 'UPLOAD_FAILED', message: expect.stringContaining('可重试') } });
    expect(progress).not.toHaveBeenCalled();
  });
});
