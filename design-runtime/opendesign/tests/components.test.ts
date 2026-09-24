// 部件测试：真实子进程的 daemon 监管、模型出口转发口、web-prototype 模板补丁、以及几条接线守卫。
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createDesignRuntime } from '../src/app.js';
import type { ServiceConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { probeDaemonHealth } from '../src/engine/client.js';
import { OpenDesignDaemon, buildDaemonEnv, type DaemonExit } from '../src/engine/daemon.js';
import { isDeniedEgressAddress, startEgressRelay, type EgressRelay } from '../src/engine/egress-relay.js';
import { listDesignSystems } from '../src/engine/self-check.js';
import {
  findTemplateAssertionFailure,
  patchWebPrototypeLayouts,
  patchWebPrototypeTemplate,
  prepareWebPrototypeResources,
} from '../src/engine/web-prototype.js';
import { OPEN_DESIGN_CODEX_VERSION, buildOpenDesignCodexConfig } from '../src/prompts.js';
import { FIXTURES, waitFor } from './helpers.js';

const SERVICE_ROOT = path.resolve(__dirname, '..');
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('OpenDesign daemon process supervision (real child process)', () => {
  it('starts with an explicit environment that never carries the service API key, and notices an unexpected death', async () => {
    const root = tempDir('design-runtime-daemon-');
    const envDump = path.join(root, 'env.json');
    const port = await freePort();
    process.env.DESIGN_RUNTIME_API_KEY = 'must-not-leak-into-the-engine';
    cleanups.push(() => { delete process.env.DESIGN_RUNTIME_API_KEY; });
    const daemon = new OpenDesignDaemon({
      command: [process.execPath, path.join(FIXTURES, 'fake-od-daemon.mjs'), envDump],
      cwd: root,
      port,
      dataDir: path.join(root, 'data'),
      workspaceDir: path.join(root, 'workspace'),
      home: root,
      stopTimeoutMs: 2_000,
    });
    cleanups.push(() => daemon.stop());
    const exits: DaemonExit[] = [];
    daemon.onUnexpectedExit((exit) => exits.push(exit));

    const handle = await daemon.start();
    const health = await waitFor(async () => {
      const probe = await probeDaemonHealth(fetch, handle.baseUrl, handle.apiToken, 500);
      return probe.ok ? probe : undefined;
    }, 'fake daemon health');
    expect(health?.version).toBe('0.21.1');
    const env = JSON.parse(fs.readFileSync(envDump, 'utf8')) as Record<string, string>;
    expect(env.OD_API_TOKEN).toBe(handle.apiToken);
    expect(env.MAP_CODEX_MODEL_TOKEN).toBe(handle.modelPlaceholderToken);
    expect(env.OD_BIND_HOST).toBe('127.0.0.1');
    expect(env.OD_CODEX_SANDBOX).toBe('danger-full-access');
    expect(env.DESIGN_RUNTIME_API_KEY).toBeUndefined();
    expect(Object.values(env)).not.toContain('must-not-leak-into-the-engine');

    // 进程自己死掉（这里用 SIGKILL 模拟）：监听者收到「非本服务发起」的退出。
    const pid = daemon.describe().pid!;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => exits.length === 1, 'unexpected exit notification');
    expect(exits[0]).toMatchObject({ intentional: false, signal: 'SIGKILL' });
    expect(daemon.describe().running).toBe(false);
    expect(daemon.current()).toBeNull();

    // 主动停止不算意外退出。
    await daemon.start();
    await daemon.stop();
    expect(exits).toHaveLength(1);
    expect(daemon.describe().lastExit?.intentional).toBe(true);
  });

  it('wires a dead engine into capabilities and recovers through a clean restart', async () => {
    const root = tempDir('design-runtime-supervised-');
    const config: ServiceConfig = {
      ...loadConfig({}),
      apiKey: 'k',
      workspaceDir: path.join(root, 'workspace'),
      odDataDir: path.join(root, 'od'),
      templatesDir: path.join(root, 'templates'),
      outputDir: path.join(root, 'output'),
      webPrototypeSourceDir: path.join(FIXTURES, 'web-prototype'),
      designSystemsDir: path.join(FIXTURES, 'design-systems'),
      odPort: await freePort(),
      odCommand: [process.execPath, path.join(FIXTURES, 'fake-od-daemon.mjs')],
      odCwd: root,
      engineHome: root,
      engineUid: undefined,
      engineGid: undefined,
      egressPort: 0,
    };
    const runtime = await createDesignRuntime(config, {
      pollIntervalMs: 20,
      log: () => undefined,
      selfCheck: { codexVersion: 'codex-cli 0.143.0', codexMatches: true, codexObservation: '', missingSkillFiles: [], designSystems: [] },
    });
    await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
    cleanups.push(() => runtime.shutdown());
    await runtime.start();
    const healthy = await (await fetch(`${base}/v1/capabilities`)).json();
    expect(healthy).toMatchObject({ healthy: true, engineVersion: '0.21.1', state: 'idle' });

    process.kill(runtime.lifecycle.daemon.describe().pid!, 'SIGKILL');
    // 死掉之后到重新拉起之前，能力接口必须如实报不健康，不能静默。
    const during = await waitFor(async () => {
      const body = await (await fetch(`${base}/v1/capabilities`)).json();
      return body.healthy === false ? body : undefined;
    }, 'capabilities to report the dead engine');
    expect(['engine_restarting', 'engine_unhealthy']).toContain(during.reason.code);
    expect(during.reason.message.startsWith('OpenDesign 引擎进程')).toBe(true);
    const recovered = await waitFor(async () => {
      const body = await (await fetch(`${base}/v1/capabilities`)).json();
      return body.healthy === true ? body : undefined;
    }, 'engine recovery');
    expect(recovered.engineProcess.unexpectedExitsInLast10Minutes).toBe(1);
  });

  it('builds the daemon environment from an explicit list only', () => {
    const env = buildDaemonEnv({
      port: 7456, dataDir: '/app/.od', workspaceDir: '/workspace', apiToken: 't', modelPlaceholderToken: 'p', home: '/home/open-design', path: '/usr/bin',
    });
    expect(Object.keys(env).sort()).toEqual([
      'HOME', 'MAP_CODEX_MODEL_TOKEN', 'NODE_ENV', 'NODE_OPTIONS', 'OD_API_TOKEN', 'OD_BIND_HOST', 'OD_CODEX_SANDBOX',
      'OD_DATA_DIR', 'OD_PORT', 'OD_SANDBOX_IMPORT_ALLOWED_ROOTS', 'OD_SANDBOX_MODE', 'OD_WEB_PORT', 'PATH',
    ]);
  });
});

