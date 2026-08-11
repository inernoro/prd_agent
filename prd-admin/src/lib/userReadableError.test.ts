import { describe, expect, it } from 'vitest';
import { toUserReadableErrorMessage } from './userReadableError';

const options = {
  fallbackMessage: '文件上传未完成',
  recoveryMessage: '请检查文件后重新上传。',
};

describe('toUserReadableErrorMessage', () => {
  it('从标准错误响应中提取用户文案并补充恢复动作', () => {
    const message = toUserReadableErrorMessage(
      '{"success":false,"data":null,"error":{"code":"INVALID_FORMAT","message":"文件内容无法解析"},"traceId":"trace-1"}',
      options,
    );

    expect(message).toBe('文件内容无法解析，请检查文件后重新上传。');
    expect(message).not.toMatch(/success|traceId|INVALID_FORMAT/);
  });

  it('屏蔽内部诊断和上游协议错误', () => {
    const message = toUserReadableErrorMessage(
      { code: 'UPLOAD_FAILED', message: 'Input must have at least 1 token. requestId=req-1' },
      options,
    );

    expect(message).toBe('文件上传未完成，请检查文件后重新上传。');
    expect(message).not.toMatch(/token|requestId/i);
  });

  it('把服务异常归类为稳定用户提示', () => {
    const message = toUserReadableErrorMessage(
      { code: 'SERVER_UNAVAILABLE', message: 'HTTP 503 /api/files' },
      options,
    );

    expect(message).toBe('服务暂时不可用，请检查文件后重新上传。');
    expect(message).not.toMatch(/HTTP|\/api\//i);
  });

  it('保留已经包含恢复动作的安全中文文案', () => {
    const message = toUserReadableErrorMessage(
      { code: 'INVALID_FORMAT', message: '文件格式不受支持，请更换文件后重试。' },
      options,
    );

    expect(message).toBe('文件格式不受支持，请更换文件后重试。');
  });

  it('权限不足时提示联系管理员而不是要求重新登录', () => {
    const message = toUserReadableErrorMessage(
      { code: 'PERMISSION_DENIED', message: 'forbidden' },
      options,
    );

    expect(message).toBe('当前账号没有执行此操作的权限，请联系管理员开通后重试。');
    expect(message).not.toContain('重新登录');
  });
});
