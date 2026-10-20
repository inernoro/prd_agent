/** 巡检仍禁止 SW 接管请求，但 opaque srcDoc 的浏览器权限拒绝不应变成注入脚本异常。 */
export function blockStableSmokeServiceWorkerRegistration() {
  try {
    const worker = navigator.serviceWorker;
    if (worker) worker.register = async () => {
      console.warn('稳定冒烟禁止 Service Worker 注册');
    };
  } catch (error) {
    if (error?.name !== 'SecurityError') throw error;
  }
}
