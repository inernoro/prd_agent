/**
 * 设计样例数据：录制真实接口响应 → 手改成设计稿那套数据 → 回放。
 *
 * 为什么需要它（这条是 SKILL.md Step 5 里那句「做不到就用 --ignore 排掉」的正解）：
 * 文案覆盖率把设计稿里的**样例数据**也算成文案——站点名「多租户架构设计」、大小「11.2 KB」、
 * 「12 分钟前」。实现页跑的是另一套真实数据，于是这些条目全被判成「缺失」，覆盖率天然到不了顶，
 * 而真正该盯的结构文案（按钮、列头、空态引导、括号补充）就淹在这堆噪音里——
 * 一个读不出信号的判据，等于没有判据。
 *
 * 为什么走 route 拦截而不是在应用里加「fixture 模式」：
 * 那种模式要往生产代码里塞一条只在取证时才走的分支，是**永远不会被真实用户走到的代码路径**
 * （predicate-and-wiring-discipline 形状 8：不成立的证据）。而且一旦漏了开关，
 * fixture 数据可能出现在真实页面上。拦截全在取证工具这一侧，应用一行都不用改。
 *
 * 录制-回放而不是手写 JSON：手写的 fixture 一定跟真实契约漂移（字段改名、包一层
 * ApiResponse、分页字段变了），漂移之后页面渲染成空，而覆盖率只会告诉你「文案缺失」——
 * 你会以为是实现漏了文案，实际是 fixture 已经喂不进去了。所以形状永远来自真机录制，
 * 只手改**值**；再配一条漂移守卫定期比对形状。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 会话/时间戳类查询参数：同一个逻辑请求每次值都不同，进了键就永远回放不中。
 * 只列**确定无语义**的那几个；`page` / `pageSize` / `tab` 这类会改变返回内容的一律保留。
 */
const VOLATILE_QUERY_KEYS = new Set(['_', 't', 'ts', 'r', 'rand', 'random', 'nocache', 'cachebust']);

/** 把一个请求映射成稳定的文件名。查询参数排序后拼进去——参数顺序不同不该算两个请求。 */
export function fixtureKey(method, rawUrl) {
  const u = new URL(rawUrl);
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !VOLATILE_QUERY_KEYS.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const p = u.pathname.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]+/g, '_');
  const q = params ? `__${params.replace(/[^A-Za-z0-9._=&-]+/g, '_')}` : '';
  // 太长的键会撞文件名上限；截断后补一个短哈希，避免两个长 URL 截成同一个名字
  const base = `${method.toUpperCase()}__${p}${q}`;
  if (base.length <= 150) return base;
  let h = 0;
  for (let i = 0; i < base.length; i += 1) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return `${base.slice(0, 140)}~${h.toString(36)}`;
}

/** 递归取出 JSON 的键路径集合（数组只看第一个元素——同构数组不必逐个展开） */
export function keyShape(value, prefix = '', acc = new Set()) {
  if (value === null || typeof value !== 'object') {
    acc.add(`${prefix}:${value === null ? 'null' : typeof value}`);
    return acc;
  }
  if (Array.isArray(value)) {
    acc.add(`${prefix}[]`);
    if (value.length) keyShape(value[0], `${prefix}[]`, acc);
    return acc;
  }
  for (const k of Object.keys(value).sort()) keyShape(value[k], prefix ? `${prefix}.${k}` : k, acc);
  return acc;
}

/**
 * 把 fixture 装到一个 page 上。
 *
 * @param page      Playwright page
 * @param dir       fixture 目录
 * @param mode      'replay'（默认）| 'record'
 * @param match     哪些请求要管，默认所有同源 /api/ 请求
 * @returns {{report: () => {served: string[], missed: string[], recorded: string[]}}}
 */
export async function installFixtures(page, { dir, mode = 'replay', match } = {}) {
  if (!dir) throw new Error('installFixtures 需要 dir');
  fs.mkdirSync(dir, { recursive: true });
  const isTarget = match || ((url) => /\/api\//.test(url));

  const served = [];
  const missed = [];
  const recorded = [];

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (!isTarget(url)) return route.continue();

    const key = fixtureKey(req.method(), url);
    const file = path.join(dir, `${key}.json`);

    if (mode === 'record') {
      const res = await route.fetch();
      const body = await res.text();
      fs.writeFileSync(file, JSON.stringify({
        method: req.method(),
        url,
        status: res.status(),
        contentType: res.headers()['content-type'] || 'application/json',
        // body 原样存字符串：解析再序列化会悄悄改写数字精度与键顺序，
        // 而回放时喂给应用的必须与真机字节等价。
        body,
      }, null, 2));
      recorded.push(key);
      return route.fulfill({ response: res });
    }

    if (!fs.existsSync(file)) {
      // 落到真网络也要**记一笔**：静默穿透正是「以为在用样例数据、其实一半是真数据」
      // 的来源，那种混合状态下的覆盖率没有任何意义。
      missed.push(key);
      return route.continue();
    }
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    served.push(key);
    return route.fulfill({
      status: saved.status ?? 200,
      contentType: saved.contentType || 'application/json',
      body: saved.body,
    });
  });

  return { report: () => ({ served, missed, recorded }) };
}