describe('model egress relay', () => {
  let upstream: http.Server | undefined;
  let relay: EgressRelay | undefined;

  afterEach(async () => {
    await relay?.close();
    await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
    relay = undefined;
    upstream = undefined;
  });

  async function startUpstream(): Promise<{ origin: string; seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> }> {
    const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
    upstream = http.createServer((req, res) => {
      seen.push({ url: req.url || '', headers: req.headers });
      if (req.url?.endsWith('/redirect')) {
        res.writeHead(302, { Location: 'http://169.254.169.254/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    return { origin: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, seen };
  }

  it('swaps the placeholder for the real ticket and strips caller credentials', async () => {
    const { origin, seen } = await startUpstream();
    relay = await startEgressRelay({
      modelBaseUrl: `${origin}/api/design-artifacts/runtime/run-1/llm/v1`,
      mapModelTicket: 'real-map-ticket',
      relayClientToken: 'placeholder',
      port: 0,
      // 上游在回环地址上只因为这是测试；默认判据会拒绝它（见下一条用例）。
      isDeniedAddress: () => false,
    });
    expect(relay.proxiedBaseUrl).toBe(`http://127.0.0.1:${relay.port}/api/design-artifacts/runtime/run-1/llm/v1`);
    const ok = await fetch(`${relay.proxiedBaseUrl}/responses`, {
      method: 'POST',
      headers: { Authorization: 'Bearer placeholder', Cookie: 'session=1', 'X-Api-Key': 'caller-key', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(ok.status).toBe(200);
    expect(seen[0].headers.authorization).toBe('Bearer real-map-ticket');
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers['x-api-key']).toBeUndefined();
    expect((await fetch(`${relay.proxiedBaseUrl}/responses`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${relay.port}/other/path`, { headers: { Authorization: 'Bearer placeholder' } })).status).toBe(403);
    expect((await fetch(`${relay.proxiedBaseUrl}/x`, { method: 'DELETE', headers: { Authorization: 'Bearer placeholder' } })).status).toBe(403);
    expect((await fetch(`${relay.proxiedBaseUrl}/redirect`, { headers: { Authorization: 'Bearer placeholder' }, redirect: 'manual' })).status).toBe(502);
    expect((await fetch(`http://127.0.0.1:${relay.port}/__health`)).status).toBe(204);
  });

  it('closes the downstream stream as soon as the upstream drops mid-response', async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: first\n\n');
      // 发完一段就把连接硬掐掉，模拟 MAP 重启或网络中断。
      setTimeout(() => res.socket?.destroy(), 50);
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    relay = await startEgressRelay({
      modelBaseUrl: `${origin}/llm/v1`,
      mapModelTicket: 'real-map-ticket',
      relayClientToken: 'placeholder',
      port: 0,
      isDeniedAddress: () => false,
    });
    const startedAt = Date.now();
    const response = await fetch(`${relay.proxiedBaseUrl}/responses`, { method: 'POST', headers: { Authorization: 'Bearer placeholder' }, body: '{}' });
    expect(response.status).toBe(200);
    // 下游必须很快看到中断（读流抛错），而不是等 90 秒超时。
    await expect(response.text()).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('refuses to forward to private, loopback, link-local or metadata addresses by default', async () => {
    const { origin, seen } = await startUpstream();
    relay = await startEgressRelay({
      modelBaseUrl: `${origin}/llm/v1`,
      mapModelTicket: 'real-map-ticket',
      relayClientToken: 'placeholder',
      port: 0,
    });
    const response = await fetch(`${relay.proxiedBaseUrl}/responses`, { method: 'POST', headers: { Authorization: 'Bearer placeholder' }, body: '{}' });
    expect(response.status).toBe(502);
    expect(seen).toHaveLength(0);
    for (const address of ['127.0.0.1', '10.1.2.3', '172.17.0.2', '192.168.1.1', '169.254.169.254', '::1', '::ffff:10.0.0.1', 'fd00::1', 'not-an-ip']) {
      expect(isDeniedEgressAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isDeniedEgressAddress(address), address).toBe(false);
    }
  });
});

describe('web-prototype template preparation', () => {
  const read = (relative: string) => fs.readFileSync(path.join(FIXTURES, 'web-prototype', relative), 'utf8');

  it('patches the starter template into a gate-passing shape and proves it', () => {
    const original = read('assets/template.html');
    expect(findTemplateAssertionFailure(original)).toBe('template still contains an empty link or a bare button');
    const patched = patchWebPrototypeTemplate(original);
    expect(findTemplateAssertionFailure(patched)).toBeUndefined();
    expect(patched).toContain('<a href="#hero">[REPLACE] Link 1</a>');
    expect(patched).toContain('<section class="section hero" id="hero" data-od-id="hero">');
    expect(patched).toContain('<a class="btn btn-primary" href="#content">[REPLACE] CTA</a>');
    expect(patched).toContain('[REPLACE] tagline · [REPLACE] contact');
    expect(patchWebPrototypeLayouts(read('references/layouts.md'))).toContain('href="#content"');
  });

  it('does not accept data-od-id as a fragment target, nor placeholder emails and dates', () => {
    expect(findTemplateAssertionFailure('<a href="#hero">x</a><section data-od-id="hero"></section>')).toBe('template anchor #hero has no matching id');
    expect(findTemplateAssertionFailure('<p>contact@example.com</p>')).toBe('template still contains a placeholder email or date');
    expect(findTemplateAssertionFailure('<p>2026-09</p>')).toBe('template still contains a placeholder email or date');
    expect(findTemplateAssertionFailure('<main id="content"><a href="#content">x</a></main>')).toBeUndefined();
  });

  it('copies both skill copies, patches them, and fails closed when a resource is missing', () => {
    const root = tempDir('design-runtime-template-');
    const workspaceDir = path.join(root, 'workspace');
    fs.mkdirSync(workspaceDir);
    prepareWebPrototypeResources(
      { sourceDir: path.join(FIXTURES, 'web-prototype'), templatesDir: path.join(root, 'templates'), workspaceDir },
      () => undefined,
    );
    for (const copy of [path.join(root, 'templates/web-prototype'), path.join(workspaceDir, '.od-skills/web-prototype')]) {
      expect(findTemplateAssertionFailure(fs.readFileSync(path.join(copy, 'assets/template.html'), 'utf8'))).toBeUndefined();
    }
    // 新建页面不种 index.html。
    expect(fs.existsSync(path.join(workspaceDir, 'index.html'))).toBe(false);

    const broken = tempDir('design-runtime-template-broken-');
    fs.cpSync(path.join(FIXTURES, 'web-prototype'), path.join(broken, 'source'), { recursive: true });
    fs.rmSync(path.join(broken, 'source/references/checklist.md'));
    fs.mkdirSync(path.join(broken, 'workspace'));
    expect(() => prepareWebPrototypeResources(
      { sourceDir: path.join(broken, 'source'), templatesDir: path.join(broken, 'templates'), workspaceDir: path.join(broken, 'workspace') },
      () => undefined,
    )).toThrow(expect.objectContaining({ code: 'workspace_design_template_init_failed' }));
  });

  it('lists only real design systems', () => {
    expect(listDesignSystems(path.join(FIXTURES, 'design-systems'))).toEqual(['default', 'editorial']);
    expect(listDesignSystems(path.join(FIXTURES, 'does-not-exist'))).toEqual([]);
  });
});

describe('wiring guards', () => {
  const executorSource = fs.readFileSync(path.join(SERVICE_ROOT, 'src/executor.ts'), 'utf8');

  // 伙伴侧传输的 origin 在任务提交时被钉死，但 fetch 默认跟随 3xx。唯一入口是 fetchPartnerTransfer；
  // 这条守卫盯的是「以后有人新写一处伙伴请求时绕过它」（形状 2 / 3）。搬迁自 CDS 的同名守卫。
  it('sends every MAP transfer through the single redirect-refusing entry', () => {
    const helper = executorSource.slice(executorSource.indexOf('private async fetchPartnerTransfer'));
    const body = helper.slice(0, helper.indexOf('\n  }\n'));
    expect(body).toContain("redirect: 'manual'");
    expect(body).toContain('workspace_transfer_redirect_rejected');
    const direct = executorSource.split('\n').filter((line) => line.includes('this.fetchImpl(')
      && !line.includes('this.fetchImpl(url, { ...init'));
    expect(direct).toEqual([]);
    const calls = executorSource.split('\n').filter((line) => line.includes('this.fetchPartnerTransfer('));
    expect(calls.some((line) => line.includes('inputPackageUrl'))).toBe(true);
    expect(calls.some((line) => line.includes('resultCommitUrl'))).toBe(true);
    expect(calls.some((line) => line.includes('previewUrl'))).toBe(true);
  });

  it('pins the native Codex runtime in the image and keeps MAP authority out of the configuration file', () => {
    const dockerfile = fs.readFileSync(path.join(SERVICE_ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(`@openai/codex@${OPEN_DESIGN_CODEX_VERSION}`);
    expect(dockerfile).toContain('FROM ghcr.io/nexu-io/od:0.21.1');
    expect(dockerfile).toContain(`codex-cli ${OPEN_DESIGN_CODEX_VERSION}`);
    const config = buildOpenDesignCodexConfig('http://127.0.0.1:8787/task/llm/v1', 'map-selected-model');
    expect(config).toContain('model = "map-selected-model"');
    expect(config).toContain('env_key = "MAP_CODEX_MODEL_TOKEN"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('supports_websockets = false');
    expect(config).not.toMatch(/OPENAI_API_KEY|CODEX_API_KEY|chatgpt|api\.openai\.com/);
  });

  it('keeps the production defaults on the layout the image provides', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: 8093,
      apiKey: '',
      workspaceDir: '/workspace',
      odDataDir: '/app/.od',
      templatesDir: '/app/design-templates',
      webPrototypeSourceDir: '/app/plugins/_official/examples/web-prototype',
      odPort: 7456,
      egressPort: 8787,
      engineUid: 1001,
      engineGid: 1001,
    });
    expect(config.odCommand.slice(1)).toEqual(['apps/daemon/dist/cli.js', '--no-open']);
  });
});
