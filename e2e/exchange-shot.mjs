// 本地视觉取证：起同一套 stub 服务，把 /exchanges 双主题各截一张。
// 只用于本仓库的排版自查，不连任何真实环境。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.LLMGW_DIST || path.join(REPO_ROOT, 'llmgw/web/dist');
const OUT = process.env.SHOT_OUT || path.join(REPO_ROOT, 'e2e/.shots');
const LABEL = process.env.SHOT_LABEL || 'shot';
const PORT = 5621;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const nowIso = new Date().toISOString();
const row = (over) => ({ id: 'x', createdAt: nowIso, updatedAt: nowIso, enabled: true, authority: 'llm_gateway', ...over });

const EXCHANGES = [
  row({
    id: 'gw-exchange-30a385a0a55c45d58c1e1da206b29560', name: 'LLMGW 外部 WSS 视觉验收',
    models: [{ modelId: 'doubao-streaming-asr-visual', displayName: '豆包流式语音识别验收', modelType: 'asr', description: null, enabled: true }],
    targetUrl: 'wss://echo.websocket.events', targetAuthScheme: 'XApiKey',
    transformerType: 'doubao-asr-stream', description: null, hasKey: true, version: 1,
  }),
  row({
    id: 'gw-exchange-8e8c3e82c33b43d98717e6e0b22968fa', name: 'fal.ai Qwen Image Layered',
    models: [{ modelId: 'fal-qwen-image-layered', displayName: 'Qwen Image Layered', modelType: 'generation', description: null, enabled: true }],
    targetUrl: 'https://fal.run/fal-ai/qwen-image-layered', targetAuthScheme: 'Key',
    transformerType: 'fal-image-layered', description: null, hasKey: true, version: 2,
  }),
];
const LIST = { items: [], total: 2, page: 1, pageSize: 20 };
const STUBS = {
  '/auth/tenants': [],
  '/exchanges': { ...LIST, items: EXCHANGES, exchanges: EXCHANGES },
  '/capabilities/image-layering': {
    capabilityId: 'image-layering', state: 'installed', installed: true, verified: false, hasKey: true,
    exchangeId: EXCHANGES[1].id, logicalModelId: 'lm-image-layering', offeringId: 'of-image-layering',
    modelId: 'fal-qwen-image-layered', publicId: 'image-layering', lastVerifiedAt: null,
  },
  '/exchanges/meta': {
    transformerTypes: [
      { value: 'doubao-asr-stream', label: '豆包流式语音识别', description: '转换为豆包流式 ASR 协议' },
      { value: 'fal-image-layered', label: 'fal.ai 图片分层', description: '把图片拆成可编辑图层' },
    ],
    authSchemes: [
      { value: 'XApiKey', label: 'X-Api-Key', description: '自定义头透传' },
      { value: 'Key', label: 'Key', description: 'Authorization: Key <key>' },
    ],
    modelTypes: [
      { value: 'asr', label: '语音识别', description: null },
      { value: 'generation', label: '图片生成', description: null },
    ],
  },
};
const stubFor = (api) => STUBS[api.split('?')[0]] ?? { ...LIST, items: [] };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = http.createServer((req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (p.startsWith('/llmgw/gw/')) {
    if (p === '/llmgw/gw/auth/login') {
      return json(res, 200, { success: true, error: null, data: {
        token: 'stub', username: 'demo', displayName: 'Demo',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), mustChangePassword: false,
        tenant: { id: 't1', name: 'MAP Internal', isInternal: true, role: 'owner', teamIds: ['team-1'] },
      } });
    }
    return json(res, 200, { success: true, error: null, data: stubFor(p.replace('/llmgw/gw', '')) });
  }
  const rel = p.replace(/^\/llmgw/, '');
  const file = rel === '' || rel === '/' || !path.extname(rel) ? '/index.html' : rel;
  const full = path.join(DIST, file);
  if (!fs.existsSync(full)) return json(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  res.end(fs.readFileSync(full));
});

await new Promise((resolve) => server.listen(PORT, resolve));
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] });

for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme });
  const page = await ctx.newPage();
  const base = `http://localhost:${PORT}/llmgw`;
  await page.goto(`${base}/exchanges`);
  await page.waitForSelector('#llmgw-username');
  await page.fill('#llmgw-username', 'demo');
  await page.fill('#llmgw-password', 'demo');
  await page.click('button[type=submit]');
  await page.goto(`${base}/exchanges`);
  await page.waitForSelector('[data-testid="exchange-list"]');
  await page.waitForTimeout(1200);
  const cards = await page.locator('[data-testid="exchange-list"] > *').count();
  console.log(`${theme}: exchange cards = ${cards}`);
  await page.screenshot({ path: path.join(OUT, `${LABEL}-${theme}.png`), fullPage: true });
  await ctx.close();
}
await browser.close();
server.close();
console.log('shots ->', OUT);
