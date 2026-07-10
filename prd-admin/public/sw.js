/**
 * MAP 最小 Service Worker
 *
 * 唯一职责：接收 Web Share Target（manifest.webmanifest 的 share_target）的
 * POST /share-defect 请求 —— 把手机系统分享菜单送来的截图暂存进 Cache Storage，
 * 然后 303 重定向到缺陷提交面板（/defect-agent?action=submit&shared=1）。
 *
 * 刻意不做任何静态资源缓存：index.html / assets 走服务端 no-cache 策略，
 * 由 SW 缓存会引入发版后旧资源问题（见 .claude/rules/no-localstorage.md 同类教训）。
 * 前端消费入口：src/lib/sharedDefectFiles.ts（读取后即删，一次性）。
 */

const SHARE_CACHE = 'map-shared-defect-v1';
const SHARE_PATH = '/share-defect';
const SHARE_ENTRY_PREFIX = '/__shared-defect__/';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== SHARE_PATH) {
    // 其余请求一律不拦截（无 respondWith 即走网络），SW 只当 share target 的收件箱
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const formData = await event.request.formData();
        const cache = await caches.open(SHARE_CACHE);
        const stamp = Date.now();

        const files = formData.getAll('screenshots');
        let index = 0;
        for (const file of files) {
          if (!file || typeof file === 'string') continue;
          if (file.type && !file.type.startsWith('image/')) continue;
          const headers = new Headers({
            'Content-Type': file.type || 'image/png',
            'X-File-Name': encodeURIComponent(file.name || `screenshot-${stamp}-${index}.png`),
          });
          await cache.put(
            new Request(`${SHARE_ENTRY_PREFIX}${stamp}-${String(index).padStart(3, '0')}`),
            new Response(await file.arrayBuffer(), { headers })
          );
          index += 1;
        }

        const sharedText = ['title', 'text', 'url']
          .map((key) => formData.get(key))
          .filter((v) => typeof v === 'string' && v.trim())
          .join('\n');
        if (sharedText) {
          await cache.put(
            new Request(`${SHARE_ENTRY_PREFIX}text`),
            new Response(sharedText, { headers: { 'Content-Type': 'text/plain;charset=utf-8' } })
          );
        }
      } catch (err) {
        // 暂存失败也照常跳转 —— 用户至少落到提交面板，可手动补图
        console.warn('[sw] share-defect stash failed:', err);
      }
      return Response.redirect('/defect-agent?action=submit&shared=1', 303);
    })()
  );
});
