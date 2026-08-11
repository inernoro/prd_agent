export type UserReadableErrorOptions = {
  fallbackMessage: string;
  recoveryMessage: string;
  code?: string | null;
};

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  error?: unknown;
};

const RECOVERY_WORDS = [
  '重试',
  '重新',
  '稍后',
  '检查',
  '更换',
  '减少',
  '上传',
  '输入',
  '选择',
  '登录',
  '联系管理员',
  '返回',
];

const INTERNAL_DIAGNOSTIC_PATTERNS = [
  /\bHTTP\s*\d{3}\b/i,
  /\b(?:traceId|requestId|runId|provider|offering|endpoint|model|protocol|token|stack|exception)\b/i,
  /\/api\//i,
  /<!doctype|<html|<body/i,
  /input must have at least/i,
  /unexpected token/i,
  /failed to fetch|networkerror|load failed/i,
  /system\.(?:invalidoperation|exception)/i,
  /\b(?:econnrefused|econnreset|enotfound|etimedout|socket|authorization|api[ _-]?key|secret|password)\b/i,
  /\b(?:sk|pk|rk)-[a-z0-9_-]{6,}\b/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/,
  /https?:\/\//i,
];

const USER_MESSAGE_ALLOWLIST = new Map<string, ReadonlySet<string>>([
  ['INVALID_FORMAT', new Set([
    '文件内容无法解析',
    '文件格式不受支持，请更换文件后重试。',
    '头像上传未完成，请稍后重新上传。',
  ])],
  ['AVATAR_SOURCE_UNAVAILABLE', new Set([
    '当前头像无法用于生成，请重新上传一张清晰图片后重试。',
  ])],
]);

function extractErrorLike(value: unknown): { code?: string; message?: string } {
  if (!value) return {};
  if (value instanceof Error) return { message: value.message };
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return {};
    if (/^[{[]/.test(text)) {
      try {
        return extractErrorLike(JSON.parse(text) as unknown);
      } catch {
        return { message: text };
      }
    }
    return { message: text };
  }
  if (typeof value !== 'object') return {};

  const candidate = value as ErrorLike;
  const nested = extractErrorLike(candidate.error);
  const code = typeof candidate.code === 'string' ? candidate.code : nested.code;
  const message = typeof candidate.message === 'string' ? candidate.message : nested.message;
  return { code, message };
}

function messageContainsRecovery(message: string): boolean {
  return RECOVERY_WORDS.some((word) => message.includes(word));
}

function isSafeUserMessage(message: string, code: string): boolean {
  const text = message.trim();
  const normalizedCode = code.trim().toUpperCase();
  if (!USER_MESSAGE_ALLOWLIST.get(normalizedCode)?.has(text)) return false;
  if (!text || text.length > 320) return false;
  if (/^[{[]/.test(text)) return false;
  if (!/[\u3400-\u9fff]/u.test(text)) return false;
  return !INTERNAL_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(text));
}

function classifiedMessage(code: string, recoveryMessage: string): string | null {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === 'UNAUTHORIZED') {
    return '当前登录状态无法完成此操作，请重新登录后重试。';
  }
  if (normalized === 'PERMISSION_DENIED') {
    return '当前账号没有执行此操作的权限，请联系管理员开通后重试。';
  }
  if (normalized === 'RATE_LIMITED') {
    return '当前请求较多，请稍后重试。';
  }
  if (normalized === 'TIMEOUT') {
    return '本次等待超时，请稍后重试。';
  }
  if (normalized === 'DOCUMENT_TOO_LARGE' || normalized === 'FILE_TOO_LARGE') {
    return '文件超过当前大小限制，请缩小文件后重新上传。';
  }
  if (normalized === 'UNSUPPORTED_FILE_TYPE') {
    return '文件格式不受支持，请更换文件后重试。';
  }
  if (normalized === 'CONTENT_REJECTED') {
    return `提交内容未通过安全检查，${recoveryMessage}`;
  }
  if (normalized === 'NETWORK_ERROR' || normalized === 'SERVER_UNAVAILABLE' || normalized === 'SERVER_ERROR') {
    return `服务暂时不可用，${recoveryMessage}`;
  }
  return null;
}

export function toUserReadableErrorMessage(
  value: unknown,
  options: UserReadableErrorOptions,
): string {
  const extracted = extractErrorLike(value);
  const code = options.code || extracted.code || '';
  const classified = classifiedMessage(code, options.recoveryMessage);
  if (classified) return classified;

  const message = extracted.message?.trim() || '';
  if (isSafeUserMessage(message, code)) {
    return messageContainsRecovery(message)
      ? message
      : `${message}，${options.recoveryMessage}`;
  }
  return `${options.fallbackMessage}，${options.recoveryMessage}`;
}
