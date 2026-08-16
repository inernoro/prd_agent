export interface QuickCaptureRequestHolder<T> {
  current: Promise<T> | null;
}

/**
 * React StrictMode 会在开发环境重新执行 effect。第二次 effect 必须复用并订阅
 * 第一次已经发出的请求，不能只用一个布尔锁把第二个订阅者挡掉。
 */
export function getSharedQuickCaptureRequest<T>(
  holder: QuickCaptureRequestHolder<T>,
  createRequest: () => Promise<T>,
): Promise<T> {
  if (holder.current) return holder.current;

  const request = createRequest();
  holder.current = request;
  const clear = () => {
    if (holder.current === request) holder.current = null;
  };
  void request.then(clear, clear);
  return request;
}
