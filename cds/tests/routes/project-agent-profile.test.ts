/**
 * 项目 Agent 角色声明的读写契约。
 *
 * 这条链路存在的理由：角色此前只写进仓库里的 .cds/bootstrap.json，
 * 全仓零个读取点，CDS 自己不知道某个项目的 Agent 是什么角色。
 * 这里断言「写得进、读得回、脏值进不来、且会被 /api/projects 带出去」——
 * 最后一条是关键：带不出去，项目列表就还是显示不了角色，等于白写。
 */

import { readFileSync } from 'node:fs';
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

  /**
   * 写入时机的守卫。
   *
   * 这条 PUT 一旦挂进以 projectId 为依赖的 useEffect，就会跟着目标项目变化
   * 自动重发：给项目 A 生成完上手包，完成屏上把目标切成项目 B，B 立刻被盖上
   * A 的角色——用户从没为 B 确认过任何东西。接口这边看不出异常（两次都是合法
   * 请求），只有从调用侧才拦得住，所以守卫放在这里。
   */
  it('前端只在点「生成」时写角色，不跟着 projectId 自动重发', () => {
    const source = readFileSync(
      new URL('../../web/src/components/AgentStarterTab.tsx', import.meta.url),
      'utf8',
    );
    const putIndex = source.indexOf('/agent-profile');
    expect(putIndex).toBeGreaterThan(-1);
    // 这个 PUT 必须在一个显式函数里，由生成按钮调用，而不是 effect 的副作用。
    expect(source).toMatch(/const syncAgentProfile = \(targetProjectId\?: string\)/);
    expect(source).toMatch(/onClick=\{\(\) => \{ advance\(4\); syncAgentProfile\(projectId\) \}\}/);
    // 从 PUT 往前找最近的 useEffect(，中间若没有函数定义就说明它又挂回 effect 了。
    const before = source.slice(0, putIndex);
    const lastEffect = before.lastIndexOf('useEffect(');
    const lastFn = before.lastIndexOf('const syncAgentProfile');
    expect(lastFn).toBeGreaterThan(lastEffect);
  });

  /**
   * 旧响应不许覆盖新结果。
   *
   * 慢网下可以「给 A 生成 → 换到 B → 再生成」，A 的响应可能后于 B 落地。
   * 两个回调若写同一个无主的状态位，就会用 A 的成败报告 B 的成败——
   * 界面上是一句确定的「已记到项目」或「没能记到」，而它说的是另一次写入的事。
   * 判据盯住：两个回调都必须经过带序号的 settle，而不是直接 setProfileSync。
   */
  it('前端的写入回调认序号，旧响应不覆盖新结果', () => {
    const source = readFileSync(
      new URL('../../web/src/components/AgentStarterTab.tsx', import.meta.url),
      'utf8',
    );
    const fnStart = source.indexOf('const syncAgentProfile');
    const fnEnd = source.indexOf('const copyPrompt', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = source.slice(fnStart, fnEnd);
    // 领号 + 回调里先比对再落地
    expect(body).toMatch(/profileSyncTicket\.current \+ 1/);
    expect(body).toMatch(/if \(profileSyncTicket\.current !== ticket\) return/);
    // then/catch 必须走 settle，不许直接写状态位
    expect(body).toMatch(/\.then\(\(\) => settle\('saved'\)\)/);
    expect(body).toMatch(/\.catch\(\(\) => settle\('failed'\)\)/);
    expect(body).not.toMatch(/\.then\(\(\) => setProfileSync\(/);
    expect(body).not.toMatch(/\.catch\(\(\) => setProfileSync\(/);
  });

  /**
   * 文案里点名的控件必须真的存在，且「没记上」不能是死胡同。
   *
   * 真实事故：换目标项目后的提示写「点一次『重新生成』就会记上」，而完成屏上
   * 从来没有叫这个名字的按钮——凭空编了一个控件让用户去找。同时写失败与换目标
   * 这两种状态都没有补写入口，复制提示词和下载脚本都不会补写，用户只能带着
   * 「这个项目没有角色」离开。
   *
   * 判据分两层：文案里用「」点名的控件，必须能在同文件的按钮文本里找到；
   * 以及必须存在一个调用 syncAgentProfile 的补写按钮。
   */
  it('完成屏文案点名的控件真实存在，且没记上时有补写入口', () => {
    const source = readFileSync(
      new URL('../../web/src/components/AgentStarterTab.tsx', import.meta.url),
      'utf8',
    );
    // 完成屏 aria-live 状态段里，中文书名号点名的控件
    const statusBlock = source.slice(
      source.indexOf('aria-live="polite"'),
      source.indexOf('const copyPrompt') > 0 ? source.length : source.length,
    );
    const named = [...statusBlock.matchAll(/点一次「([^」]+)」/g)].map((m) => m[1]);
    for (const label of named) {
      expect(
        source.includes(`>${label}<`) || source.includes(`'${label}'`) || source.includes(`${label}<`),
        `文案点名了「${label}」，但界面上没有这个控件`,
      ).toBe(true);
    }
    // 补写入口：必须有按钮真的调 syncAgentProfile，而不只是 onClick 里 advance
    expect(source).toMatch(/onClick=\{\(\) => syncAgentProfile\(projectId\)\}/);
    expect(source).toMatch(/const needsProfileRetry = /);
  });
});
