import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

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
const speechFixture = Buffer.from(readFileSync(
  resolve(specDir, '../fixtures/stable-smoke-speech.m4a.b64'),
  'utf8',
).trim(), 'base64');

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

type ImageModelPool = {
  id: string;
  code: string;
  models: Array<{ healthStatus?: string }>;
};

type ImageRunDetail = {
  run: {
    status: string;
    total: number;
    done: number;
    failed: number;
  };
  items: Array<{
    status: string;
    requestedSize?: string;
    effectiveSize?: string;
    base64?: string;
    url?: string;
    errorMessage?: string;
  }>;
};

function crc32(input: Buffer) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function solidPngDataUrl(red: number, green: number, blue: number, size = 256) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = red;
    row[2 + x * 3] = green;
    row[3 + x * 3] = blue;
  }
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function createVisualWorkspace(page: Page, token: string, suffix: string) {
  const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await page.request.post('/api/visual-agent/image-master/workspaces', {
    headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${suffix}-${attemptId}` },
    data: { title: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${suffix}-${attemptId}`, scenarioType: 'image-gen' },
  });
  return readEnvelope<{ workspace: { id: string } }>(response);
}

async function waitForImageRun(page: Page, token: string, runId: string, timeoutMs = 180_000) {
  const statuses: string[] = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await page.request.get(`/api/visual-agent/image-gen/runs/${runId}?includeItems=true&includeImages=false`, {
      headers: authHeaders(token),
    });
    const detail = await readEnvelope<ImageRunDetail>(response);
    if (!statuses.includes(detail.run.status)) statuses.push(detail.run.status);
    if (/Completed|Failed|Cancelled/i.test(detail.run.status)) return { detail, statuses };
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  }
  throw new Error(`图片生成等待超时，请检查任务 ${runId} 的运行状态`);
}

