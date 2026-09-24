import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInfraCredentialRotationRouter } from '../../src/routes/infra-credential-rotation.js';
import { assertProjectAccess } from '../../src/routes/projects.js';
import type { InfraService } from '../../src/types.js';

async function request(server: http.Server, method: string, pathName: string, headers: Record<string, string> = {}) {
  const address = server.address() as { port: number };
  return await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: address.port, method, path: pathName, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode || 0, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('共享凭据轮换路由', () => {
  let server: http.Server;
  const infra: InfraService = {
    id: 'mongodb', projectId: 'project-a', name: 'MongoDB', dockerImage: 'mongo:7',
    containerPort: 27017, hostPort: 17017, containerName: 'cds-mongodb', status: 'running',
    volumes: [], env: {}, createdAt: '2026-09-06T00:00:00.000Z',
  };
  const execute = vi.fn(async () => ({
    id: 'icr-1', idempotencyKey: 'request-1234', projectId: 'project-a', serviceId: 'mongodb',
    runtime: 'mongodb', stage: 'verified_after_revoke', previousFingerprint: '1'.repeat(16),
    nextFingerprint: '2'.repeat(16), consumerIds: ['branch/api'], startedAt: 'x', updatedAt: 'x',
    finishedAt: 'x', rollback: 'not-required', events: [],
  }));

  beforeEach(async () => {
    execute.mockClear();
    const app = express();
    app.use((req, _res, next) => {
      if (req.headers['x-project'] === 'b') (req as any).cdsProjectKey = { projectId: 'project-b', keyId: 'b' };
      if (req.headers['x-project'] === 'a') (req as any).cdsProjectKey = { projectId: 'project-a', keyId: 'a' };
      next();
    });
    app.use('/api', createInfraCredentialRotationRouter({
      stateService: { getInfraServiceForProjectAndId: (projectId: string, id: string) => projectId === 'project-a' && id === 'mongodb' ? infra : undefined } as never,
      rotationService: { execute } as never,
      assertProjectAccess: assertProjectAccess as never,
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  it('项目 Key 不能跨项目触发轮换', async () => {
    const response = await request(server, 'POST', '/api/projects/project-a/infra/mongodb/credential-rotation', {
      'X-Project': 'b', 'Idempotency-Key': 'request-1234', 'X-CDS-Confirm-Service': 'mongodb',
    });
    expect(response.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('同项目机器 Key 也不能执行高危凭据撤销', async () => {
    const response = await request(server, 'POST', '/api/projects/project-a/infra/mongodb/credential-rotation', {
      'X-Project': 'a', 'Idempotency-Key': 'request-1234', 'X-CDS-Confirm-Service': 'mongodb',
    });
    expect(response.status).toBe(403);
    expect(response.text).toContain('agent_key_cannot_mint_global');
    expect(execute).not.toHaveBeenCalled();
  });

  it('没有逐字确认目标资源时拒绝，不启动备份或签发', async () => {
    const response = await request(server, 'POST', '/api/projects/project-a/infra/mongodb/credential-rotation', {
      'Idempotency-Key': 'request-1234',
    });
    expect(response.status).toBe(400);
    expect(response.text).toContain('rotation.confirmation_required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('请求体完全不接收凭据，响应只含指纹和审计元数据', async () => {
    const response = await request(server, 'POST', '/api/projects/project-a/infra/mongodb/credential-rotation', {
      'Idempotency-Key': 'request-1234', 'X-CDS-Confirm-Service': 'mongodb',
    });
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith('project-a', 'mongodb', 'request-1234');
    expect(response.text).not.toContain('password');
    expect(response.text).not.toContain('secret');
  });

  it('server 已挂载路由，且读写 API 都有活动日志标签', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/server.ts'), 'utf8');
    expect(source).toContain("app.use('/api', createInfraCredentialRotationRouter({");
    expect(source).toContain('查看共享凭据轮换');
    expect(source).toContain('执行共享凭据轮换');
  });
});
