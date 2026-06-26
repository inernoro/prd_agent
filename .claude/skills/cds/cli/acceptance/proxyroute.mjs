// CDS 验收取证 · 代理穿透层（沉淀自 2026-06 CDS 验收会话的关键工程解）。
//
// 背景：本环境的 chromium 自身网络栈穿不过 agent 出口代理（直接 page.goto 报
// ERR_CONNECTION_CLOSED），但 node 的 fetch 在 NODE_USE_ENV_PROXY=1 下可以。
// 策略：chromium **不**配代理，用 context.route 拦截所有请求，改由 node fetch 取回再
// route.fulfill。Cookie 双向桥接（请求带 chromium 的 cookie；响应 set-cookie 回写 context），
// 这样登录态、SSE 之外的常规取证都能跑。
//
// 用法（在 driver 里）：
//   import { installNodeFetchRoute } from './proxyroute.mjs';
//   const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
//   await installNodeFetchRoute(ctx);
// 运行：NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<proxy> node driver.mjs
//
// 局限：EventSource/SSE 长连接不走 fulfill（取静态状态截图够用，不适合实时流）。

function parseSetCookie(line, reqUrl) {
  const parts = line.split(';').map((s) => s.trim());
  const [nv, ...attrs] = parts;
  const eq = nv.indexOf('=');
  if (eq < 0) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  let domain, path = '/', httpOnly = false, secure = false, sameSite, expires;
  let u;
  try { u = new URL(reqUrl); } catch { return null; }
  for (const a of attrs) {
    const [k, v] = a.split('=').map((s) => (s || '').trim());
    const kl = k.toLowerCase();
    if (kl === 'domain') domain = v.replace(/^\./, '');
    else if (kl === 'path') path = v || '/';
    else if (kl === 'httponly') httpOnly = true;
    else if (kl === 'secure') secure = true;
    else if (kl === 'samesite') sameSite = ({ lax: 'Lax', strict: 'Strict', none: 'None' })[(v || '').toLowerCase()];
    else if (kl === 'max-age') { const ma = Number(v); if (!Number.isNaN(ma)) expires = Math.floor(Date.now() / 1000) + ma; }
    else if (kl === 'expires') { const t = Date.parse(v); if (!Number.isNaN(t)) expires = Math.floor(t / 1000); }
  }
  const cookie = { name, value, domain: domain || u.hostname, path, httpOnly, secure };
  if (sameSite) cookie.sameSite = sameSite;
  if (expires) cookie.expires = expires;
  return cookie;
}

export async function installNodeFetchRoute(context) {
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (!/^https?:/i.test(url)) { try { await route.continue(); } catch {} return; }
    const headers = { ...req.headers() };
    delete headers['accept-encoding'];
    delete headers['host'];
    delete headers[':authority'];
    delete headers['content-length'];
    const init = { method: req.method(), headers, redirect: 'manual' };
    if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      const pd = req.postDataBuffer();
      if (pd) init.body = pd;
    }
    try {
      const resp = await fetch(url, init);
      const buf = Buffer.from(await resp.arrayBuffer());
      try {
        const sc = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
        const cookies = sc.map((l) => parseSetCookie(l, url)).filter(Boolean);
        if (cookies.length) await context.addCookies(cookies).catch(() => {});
      } catch {}
      const respHeaders = {};
      resp.headers.forEach((v, k) => {
        const kl = k.toLowerCase();
        if (['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie', 'connection'].includes(kl)) return;
        respHeaders[k] = v;
      });
      await route.fulfill({ status: resp.status, headers: respHeaders, body: buf });
    } catch {
      try { await route.abort(); } catch {}
    }
  });
  return async () => { try { await context.unroute('**/*'); } catch {} };
}
