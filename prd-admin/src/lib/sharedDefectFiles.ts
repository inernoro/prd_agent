/**
 * 手机截图分享（Web Share Target）的前端消费端。
 *
 * sw.js 把系统分享菜单送来的截图暂存进 Cache Storage（map-shared-defect-v1），
 * 本模块负责把它们读出来转成 File、随读随删（一次性消费），供缺陷提交面板注入。
 *
 * 消费分两步以规避 React StrictMode 双执行：
 *   1. consumeSharedDefectPayload()（异步）：读 Cache → 删缓存条目 → 存入模块级 stash
 *   2. claimSharedDefectPayload()（同步）：DefectAgentPage 领取 stash 并清空，
 *      随后写入 defectStore.pendingSharePayload，由提交面板订阅领取
 *      （面板已打开时再次分享也能注入，见 store 的 consumePendingSharePayload）
 * 重复调用均安全返回 null。
 */

const SHARE_CACHE = 'map-shared-defect-v1';
const SHARE_ENTRY_PREFIX = '/__shared-defect__/';

export interface SharedDefectPayload {
  files: File[];
  text?: string;
}

let stash: SharedDefectPayload | null = null;

export async function consumeSharedDefectPayload(): Promise<SharedDefectPayload | null> {
  if (typeof caches === 'undefined') return stash;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const requests = await cache.keys();
    const entries = requests
      .map((req) => ({ req, pathname: new URL(req.url).pathname }))
      .filter((e) => e.pathname.startsWith(SHARE_ENTRY_PREFIX))
      // 按 SW 写入时的 `${stamp}-${index}` 命名排序，保证多图顺序稳定
      .sort((a, b) => a.pathname.localeCompare(b.pathname));

    const files: File[] = [];
    let text: string | undefined;

    for (const { req, pathname } of entries) {
      const res = await cache.match(req);
      await cache.delete(req);
      if (!res) continue;
      if (pathname === `${SHARE_ENTRY_PREFIX}text`) {
        const value = (await res.text()).trim();
        if (value) text = value;
        continue;
      }
      const blob = await res.blob();
      const rawName = res.headers.get('X-File-Name');
      let name = `screenshot-${files.length + 1}.png`;
      if (rawName) {
        try {
          name = decodeURIComponent(rawName);
        } catch {
          name = rawName;
        }
      }
      files.push(new File([blob], name, { type: blob.type || 'image/png' }));
    }

    if (files.length > 0 || text) {
      stash = {
        files: [...(stash?.files ?? []), ...files],
        text: text ?? stash?.text,
      };
    }
  } catch (err) {
    console.warn('[shared-defect] 读取分享截图失败:', err);
  }
  return stash;
}

/** 领取暂存的分享内容（领取即清空），无内容返回 null */
export function claimSharedDefectPayload(): SharedDefectPayload | null {
  const payload = stash;
  stash = null;
  return payload;
}
