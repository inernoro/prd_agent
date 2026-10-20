import { describe, it, expect } from 'vitest';
import { ApiError } from '../../web/src/lib/api.js';
import { projectUnavailable } from '../../web/src/lib/project-availability.js';

describe('项目读取失败的界面语义', () => {
  it('已删除项目明确返回列表，不引导检测技术栈', () => {
    expect(projectUnavailable(new ApiError(404, {}, 'not found'))).toContain('项目不存在或已删除');
  });
  it('无权限不泄露项目存在性，暂时失败留给刷新重试', () => {
    expect(projectUnavailable(new ApiError(403, {}, 'forbidden'))).toContain('登录和项目权限');
    expect(projectUnavailable(new ApiError(502, {}, 'gateway', undefined, true))).toBeNull();
    expect(projectUnavailable(new Error('offline'))).toBeNull();
  });
});
