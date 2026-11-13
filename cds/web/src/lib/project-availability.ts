import { ApiError } from './api.js';

/** 权威项目接口的不存在/无权限不能降级成可操作的新项目。 */
export function projectUnavailable(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.transient) return null;
  if (error.status === 404) return '项目不存在或已删除，请返回项目列表选择当前可用的项目。';
  if (error.status === 401 || error.status === 403) return '当前无法访问此项目，请确认登录和项目权限，或返回项目列表。';
  return null;
}
