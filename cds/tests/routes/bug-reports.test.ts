/**
 * /api/bug-reports 路由契约测试。
 *
 * 覆盖四件事：
 *   1. 请求体校验（描述必填、严重程度枚举、附件上限）；
 *   2. 未配置转发时**必须**退化为本地留存并如实回报 degradeReason（不许假装成功）；
 *   3. 配置了转发时走 MAP 缺陷接口（create + submit），凭据只出现在服务端请求头；
 *   4. **body 解析装配与生产一致**：全局 100kb 解析器跳过 /api/bug-reports，
 *      路由自挂大上限解析器，超限时回中文 JSON 413 而不是 HTML。
 *
 * 第 4 条是本文件此前最大的盲区：测试自建 app 时用了 20mb 的解析器，与生产装配
 * （全局默认 100kb）不一致，把「截图附件在生产必然 413」这个洞整个盖住了。
 * 现在 buildApp 逐行复刻生产装配，并额外用源码守卫锁住 server.ts 的跳过名单。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildMapDefectBody,
  createBugReportsRouter,
  BUG_REPORT_MAX_RECORDS,
  forwardToMap,
  normalizeBugReport,
  resolveForwardConfig,
  type FetchLike,
} from '../../src/routes/bug-reports.js';

const SERVER_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.ts'),
  'utf-8',
);

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'cds',
    title: '',
    description: '分支列表页刷新后卡片错位',
    severity: 'major',
    content: '分支列表页刷新后卡片错位\n\n## 环境信息（自动采集）\n- 页面地址：https://cds.example.com/branch-list',
    environment: { url: 'https://cds.example.com/branch-list', theme: 'dark' },
    attachments: [],
    ...overrides,
  };
}

async function request(
  app: express.Express,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; text: string; contentType: string }> {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${url}`, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text, contentType: res.headers.get('content-type') || '' };
  } finally {
    server.close();
  }
}

describe('normalizeBugReport', () => {
  it('描述为空时拒绝', () => {
    expect(normalizeBugReport({ description: '  ', severity: 'major' })).toEqual({ error: '请填写问题描述' });
  });

  it('严重程度非法时拒绝', () => {
    expect(normalizeBugReport({ description: 'x', severity: 'blocker' })).toEqual({ error: '严重程度取值非法' });
  });

  it('附件超过数量上限时拒绝', () => {
    const attachments = Array.from({ length: 5 }, (_, i) => ({
      name: `s${i}.png`,
      mimeType: 'image/png',
      size: 10,
      dataBase64: 'AAAA',
    }));
    expect(normalizeBugReport({ description: 'x', severity: 'major', attachments })).toEqual({ error: '附件最多 4 个' });
  });

  it('单个附件超过 5 MB 时拒绝', () => {
    const huge = 'A'.repeat(8 * 1024 * 1024);
    const result = normalizeBugReport({
      description: 'x',
      severity: 'major',
      attachments: [{ name: 'big.png', mimeType: 'image/png', size: 1, dataBase64: huge }],
    });
    expect(result).toEqual({ error: '单个附件超过 5 MB' });
  });

  it('未给标题时从描述首行推导', () => {
    const result = normalizeBugReport({ description: '首行标题\n第二行', severity: 'minor' });
    expect('report' in result && result.report.title).toBe('首行标题');
  });
});

describe('resolveForwardConfig', () => {
  it('两项凭据齐全才算配置好', () => {
    expect(resolveForwardConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveForwardConfig({ CDS_BUG_REPORT_MAP_BASE_URL: 'https://map.example.com' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveForwardConfig({ CDS_BUG_REPORT_MAP_TOKEN: 'tok' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveForwardConfig({
      CDS_BUG_REPORT_MAP_BASE_URL: 'https://map.example.com/',
      CDS_BUG_REPORT_MAP_TOKEN: 'tok',
      CDS_BUG_REPORT_MAP_ASSIGNEE: 'u1',
    } as NodeJS.ProcessEnv)).toEqual({ baseUrl: 'https://map.example.com', token: 'tok', assigneeUserId: 'u1' });
  });
});

describe('CDS 系统设置中的缺陷转发接入', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bug-integration-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function buildIntegrationApp(options: {
    environment?: ReturnType<typeof resolveForwardConfig>;
    suggestedBaseUrl?: string;
    fetchImpl?: FetchLike;
    validConnectionToken?: string;
  } = {}) {
    let stored: { baseUrl: string; token: string; assigneeUserId?: string; updatedAt?: string } | null = null;
    const app = express();
    app.use(express.json());
    app.use('/api', createBugReportsRouter({
      getDataDir: () => dataDir,
      readStoredForwardConfig: () => stored,
      readEnvironmentForwardConfig: () => options.environment ?? null,
      writeStoredForwardConfig: (input) => {
        stored = { ...input, updatedAt: '2026-07-29T00:00:00.000Z' };
        return stored;
      },
      clearStoredForwardConfig: () => {
        const existed = stored !== null;
        stored = null;
        return existed;
      },
      getSuggestedMapBaseUrl: () => options.suggestedBaseUrl ?? null,
      authenticateMapConnectionToken: (token) => token === options.validConnectionToken
        ? ({
            id: 'connection-1',
            name: 'MAP',
            partnerKind: 'map',
            status: 'active',
            scopes: [],
            partnerBaseUrl: options.suggestedBaseUrl ?? 'https://map.example.com',
            createdAt: '2026-07-30T00:00:00.000Z',
          })
        : null,
      isSecretStorageEncrypted: () => true,
      fetchImpl: options.fetchImpl,
    }));
    return app;
  }

  it('把 MAP 系统互联地址作为建议值，但不把“已配对”误报成“缺陷转发已配置”', async () => {
    const app = buildIntegrationApp({ suggestedBaseUrl: 'https://map.example.com' });
    const res = await request(app, 'GET', '/api/cds-system/integrations/bug-report');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: false,
      source: 'none',
      suggestedBaseUrl: 'https://map.example.com',
      tokenConfigured: false,
      secretStorage: 'encrypted',
      authorizationUrl: expect.stringContaining('/infra-services?authorizeCds='),
    });
  });

  it('MAP 用长期连接凭据从服务端回授永久缺陷授权，且 Token 永不回显', async () => {
    const app = buildIntegrationApp({
      suggestedBaseUrl: 'https://map.example.com',
      validConnectionToken: 'ct-valid',
    });
    const res = await request(
      app,
      'POST',
      '/api/cds-system/integrations/bug-report/authorize',
      { baseUrl: 'https://map.example.com', token: 'sk-ak-permanent', assigneeUserId: 'user-1' },
      { Authorization: 'Bearer ct-valid' },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      source: 'system-settings',
      baseUrl: 'https://map.example.com',
      tokenConfigured: true,
      assigneeUserId: 'user-1',
    });
    expect(JSON.stringify(res.body)).not.toContain('sk-ak-permanent');
  });

  it('拒绝无效长期连接凭据和与连接不一致的 MAP 地址', async () => {
    const app = buildIntegrationApp({
      suggestedBaseUrl: 'https://map.example.com',
      validConnectionToken: 'ct-valid',
    });
    const unauthorized = await request(
      app,
      'POST',
      '/api/cds-system/integrations/bug-report/authorize',
      { baseUrl: 'https://map.example.com', token: 'secret' },
      { Authorization: 'Bearer ct-wrong' },
    );
    expect(unauthorized.status).toBe(401);

    const mismatched = await request(
      app,
      'POST',
      '/api/cds-system/integrations/bug-report/authorize',
      { baseUrl: 'https://other.example.com', token: 'secret' },
      { Authorization: 'Bearer ct-valid' },
    );
    expect(mismatched.status).toBe(403);
  });

  it('保存、验证、清除走同一套系统接入配置，且 Token 永不回显', async () => {
    const hits: Array<{ url: string; method?: string; authorization?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      hits.push({ url, method: init?.method, authorization: init?.headers?.Authorization });
      return { ok: true, status: 200, text: async () => '{"success":true}' };
    };
    const app = buildIntegrationApp({ fetchImpl });

    const saved = await request(app, 'PUT', '/api/cds-system/integrations/bug-report', {
      baseUrl: 'https://map.example.com/',
      token: 'sk-ak-secret',
      assigneeUserId: 'user-1',
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      configured: true,
      source: 'system-settings',
      baseUrl: 'https://map.example.com',
      tokenConfigured: true,
      assigneeUserId: 'user-1',
    });
    expect(JSON.stringify(saved.body)).not.toContain('sk-ak-secret');

    const tested = await request(app, 'POST', '/api/cds-system/integrations/bug-report/test');
    expect(tested.status).toBe(200);
    expect(tested.body).toEqual({ ok: true, message: 'MAP 缺陷接口连接正常，Token 权限可用' });
    expect(hits).toEqual([{
      url: 'https://map.example.com/api/defect-agent/defects?page=1&pageSize=1',
      method: 'GET',
      authorization: 'Bearer sk-ak-secret',
    }]);

    const cleared = await request(app, 'DELETE', '/api/cds-system/integrations/bug-report');
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ configured: false, source: 'none', tokenConfigured: false });
  });

  it('拒绝把 API 路径当作 MAP 站点根地址', async () => {
    const app = buildIntegrationApp();
    const res = await request(app, 'PUT', '/api/cds-system/integrations/bug-report', {
      baseUrl: 'https://map.example.com/api',
      token: 'sk-ak-secret',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('站点根地址');
  });

  it('未保存系统配置时继续兼容环境变量，并明确标识来源', async () => {
    const app = buildIntegrationApp({
      environment: { baseUrl: 'https://legacy-map.example.com', token: 'legacy-token' },
    });
    const res = await request(app, 'GET', '/api/cds-system/integrations/bug-report');
    expect(res.body).toMatchObject({
      configured: true,
      source: 'environment',
      baseUrl: 'https://legacy-map.example.com',
      tokenConfigured: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('legacy-token');
  });

  it('项目级 Key 不能读取或修改 CDS 系统级外部接入', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { cdsProjectKey?: { projectId: string } }).cdsProjectKey = { projectId: 'project-a' };
      next();
    });
    app.use('/api', createBugReportsRouter({
      getDataDir: () => dataDir,
      writeStoredForwardConfig: () => undefined,
      clearStoredForwardConfig: () => false,
    }));

    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { baseUrl: 'https://map.example.com', token: 'secret' }],
      ['POST', undefined],
      ['DELETE', undefined],
    ] as const) {
      const suffix = method === 'POST' ? '/test' : '';
      const res = await request(app, method, `/api/cds-system/integrations/bug-report${suffix}`, body);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('系统级配置');
    }
  });
});

describe('buildMapDefectBody', () => {
  it('组装 MAP 缺陷接口请求体，配置了指派人才带 assigneeUserId', () => {
    const normalized = normalizeBugReport(validBody());
    if (!('report' in normalized)) throw new Error('normalize failed');
    expect(buildMapDefectBody(normalized.report, { baseUrl: 'https://map', token: 't' })).toEqual({
      title: '分支列表页刷新后卡片错位',
      content: normalized.report.content,
      severity: 'major',
    });
    expect(buildMapDefectBody(normalized.report, { baseUrl: 'https://map', token: 't', assigneeUserId: 'u1' }))
      .toMatchObject({ assigneeUserId: 'u1' });
  });
});

describe('forwardToMap', () => {
  it('先 create 再 submit，凭据放在服务端请求头', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: { defect: { id: 'd1', defectNo: 'BUG-7' } } }),
      };
    };
    const normalized = normalizeBugReport(validBody());
    if (!('report' in normalized)) throw new Error('normalize failed');
    const result = await forwardToMap(normalized.report, { baseUrl: 'https://map', token: 'secret' }, fetchImpl);
    expect(result).toEqual({ ok: true, reference: 'BUG-7' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://map/api/defect-agent/defects',
      'https://map/api/defect-agent/defects/d1/submit',
    ]);
    expect(calls[0]?.headers?.Authorization).toBe('Bearer secret');
  });

  it('create 与 submit 共用一份 10s 总预算，不是各给 10s', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      signals.push(init?.signal);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: { defect: { id: 'd1', defectNo: 'BUG-7' } } }),
      };
    };
    const normalized = normalizeBugReport(validBody());
    if (!('report' in normalized)) throw new Error('normalize failed');
    await forwardToMap(normalized.report, { baseUrl: 'https://map', token: 'secret' }, fetchImpl);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    // 同一个 AbortSignal 实例 = 同一份总预算；两次各自新建就意味着最长可等 20s，
    // 与前端「超过 10 秒会转为本地留存」的文案不符。
    expect(signals[1]).toBe(signals[0]);
  });

  it('创建失败时返回可读原因', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, text: async () => '' });
    const normalized = normalizeBugReport(validBody());
    if (!('report' in normalized)) throw new Error('normalize failed');
    const result = await forwardToMap(normalized.report, { baseUrl: 'https://map', token: 'bad' }, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('401');
  });
});

describe('POST /api/bug-reports', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bug-reports-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * 逐行复刻 server.ts 的 body 解析装配：
   *   - 全局 express.json() 用**默认** 100kb 上限（生产就是这样）；
   *   - 通过 skipGlobalParser 控制是否把 /api/bug-reports 排除在全局解析器之外，
   *     测试可以把它关掉来验证「删掉跳过名单就红」。
   * 禁止在这里换成大上限解析器——那会重新盖住生产上的 413。
   */
  function buildApp(options: {
    readForwardConfig?: () => ReturnType<typeof resolveForwardConfig>;
    fetchImpl?: FetchLike;
    bodyLimit?: string;
    skipGlobalParser?: boolean;
  }): express.Express {
    const app = express();
    const globalJsonParser = express.json();
    const skipGlobalParser = options.skipGlobalParser !== false;
    app.use((req, res, next) => {
      if (skipGlobalParser && (req.path === '/api/bug-reports' || req.path.startsWith('/api/bug-reports/'))) {
        return next();
      }
      return globalJsonParser(req, res, next);
    });
    app.use('/api', createBugReportsRouter({
      getDataDir: () => dataDir,
      readForwardConfig: options.readForwardConfig ?? (() => null),
      fetchImpl: options.fetchImpl,
      resolveReporter: () => 'tester',
      bodyLimit: options.bodyLimit,
    }));
    return app;
  }

  /** 造一个约 sizeKb KB 的 base64 截图附件。 */
  function fakeScreenshot(sizeKb: number): Record<string, unknown> {
    const bytes = Buffer.alloc(sizeKb * 1024, 7);
    return {
      name: 'shot.png',
      mimeType: 'image/png',
      size: bytes.length,
      dataBase64: bytes.toString('base64'),
    };
  }

  it('未配置转发时退化为本地留存，并如实回报未同步', async () => {
    const app = buildApp({});
    const res = await request(app, 'POST', '/api/bug-reports', validBody());
    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('local');
    expect(res.body.degradeReason).toContain('未配置缺陷系统转发');

    const records = fs.readFileSync(path.join(dataDir, 'bug-reports', 'records.jsonl'), 'utf-8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0].title).toBe('分支列表页刷新后卡片错位');
    expect(records[0].reporter).toBe('tester');
    expect(records[0].environment.url).toBe('https://cds.example.com/branch-list');
  });

  it('配置了转发且成功时 delivery=forwarded 并带缺陷编号', async () => {
    const app = buildApp({
      readForwardConfig: () => ({ baseUrl: 'https://map', token: 'secret' }),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: { defect: { id: 'd9', defectNo: 'BUG-9' } } }),
      }),
    });
    const res = await request(app, 'POST', '/api/bug-reports', validBody());
    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('forwarded');
    expect(res.body.reference).toBe('BUG-9');
  });

  it('转发失败时退化为本地留存并带上失败原因', async () => {
    const app = buildApp({
      readForwardConfig: () => ({ baseUrl: 'https://map', token: 'secret' }),
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const res = await request(app, 'POST', '/api/bug-reports', validBody());
    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('local');
    expect(res.body.degradeReason).toContain('无法连接缺陷系统');
  });

  it('截图附件落盘到 attachments 目录', async () => {
    const app = buildApp({});
    const res = await request(app, 'POST', '/api/bug-reports', validBody({
      attachments: [{ name: 'shot.png', mimeType: 'image/png', size: 3, dataBase64: Buffer.from('png').toString('base64') }],
    }));
    expect(res.status).toBe(201);
    const files = fs.readdirSync(path.join(dataDir, 'bug-reports', 'attachments'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.png$/);
  });

  it('描述为空时返回 400 且不落盘', async () => {
    const app = buildApp({});
    const res = await request(app, 'POST', '/api/bug-reports', validBody({ description: '   ' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('请填写问题描述');
    expect(fs.existsSync(path.join(dataDir, 'bug-reports', 'records.jsonl'))).toBe(false);
  });

  it('1MB 截图附件能在生产同款装配下成功落地（全局 100kb 解析器必须跳过本路由）', async () => {
    const app = buildApp({});
    const res = await request(app, 'POST', '/api/bug-reports', validBody({
      attachments: [fakeScreenshot(1024)],
    }));
    expect(res.status).toBe(201);
    expect(res.body.delivery).toBe('local');
    const files = fs.readdirSync(path.join(dataDir, 'bug-reports', 'attachments'));
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(dataDir, 'bug-reports', 'attachments', files[0]!)).size)
      .toBeGreaterThan(1000 * 1024);
  });

  it('把 /api/bug-reports 移出全局解析器跳过名单后，1MB 附件会被 413 掉（红绿闭环对照）', async () => {
    const app = buildApp({ skipGlobalParser: false });
    const res = await request(app, 'POST', '/api/bug-reports', validBody({
      attachments: [fakeScreenshot(1024)],
    }));
    expect(res.status).toBe(413);
  });

  it('server.ts 的全局解析器跳过名单必须包含 /api/bug-reports', () => {
    expect(SERVER_SOURCE).toMatch(
      /req\.path === '\/api\/bug-reports' \|\| req\.path\.startsWith\('\/api\/bug-reports\/'\)/,
    );
  });

  it('超过路由自身上限时返回可读的中文 413 JSON（不是 HTML）', async () => {
    const app = buildApp({ bodyLimit: '200kb' });
    const res = await request(app, 'POST', '/api/bug-reports', validBody({
      attachments: [fakeScreenshot(512)],
    }));
    expect(res.status).toBe(413);
    expect(res.contentType).toContain('application/json');
    expect(res.text.startsWith('<')).toBe(false);
    expect(res.body.error).toBe('提交内容超出上限，请减少或压缩截图后重试');
  });

  it('GET 列表按时间倒序返回并透出是否配置转发', async () => {
    const app = buildApp({});
    await request(app, 'POST', '/api/bug-reports', validBody({ description: '第一条' }));
    await request(app, 'POST', '/api/bug-reports', validBody({ description: '第二条' }));
    const res = await request(app, 'GET', '/api/bug-reports');
    expect(res.status).toBe(200);
    expect(res.body.forwardConfigured).toBe(false);
    expect(res.body.items.map((item: { title: string }) => item.title)).toEqual(['第二条', '第一条']);
  });
});

describe('Codex PR #1273 复审修复', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bugreport-review-'));

  /** 带 cdsProjectKey 盖章的 app（模拟项目级 cdsp_ key 走全局门后的状态）。 */
  function buildScopedApp(projectKey?: { projectId: string; keyId: string }) {
    const app = express();
    app.use((req, _res, next) => {
      if (projectKey) (req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey = projectKey;
      next();
    });
    app.use('/api', createBugReportsRouter({
      getDataDir: () => dataDir,
      readForwardConfig: () => null,
      resolveReporter: () => 'tester',
    }));
    return app;
  }

  it('P1：项目级 Key 读缺陷台账必须 403（跨项目读取正文属数据泄漏）', async () => {
    const res = await request(buildScopedApp({ projectId: 'proj-a', keyId: 'k1' }), 'GET', '/api/bug-reports');
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain('系统级');
  });

  it('P1：管理员 / 全局凭据（无 cdsProjectKey）照常可读', async () => {
    const res = await request(buildScopedApp(undefined), 'GET', '/api/bug-reports');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('P2：转发时必须在 submit 之前把截图上传到缺陷系统', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/defects')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { defect: { id: 'd1', defectNo: 'BUG-1' } } }) };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    }) as unknown as FetchLike;

    const result = await forwardToMap(
      {
        title: 't', description: 'd', severity: 'minor', environment: {}, reporter: 'tester',
        attachments: [{ name: 'a.png', mimeType: 'image/png', size: 3, dataBase64: Buffer.from('abc').toString('base64') }],
      } as Parameters<typeof forwardToMap>[0],
      { baseUrl: 'https://map.example', token: 'tok' } as Parameters<typeof forwardToMap>[1],
      fetchImpl,
    );

    expect(result.ok).toBe(true);
    const attachIdx = calls.findIndex((u) => u.includes('/attachments'));
    const submitIdx = calls.findIndex((u) => u.includes('/submit'));
    expect(attachIdx).toBeGreaterThan(-1);
    expect(submitIdx).toBeGreaterThan(attachIdx);
  });

  it('P2：附件上传失败时不得谎报完全成功，要如实回传部分失败', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith('/defects')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { defect: { id: 'd1' } } }) };
      }
      if (String(url).includes('/attachments')) return { ok: false, status: 413, text: async () => '' };
      return { ok: true, status: 200, text: async () => '{}' };
    }) as unknown as FetchLike;

    const result = await forwardToMap(
      {
        title: 't', description: 'd', severity: 'minor', environment: {}, reporter: 'tester',
        attachments: [{ name: 'a.png', mimeType: 'image/png', size: 3, dataBase64: Buffer.from('abc').toString('base64') }],
      } as Parameters<typeof forwardToMap>[0],
      { baseUrl: 'https://map.example', token: 'tok' } as Parameters<typeof forwardToMap>[1],
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(String(result.partialReason)).toContain('上传失败');
  });
});

