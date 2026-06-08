// 直连 SSE 原始探针：登录拿 token → 在页面上下文 fetch convert(engine=agent) SSE
// → 打印每个 diag/delta/done/error 事件的 wall-clock 时间戳。绕开 Playwright diag 面板选择器漂移。
import { createRequire } from 'module';
import { login } from './harness.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');

const BASE = (process.argv[2] || 'https://cds-agent-integration-x6rck-claude-prd-agent.miduo.org/').replace(/\/+$/, '');
const cfg = {
  auth: {
    browser: {
      userEnv: 'MAP_AI_USER', passEnv: 'MAP_ACCEPT_PASS',
      loginPath: '/login',
      userSelector: 'input[type=text]',
      passSelector: 'input[type=password]',
      submitSelector: 'button:has-text("进入控制台")',
    },
  },
};

const MD = `# AI 编程的信息损耗\n\n- 传统流程四层信息衰减\n- 端到端编程减少漂移\n\n---\n\n# 行业集体幻觉\n\n- 新工具循环\n- 守门员效应`;

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
try {
  await login(page, BASE, cfg);
  const tok = await page.evaluate(() => {
    const grab = (raw) => { if (!raw) return null; try { const o = JSON.parse(raw); return o?.state?.token || o?.token || o?.state?.accessToken || o?.accessToken || null; } catch { return /^ey|^sk-/.test(raw) ? raw : null; } };
    const stores = [sessionStorage, localStorage];
    for (const st of stores) for (let i = 0; i < st.length; i++) { const k = st.key(i); const t = grab(st.getItem(k)); if (t) return t; }
    return null;
  });
  console.log('TOKEN', tok ? 'ok' : 'MISSING');
  if (!tok) { await browser.close(); process.exit(2); }

  const result = await page.evaluate(async ({ base, md, token }) => {
    const t0 = Date.now();
    const lines = [];
    const stamp = (s) => `+${String(Date.now() - t0).padStart(6, ' ')}ms ${s}`;
    let firstDelta = null, firstDiag = null;
    try {
      const resp = await fetch(base + '/api/md-to-ppt/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ content: md, slideCount: 0, theme: '深色玻璃', engine: 'map' }),
      });
      lines.push(stamp('HTTP ' + resp.status));
      if (!resp.body) { lines.push(stamp('NO BODY')); return { lines, firstDelta, firstDiag }; }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '', curEvent = '', deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) { lines.push(stamp('STREAM_END')); break; }
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop() || '';
        for (const ln of parts) {
          if (ln.startsWith('event:')) curEvent = ln.slice(6).trim();
          else if (ln.startsWith('data:')) {
            const data = ln.slice(5).trim();
            if (curEvent === 'delta') {
              if (firstDelta == null) { firstDelta = Date.now() - t0; lines.push(stamp('FIRST_DELTA')); }
            } else if (curEvent === 'diag') {
              if (firstDiag == null) firstDiag = Date.now() - t0;
              lines.push(stamp('diag ' + data.slice(0, 220)));
            } else if (curEvent === 'done') {
              lines.push(stamp('DONE len=' + data.length));
              return { lines, firstDelta, firstDiag, ended: 'done' };
            } else if (curEvent === 'error') {
              lines.push(stamp('ERROR ' + data.slice(0, 300)));
              return { lines, firstDelta, firstDiag, ended: 'error' };
            }
          } else if (ln.startsWith(':')) {
            lines.push(stamp('keepalive'));
          }
        }
      }
      lines.push(stamp('PROBE_TIMEOUT_180s'));
    } catch (e) {
      lines.push(stamp('FETCH_EXCEPTION ' + (e?.message || e)));
    }
    return { lines, firstDelta, firstDiag };
  }, { base: BASE, md: MD, token: tok });

  console.log('--- RAW SSE TIMELINE ---');
  for (const l of result.lines) console.log(l);
  console.log('--- SUMMARY ---');
  console.log(JSON.stringify({ firstDiagMs: result.firstDiag, firstDeltaMs: result.firstDelta, ended: result.ended || 'timeout' }));
} catch (e) {
  console.log('PROBE_ERR', e?.message || e);
} finally {
  await browser.close();
}
