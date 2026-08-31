/** 高频画布变换低频同步 React，但停下后必须补上最后一次状态。 */
export function createViewportUiSync(sync: () => void, intervalMs = 80) {
  let lastSync = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancel();
    lastSync = Date.now();
    sync();
  };
  return {
    schedule(force = false) {
      const remaining = intervalMs - (Date.now() - lastSync);
      if (force || remaining <= 0) flush();
      else if (timer === undefined) timer = setTimeout(flush, remaining);
    },
    cancel,
  };
}
