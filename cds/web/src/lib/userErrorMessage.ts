import { ApiError } from './api';

/** 主消息保留服务端业务原因，接口路径和HTTP包装不占产品说明区。 */
export function userErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const body = error.body as Record<string, unknown>;
    for (const field of ['message', 'error', 'hint']) if (typeof body[field] === 'string' && body[field].trim()) return body[field];
  }
  if (error instanceof TypeError) return '网络连接中断，尚未收到可确认的结果';
  return error instanceof Error ? error.message : '暂时无法确认结果';
}