describe('MAP submit 非 2xx 必须如实告知（Codex PR #1273 P2）', () => {
  it('create 成功但 submit 返 500 时，回传「可能仍是草稿态」而不是静默报成功', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith('/defects')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { defect: { id: 'd1' } } }) };
      }
      if (String(url).includes('/submit')) return { ok: false, status: 500, text: async () => '' };
      return { ok: true, status: 200, text: async () => '{}' };
    }) as unknown as FetchLike;

    const result = await forwardToMap(
      { title: 't', description: 'd', severity: 'minor', environment: {}, reporter: 'tester', attachments: [] } as Parameters<typeof forwardToMap>[0],
      { baseUrl: 'https://map.example', token: 'tok' } as Parameters<typeof forwardToMap>[1],
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    expect(String(result.partialReason)).toContain('草稿态');
    expect(String(result.partialReason)).toContain('500');
  });
});

describe('本地留存必须有保留策略（Codex PR #1273 P1）', () => {
  it('超过条数上限时从最旧的整条丢弃，附件文件一并回收', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bugreport-prune-'));
    const app = express();
    app.use('/api', createBugReportsRouter({
      getDataDir: () => dir,
      readForwardConfig: () => null,
      resolveReporter: () => 'tester',
    }));

    const total = BUG_REPORT_MAX_RECORDS + 5;
    for (let i = 0; i < total; i++) {
      const res = await request(app, 'POST', '/api/bug-reports', {
        description: `第 ${i} 条`, severity: 'trivial',
      });
      expect(res.status).toBe(201);
    }
    const listed = await request(app, 'GET', '/api/bug-reports?limit=1000');
    expect(listed.body.items.length).toBeLessThanOrEqual(BUG_REPORT_MAX_RECORDS);

    const lines = fs.readFileSync(path.join(dir, 'bug-reports', 'records.jsonl'), 'utf-8')
      .split('\n').filter(Boolean);
    expect(lines.length).toBe(BUG_REPORT_MAX_RECORDS);
    // 最新那条必须还在（丢的是最旧的）
    expect(lines[lines.length - 1]).toContain(`第 ${total - 1} 条`);
  });
});

