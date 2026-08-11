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

  it('屏蔽浏览器网络错误和模型协议诊断', () => {
    const networkMessage = toUserReadableErrorMessage(new TypeError('Failed to fetch'), options);
    const protocolMessage = toUserReadableErrorMessage(
      new Error('HTTP 502 provider image model protocol mismatch'),
      options,
    );

    expect(networkMessage).toBe('文件上传未完成，请检查文件后重新上传。');
    expect(protocolMessage).toBe('文件上传未完成，请检查文件后重新上传。');
    expect(`${networkMessage} ${protocolMessage}`).not.toMatch(/fetch|HTTP|provider|model|protocol/i);
  });

  it('已知错误码携带未登记文案时也不直接展示', () => {
    const message = toUserReadableErrorMessage(
      { code: 'INVALID_FORMAT', message: '文件内部处理失败，请联系服务负责人。' },
      options,
    );

    expect(message).toBe('文件上传未完成，请检查文件后重新上传。');
  });

  it('显式允许的错误码仍会屏蔽网络地址和密钥', () => {
    const connection = toUserReadableErrorMessage(
      { code: 'VALIDATION_ERROR', message: 'connect ECONNREFUSED 10.0.0.5:443' },
      options,
    );
    const credential = toUserReadableErrorMessage(
      { code: 'INVALID_FORMAT', message: 'invalid API key sk-example-secret' },
      options,
    );

    expect(connection).toBe('文件上传未完成，请检查文件后重新上传。');
    expect(credential).toBe('文件上传未完成，请检查文件后重新上传。');
    expect(`${connection} ${credential}`).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|API key|sk-/i);
  });
});
