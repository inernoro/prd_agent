/**
 * 项目 Agent 角色声明的读写契约。
 *
 * 这条链路存在的理由：角色此前只写进仓库里的 .cds/bootstrap.json，
 * 全仓零个读取点，CDS 自己不知道某个项目的 Agent 是什么角色。
 * 这里断言「写得进、读得回、脏值进不来、且会被 /api/projects 带出去」——
 * 最后一条是关键：带不出去，项目列表就还是显示不了角色，等于白写。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('项目 Agent 角色声明', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-profile-test-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'proj-a',
      slug: 'proj-a',
      name: 'Project A',
      kind: 'git',
      dockerNetwork: 'cds-proj-a',
      legacyFlag: false,
      createdAt: now,
      updatedAt: now,
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createProjectsRouter({ stateService, shell: new MockShellExecutor() }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('未声明过时返回 null，不编一个默认角色', async () => {
    const res = await request(server, 'GET', '/api/projects/proj-a/agent-profile');
    expect(res.status).toBe(200);
    expect(res.body.profile).toBeNull();
  });

  it('写入后读得回，并带上服务端盖的时间戳与来源', async () => {
    const put = await request(server, 'PUT', '/api/projects/proj-a/agent-profile', {
      role: 'qa',
      experience: 'experienced',
      skills: ['acceptance-checklist', 'preview-url'],
      cardTitle: '验收结论卡',
    });
    expect(put.status).toBe(200);
    expect(put.body.profile.role).toBe('qa');
    expect(put.body.profile.source).toBe('agent-starter');
    expect(typeof put.body.profile.declaredAt).toBe('string');

    const get = await request(server, 'GET', '/api/projects/proj-a/agent-profile');
    expect(get.body.profile.role).toBe('qa');
    expect(get.body.profile.experience).toBe('experienced');
    expect(get.body.profile.skills).toEqual(['acceptance-checklist', 'preview-url']);
    expect(get.body.profile.cardTitle).toBe('验收结论卡');
  });

  it('角色和经验档只收枚举内的值', async () => {
    const badRole = await request(server, 'PUT', '/api/projects/proj-a/agent-profile', {
      role: 'ceo',
      experience: 'newcomer',
    });
    expect(badRole.status).toBe(400);
    expect(badRole.body.error).toBe('invalid_role');

    const badExperience = await request(server, 'PUT', '/api/projects/proj-a/agent-profile', {
      role: 'dev',
      experience: 'guru',
    });
    expect(badExperience.status).toBe(400);
    expect(badExperience.body.error).toBe('invalid_experience');

    // 两次都该被拒，项目上不留任何残留。
    const get = await request(server, 'GET', '/api/projects/proj-a/agent-profile');
    expect(get.body.profile).toBeNull();
  });

  it('技能列表只保留合法 key 并限长，脏值不落库', async () => {
    const put = await request(server, 'PUT', '/api/projects/proj-a/agent-profile', {
      role: 'dev',
      experience: 'newcomer',
      skills: ['ok-skill', '../../etc/passwd', 'UPPER', 42, null, 'a'.repeat(200)],
    });
    expect(put.status).toBe(200);
    expect(put.body.profile.skills).toEqual(['ok-skill']);
  });

  it('整条覆盖写：换角色不会留下上一次的技能列表', async () => {
    await request(server, 'PUT', '/api/projects/proj-a/agent-profile', {
      role: 'dev',
      experience: 'newcomer',
      skills: ['code-hygiene'],
    });
    await request(server, 'PUT', '/api/projects/proj-a/agent-profile', {
      role: 'pm',
      experience: 'experienced',
      skills: [],
    });
    const get = await request(server, 'GET', '/api/projects/proj-a/agent-profile');
    expect(get.body.profile.role).toBe('pm');
    expect(get.body.profile.skills).toEqual([]);
  });

  it('不存在的项目返回 404', async () => {
    const get = await request(server, 'GET', '/api/projects/nope/agent-profile');
    expect(get.status).toBe(404);
    const put = await request(server, 'PUT', '/api/projects/nope/agent-profile', {
      role: 'dev',
      experience: 'newcomer',
    });
    expect(put.status).toBe(404);
  });

  it('声明会被 /api/projects 列表带出去，前端才显示得了角色', async () => {
    await request(server, 'PUT', '/api/projects/proj-a/agent-profile', {
      role: 'owner',
      experience: 'newcomer',
      skills: [],
      cardTitle: '规则交付卡',
    });
    const list = await request(server, 'GET', '/api/projects');
    expect(list.status).toBe(200);
    const entry = (list.body.projects || []).find((item: any) => item.id === 'proj-a');
    expect(entry?.agentProfile?.role).toBe('owner');
    expect(entry?.agentProfile?.cardTitle).toBe('规则交付卡');
  });
});