describe('保留策略按项目分桶（Codex PR #1273 P1）', () => {
  it('吵闹项目提交超限不得挤掉别的项目的本地留存', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bugreport-bucket-'));
    const appFor = (projectId?: string) => {
      const a = express();
      a.use((req, _res, next) => {
        if (projectId) (req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey = { projectId, keyId: 'k' };
        next();
      });
      a.use('/api', createBugReportsRouter({
        getDataDir: () => dir, readForwardConfig: () => null, resolveReporter: () => 'tester',
      }));
      return a;
    };

    // 安静项目先提交 2 条
    for (let i = 0; i < 2; i++) {
      await request(appFor('quiet'), 'POST', '/api/bug-reports', { description: `quiet-${i}`, severity: 'trivial' });
    }
    // 吵闹项目提交远超上限
    for (let i = 0; i < BUG_REPORT_MAX_RECORDS + 20; i++) {
      await request(appFor('noisy'), 'POST', '/api/bug-reports', { description: `noisy-${i}`, severity: 'trivial' });
    }

    const raw = fs.readFileSync(path.join(dir, 'bug-reports', 'records.jsonl'), 'utf-8');
    expect(raw).toContain('quiet-0');
    expect(raw).toContain('quiet-1');
    const noisyKept = raw.split('\n').filter((l) => l.includes('"noisy"')).length;
    expect(noisyKept).toBeLessThanOrEqual(BUG_REPORT_MAX_RECORDS);
  });
});
