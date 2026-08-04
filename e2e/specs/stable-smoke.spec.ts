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

async function readStableAuthSnapshot(page: Page) {
  let snapshot = '';
  await expect.poll(async () => {
    snapshot = await page.evaluate(() => window.localStorage.getItem('prd-admin-auth') || '').catch(() => '');
    return snapshot;
  }, {
    message: '等待页面导航稳定并读取认证快照',
    timeout: 10_000,
    intervals: [100, 200, 400, 800],
  }).not.toBe('');
  return snapshot;
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

function zipStore(entries: Array<{ name: string; content: string }>) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function docxFixture(text: string) {
  return zipStore([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', content: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', content: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>` },
  ]);
}

function pptxFixture(text: string) {
  return zipStore([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>' },
    { name: '_rels/.rels', content: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>' },
    { name: 'ppt/presentation.xml', content: '<?xml version="1.0"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>' },
    { name: 'ppt/_rels/presentation.xml.rels', content: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>' },
    { name: 'ppt/slides/slide1.xml', content: `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>` },
  ]);
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

async function dismissVisualTutorial(page: Page) {
  const learned = page.getByRole('button', { name: '我已学会' });
  await learned.waitFor({ state: 'visible', timeout: 2_500 }).catch(() => undefined);
  if (await learned.isVisible().catch(() => false)) {
    await learned.click();
    await expect(learned, '关闭教程后不应继续遮挡视觉创作结果').toBeHidden();
  }
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

  test('[CORE-006][REG-user-error-001] 首页告警不泄漏上游技术细节', async ({ page, request }) => {
    const notificationsLoaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/dashboard/notifications',
      { timeout: 15_000 },
    );
    await loginAndReadToken(page, request, '/');
    const notificationResponse = await notificationsLoaded;
    expect(notificationResponse.ok(), '首页通知列表加载失败').toBe(true);
    const body = page.locator('body');
    await expect(body).not.toContainText(/上游信息|Key limit exceeded|openrouter|\/keys\//i);
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

  test('[CORE-008][REG-tutorial-progress-001] 历史空进度用户可完成教程且重复提交幂等', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/document-store');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await page.request.post('/api/daily-tips/seed-document-store-page-guide/mark-learned', {
        headers: authHeaders(token),
      });
      const body = await response.json() as ApiEnvelope<{
        learned: { sourceId: string; version: number; tier: string };
      }>;
      expect(response.status(), body.error?.message || '教程完成状态保存失败').toBe(200);
      expect(body.success, body.error?.message || '教程完成状态保存失败').toBe(true);
      expect(body.data.learned.sourceId).toBe('document-store-page-guide');
    }
    const progress = await readEnvelope<{
      items: Array<{ sourceId: string; learned: boolean }>;
    }>(await page.request.get('/api/daily-tips/progress', { headers: authHeaders(token) }));
    expect(progress.items.find((item) => item.sourceId === 'document-store-page-guide')?.learned).toBe(true);
  });

  test('[CORE-002][CORE-003] 合成会话刷新恢复且匿名请求被隔离', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/');
    const allowed = await page.request.get('/api/authz/me', { headers: authHeaders(token) });
    expect(allowed.ok()).toBe(true);

    const anonymous = await request.get('/api/authz/me');
    expect([401, 403]).toContain(anonymous.status());

    const beforeReload = await readStableAuthSnapshot(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).not.toContainText('请重新登录');
    const afterReload = await readStableAuthSnapshot(page);
    expect(afterReload).toBe(beforeReload);
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

  test('[FILE-001][FILE-002][FILE-004][FILE-005][FILE-006][FILE-007][FILE-009][FILE-010][REG-file-001] 文件格式、错误、下载、重复与清理', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/transcript-agent');
    const runKey = `stsmk-${Date.now()}`;
    let storeId = '';
    const createdEntryIds: string[] = [];
    try {
      const createStore = await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: { name: `${runKey}-文件解析`, description: '稳定冒烟专用，执行后自动清理', isPublic: false },
      });
      const store = await readEnvelope<{ id: string; name: string }>(createStore);
      storeId = store.id;

      const expectedText = `${runKey} 中文文件解析基准内容`;
      const fixtures = [
        { suffix: 'txt', mime: 'text/plain', buffer: Buffer.from(expectedText, 'utf8'), expected: expectedText },
        { suffix: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxFixture(expectedText), expected: expectedText },
        { suffix: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: pptxFixture(expectedText), expected: expectedText },
        { suffix: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: readFileSync(resolve(specDir, '../../prd-admin/public/templates/product-agent-feature-catalog-test.xlsx')), expected: '' },
        { suffix: 'pdf', mime: 'application/pdf', buffer: readFileSync(resolve(specDir, '../../doc/report.cds-agent-p4-1-remote-preflight-2026-05-19.pdf')), expected: '' },
      ];
      for (const fixture of fixtures) {
        const upload = await page.request.post(`/api/document-store/stores/${storeId}/upload`, {
          headers: authHeaders(token),
          multipart: {
            file: {
              name: `${runKey}-中文样本.${fixture.suffix}`,
              mimeType: fixture.mime,
              buffer: fixture.buffer,
            },
          },
        });
        const uploaded = await readEnvelope<{ entry: { id: string; title: string }; fileUrl: string }>(upload);
        createdEntryIds.push(uploaded.entry.id);
        expect(uploaded.entry.title).toContain('中文样本');
        expect(uploaded.fileUrl).toBeTruthy();

        const contentResponse = await page.request.get(`/api/document-store/entries/${uploaded.entry.id}/content`, {
          headers: authHeaders(token),
        });
        const content = await readEnvelope<{ content?: string; hasContent: boolean }>(contentResponse);
        expect(content.hasContent, `${fixture.suffix} 应提取出可读内容`).toBe(true);
        expect((content.content || '').trim().length).toBeGreaterThan(5);
        if (fixture.expected) expect(content.content).toContain(fixture.expected);

        const original = await page.request.get(uploaded.fileUrl);
        expect(original.ok()).toBe(true);
        expect(original.headers()['content-type'] || '').toContain(fixture.mime.split(';')[0]);
        expect((await original.body()).byteLength).toBe(fixture.buffer.byteLength);
      }

      const duplicate = await page.request.post(`/api/document-store/stores/${storeId}/upload`, {
        headers: authHeaders(token),
        multipart: { file: { name: `${runKey}-中文样本.txt`, mimeType: 'text/plain', buffer: Buffer.from(expectedText, 'utf8') } },
      });
      const duplicateData = await readEnvelope<{ entry: { id: string } }>(duplicate);
      expect(createdEntryIds).not.toContain(duplicateData.entry.id);
      createdEntryIds.push(duplicateData.entry.id);

      const corrupt = await page.request.post(`/api/document-store/stores/${storeId}/upload`, {
        headers: authHeaders(token),
        multipart: { file: { name: `${runKey}-损坏.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not-a-docx') } },
      });
      const corruptBody = await corrupt.json() as ApiEnvelope<never>;
      expect(corrupt.status()).toBe(400);
      expectUserReadable(corruptBody.error?.message || '');

      const empty = await page.request.post(`/api/document-store/stores/${storeId}/upload`, {
        headers: authHeaders(token),
        multipart: { file: { name: `${runKey}-空文件.txt`, mimeType: 'text/plain', buffer: Buffer.alloc(0) } },
      });
      const emptyBody = await empty.json() as ApiEnvelope<never>;
      expect(empty.status()).toBe(400);
      expectUserReadable(emptyBody.error?.message || '');
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
        for (const entryId of createdEntryIds) {
          expect((await page.request.get(`/api/document-store/entries/${entryId}`, { headers: authHeaders(token) })).status()).toBe(404);
        }
      }
    }
  });

  test('[FILE-003] 大文件上传期间持续显示文件名和百分比', async ({ page, request }) => {
    test.setTimeout(90_000);
    const token = await loginAndReadToken(page, request, '/document-store');
    const runKey = `${requiredEnv('STABLE_SMOKE_RUN_ID')}-progress`;
    let storeId = '';
    try {
      const store = await readEnvelope<{ id: string }>(await page.request.post('/api/document-store/stores', {
        headers: authHeaders(token),
        data: { name: runKey, description: '上传进度稳定冒烟，执行后自动清理', isPublic: false },
      }));
      storeId = store.id;
      await page.evaluate((id) => sessionStorage.setItem('doc-store-selected-id', id), storeId);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByText(runKey, { exact: true })).toBeVisible({ timeout: 15_000 });

      let releaseUpload!: () => void;
      const release = new Promise<void>((resolveRelease) => { releaseUpload = resolveRelease; });
      await page.route(`**/api/document-store/stores/${storeId}/upload`, async (route) => {
        await release;
        await route.continue();
      });
      const name = `${runKey}.txt`;
      await page.locator('input[type="file"][accept*=".pdf"]').first().setInputFiles({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.alloc(2 * 1024 * 1024, 65),
      });
      await expect(page.getByText(`正在上传 ${name}`, { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/^\d+%$/)).toBeVisible();
      releaseUpload();
      await expect(page.getByText(`正在上传 ${name}`, { exact: true })).toBeHidden({ timeout: 30_000 });
    } finally {
      if (storeId) {
        const deleted = await page.request.delete(`/api/document-store/stores/${storeId}`, { headers: authHeaders(token) });
        expect([200, 204]).toContain(deleted.status());
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

  test('[LIT-002][LIT-005][LIT-008][LIT-010] 文学配图标记流式生成、保存恢复与清理', async ({ page, request }) => {
    test.setTimeout(240_000);
    const token = await loginAndReadToken(page, request, '/literary-agent');
    const title = `stsmk-${Date.now()}-文学流式创作`;
    const article = '清晨，城市公园里的蓝色长椅刚被阳光照亮。\n\n一位读者翻开书本，远处的树叶在微风中轻轻摇动。';
    let workspaceId = '';
    try {
      const created = await readEnvelope<{ workspace: { id: string } }>(
        await page.request.post('/api/literary-agent/workspaces', {
          headers: authHeaders(token),
          data: { title, scenarioType: 'article-illustration', articleContent: article },
        }),
      );
      workspaceId = created.workspace.id;
      await readEnvelope<{ workspace: { id: string } }>(await page.request.put(`/api/literary-agent/workspaces/${workspaceId}`, {
        headers: authHeaders(token),
        data: { title, articleContent: article },
      }));
      const streamed = await page.evaluate(async ({ id, accessToken, content }) => {
        const startedAt = performance.now();
        const response = await fetch(`/api/visual-agent/image-master/workspaces/${id}/article/generate-markers`, {
          method: 'POST',
          headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Idempotency-Key': `stable-literary-${id}`,
          },
          body: JSON.stringify({
            articleContent: content,
            userInstruction: '只插入一处配图标记，保持原文不变',
            insertionMode: 'anchor',
          }),
        });
        if (!response.ok || !response.body) return { ok: false, firstChunkMs: -1, chunkCount: 0, text: await response.text() };
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let firstChunkMs = -1;
        let chunkCount = 0;
        let text = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (firstChunkMs < 0) firstChunkMs = performance.now() - startedAt;
          chunkCount += 1;
          text += decoder.decode(value, { stream: true });
        }
        return { ok: true, firstChunkMs, chunkCount, text };
      }, { id: workspaceId, accessToken: token, content: article });
      expect(streamed.ok, streamed.text).toBe(true);
      expect(streamed.firstChunkMs).toBeGreaterThanOrEqual(0);
      expect(streamed.firstChunkMs).toBeLessThan(30_000);
      expect(streamed.chunkCount).toBeGreaterThan(1);
      expect(streamed.text).toMatch(/(?:delta|done|complete|marker)/i);

      const detail = await readEnvelope<{ workspace: { articleContent?: string; articleContentWithMarkers?: string } }>(
        await page.request.get(`/api/literary-agent/workspaces/${workspaceId}/detail`, { headers: authHeaders(token) }),
      );
      expect(detail.workspace.articleContent).toContain('蓝色长椅');
      expect((detail.workspace.articleContentWithMarkers || '').length).toBeGreaterThan(article.length);
    } finally {
      if (workspaceId) {
        const deleted = await page.request.delete(`/api/literary-agent/workspaces/${workspaceId}`, { headers: authHeaders(token) });
        expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
      }
    }
  });

  test('[LIT-009] 移动端可输入标题、创建作品并进入编辑页', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const token = await loginAndReadToken(page, request, '/literary-agent');
    const title = `${requiredEnv('STABLE_SMOKE_RUN_ID')}-移动文学`;
    let workspaceId = '';
    try {
      await page.locator('[data-tour-id="literary-create"]').click();
      const input = page.getByPlaceholder('未命名');
      await expect(input).toBeVisible();
      await input.fill(title);
      await page.getByRole('button', { name: '创建', exact: true }).click();
      await page.waitForURL(/\/literary-agent\/[^/?#]+/, { timeout: 20_000 });
      workspaceId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1) || '';
      expect(workspaceId).toBeTruthy();
      await expect(page.locator('body')).toContainText(title);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, '移动端文学创作页面不得横向裁切').toBeLessThanOrEqual(1);
      expect(await page.locator('button:visible, textarea:visible, [contenteditable="true"]:visible').count()).toBeGreaterThan(0);
    } finally {
      if (workspaceId) {
        const deleted = await page.request.delete(`/api/literary-agent/workspaces/${workspaceId}`, {
          headers: authHeaders(token),
        });
        expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
      }
    }
  });

  test('[PARSE-003][REG-short-video-input-001] 非法短视频链接在入口被拒绝并说明恢复动作', async ({ page, request }) => {
    const token = await loginAndReadToken(page, request, '/document-store');
    const response = await page.request.post('/api/short-video-materials/runs', {
      headers: authHeaders(token),
      data: { videoUrl: '这不是链接', title: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-invalid-video` },
    });
    const body = await response.json() as ApiEnvelope<never>;
    expect(response.status()).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error?.message || '').toContain('完整的公开视频链接');
    expectUserReadable(body.error?.message || '');
  });

  test('[VIDEO-004][VIDEO-007][VIDEO-008][REG-video-001] 最短视频真实生成、播放文件校验与下载', async ({ page, request }) => {
    test.setTimeout(420_000);
    const token = await loginAndReadToken(page, request, '/video-agent');
    const models = await readEnvelope<Array<{
      id: string;
      healthStatus?: string;
      durations?: number[];
      resolutions?: string[];
      aspectRatios?: string[];
      pricePerCall?: number;
    }>>(await page.request.get('/api/video-agent/models', { headers: authHeaders(token) }));
    const available = models
      .filter((model) => !/unhealthy|disabled|unavailable/i.test(model.healthStatus || ''))
      .sort((left, right) => (left.pricePerCall ?? Number.MAX_SAFE_INTEGER) - (right.pricePerCall ?? Number.MAX_SAFE_INTEGER));
    expect(available.length, '没有可用的视频生成模型').toBeGreaterThan(0);
    const model = available[0];
    const submit = await page.request.post('/api/video-agent/videogen-direct', {
      headers: authHeaders(token),
      data: {
        model: model.id,
        prompt: '固定镜头，一只蓝色陶瓷杯放在纯白桌面上，柔和自然光，不要文字，不要人物',
        aspectRatio: model.aspectRatios?.includes('16:9') ? '16:9' : model.aspectRatios?.[0],
        resolution: model.resolutions?.includes('720p') ? '720p' : model.resolutions?.[0],
        durationSeconds: Math.min(...(model.durations?.length ? model.durations : [5])),
        generateAudio: false,
      },
    });
    const submitted = await readEnvelope<{
      success: boolean;
      jobId?: string;
      actualModel?: string;
      errorMessage?: string;
    }>(submit);
    expect(submitted.success, submitted.errorMessage || '视频任务提交失败').toBe(true);
    expect(submitted.jobId).toBeTruthy();

    const startedAt = Date.now();
    let videoUrl = '';
    while (Date.now() - startedAt < 360_000) {
      const status = await readEnvelope<{
        status: string;
        videoUrl?: string;
        errorMessage?: string;
        isCompleted: boolean;
        isFailed: boolean;
      }>(await page.request.get(`/api/video-agent/videogen-direct/status/${encodeURIComponent(submitted.jobId!)}`, {
        headers: authHeaders(token),
      }));
      if (status.isFailed) {
        expectUserReadable(status.errorMessage || '视频生成失败，请稍后重试或切换模型');
        throw new Error(status.errorMessage || '视频生成失败，请稍后重试或切换模型');
      }
      if (status.isCompleted) {
        videoUrl = status.videoUrl || '';
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
    }
    expect(videoUrl, '视频任务完成后必须返回成片标识').toBeTruthy();
    const modelQuery = submitted.actualModel ? `?model=${encodeURIComponent(submitted.actualModel)}` : '';
    const video = await page.request.get(`/api/video-agent/videogen-direct/content/${encodeURIComponent(submitted.jobId!)}${modelQuery}`, {
      headers: authHeaders(token),
      timeout: 180_000,
    });
    expect(video.ok()).toBe(true);
    expect(video.headers()['content-type'] || '').toMatch(/^video\//);
    expect((await video.body()).byteLength).toBeGreaterThan(1024);
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

  test('[REC-001][REC-002][REC-006] 现场录音自动开始、暂停继续且静音会在上传前拦截', async ({ page, request, context }) => {
    test.setTimeout(90_000);
    await context.grantPermissions(['microphone']);
    await page.addInitScript(() => {
      const analyser = window.AnalyserNode?.prototype;
      if (!analyser) return;
      analyser.getByteTimeDomainData = function getSilentTimeDomainData(target: Uint8Array) {
        target.fill(128);
      };
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAndReadToken(page, request, '/document-store?quickRecord=1');

    await expect(page.getByText('录音中', { exact: true }), '进入快捷录音后必须自动开始').toBeVisible({ timeout: 20_000 });
    const timer = page.getByText(/^\d{2}:\d{2}$/).first();
    await expect(timer).toBeVisible();
    await expect.poll(() => timer.textContent(), { timeout: 5_000 }).not.toBe('00:00');

    await page.getByRole('button', { name: '暂停录音' }).click();
    await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
    const pausedAt = await timer.textContent();
    await page.waitForTimeout(1_200);
    expect(await timer.textContent(), '暂停期间计时不得继续增长').toBe(pausedAt);

    await page.getByRole('button', { name: '继续录音' }).click();
    await expect(page.getByText('录音中', { exact: true })).toBeVisible();
    await expect.poll(() => timer.textContent(), { timeout: 5_000 }).not.toBe(pausedAt);

    await page.getByRole('button', { name: '结束录音并转成文字' }).click();
    await expect(page.getByText('整段录音几乎没有检测到声音，转录很可能失败。请确认麦克风没有静音。')).toBeVisible();
    await page.getByRole('button', { name: '放弃本次录音' }).click();
    await expect(page.getByText('快捷录音', { exact: true })).toBeHidden();
  });

  test('[REC-008] 浏览器不支持录音时直接提供上传音频兜底', async ({ page, request }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAndReadToken(page, request, '/document-store?quickRecord=1');
    await expect(page.getByText('当前浏览器不支持录音', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /上传音频文件/ })).toBeVisible();
    await page.getByRole('button', { name: '取消录音' }).click();
    await expect(page.getByText('快捷录音', { exact: true })).toBeHidden();
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

  test('[GW-001][GW-002][GW-003][GW-004][GW-005][GW-006][GW-007][GW-008][GW-009][REG-llmgw-auth-001][REG-asr-routing-001] 网关配置、路由与日志可由专用身份审计', async ({ request }) => {
    const baseUrl = requiredEnv('STABLE_SMOKE_GW_BASE_URL');
    const login = await request.post(`${baseUrl}/gw/auth/login`, {
      data: {
        username: requiredEnv('STABLE_SMOKE_GW_USER'),
        password: requiredEnv('STABLE_SMOKE_GW_PASSWORD'),
      },
    });
    const loginBody = await login.json() as ApiEnvelope<{ token: string; mustChangePassword: boolean }>;
    expect(login.ok(), loginBody.error?.message || '模型网关专用账号登录失败').toBe(true);
    expect(loginBody.success, loginBody.error?.message || '模型网关专用账号登录失败').toBe(true);
    expect(loginBody.data.token).toBeTruthy();
    expect(loginBody.data.mustChangePassword).toBe(false);
    const headers = { Authorization: `Bearer ${loginBody.data.token}` };

    const [context, models, logicalModels, health, authority, logs, poolTypes, asrPools] = await Promise.all([
      request.get(`${baseUrl}/gw/auth/context`, { headers }),
      request.get(`${baseUrl}/gw/models?enabled=true`, { headers }),
      request.get(`${baseUrl}/gw/logical-models?enabled=true`, { headers }),
      request.get(`${baseUrl}/gw/key-health`, { headers }),
      request.get(`${baseUrl}/gw/config-authority/report`, { headers }),
      request.get(`${baseUrl}/gw/logs?limit=20`, { headers }),
      request.get(`${baseUrl}/gw/pool-types`, { headers }),
      request.get(`${baseUrl}/gw/pools?modelType=asr&sinceHours=168`, { headers }),
    ]);
    for (const response of [context, models, logicalModels, health, authority, logs, poolTypes, asrPools]) {
      expect(response.ok(), `网关审计接口 ${response.url()} 不可用`).toBe(true);
    }

    const modelsBody = await models.text();
    const logicalBody = await logicalModels.text();
    expect(modelsBody).not.toMatch(/(?:apiKey|password)"\s*:\s*"(?!\*{3,}|\[masked\]|null|undefined)/i);
    expect(logicalBody).not.toMatch(/(?:apiKey|password)"\s*:\s*"(?!\*{3,}|\[masked\]|null|undefined)/i);
    const logicalJson = JSON.parse(logicalBody) as ApiEnvelope<{ items: Array<{
      publicId?: string;
      modelType?: string;
      enabled?: boolean;
      offerings?: Array<{ protocol?: string; endpointPath?: string; priority?: number; weight?: number }>;
    }> }>;
    expect(logicalJson.success).toBe(true);
    expect(logicalJson.data.items.length).toBeGreaterThan(0);
    for (const logical of logicalJson.data.items) {
      expect(logical.publicId).toBeTruthy();
      expect(logical.modelType).toBeTruthy();
      expect(logical.enabled).toBe(true);
      for (const offering of logical.offerings || []) {
        expect(offering.protocol || '').not.toMatch(/^https?:/i);
        expect(offering.endpointPath || '').not.toMatch(/^https?:|\\/);
        expect(offering.priority ?? 0).toBeGreaterThanOrEqual(0);
        expect(offering.weight ?? 1).toBeGreaterThan(0);
      }
    }

    const poolTypesJson = await poolTypes.json() as ApiEnvelope<{ items: Array<{
      code: string;
      defaultPoolId: string;
      modelCount: number;
      ready: boolean;
    }> }>;
    const asrType = poolTypesJson.data.items.find((item) => item.code === 'asr');
    expect(asrType, '网关必须注册 ASR 类型和默认池').toBeTruthy();
    expect(asrType?.ready, 'ASR 默认池必须处于就绪状态').toBe(true);
    expect(asrType?.modelCount, 'ASR 默认池必须至少有主备两个成员').toBeGreaterThanOrEqual(2);

    const asrPoolsJson = await asrPools.json() as ApiEnvelope<{ items: Array<{
      id: string;
      isDefaultForType: boolean;
      health: string;
      healthyMembers: number;
      models: Array<{ modelId: string; platformId: string; priority: number; healthStatus: number }>;
    }> }>;
    const defaultAsrPool = asrPoolsJson.data.items.find((pool) => pool.id === asrType?.defaultPoolId);
    expect(defaultAsrPool, 'ASR 类型指针必须命中可读取的默认池').toBeTruthy();
    expect(defaultAsrPool?.isDefaultForType).toBe(true);
    expect(defaultAsrPool?.health).not.toBe('unavailable');
    expect(defaultAsrPool?.healthyMembers || 0).toBeGreaterThan(0);
    expect(defaultAsrPool?.models.length || 0).toBeGreaterThanOrEqual(2);
    expect(new Set((defaultAsrPool?.models || []).map((model) => model.modelId)).size).toBeGreaterThanOrEqual(2);
    for (const model of defaultAsrPool?.models || []) {
      expect(model.modelId).toBeTruthy();
      expect(model.platformId).toBeTruthy();
      expect(model.priority).toBeGreaterThan(0);
    }
  });

  test('[CORE-005][VIS-008][REG-visual-error-001] 无效生图请求返回用户可读错误', async ({ page, request }) => {
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

  test('[MVIS-012] 移动端参考图、尺寸、输入和移除操作均可触达', async ({ page, request }, testInfo) => {
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'multi-image-mobile-layout');
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissVisualTutorial(page);
      const reference = solidPngDataUrl(35, 90, 190, 128);
      await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
        name: 'mobile-reference.png',
        mimeType: 'image/png',
        buffer: Buffer.from(reference.split(',')[1], 'base64'),
      });
      await expect(page.getByAltText('参考图')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByPlaceholder('描述要怎么改这张图…')).toBeVisible();
      await expect(page.getByRole('button', { name: '生成', exact: true })).toBeVisible();
      await expect(page.getByText('方形 1:1', { exact: true })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await testInfo.attach('multi-image-mobile-input', { body: await page.screenshot(), contentType: 'image/png' });
      await page.getByRole('button', { name: '移除参考图' }).click();
      await expect(page.getByAltText('参考图')).toBeHidden();
    } finally {
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-mobile-delete` },
      });
      expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
    }
  });

  test('[CORE-004][VIS-002][VIS-004][VIS-005][VIS-007][VIS-010] 文生图真实产物、SSE 恢复、进度布局与清理', async ({ page, request }, testInfo) => {
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

      const streamPromise = page.request.get(`/api/visual-agent/image-gen/runs/${runId}/stream`, {
        headers: authHeaders(token),
        timeout: 180_000,
      });
      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissVisualTutorial(page);
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
      const stream = await streamPromise;
      expect(stream.ok()).toBe(true);
      expect(stream.headers()['content-type'] || '').toContain('text/event-stream');
      expect(await stream.text()).toMatch(/(?:keepalive|progress|completed|done)/i);
      await assertImageArtifact(page, completed.detail);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const generatedImage = page.getByTestId('canvas-image').first();
      await expect(generatedImage, '任务完成并刷新后画布必须恢复真实图片').toBeVisible({ timeout: 30_000 });
      await expect.poll(
        () => generatedImage.evaluate((image) => (image as HTMLImageElement).naturalWidth),
        { message: '画布图片必须完成浏览器解码', timeout: 30_000 },
      ).toBeGreaterThan(0);
      await generatedImage.evaluate((image) => (image as HTMLImageElement).decode());
      await page.waitForTimeout(500);
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

  test('[MVIS-001][MVIS-002][MVIS-008][MVIS-009][MVIS-010][MVIS-011][REG-multi-image-001][REG-multi-image-002] 多图引用真实生成、恢复与清理', async ({ page, request }, testInfo) => {
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
      await dismissVisualTutorial(page);
      const generatedImage = page.getByTestId('canvas-image').first();
      await expect(generatedImage, '多图生成完成后页面必须恢复真实图片').toBeVisible({ timeout: 30_000 });
      await expect.poll(
        () => generatedImage.evaluate((image) => (image as HTMLImageElement).naturalWidth),
        { message: '多图结果必须完成浏览器解码', timeout: 30_000 },
      ).toBeGreaterThan(0);
      await generatedImage.evaluate((image) => (image as HTMLImageElement).decode());
      await page.waitForTimeout(500);
      await expect(page.getByText('参考', { exact: false }).last()).toBeVisible({ timeout: 15_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, '桌面端多图引用、结果和输入区不得造成页面横向裁切').toBeLessThanOrEqual(1);
      expect(await page.locator('textarea:visible, [contenteditable="true"]:visible').count()).toBeGreaterThan(0);
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

  test('[MVIS-003][MVIS-004][MVIS-005][MVIS-006] 多图重排、删除、重复与超限行为明确', async ({ page, request }, testInfo) => {
    test.setTimeout(240_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'multi-image-boundaries');
    const png = Buffer.from(solidPngDataUrl(45, 120, 210, 32).split(',')[1]!, 'base64');
    const file = (name: string) => ({ name, mimeType: 'image/png', buffer: png });
    try {
      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissVisualTutorial(page);
      const picker = page.locator('input[type="file"][accept="image/*"]');
      await picker.setInputFiles([file('a.png'), file('b.png'), file('c.png')]);
      await expect(page.getByTestId('canvas-image')).toHaveCount(3, { timeout: 30_000 });

      await page.locator('[data-tour-id="visual-editor-canvas"]').click({ position: { x: 180, y: 180 } });
      await page.locator('[title="b.png"]').click();
      await page.locator('[title="a.png"]').click({ modifiers: ['Shift'] });
      const chips = page.locator('.image-chip-node');
      await expect(chips).toHaveCount(2);
      const chipLabels = await chips.allTextContents();
      expect(chipLabels[0]).toContain('b.png');
      expect(chipLabels[1]).toContain('a.png');

      await page.getByRole('button', { name: '删除选中' }).click();
      await expect(page.getByText('确认删除选中的 2 项？')).toBeVisible();
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await expect(page.getByTestId('canvas-image')).toHaveCount(1);
      await expect(chips).toHaveCount(0);
      await expect(page.locator('[title="a.png"], [title="b.png"]')).toHaveCount(0);

      await picker.setInputFiles([file('dup1.png'), file('dup2.png')]);
      await expect(page.getByTestId('canvas-image')).toHaveCount(3, { timeout: 30_000 });
      await expect(page.getByText('已把 2 张图片加入画板。你可以选中其中一张作为首帧，或用 @imgN 引用多张图。')).toBeVisible();
      await expect(page.locator('[data-testid="canvas-image"][alt="dup1.png"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="canvas-image"][alt="dup2.png"]')).toHaveCount(1);

      await picker.setInputFiles(Array.from({ length: 21 }, (_, index) => file(`limit-${String(index + 1).padStart(2, '0')}.png`)));
      await expect(page.getByText('一次最多上传 20 张，已保留前 20 张；其余图片未上传，请分批添加')).toBeVisible();
      await expect(page.getByTestId('canvas-image')).toHaveCount(23, { timeout: 60_000 });
      await expect(page.locator('[data-testid="canvas-image"][alt="limit-21.png"]')).toHaveCount(0);
      await expect(page.getByText('同步中', { exact: true })).toHaveCount(0, { timeout: 120_000 });
      await testInfo.attach('multi-image-boundaries', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-boundaries-delete` },
      });
      expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
    }
  });

  test('[MVIS-007] 损坏引用指出具体图片并保留其他输入', async ({ page, request }, testInfo) => {
    test.setTimeout(180_000);
    const token = await loginAndReadToken(page, request, '/visual-agent');
    const { workspace } = await createVisualWorkspace(page, token, 'multi-image-broken-reference');
    let runId = '';
    try {
      const assetResponse = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/assets`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-valid-ref` },
        data: { data: solidPngDataUrl(35, 90, 190), width: 256, height: 256, prompt: '有效参考图' },
      });
      const valid = await readEnvelope<{ asset: { sha256: string; url: string } }>(assetResponse);
      const pools = await readEnvelope<ImageModelPool[]>(
        await page.request.get('/api/visual-agent/image-gen/models/vision', { headers: authHeaders(token) }),
      );
      const pool = pools.find((item) => item.models.some((model) => !/unhealthy|disabled/i.test(model.healthStatus || '')));
      expect(pool, '没有可用的多图视觉逻辑模型').toBeTruthy();
      const prompt = '参考 @img1 和 @img2 生成一张构图测试图';
      const create = await page.request.post(`/api/visual-agent/image-master/workspaces/${workspace.id}/image-gen/runs`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-broken-ref-run` },
        data: {
          prompt,
          userMessageContent: prompt,
          targetKey: `${requiredEnv('STABLE_SMOKE_RUN_ID')}-broken-ref-target`,
          platformId: 'logical-model',
          modelId: pool!.code,
          size: '1024x1024',
          responseFormat: 'url',
          imageRefs: [
            { refId: 1, assetSha256: valid.asset.sha256, url: valid.asset.url, label: '有效参考图', role: 'target' },
            { refId: 2, assetSha256: 'f'.repeat(64), url: '', label: '已损坏参考图', role: 'style' },
          ],
          x: 0,
          y: 0,
          w: 1001,
          h: 1001,
        },
      });
      runId = (await readEnvelope<{ runId: string }>(create)).runId;
      const terminal = await waitForImageRun(page, token, runId);
      expect(terminal.detail.run.status).toBe('Failed');
      const errorMessage = terminal.detail.items[0]?.errorMessage || '';
      expect(errorMessage).toContain('@img2');
      expect(errorMessage).toContain('其他输入已保留');
      expectUserReadable(errorMessage);

      const messages = await page.request.get(`/api/visual-agent/image-master/workspaces/${workspace.id}/messages`, { headers: authHeaders(token) });
      const messageData = (await messages.json() as ApiEnvelope<{
        messages: Array<{ role: string; content: string }>;
      }>).data;
      expect(messageData.messages.some((message) => message.role === 'User' && message.content === prompt)).toBe(true);
      const storedError = messageData.messages.find((message) => message.role === 'Assistant' && message.content.startsWith('[GEN_ERROR]'));
      expect(storedError, '损坏引用失败消息必须持久化').toBeTruthy();
      const storedErrorPayload = JSON.parse(storedError!.content.slice('[GEN_ERROR]'.length)) as { msg: string; prompt: string };
      expect(storedErrorPayload.prompt).toBe(prompt);
      expect(storedErrorPayload.msg).toContain('@img2');
      expect(storedErrorPayload.msg).toContain('其他输入已保留');

      await page.goto(`/visual-agent/${workspace.id}`, { waitUntil: 'domcontentloaded' });
      await dismissVisualTutorial(page);
      await expect(page.getByText(/参考图 @img2 无法使用/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/其他输入已保留/)).toBeVisible();
      await testInfo.attach('multi-image-broken-reference', { body: await page.screenshot(), contentType: 'image/png' });
    } finally {
      const deleted = await page.request.delete(`/api/visual-agent/image-master/workspaces/${workspace.id}`, {
        headers: { ...authHeaders(token), 'Idempotency-Key': `${requiredEnv('STABLE_SMOKE_RUN_ID')}-${workspace.id}-broken-ref-delete` },
      });
      expect((await deleted.json() as ApiEnvelope<{ deleted: boolean }>).data.deleted).toBe(true);
      if (runId) {
        expect((await page.request.get(`/api/visual-agent/image-gen/runs/${runId}`, { headers: authHeaders(token) })).status()).toBe(404);
      }
    }
  });
});
