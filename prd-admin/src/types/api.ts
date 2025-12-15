export type ErrorCode =
  | 'INVALID_FORMAT'
  | 'CONTENT_EMPTY'
  | 'DOCUMENT_TOO_LARGE'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'RATE_LIMITED'
  | 'PERMISSION_DENIED'
  | 'LLM_ERROR'
  | 'UNAUTHORIZED'
  | 'UNKNOWN';

export type ApiError = {
  code: ErrorCode;
  message: string;
};

export type ApiResponse<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: ApiError };

export function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data, error: null };
}

export function fail(code: ErrorCode, message: string): ApiResponse<never> {
  return { success: false, data: null, error: { code, message } };
}
