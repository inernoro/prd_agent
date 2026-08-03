import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type BusinessCatalog = {
  featureLines: Array<{
    id: string;
    label: string;
    entryPath: string;
    entrySmoke: boolean;
  }>;
};

const specDir = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(
  resolve(specDir, '../../.claude/skills/stable-smoke/reference/business-function-catalog.json'),
  'utf8',
)) as BusinessCatalog;

type TicketResponse = {
  success: boolean;
  data?: { loginUrl?: string; ticketId?: string; expiresAt?: string };
  error?: { code?: string; message?: string };
};

type ApiEnvelope<T> = {
  success: boolean;
  data: T;
  error?: { code?: string; message?: string };
};

type AuthSession = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

const modules = catalog.featureLines
  .filter((feature) => feature.entrySmoke)
  .map((feature) => ({ key: feature.id, label: feature.label, path: feature.entryPath }));

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}，无法执行合成登录冒烟测试。`);
  return value;
}

async function issueTicket(request: APIRequestContext, returnUrl: string) {
  const response = await request.post('/api/v1/auth/synthetic/ticket', {
    headers: {
      'X-AI-Access-Key': requiredEnv('STABLE_SMOKE_AI_ACCESS_KEY'),
      'X-AI-Impersonate': requiredEnv('STABLE_SMOKE_USER'),
    },
    data: { returnUrl, expiresInSeconds: 180 },
  });
  const body = await response.json() as TicketResponse;
  expect(response.status(), body.error?.message || '生成合成登录入口失败').toBe(200);
  expect(body.success, body.error?.message || '生成合成登录入口失败').toBe(true);
  expect(body.data?.loginUrl).toMatch(/^\/synthetic-login\?code=/);
  return body.data?.loginUrl || '';
}

async function issueTicketDetails(request: APIRequestContext, returnUrl: string) {
  const response = await request.post('/api/v1/auth/synthetic/ticket', {
    headers: {
      'X-AI-Access-Key': requiredEnv('STABLE_SMOKE_AI_ACCESS_KEY'),
      'X-AI-Impersonate': requiredEnv('STABLE_SMOKE_USER'),
    },
    data: { returnUrl, expiresInSeconds: 180 },
  });
  const body = await response.json() as TicketResponse;
  expect(response.status(), body.error?.message || '生成合成登录入口失败').toBe(200);
  expect(body.success, body.error?.message || '生成合成登录入口失败').toBe(true);
  return body.data!;
}

async function loginAndReadToken(page: Page, request: APIRequestContext, returnUrl = '/') {
  const loginUrl = await issueTicket(request, returnUrl);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((url) => url.pathname !== '/synthetic-login', { timeout: 30_000 });
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem('prd-admin-auth');
    if (!raw) return '';
    try {
      return JSON.parse(raw)?.state?.token || '';
    } catch {
      return '';
    }
  }), { message: '等待合成会话写入浏览器认证状态', timeout: 10_000 }).not.toBe('');
  const storedToken = await page.evaluate(() => {
    const raw = window.localStorage.getItem('prd-admin-auth');
    return raw ? JSON.parse(raw)?.state?.token || '' : '';
  });
  expect(storedToken, '合成会话未写入浏览器认证状态').not.toBe('');
  return storedToken;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function readEnvelope<T>(response: Awaited<ReturnType<APIRequestContext['get']>>) {
  const body = await response.json() as ApiEnvelope<T>;
  expect(response.ok(), body.error?.message || '业务接口调用失败').toBe(true);
  expect(body.success, body.error?.message || '业务接口调用失败').toBe(true);
  return body.data;
}

function expectUserReadable(message: string) {
  expect(message).not.toMatch(/\b(?:HTTP\s*\d{3}|token|provider|stack trace|at\s+\w+\.\w+\()/i);
  expect(message).toMatch(/请|重试|检查|选择|重新|稍后/);
}

async function openModule(
  page: Page,
  request: APIRequestContext,
  module: (typeof modules)[number],
  testInfo: TestInfo,
) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon|ResizeObserver/i.test(message.text())) {
      errors.push(message.text());
    }
  });

  const loginUrl = await issueTicket(request, module.path);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((url) => url.pathname.startsWith(module.path), { timeout: 30_000 });
  await expect(page.locator('body')).not.toBeEmpty();
  await expect(page.locator('body')).not.toContainText('合成测试登录未完成');
  await page.waitForTimeout(800);
  expect(errors, `${module.label} 页面出现前端运行错误`).toEqual([]);

  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(`${module.key}-${testInfo.project.name}`, {
    body: screenshot,
    contentType: 'image/png',
  });
}

test.describe('稳定冒烟：双环境合成登录与模块入口', () => {
  test('[CORE-001] 首页与入口静态资源可用', async ({ page }) => {
    const resourceFailures: string[] = [];
    page.on('response', (item) => {
      if (/\.(?:js|css)(?:\?|$)/.test(item.url()) && item.status() >= 500) resourceFailures.push(item.url());
    });
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBeLessThan(500);
    await expect(page.locator('body')).not.toBeEmpty();
    await page.waitForTimeout(1_500);
    expect(resourceFailures).toEqual([]);
  });

  test('[CORE-007] 一次性票据只能消费一次且会话不可续期', async ({ request }) => {
    const ticket = await issueTicketDetails(request, '/');
    const code = new URL(ticket.loginUrl!, 'https://stable-smoke.invalid').searchParams.get('code');
    expect(code).toBeTruthy();

    const first = await request.post('/api/v1/auth/synthetic/exchange', { data: { code } });
    const firstBody = await first.json() as ApiEnvelope<AuthSession>;
    expect(first.status(), firstBody.error?.message).toBe(200);
    expect(firstBody.success).toBe(true);
    expect(firstBody.data.accessToken).toBeTruthy();
    expect(firstBody.data.refreshToken).toBe('');
    expect(firstBody.data.expiresIn).toBeLessThanOrEqual(30 * 60);

    const second = await request.post('/api/v1/auth/synthetic/exchange', { data: { code } });
    const secondBody = await second.json() as ApiEnvelope<never>;
    expect(second.status()).toBe(401);
    expect(secondBody.success).toBe(false);
    expectUserReadable(secondBody.error?.message || '');
  });

  test('[COMMON-001] 专用前缀资源可创建、回读并清理', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request);
    const title = `stsmk-${Date.now()}-common`;
    let workspaceId = '';
    try {
      const created = await page.request.post('/api/transcript-agent/workspaces', {
        headers: authHeaders(token),
        data: { title },
      });
      expect(created.ok()).toBe(true);
      const workspace = await created.json() as { id: string; title: string };
      workspaceId = workspace.id;
      expect(workspace.title).toBe(title);

      const readBack = await page.request.get(`/api/transcript-agent/workspaces/${workspaceId}`, {
        headers: authHeaders(token),
      });
      expect((await readBack.json()).title).toBe(title);
    } finally {
      if (workspaceId) {
        const deleted = await page.request.delete(`/api/transcript-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
        });
        expect(deleted.status()).toBe(204);
        const missing = await page.request.get(`/api/transcript-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
        });
        expect(missing.status()).toBe(404);
      }
    }
  });

  test('[FILE-002] 中文文件名上传、解析回读与级联清理', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/transcript-agent');
    const runKey = `stsmk-${Date.now()}`;
    let storeId = '';
    try {
      const createStore = await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: { name: `${runKey}-文件解析`, description: '稳定冒烟专用，执行后自动清理', isPublic: false },
      });
      const store = await readEnvelope<{ id: string; name: string }>(createStore);
      storeId = store.id;

      const expectedText = `${runKey} 中文文件解析基准内容`;
      const upload = await page.request.post(`/api/document-store/stores/${storeId}/upload`, {
        headers: authHeaders(token),
        multipart: {
          file: {
            name: `${runKey}-中文样本.txt`,
            mimeType: 'text/plain',
            buffer: Buffer.from(expectedText, 'utf8'),
          },
        },
      });
      const uploaded = await readEnvelope<{ entry: { id: string; title: string }; fileUrl: string }>(upload);
      expect(uploaded.entry.title).toContain('中文样本');
      expect(uploaded.fileUrl).toBeTruthy();

      const contentResponse = await page.request.get(`/api/document-store/entries/${uploaded.entry.id}/content`, {
        headers: authHeaders(token),
      });
      const content = await readEnvelope<{ content?: string; hasContent: boolean }>(contentResponse);
      expect(content.hasContent).toBe(true);
      expect(content.content).toContain(expectedText);
    } finally {
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, {
          headers: authHeaders(token),
        });
        const body = await deleted.json() as ApiEnvelope<{ deleted: boolean }>;
        expect(body.success).toBe(true);
        const missing = await page.request.get(`/api/document-store/stores/${storeId}`, {
          headers: authHeaders(token),
        });
        expect(missing.status()).toBe(404);
      }
    }
  });

  test('[LIT-001] 文学作品可新建、保存、刷新回读并清理', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/literary-agent');
    const title = `stsmk-${Date.now()}-文学作品`;
    const article = '稳定冒烟文学创作基准正文。';
    let workspaceId = '';
    try {
      const created = await page.request.post('/api/literary-agent/workspaces', {
        headers: authHeaders(token),
        data: { title, scenarioType: 'article-illustration' },
      });
      const createdData = await readEnvelope<{ workspace: { id: string; title: string } }>(created);
      workspaceId = createdData.workspace.id;

      const updated = await page.request.put(`/api/literary-agent/workspaces/${workspaceId}`, {
        headers: authHeaders(token),
        data: { title, articleContent: article },
      });
      const updatedData = await readEnvelope<{ workspace: { articleContent: string } }>(updated);
      expect(updatedData.workspace.articleContent).toBe(article);

      const detail = await page.request.get(`/api/literary-agent/workspaces/${workspaceId}/detail`, {
        headers: authHeaders(token),
      });
      const detailData = await readEnvelope<{ workspace: { title: string; articleContent: string } }>(detail);
      expect(detailData.workspace.title).toBe(title);
      expect(detailData.workspace.articleContent).toBe(article);
    } finally {
      if (workspaceId) {
        const deleted = await page.request.delete(`/api/literary-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
        });
        expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
        const missing = await page.request.get(`/api/literary-agent/workspaces/${workspaceId}/detail`, {
          headers: authHeaders(token),
        });
        expect(missing.status()).toBe(404);
      }
    }
  });

  test('[VIS-001] 单图模型目录只返回可用逻辑模型', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const response = await page.request.get('/api/visual-agent/image-gen/models', { headers: authHeaders(token) });
    const pools = await readEnvelope<Array<{ id: string; code: string; models: Array<{ healthStatus?: string }> }>>(response);
    expect(pools.length).toBeGreaterThan(0);
    for (const pool of pools) {
      expect(pool.id).toBeTruthy();
      expect(pool.code).toBeTruthy();
      expect(pool.models.length).toBeGreaterThan(0);
      expect(pool.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || ''))).toBe(true);
    }
  });

  test('[CORE-005] 无效生图请求返回用户可读错误', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const response = await page.request.post('/api/visual-agent/image-gen/runs', {
      headers: authHeaders(token),
      data: { platformId: 'logical-model', modelId: 'invalid', items: [] },
    });
    const body = await response.json() as ApiEnvelope<never>;
    expect(response.status()).toBe(400);
    expect(body.success).toBe(false);
    expectUserReadable(body.error?.message || '');
  });

  for (const module of modules) {
    test(`${module.label}可通过短时测试会话打开`, async ({ page, request }, testInfo) => {
      await openModule(page, request, module, testInfo);
    });
  }

  test('移动端核心入口无横向溢出', async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const module = modules[0];
    await openModule(page, request, module, testInfo);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('[VIS-009] 移动端视觉输入与结果区域无横向溢出', async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const module = modules.find((item) => item.key === 'visual-creation') || modules[0];
    await openModule(page, request, module, testInfo);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const interactive = page.locator('textarea:visible, input:visible, button:visible');
    expect(await interactive.count()).toBeGreaterThan(0);
  });
});
