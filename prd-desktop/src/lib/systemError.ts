export const SYSTEM_ERROR_CODES = new Set([
  'UNAUTHORIZED',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'LLM_ERROR',
]);

export function isSystemErrorCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return SYSTEM_ERROR_CODES.has(String(code));
}

export function systemErrorTitle(code: string | null | undefined): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return '未授权';
    case 'PERMISSION_DENIED':
      return '无权限';
    case 'RATE_LIMITED':
      return '请求过于频繁';
    case 'LLM_ERROR':
      return '模型服务异常';
    case 'INTERNAL_ERROR':
      return '服务器错误';
    default:
      return '系统错误';
  }
}



