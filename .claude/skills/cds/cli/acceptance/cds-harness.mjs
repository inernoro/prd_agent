// CDS 验收取证 · launch 包装。chromium 不配代理 + 装 node-fetch 拦截（proxyroute.mjs），
// 复用 create-visual-test-to-kb/harness.mjs 的 page-helpers（login/shot/box/stepClick/
// stepShot/setTheme/writeManifest...）。前置：NODE_USE_ENV_PROXY=1 + HTTPS_PROXY 已在 env。
//
// 取证 CDS 自身 Web（cds.miduo.org）时用 CDS admin 登录（见 cds.config.example.json）。
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PW = process.env.PWPATH || '/opt/node22/lib/node_modules/playwright';
const { chromium } = require(PW);
import { attachAutoCapture, _bumpCaptureSession } from '/home/user/prd_agent/.claude/skills/create-visual-test-to-kb/scripts/harness.mjs';
export * from '/home/user/prd_agent/.claude/skills/create-visual-test-to-kb/scripts/harness.mjs';
import { installNodeFetchRoute } from './proxyroute.mjs';

export async function launchCds(cfg, opts = {}) {
  const session = _bumpCaptureSession();
  const sc = cfg.screenshot || {};
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: sc.width || 1440, height: sc.height || 900 },
    deviceScaleFactor: sc.deviceScaleFactor || 2,
    ignoreHTTPSErrors: true,
  });
  await installNodeFetchRoute(ctx);
  const page = await ctx.newPage();
  attachAutoCapture(page, { ...(opts.autoCapture || {}), _session: session });
  return { browser, ctx, page };
}
