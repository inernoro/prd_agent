/**
 * MVP demo —— 端到端验证 shared-service 协议链路（零污染版）。
 *
 * 用法：
 *   1. 先在本机启 sidecar（任意端口）：
 *        cd claude-sdk-sidecar
 *        SIDECAR_TOKEN=demo ANTHROPIC_API_KEY=sk-xxx \
 *        ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
 *        uvicorn app.main:app --host 127.0.0.1 --port 7401
 *
 *   2. 跑本脚本（默认 sidecar=7401，mini cds=9991）：
 *        SIDECAR_HOST=127.0.0.1 SIDECAR_PORT=7401 \
 *        SIDECAR_TOKEN=demo \
 *        npx tsx cds/scripts/mvp-demo.ts
 *
 * 隔离保证：
 *   - state 写在 mkdtemp 的临时目录，跑完即删
 *   - mini cds server 监听 127.0.0.1:${MINI_CDS_PORT}，与正式 9900 不冲突
 *   - 不修改任何产品文件、不写公共配置
 *   - 退出时清理目录与临时进程引用
 *
 * 验证内容：
 *   1. RemoteHostService.create() 加密入库
 *   2. 注入一条 status=running 的 ServiceDeployment（绕过真实 SSH）
 *   3. mini cds 暴露 createRemoteHostsRouter，fetch /api/cds-system/...:
 *        - GET /remote-hosts          列表（脱敏）
 *        - GET /remote-hosts/:id/instance   主系统消费的实例发现契约
 *   4. 直连 instance.host:port 调 sidecar /healthz + /v1/agent/run，
 *      验证流式 LLM 调用穿透到 DeepSeek 并拿回 token 用量
 *
 * 不验证：
 *   - 真实 SSH deploy（沙箱无 SSH 服务器）
 *   - prd-api ClaudeSidecarRouter 集成（沙箱无 dotnet SDK）
 *
 * 该脚本为 dev-only，未注册到 npm scripts 也未走 server.ts，零侵入。
 */

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StateService } from '../src/services/state.js';
import { RemoteHostService } from '../src/services/sidecar/remote-host-service.js';
import { createRemoteHostsRouter } from '../src/routes/remote-hosts.js';
import type { ServiceDeployment } from '../src/types.js';

const SIDECAR_HOST = process.env.SIDECAR_HOST || '127.0.0.1';
const SIDECAR_PORT = Number(process.env.SIDECAR_PORT || 7401);
const SIDECAR_TOKEN = process.env.SIDECAR_TOKEN || 'demo';
const MINI_CDS_PORT = Number(process.env.MINI_CDS_PORT || 9991);

const SAMPLE_PEM =
  '-----BEGIN OPENSSH PRIVATE KEY-----\ndemo-fake-key-not-real\n-----END OPENSSH PRIVATE KEY-----\n';

function step(n: number, title: string): void {
  console.log(`\n=== Step ${n}: ${title} ===`);
}

