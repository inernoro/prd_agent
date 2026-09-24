import { describe, expect, it } from 'vitest';
import { revisionHistoryErrorMessage } from './SiteEditPanel';

describe('版本读取错误的恢复动作', () => {
  it('读取失败不要求用户修改尚未提交的输入', () => {
    const message = revisionHistoryErrorMessage({
      code: 'INVALID_FORMAT',
      message: '操作未完成，请检查输入后重试。',
    });
    expect(message).toContain('版本记录暂时无法读取');
    expect(message).toContain('刷新版本记录');
    expect(message).not.toContain('检查输入');
  });

  it('领域码使用固定安全文案而非存储诊断', () => {
    const message = revisionHistoryErrorMessage({
      code: 'HOSTED_SITE_HISTORY_UNAVAILABLE',
      message: 'HTTP 503 https://storage.invalid/private?token=secret',
    });
    expect(message).toContain('检查网页文件');
    expect(message).not.toMatch(/HTTP|token|https/);
  });

  it('保留登录失效的明确恢复方式', () => {
    expect(revisionHistoryErrorMessage({ code: 'UNAUTHORIZED' })).toContain('重新登录');
  });
});