async function assertImageArtifact(page: Page, detail: ImageRunDetail) {
  expect(detail.run.status).toBe('Completed');
  expect(detail.run.done).toBe(detail.run.total);
  expect(detail.run.failed).toBe(0);
  expect(detail.items.length).toBeGreaterThan(0);
  const item = detail.items[0];
  expect(item.errorMessage || '').toBe('');
  expect(item.effectiveSize || item.requestedSize).toMatch(/^\d+x\d+$/);
  if (item.url) {
    const image = await page.request.get(item.url);
    expect(image.ok()).toBe(true);
    expect(image.headers()['content-type'] || '').toMatch(/^image\//);
    expect((await image.body()).byteLength).toBeGreaterThan(512);
  } else {
    expect(Buffer.from(item.base64 || '', 'base64').byteLength).toBeGreaterThan(512);
  }
}

async function waitForTranscriptRun(page: Page, token: string, runId: string, timeoutMs = 180_000) {
  const statuses: string[] = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await page.request.get(`/api/transcript-agent/runs/${runId}`, { headers: authHeaders(token) });
    expect(response.ok()).toBe(true);
    const run = await response.json() as { status: string; progress: number; error?: string };
    if (!statuses.includes(run.status)) statuses.push(run.status);
    if (run.status === 'completed') return { run, statuses };
    if (run.status === 'failed') throw new Error(run.error || '录音转写失败，请检查 ASR 服务状态后重试');
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  }
  throw new Error('录音转写等待超时，请检查任务状态后重试');
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

  test('[REC-003][REC-007][REC-012] 音频上传、真实转写、回读与清理', async ({ page, request }) => {
    test.setTimeout(240_000);
    const token = await loginAndReadToken(page, request, '/transcript-agent');
    const title = `${requiredEnv('STABLE_SMOKE_RUN_ID')}-audio`;
    let workspaceId = '';
    let itemId = '';
    let runId = '';
    try {
      const created = await page.request.post('/api/transcript-agent/workspaces', {
        headers: authHeaders(token),
        data: { title },
      });
      expect(created.ok()).toBe(true);
      workspaceId = ((await created.json()) as { id: string }).id;

      const uploaded = await page.request.post(`/api/transcript-agent/workspaces/${workspaceId}/items/upload`, {
        headers: authHeaders(token),
        multipart: {
          file: {
            name: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-speech.m4a`,
            mimeType: 'audio/mp4',
            buffer: speechFixture,
          },
        },
      });
      expect(uploaded.ok(), await uploaded.text()).toBe(true);
      const uploadBody = await uploaded.json() as { item: { id: string; fileName: string }; runId: string };
      itemId = uploadBody.item.id;
      runId = uploadBody.runId;
      expect(uploadBody.item.fileName).toContain('speech.m4a');

      const completed = await waitForTranscriptRun(page, token, runId);
      expect(completed.statuses.length).toBeGreaterThanOrEqual(2);
      expect(completed.run.progress).toBeGreaterThanOrEqual(90);

      const items = await page.request.get(`/api/transcript-agent/workspaces/${workspaceId}/items`, {
        headers: authHeaders(token),
      });
      const item = ((await items.json()) as Array<{
        id: string;
        transcribeStatus: string;
        segments?: Array<{ text: string }>;
      }>).find((candidate) => candidate.id === itemId);
      expect(item?.transcribeStatus).toBe('completed');
      expect((item?.segments || []).map((segment) => segment.text).join(' ').trim().length).toBeGreaterThan(10);
    } finally {
      if (itemId) await page.request.delete(`/api/transcript-agent/items/${itemId}`, { headers: authHeaders(token) });
      if (workspaceId) {
        const deleted = await page.request.delete(`/api/transcript-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
        });
        expect(deleted.status()).toBe(204);
        expect((await page.request.get(`/api/transcript-agent/workspaces/${workspaceId}`, { headers: authHeaders(token) })).status()).toBe(404);
      }
    }
  });

  test('[REC-004][REC-005][REC-010] 录音分片可恢复、重复完成幂等且无重复条目', async ({ page, request }) => {
    test.setTimeout(120_000);
    const token = await loginAndReadToken(page, request, '/document-store');
    let storeId = '';
    let sessionId = '';
    try {
      const createStore = await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: {
          name: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-recording`,
          description: '稳定冒烟录音保险箱，执行后自动清理',
          isPublic: false,
        },
      });
      storeId = (await readEnvelope<{ id: string }>(createStore)).id;
      const started = await page.request.post(`/api/document-store/stores/${storeId}/recording-uploads`, {
        headers: authHeaders(token),
        data: { fileName: `${requiredEnv('STABLE_SMOKE_RUN_ID')}.m4a`, mimeType: 'audio/mp4' },
      });
      sessionId = (await readEnvelope<{ sessionId: string }>(started)).sessionId;

      const midpoint = Math.ceil(speechFixture.length / 2);
      const chunks = [speechFixture.subarray(0, midpoint), speechFixture.subarray(midpoint)];
      for (let index = 0; index < chunks.length; index += 1) {
        const appended = await page.request.post(`/api/document-store/recording-uploads/${sessionId}/chunks/${index}`, {
          headers: { ...authHeaders(token), 'Content-Type': 'application/octet-stream' },
          data: chunks[index],
        });
        const data = await readEnvelope<{ nextChunkIndex: number; uploadedBytes: number }>(appended);
        expect(data.nextChunkIndex).toBe(index + 1);
        expect(data.uploadedBytes).toBeGreaterThan(0);

        const restored = await page.request.get(`/api/document-store/recording-uploads/${sessionId}`, {
          headers: authHeaders(token),
        });
        expect((await readEnvelope<{ nextChunkIndex: number }>(restored)).nextChunkIndex).toBe(index + 1);
      }

      const duplicate = await page.request.post(`/api/document-store/recording-uploads/${sessionId}/chunks/0`, {
        headers: { ...authHeaders(token), 'Content-Type': 'application/octet-stream' },
        data: chunks[0],
      });
      expect((await readEnvelope<{ duplicate: boolean }>(duplicate)).duplicate).toBe(true);

      const firstComplete = await page.request.post(`/api/document-store/recording-uploads/${sessionId}/complete`, {
        headers: authHeaders(token),
      });
      const first = await readEnvelope<{ entry: { id: string }; sessionId: string }>(firstComplete);
      const secondComplete = await page.request.post(`/api/document-store/recording-uploads/${sessionId}/complete`, {
        headers: authHeaders(token),
      });
      const second = await readEnvelope<{ entry: { id: string }; reused: boolean }>(secondComplete);
      expect(second.entry.id).toBe(first.entry.id);
      expect(second.reused).toBe(true);
    } finally {
      if (sessionId) {
        await page.request.delete(`/api/document-store/recording-uploads/${sessionId}`, {
          headers: authHeaders(token),
        }).catch(() => undefined);
      }
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, {
          headers: authHeaders(token),
        });
        expect([200, 204]).toContain(deleted.status());
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

  test('[VIS-002][VIS-004][VIS-005][VIS-007][VIS-010] 文生图真实产物、进度布局与清理', async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'single-image');
    let runId = '';
    try {
      const poolResponse = await page.request.get('/api/visual-agent/image-gen/models/text2img', { headers: authHeaders(token) });
      const pools = await readEnvelope<ImageModelPool[]>(poolResponse);
      const pool = pools.find((item) => item.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || '')));
      expect(pool, '没有可用的文生图逻辑模型').toBeTruthy();

      const create = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/image-gen/runs`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-single-run` },
        data: {
          prompt: '一枚放在纯白背景上的蓝色陶瓷杯，产品摄影，柔和自然光，不要文字',
          userMessageContent: '生成一枚纯白背景上的蓝色陶瓷杯',
          targetKey: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-single-target`,
          platformId: 'logical-model',
          modelId: pool!.code,
          size: '1024x1024',
          responseFormat: 'url',
          x: 0,
          y: 0,
          w: 1001,
          h: 1001,
        },
      });
      const created = await readEnvelope<{ runId: string }>(create);
      runId = created.runId;

      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      const progress = page.getByTestId('generation-progress').first();
      await expect(progress, '真实生图开始后页面必须恢复生成中占位').toBeVisible({ timeout: 15_000 });
      const progressBox = await progress.boundingBox();
      const barBox = await progress.locator('.gen-sweep__bar').boundingBox();
      expect(progressBox).not.toBeNull();
      expect(barBox).not.toBeNull();
      expect(barBox!.x).toBeGreaterThanOrEqual(progressBox!.x - 1);
      expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(progressBox!.x + progressBox!.width + 1);
      await testInfo.attach('single-image-progress', { body: await page.screenshot(), contentType: 'image/png' });

      const completed = await waitForImageRun(page, token, runId);
      expect(completed.statuses.length).toBeGreaterThanOrEqual(2);
      await assertImageArtifact(page, completed.detail);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const generatedImage = page.getByTestId('canvas-image').first();
      await expect(generatedImage, '任务完成并刷新后画布必须恢复真实图片').toBeVisible({ timeout: 30_000 });
      expect(await generatedImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await testInfo.attach('single-image-result', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      if (runId) {
        const current = await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) });
        if (current.ok()) {
          const state = await current.json() as ApiEnvelope<ImageRunDetail>;
          if (!/Completed|Failed|Cancelled/i.test(state.data?.run?.status || '')) {
            await page.request.post(`/api/visual-agent/image-gen/runs/${runId}/cancel`, { headers: authHeaders(token) });
            await waitForImageRun(page, token, runId, 30_000).catch(() => undefined);
          }
        }
      }
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-single-delete` },
      });
      expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
      expect((await page.request.get(`/api/visual-agent/image-master/workspaces/${workspace.id}/detail`, { headers: authHeaders(token) })).status()).toBe(404);
      if (runId) {
        expect((await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) })).status()).toBe(404);
      }
    }
  });

  test('[MVIS-001][MVIS-002][MVIS-008][MVIS-009][MVIS-010] 多图引用真实生成、恢复与清理', async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'multi-image');
    let runId = '';
    try {
      const uploadAsset = async (data: string, suffix: string) => {
        const response = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/assets`, {
          headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-${suffix}` },
          data: { data, width: 256, height: 256, prompt: suffix },
        });
        return readEnvelope<{ asset: { sha256: string; url: string } }>(response);
      };
      const first = await uploadAsset(solidPngDataUrl(35, 90, 190), 'blue-reference');
      const second = await uploadAsset(solidPngDataUrl(235, 190, 55), 'yellow-reference');

      const poolResponse = await page.request.get('/api/visual-agent/image-gen/models/vision', { headers: authHeaders(token) });
      const pools = await readEnvelope<ImageModelPool[]>(poolResponse);
      const pool = pools.find((item) => item.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || '')));
      expect(pool, '没有可用的多图视觉逻辑模型').toBeTruthy();

      const create = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/image-gen/runs`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-multi-run` },
        data: {
          prompt: '参考 @img1 的蓝色与 @img2 的黄色，生成一个左右双色的极简包装盒，纯白背景，不要文字',
          userMessageContent: '参考 @img1 和 @img2 生成一个蓝黄双色包装盒',
          targetKey: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-multi-target`,
          platformId: 'logical-model',
          modelId: pool!.code,
          size: '1024x1024',
          responseFormat: 'url',
          imageRefs: [
            { refId: 1, assetSha256: first.asset.sha256, url: first.asset.url, label: '蓝色参考', role: 'target' },
            { refId: 2, assetSha256: second.asset.sha256, url: second.asset.url, label: '黄色参考', role: 'style' },
          ],
          x: 0,
          y: 0,
          w: 1001,
          h: 1001,
        },
      });
      runId = (await readEnvelope<{ runId: string }>(create)).runId;

      const completed = await waitForImageRun(page, token, runId);
      await assertImageArtifact(page, completed.detail);
      const afterRefresh = await page.request.get(`/api/visual-agent/image-gen/runs/${runId}?includeItems=true`, { headers: authHeaders(token) });
      expect((await readEnvelope<ImageRunDetail>(afterRefresh)).run.status).toBe('Completed');

      const messages = await page.request.get(`/api/visual-agent/image-master/workspaces/${workspace.id}/messages`, { headers: authHeaders(token) });
      const messageText = JSON.stringify((await messages.json() as ApiEnvelope<unknown>).data);
      expect(messageText).toContain('@img1');
      expect(messageText).toContain('@img2');

      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      const generatedImage = page.getByTestId('canvas-image').first();
      await expect(generatedImage, '多图生成完成后页面必须恢复真实图片').toBeVisible({ timeout: 30_000 });
      expect(await generatedImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect(page.getByText('参考', { exact: false }).last()).toBeVisible({ timeout: 15_000 });
      await testInfo.attach('multi-image-result', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      if (runId) {
        const current = await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) });
        if (current.ok()) {
          const state = await current.json() as ApiEnvelope<ImageRunDetail>;
          if (!/Completed|Failed|Cancelled/i.test(state.data?.run?.status || '')) {
            await page.request.post(`/api/visual-agent/image-gen/runs/${runId}/cancel`, { headers: authHeaders(token) });
            await waitForImageRun(page, token, runId, 30_000).catch(() => undefined);
          }
        }
      }
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-multi-delete` },
      });
      expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
      if (runId) {
        expect((await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) })).status()).toBe(404);
      }
    }
  });
});
