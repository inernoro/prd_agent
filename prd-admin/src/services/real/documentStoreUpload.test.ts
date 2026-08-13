import { describe, expect, it } from 'vitest';
import { classifyDocumentUploadFailure } from './documentStore';

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
});
