import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type Request } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  createCdsSystemSealedStorageRouter,
  isGlobalHumanAdminRequest,
} from '../../src/routes/cds-system-sealed-storage.js';
import type { ServerEventRecord } from '../../src/services/server-event-log-store.js';

const GENERATED_SECRET = Buffer.alloc(32, 0x5a);
const CLIENT_CANARY = 'client-provided-canary-must-not-survive';

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('CDS 系统级密封存储初始化', () => {
  let dir: string;
  let envFile: string;
  let env: NodeJS.ProcessEnv;
  let server: http.Server;
  let auditRecords: Array<Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string }>;
  let requestAudit: string[];
  let randomCalls: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sealed-storage-'));
    envFile = path.join(dir, '.cds.env');
    fs.writeFileSync(envFile, 'export CDS_EXISTING="keep-me"\n', { mode: 0o644 });
    env = {};
    auditRecords = [];
    requestAudit = [];
    randomCalls = 0;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.headers.cookie === 'cds_token=human-cookie-token') {
        (req as Request & { _cdsBasicHumanAuth?: boolean })._cdsBasicHumanAuth = true;
      }
      if (req.headers['x-test-project-key'] === '1') {
        (req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey = { projectId: 'p', keyId: 'k' };
      }
      if (req.headers['x-test-global-key'] === '1') {
        (req as unknown as { cdsAccess?: unknown }).cdsAccess = { keyId: 'g', access: { projects: 'all' } };
      }
      next();
    });
    // Mirror the production HTTP logger's route-controlled omission contract.
    app.use((req, res, next) => {
      res.on('finish', () => {
        const suppressed = Boolean(
          (res.locals as { cdsSuppressRequestBodyLog?: boolean }).cdsSuppressRequestBodyLog,
        );
        requestAudit.push(suppressed ? '[cds request body omitted]' : JSON.stringify(req.body));
      });
      next();
    });
    app.use('/api', createCdsSystemSealedStorageRouter({
      authMode: 'basic',
      env,
      envFilePath: () => envFile,
      randomBytes: (size) => {
        expect(size).toBe(32);
        randomCalls++;
        return Buffer.from(GENERATED_SECRET);
      },
      audit: {
        record: (record) => { auditRecords.push(record); },
      },
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  });

  afterEach(async () => {
    server.close();
    server.closeAllConnections();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const HUMAN = {
    Cookie: 'cds_token=human-cookie-token',
    'X-CDS-Human-Action': 'initialize-sealed-storage',
  };

  it('项目、全局及静态机器凭据都不能读取或初始化', async () => {
    for (const headers of [
      { 'x-test-project-key': '1' },
      { 'x-test-global-key': '1' },
      { 'x-ai-access-key': 'legacy-global-ai-key' },
      { 'x-cds-token': 'machine-header-token' },
    ]) {
      const read = await request(server, 'GET', '/api/cds-system/sealed-storage', undefined, headers);
      const write = await request(server, 'POST', '/api/cds-system/sealed-storage/initialize', undefined, headers);
      expect(read.status).toBe(403);
      expect(write.status).toBe(403);
    }
    expect(randomCalls).toBe(0);
    expect(env.CDS_SECRET_KEY).toBeUndefined();
  });

  it('人工管理员初始化后只返回四个安全字段并立即热生效', async () => {
    const response = await request(
      server,
      'POST',
      '/api/cds-system/sealed-storage/initialize',
      undefined,
      HUMAN,
    );

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      'enabled',
      'fingerprint',
      'persisted',
      'restartRequired',
    ]);
    expect(response.body).toMatchObject({ enabled: true, persisted: true, restartRequired: false });
    expect(response.body.fingerprint).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(JSON.stringify(response.body)).not.toContain(GENERATED_SECRET.toString('hex'));
    expect(env.CDS_SECRET_KEY).toBe(GENERATED_SECRET.toString('hex'));
    expect(randomCalls).toBe(1);

    const written = fs.readFileSync(envFile, 'utf8');
    expect(written).toContain('CDS_EXISTING="keep-me"');
    expect(written).toContain(`CDS_SECRET_KEY="${GENERATED_SECRET.toString('hex')}"`);
    if (process.platform !== 'win32') expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it('重复初始化不覆盖已有 key，也不会再次生成', async () => {
    const first = await request(server, 'POST', '/api/cds-system/sealed-storage/initialize', undefined, HUMAN);
    const firstFile = fs.readFileSync(envFile, 'utf8');
    const second = await request(server, 'POST', '/api/cds-system/sealed-storage/initialize', undefined, HUMAN);

    expect(second.status).toBe(200);
    expect(second.body.fingerprint).toBe(first.body.fingerprint);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(firstFile);
    expect(randomCalls).toBe(1);
  });

  it('模拟进程重启时从已持久化文件恢复同一 key', async () => {
    const first = await request(server, 'POST', '/api/cds-system/sealed-storage/initialize', undefined, HUMAN);
    const restartedEnv: NodeJS.ProcessEnv = {};
    const restartedApp = express();
    restartedApp.use(express.json());
    restartedApp.use((req, _res, next) => {
      if (req.headers.cookie === 'cds_token=human-cookie-token') {
        (req as Request & { _cdsBasicHumanAuth?: boolean })._cdsBasicHumanAuth = true;
      }
      next();
    });
    restartedApp.use('/api', createCdsSystemSealedStorageRouter({
      authMode: 'basic',
      env: restartedEnv,
      envFilePath: () => envFile,
      randomBytes: () => { throw new Error('已有密钥时不应生成新密钥'); },
    }));
    const restartedServer = restartedApp.listen(0);
    await new Promise<void>((resolve) => restartedServer.once('listening', resolve));
    try {
      const restored = await request(
        restartedServer,
        'POST',
        '/api/cds-system/sealed-storage/initialize',
        undefined,
        HUMAN,
      );
      expect(restored.status).toBe(200);
      expect(restored.body.fingerprint).toBe(first.body.fingerprint);
      expect(restartedEnv.CDS_SECRET_KEY).toBe(GENERATED_SECRET.toString('hex'));
      expect(fs.readFileSync(envFile, 'utf8')).toContain(GENERATED_SECRET.toString('hex'));
    } finally {
      restartedServer.close();
      restartedServer.closeAllConnections();
    }
  });

  it('客户端传入任意参数都拒绝，且 canary 不进入响应、审计或请求日志', async () => {
    const response = await request(
      server,
      'POST',
      '/api/cds-system/sealed-storage/initialize',
      { value: CLIENT_CANARY },
      HUMAN,
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(CLIENT_CANARY);
    expect(JSON.stringify(auditRecords)).not.toContain(CLIENT_CANARY);
    expect(requestAudit.at(-1)).toBe('[cds request body omitted]');
    expect(JSON.stringify(requestAudit)).not.toContain(CLIENT_CANARY);
    expect(env.CDS_SECRET_KEY).toBeUndefined();
    expect(randomCalls).toBe(0);
  });

  it('审计只记录状态、指纹和结果，不记录生成值', async () => {
    await request(server, 'POST', '/api/cds-system/sealed-storage/initialize', undefined, HUMAN);
    expect(auditRecords).toHaveLength(1);
    const serialized = JSON.stringify(auditRecords[0]);
    expect(serialized).toContain('sealed-storage.initialize');
    expect(serialized).toContain('sha256:');
    expect(serialized).not.toContain(GENERATED_SECRET.toString('hex'));
    expect(serialized).not.toContain(CLIENT_CANARY);
  });

  it('拒绝缺少人工动作头的 cookie-only CSRF 请求', async () => {
    const response = await request(
      server,
      'POST',
      '/api/cds-system/sealed-storage/initialize',
      undefined,
      { Cookie: 'cds_token=human-cookie-token' },
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('human_confirmation_required');
    expect(env.CDS_SECRET_KEY).toBeUndefined();
  });

  it('拒绝 query 与非 JSON 传输正文而不初始化', async () => {
    const query = await request(
      server,
      'POST',
      `/api/cds-system/sealed-storage/initialize?value=${encodeURIComponent(CLIENT_CANARY)}`,
      undefined,
      HUMAN,
    );
    const text = await request(
      server,
      'POST',
      '/api/cds-system/sealed-storage/initialize',
      CLIENT_CANARY,
      { ...HUMAN, 'Content-Type': 'text/plain' },
    );
    expect(query.status).toBe(400);
    expect(text.status).toBe(400);
    expect(JSON.stringify(query.body)).not.toContain(CLIENT_CANARY);
    expect(JSON.stringify(text.body)).not.toContain(CLIENT_CANARY);
    expect(env.CDS_SECRET_KEY).toBeUndefined();
  });
});

describe('全局人工管理员判定', () => {
  it('basic 模式只认独立人工 cookie，机器 token 改放 Cookie 也不能重放', () => {
    const cookieReq = { headers: {}, _cdsBasicHumanAuth: true } as unknown as Request;
    const ssoReq = { headers: {}, _cdsCookieAuth: true } as unknown as Request;
    const replayReq = { headers: { cookie: 'cds_token=machine-token' } } as Request;
    const headerReq = { headers: { 'x-cds-token': 'machine-token' } } as unknown as Request;
    const deps = { authMode: 'basic' };
    expect(isGlobalHumanAdminRequest(cookieReq, deps)).toBe(true);
    expect(isGlobalHumanAdminRequest(ssoReq, deps)).toBe(false);
    expect(isGlobalHumanAdminRequest(replayReq, deps)).toBe(false);
    expect(isGlobalHumanAdminRequest(headerReq, deps)).toBe(false);
  });

  it('github 模式只认带会话的 system owner，拒绝普通用户与 SSO', () => {
    const owner = {
      headers: {}, cdsSession: { id: 'session' },
      cdsUser: { isSystemOwner: true, authProvider: 'github' },
    } as unknown as Request;
    const ordinary = {
      headers: {}, cdsSession: { id: 'session' },
      cdsUser: { isSystemOwner: false, authProvider: 'github' },
    } as unknown as Request;
    const sso = {
      headers: {}, cdsSession: { id: 'session' },
      cdsUser: { isSystemOwner: true, authProvider: 'sso' },
    } as unknown as Request;
    expect(isGlobalHumanAdminRequest(owner, { authMode: 'github' })).toBe(true);
    expect(isGlobalHumanAdminRequest(ordinary, { authMode: 'github' })).toBe(false);
    expect(isGlobalHumanAdminRequest(sso, { authMode: 'github' })).toBe(false);
  });
});

describe('server 接线守卫', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/server.ts'), 'utf8');

  it('端点复用启动加载器的环境文件 SSOT，并登记两条中文 API label', () => {
    expect(source).toContain('envFilePath: defaultEnvFilePath');
    expect(source).not.toContain("envFilePath: () => path.join(deps.config.repoRoot, 'cds', '.cds.env')");
    expect(source).toContain("'GET /cds-system/sealed-storage': '查询密封存储'");
    expect(source).toContain("'POST /cds-system/sealed-storage/initialize': '初始化密封存储'");
    expect(source).toContain('createCdsSystemSealedStorageRouter({');
  });

  it('HTTP 日志遵守路由设置的请求体抑制标记', () => {
    expect(source).toContain('cdsSuppressRequestBodyLog');
    expect(source).toContain('cdsSuppressActivity');
    expect(source).toContain('requestHeadersForLogs(req, res)');
    expect(source).toContain('selectRequestBodyForHttpLog(');
  });
});