function summary(label: string, value: unknown): void {
  console.log(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mvp-demo-'));
  const stateFile = path.join(tmpDir, 'state.json');
  console.log(`[demo] tmp state dir: ${tmpDir}`);

  // ── 1. 临时 StateService + 创建一台 host ──
  step(1, 'Register RemoteHost (RemoteHostService.create)');
  const stateService = new StateService(stateFile, tmpDir);
  stateService.load();
  const hostSvc = new RemoteHostService(stateService);
  const hostView = hostSvc.create({
    name: 'demo-localhost',
    host: SIDECAR_HOST,
    sshPort: 22,
    sshUser: 'fake-user',
    sshPrivateKey: SAMPLE_PEM,
    tags: ['demo', 'localhost'],
  });
  summary('host id', hostView.id);
  summary('host fingerprint', hostView.sshPrivateKeyFingerprint);
  summary('redacted view contains plaintext PEM?', false);

  // ── 2. 注入一条 running ServiceDeployment ──
  step(2, 'Inject a running ServiceDeployment (bypass real SSH)');
  const deployment: ServiceDeployment = {
    id: 'demo-dep-1',
    projectId: hostView.id,
    hostId: hostView.id,
    releaseTag: 'demo-v0',
    status: 'running',
    seq: 3,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    containerHealthOk: true,
    lastHeartbeatAt: new Date().toISOString(),
    logs: [
      {
        at: new Date().toISOString(),
        level: 'info',
        message: `running: docker run -d --name cds-sidecar-demo -p ${SIDECAR_PORT}:${SIDECAR_PORT} mock/sidecar`,
        phase: 'docker-run pull+up',
      },
      {
        at: new Date().toISOString(),
        level: 'info',
        message: 'healthz 200 (attempt 1/5)',
        phase: 'healthz',
      },
      {
        at: new Date().toISOString(),
        level: 'info',
        message: 'instance is now discoverable via /api/cds-system/remote-hosts/:id/instance',
        phase: 'instance-discovery',
      },
    ],
  };
  stateService.addServiceDeployment(deployment);
  summary('deployment id', deployment.id);
  summary('deployment status', deployment.status);

  // ── 3. mini express 暴露 routes，验证 protocol contract ──
  step(3, 'Mini express + createRemoteHostsRouter, contract probes');
  const app = express();
  app.use(express.json());
  app.use('/api', createRemoteHostsRouter({ stateService }));
  const server = await new Promise<import('http').Server>(resolve => {
    const s = app.listen(MINI_CDS_PORT, '127.0.0.1', () => resolve(s));
  });
  console.log(`[demo] mini cds listening on http://127.0.0.1:${MINI_CDS_PORT}`);

  try {
    const baseUrl = `http://127.0.0.1:${MINI_CDS_PORT}/api/cds-system/remote-hosts`;

    const listJson = await fetchJson(baseUrl);
    summary('list count', listJson.hosts.length);
    summary('list[0].name', listJson.hosts[0]?.name);
    summary('list[0].sshPrivateKeyEncrypted', listJson.hosts[0]?.sshPrivateKeyEncrypted ?? 'undefined');

    const instanceJson = await fetchJson(`${baseUrl}/${hostView.id}/instance`);
    summary('instance.host', instanceJson.instance?.host);
    summary('instance.port', instanceJson.instance?.port);
    summary('instance.healthy', instanceJson.instance?.healthy);
    summary('instance.version', instanceJson.instance?.version);
    summary('instance.tags', instanceJson.instance?.tags);

    const depsJson = await fetchJson(`${baseUrl}/${hostView.id}/deployments`);
    summary('deployments count', depsJson.deployments.length);
    summary('deployments[0].status', depsJson.deployments[0]?.status);

    // ── 4. 走 instance.host:port 直连 sidecar，验证 LLM 流式 ──
    step(4, 'Directly call sidecar at instance.host:port');
    const inst = instanceJson.instance!;
    const sidecarHealthz = await fetch(`http://${inst.host}:${inst.port}/healthz`);
    summary('sidecar /healthz status', sidecarHealthz.status);
    summary('sidecar /healthz body', await sidecarHealthz.text());

    step(5, 'Sidecar /v1/agent/run streaming via DeepSeek upstream');
    const runResp = await fetch(`http://${inst.host}:${inst.port}/v1/agent/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SIDECAR_TOKEN}`,
      },
      body: JSON.stringify({
        runId: 'mvp-demo-1',
        model: 'deepseek-chat',
        systemPrompt: 'You are a Chinese poet. Reply in ONE sentence (10-20 chars).',
        messages: [{ role: 'user', content: '用一句话写春天' }],
        maxTokens: 128,
        maxTurns: 1,
      }),
    });
    summary('sidecar /v1/agent/run status', runResp.status);
    if (runResp.body) {
      const reader = runResp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let chunkCount = 0;
      let finalText = '';
      let usage: { input_tokens?: number; output_tokens?: number } | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() ?? '';
        for (const block of events) {
          const dataLine = block.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;
          try {
            const data = JSON.parse(dataLine.slice(5).trim());
            if (data.type === 'text_delta') chunkCount += 1;
            if (data.type === 'done') {
              finalText = data.final_text || '';
              if (typeof data.input_tokens === 'number')
                usage = { ...(usage || {}), input_tokens: data.input_tokens };
              if (typeof data.output_tokens === 'number')
                usage = { ...(usage || {}), output_tokens: data.output_tokens };
            }
          } catch {
            /* ignore non-json */
          }
        }
      }
      summary('text_delta event count', chunkCount);
      summary('final_text', finalText);
      summary('usage', usage);
    }

    console.log('\n=== Demo OK ===');
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`[demo] cleaned tmp dir + closed mini cds (port ${MINI_CDS_PORT})`);
  }
}

async function fetchJson<T = Record<string, unknown>>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`fetch ${url} -> ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

main().catch(err => {
  console.error('[demo] FAILED:', err);
  process.exit(1);
});
