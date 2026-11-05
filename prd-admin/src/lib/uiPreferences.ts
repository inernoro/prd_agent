/** 仅用于非敏感、设备本地的 UI 偏好；存储禁用时正常降级。 */
export function readUiPreference(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; }
  catch { return fallback; }
}

export function writeUiPreference(key: string, value: string): void {
  try { localStorage.setItem(key, value); }
  catch { /* 隐私模式或存储已满不影响当前交互。 */ }
}
