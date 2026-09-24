// 执行器在本机后端上的行为测试。场景改写自 cds/tests/services/agent-workspace-session-runtime.test.ts
// 里依赖 fake shell 的运行时用例：原来断言「发出了哪条 docker 命令」，现在断言真实结果——工作区里
// 铺了什么、引擎收到了什么、MAP 收到了什么、失败时报了什么码。全部经由真实的 HTTP 层与任务槽。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildGeneratedArtifactFiles,
  buildGeneratedPublicArtifactPackage,
  computePublicArtifactRevision,
} from '../src/artifact/public-package.js';
import { hardenSelfContainedHtml } from '../src/quality/gate.js';
import { MAP_DESIGN_WORKSPACE_SCHEMA } from '../src/workspace/transfer.js';
import { DesignTaskExecutor } from '../src/executor.js';
import {
  auth,
  buildPackage,
  digest,
  startFakeMap,
  startHarness,
  taskRequest,
  waitFor,
  type BuiltPackage,
  type FakeMap,
  type Harness,
} from './helpers.js';

const REPO_ROOT = path.resolve(__dirname, '../../..');

let harness: Harness | undefined;
let map: FakeMap | undefined;

afterEach(async () => {
  await harness?.close();
  await map?.close();
  harness = undefined;
  map = undefined;
});

type TaskRequest = ReturnType<typeof taskRequest>;

async function runToEnd(pkg: BuiltPackage, mutate: (request: TaskRequest) => TaskRequest = (request) => request) {
  map = await startFakeMap(pkg);
  const submitted = await harness!.request('POST', '/v1/tasks', mutate(taskRequest(map, pkg)), auth);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
  return waitFor(async () => {
    const response = await harness!.request('GET', `/v1/tasks/${pkg.runId}`, undefined, auth);
    return response.body.task?.state !== 'running' ? response.body.task : undefined;
  }, 'task to finish');
}

async function statusReasons(taskId: string): Promise<string[]> {
  const events = (await harness!.request('GET', `/v1/tasks/${taskId}/events`, undefined, auth)).body.events;
  return events.filter((event: { type: string }) => event.type === 'status').map((event: { payload: { reason: string } }) => event.payload.reason);
}

describe('edit runs seeded from the current published site', () => {
  it.each([[false, true], [true, true], [false, false]])('seeds complete edit resources and never restores deleted output: delete=%s reports=%s', async (removeAsset, includeReports) => {
    harness = await startHarness();
    const html = '<!doctype html><html><head><title>Library</title></head><body><main><h1>Original sentence.</h1><p>Library information.</p></main></body></html>';
    const metadataPaths = ['assets/accessibility-static-report.json', 'assets/design-tokens.json', 'assets/page-outline.json', 'assets/provenance.json'];
    const assets = [
      { path: 'assets/site.css', content: 'body { color: #123; }', mediaType: 'text/css' },
      { path: 'assets/app.js', content: 'document.documentElement.dataset.ready = "yes";', mediaType: 'application/javascript' },
      { path: 'assets/pixel.png', content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6hQAAAABJRU5ErkJggg==', 'base64'), mediaType: 'image/png' },
    ];
    const oldPackage = buildGeneratedPublicArtifactPackage(hardenSelfContainedHtml(html), assets.map((file) => ({
      path: file.path, contentBase64: Buffer.from(file.content).toString('base64'), sha256: digest(Buffer.from(file.content)),
      size: Buffer.byteLength(file.content), mediaType: file.path.endsWith('.css') ? 'text/css; charset=utf-8' : file.path.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.mediaType,
    })));
    const inputFiles = [
      { path: 'current/index.html', content: html, mediaType: 'text/html' },
      ...assets.map((file) => ({ ...file, path: `current/${file.path}` })),
      ...oldPackage.filter((file) => metadataPaths.includes(file.path) || file.path === 'manifest.json').map((file) => ({
        path: `current/${file.path}`, content: Buffer.from(file.contentBase64, 'base64'), mediaType: file.mediaType,
      })),
    ];
    const pkg = buildPackage(inputFiles);
    harness.daemon.onRun = ({ body, index, workspaceDir }) => {
      expect(String(body.systemPrompt)).not.toContain('must be removed from the final deliverable');
      expect(String(body.systemPrompt)).toContain('Preserve existing scripts, resources, and interactions');
      if (index === 1) {
        expect(fs.readFileSync(path.join(workspaceDir, 'index.html'), 'utf8')).toBe(html);
        for (const asset of assets) expect(fs.readFileSync(path.join(workspaceDir, asset.path))).toEqual(Buffer.from(asset.content));
        for (const filePath of [...metadataPaths, 'manifest.json']) expect(fs.existsSync(path.join(workspaceDir, filePath))).toBe(false);
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), html.replace('Original sentence.', 'Updated sentence.'));
        if (removeAsset) fs.unlinkSync(path.join(workspaceDir, 'assets/pixel.png'));
      }
      for (const file of inputFiles) expect(fs.readFileSync(path.join(workspaceDir, file.path))).toEqual(Buffer.from(file.content));
      return { status: 'succeeded' };
    };
    const allowedOutputPaths = ['index.html', 'manifest.json', ...(includeReports ? ['assets/**'] : assets.map((asset) => asset.path))];
    const view = await runToEnd(pkg, (request) => ({ ...request, transfer: { ...request.transfer, allowedOutputPaths } }));
    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    const committed = map!.commits[0];
    for (const asset of assets) {
      const file = committed.files.find((item: { path: string }) => item.path === asset.path);
      if (removeAsset && asset.path === 'assets/pixel.png') expect(file).toBeUndefined();
      else {
        expect(Buffer.from(file.contentBase64, 'base64')).toEqual(Buffer.from(asset.content));
        expect(file.sha256).toBe(digest(Buffer.from(asset.content)));
      }
    }
    for (const filePath of metadataPaths) {
      const file = committed.files.find((item: { path: string }) => item.path === filePath);
      if (includeReports) {
        const expected = buildGeneratedArtifactFiles(hardenSelfContainedHtml(html.replace('Original sentence.', 'Updated sentence.')),
          assets.filter((asset) => !removeAsset || asset.path !== 'assets/pixel.png').map((asset) => asset.path)).find((item) => item.path === filePath);
        expect(file).toEqual(expected);
      } else expect(file).toBeUndefined();
    }
    const manifest = JSON.parse(Buffer.from(committed.files.find((item: { path: string }) => item.path === 'manifest.json').contentBase64, 'base64').toString('utf8'));
    expect(manifest.artifactRevision).toBe(computePublicArtifactRevision(committed.files.filter((item: { path: string }) => item.path !== 'manifest.json')));
    expect(Buffer.from(committed.files.find((item: { path: string }) => item.path === 'index.html').contentBase64, 'base64').toString('utf8')).toContain('Updated sentence.');
  });

  it.each([
    ['unsupported-extension', 'assets/drawing.svg', 'image/svg+xml', ['index.html', 'manifest.json', 'assets/**']],
    ['unsupported-path', 'styles/site.css', 'text/css', ['index.html', 'manifest.json', 'assets/**']],
    ['disallowed-resource', 'assets/site.css', 'text/css', ['index.html', 'manifest.json']],
    ['wrong-mime', 'assets/site.css', 'application/json', ['index.html', 'manifest.json', 'assets/**']],
    ['business-manifest', 'manifest.json', 'application/json', ['index.html', 'manifest.json', 'assets/**']],
  ])('rejects incompatible current resources before the engine is involved: %s', async (_label, filePath, mediaType, allowlist) => {
    harness = await startHarness();
    const pkg = buildPackage([
      { path: 'current/index.html', content: '<!doctype html><html><body><main>Library</main></body></html>', mediaType: 'text/html' },
      { path: `current/${filePath}`, content: '{}', mediaType },
    ]);
    map = await startFakeMap(pkg);
    const request = taskRequest(map, pkg);
    await harness.request('POST', '/v1/tasks', { ...request, transfer: { ...request.transfer, allowedOutputPaths: allowlist } }, auth);
    const view = await waitFor(async () => {
      const response = await harness!.request('GET', `/v1/tasks/${pkg.runId}`, undefined, auth);
      return response.body.task?.state !== 'running' ? response.body.task : undefined;
    }, 'task to fail');
    expect(view.error.code).toBe('workspace_current_artifact_unsupported');
    expect(harness.daemon.imports).toHaveLength(0);
  });
});

describe('workspace task contract', () => {
  const baseQuality = {
    schemaVersion: 'map-design-artifact-quality-v1',
    factualSources: ['title', 'instruction', 'knowledge'],
    measuredClaimsRequireSource: true,
    sensitiveFactsRequireSource: true,
    contextBoundMetricsReviewRequired: true,
    visibleDraftMarkersAllowed: false,
    emptyOrMissingFragmentTargetsAllowed: false,
    inertEnabledButtonsAllowed: false,
    finalReviewRequired: true,
  };
  it.each([
    { name: 'unknown quality contract', task: { operation: 'generate', qualityContract: { schemaVersion: 'map-design-artifact-quality-v2' } }, code: 'workspace_quality_contract_unsupported' },
    { name: 'malformed visible text occurrence constraint', task: { operation: 'generate', instruction: 'Build', title: 'Launch page', responseContract: { requiredFile: 'index.html', manifestFile: 'manifest.json', writeback: 'external' }, qualityContract: { ...baseQuality, visibleTextOccurrenceConstraints: [{ text: '重复文案', minOccurrences: 1, maxOccurrences: 2 }] } }, code: 'workspace_quality_contract_unsupported' },
    { name: 'operation mismatch', task: { operation: 'edit', instruction: 'Build', title: 'Launch page', responseContract: { requiredFile: 'index.html', manifestFile: 'manifest.json', writeback: 'external' }, qualityContract: baseQuality }, code: 'workspace_package_invalid' },
  ])('rejects $name before the engine imports the workspace', async ({ task, code }) => {
    harness = await startHarness();
    const pkg = buildPackage([{
      path: 'brief/task.json',
      content: JSON.stringify({ schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA, runId: 'map-run-1', baseRevision: 'rev-1', ...task }),
      mediaType: 'application/json',
    }]);
    const view = await runToEnd(pkg);
    expect(view.error.code).toBe(code);
    expect(harness.daemon.imports).toHaveLength(0);
  });

  it('rejects a package whose runId is not the submitted taskId', async () => {
    harness = await startHarness();
    // 包里写的是别人的 runId，任务却以 map-run-other 提交：拿到的不是这个任务的包，必须拒收。
    const mismatched = buildPackage([], { runId: 'someone-elses-run' });
    map = await startFakeMap({ ...mismatched, runId: 'map-run-other' });
    const request = taskRequest(map, { ...mismatched, runId: 'map-run-other' });
    await harness.request('POST', '/v1/tasks', request, auth);
    const failed = await waitFor(async () => {
      const response = await harness!.request('GET', '/v1/tasks/map-run-other', undefined, auth);
      return response.body.task?.state !== 'running' ? response.body.task : undefined;
    }, 'mismatched task to fail');
    expect(failed.error.code).toBe('workspace_package_invalid');
  });

  it('accepts the shared C# task contract fixture and runs it', async () => {
    harness = await startHarness();
    const task = fs.readFileSync(path.join(REPO_ROOT, 'scripts/fixtures/opendesign-task-v1.json'), 'utf8').trim();
    const pkg = buildPackage([
      { path: 'brief/task.json', content: task, mediaType: 'application/json' },
      { path: 'knowledge/01-product.md', content: '# 产品 资料\n\n产品定位与核心卖点', mediaType: 'text/markdown' },
      { path: 'current/index.html', content: '<!doctype html><html><body>旧页面</body></html>', mediaType: 'text/html' },
    ], { runId: 'run-workspace-1', baseRevision: 'f8d4db0e6f79e6607ae38e7fd2624b8454fc0a84df3e0246476868bc77dbb493' });
    harness.daemon.onRun = ({ workspaceDir, index }) => {
      if (index === 1) fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main><p>产品定位与核心卖点</p></main></body></html>');
      return { status: 'succeeded' };
    };
    const view = await runToEnd(pkg);
    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
  });

  it('refuses to follow a redirect on the pinned input transfer', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    map.inputResponder = (res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    };
    await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    const view = await waitFor(async () => {
      const response = await harness!.request('GET', `/v1/tasks/${pkg.runId}`, undefined, auth);
      return response.body.task?.state !== 'running' ? response.body.task : undefined;
    }, 'task to fail');
    expect(view.error.code).toBe('workspace_transfer_redirect_rejected');
  });
});

describe('design direction, review passes and live preview', () => {
  const direction = {
    schemaVersion: 'map-design-direction-v1',
    styleId: 'kami',
    styleName: '纸感',
    styleDescription: '纸张质感',
    designSystemId: 'kami',
    reviewMode: 'strict',
    prompts: { generate: 'EDITABLE-GENERATE-MARKER', edit: 'EDITABLE-EDIT-MARKER', review: 'EDITABLE-REVIEW-MARKER' },
    promptFingerprint: 'abc123def456',
  };

  it('applies the frozen MAP design direction: design system, editable prompt, strict review, live preview', async () => {
    harness = await startHarness();
    const pkg = buildPackage([
      { path: 'knowledge/source.md', content: 'Product facts', mediaType: 'text/markdown' },
      { path: 'reference/screenshot-01.png', content: Buffer.from([137, 80, 78, 71]), mediaType: 'image/png' },
    ], { taskExtras: { designDirection: direction } });
    harness.daemon.onRun = async ({ workspaceDir, index }) => {
      fs.writeFileSync(path.join(workspaceDir, 'index.html'), `<!doctype html><html><body><main>Product facts ${index}</main></body></html>`);
      // 第一轮留出时间让预览推送器看到页面。
      if (index === 1) await waitFor(() => map!.previews.length > 0, 'first preview');
      return { status: 'succeeded', deliverableValid: true, deliverableEntryFile: 'index.html' };
    };
    const view = await runToEnd(pkg);
    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    const runBodies = harness.daemon.runBodies;
    // 首轮 + 严格自查两轮 = 3 次 /api/runs；每一次都带着选中的设计系统。
    expect(runBodies).toHaveLength(3);
    expect(runBodies.every((body) => body.designSystemId === 'kami')).toBe(true);
    const systemPrompt = String(runBodies[0].systemPrompt);
    expect(systemPrompt.indexOf('WRITE the finished HTML to /workspace/index.html')).toBeLessThan(systemPrompt.indexOf('EDITABLE-GENERATE-MARKER'));
    expect(systemPrompt).not.toContain('EDITABLE-EDIT-MARKER');
    expect(systemPrompt).toContain('/workspace/reference/');
    expect(String(runBodies[1].message)).toContain('EDITABLE-REVIEW-MARKER');
    expect(String(runBodies[2].message)).toContain('visual quality pass');
    expect(map!.previews.length).toBeGreaterThanOrEqual(1);
    expect(map!.previews[0].html).toContain('Product facts');
    expect(map!.previews.map((item) => item.revision)).toEqual(map!.previews.map((_, index) => index + 1));
    expect(await statusReasons(pkg.runId)).toContain('open_design_preview_pushed');
  });

  it('skips the model review entirely when the MAP review mode is off', async () => {
    harness = await startHarness();
    const pkg = buildPackage([
      { path: 'knowledge/source.md', content: 'Product facts', mediaType: 'text/markdown' },
    ], { taskExtras: { designDirection: { ...direction, reviewMode: 'off' } } });
    harness.daemon.onRun = ({ workspaceDir }) => {
      fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>Product facts</main></body></html>');
      return { status: 'succeeded' };
    };
    const view = await runToEnd(pkg);
    expect(view.state).toBe('succeeded');
    expect(harness.daemon.runBodies).toHaveLength(1);
    expect(view.result.openDesignRunId).toBe('od-run-1');
  });

  it('writes the session Codex configuration into the engine data directory, pointing only at the local relay', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    let config = '';
    let mode = 0;
    harness.daemon.onRun = ({ workspaceDir, index }) => {
      if (index === 1) {
        const file = path.join(harness!.config.odDataDir, 'sandbox/agent-home/.codex/config.toml');
        config = fs.readFileSync(file, 'utf8');
        mode = fs.statSync(file).mode & 0o777;
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>Launch page</main></body></html>');
      }
      return { status: 'succeeded' };
    };
    const view = await runToEnd(pkg);
    expect(view.state).toBe('succeeded');
    expect(mode).toBe(0o600);
    expect(config).toMatch(/base_url = "http:\/\/127\.0\.0\.1:\d+\/api\/design-artifacts\/runtime\/map-run-1\/llm\/v1"/);
    expect(config).toContain('env_key = "MAP_CODEX_MODEL_TOKEN"');
    // 真实票据只在转发口里：配置文件里既没有票据，也没有 MAP 的真实地址。
    expect(config).not.toContain('model-ticket-secret');
    expect(config).not.toContain(map!.origin);
  });

  it('fails before starting Codex when the session model configuration cannot be installed', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    // 让 sandbox 变成一个文件：CODEX_HOME 建不出来。
    fs.mkdirSync(harness.config.odDataDir, { recursive: true });
    fs.writeFileSync(path.join(harness.config.odDataDir, 'sandbox'), 'not a directory');
    const view = await runToEnd(pkg);
    expect(view.error.code).toBe('open_design_codex_config_failed');
    expect(harness.daemon.runBodies).toHaveLength(0);
  });
});

describe('collecting the deliverable', () => {
  it('promotes the deliverable file OpenDesign named instead of guessing', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    harness.daemon.onRun = ({ workspaceDir, index }) => {
      if (index === 1) {
        fs.writeFileSync(path.join(workspaceDir, 'launch-page.html'), '<!doctype html><html><body><main>Promoted launch page</main></body></html>');
        return { status: 'succeeded', deliverableEntryFile: 'launch-page.html' };
      }
      return { status: 'succeeded', deliverableValid: false, deliverableValidation: 'no_artifact' };
    };
    await runToEnd(pkg);
    // 只断言「按 OpenDesign 指名的文件搬」这一步本身。搬完之后那份 slug 文件仍留在工作区根、
    // 会被产物预检按白名单拒收——这与 CDS 现行实现一致，是否属实要在真实引擎上确认，
    // 记在 doc/debt.platform.open-design.md，这里不把它锁成期望。
    const events = (await harness.request('GET', `/v1/tasks/${pkg.runId}/events`, undefined, auth)).body.events;
    const resolved = events.find((event: { payload: { reason?: string; promoted?: boolean } }) => event.payload.reason === 'deliverable_entry_resolved' && event.payload.promoted);
    expect(resolved.payload).toMatchObject({ entryFile: 'launch-page.html', promoted: true, bytes: 74 });
  });

  it.each([
    ['a path that climbs out of the workspace', '../../etc/secret.html', 'open_design_deliverable_entry_invalid'],
    ['a symbolic link to a file outside the workspace', 'linked.html', 'open_design_deliverable_entry_unreadable'],
  ])('refuses to promote %s', async (_label, entryFile, code) => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    const outside = path.join(harness.root, 'outside.html');
    fs.writeFileSync(outside, '<!doctype html><html><body>SERVICE SECRET</body></html>');
    harness.daemon.onRun = ({ workspaceDir, index }) => {
      if (entryFile === 'linked.html' && index === 1) fs.symlinkSync(outside, path.join(workspaceDir, 'linked.html'));
      return { status: 'succeeded', deliverableEntryFile: entryFile };
    };
    const view = await runToEnd(pkg);
    expect(view.error.code).toBe(code);
    expect(map!.commits).toHaveLength(0);
    expect(JSON.stringify(view)).not.toContain('SERVICE SECRET');
  });

  it('reports why there is no index.html with the workspace listing and a run transcript digest', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    harness.daemon.onRun = () => ({ status: 'succeeded' });
    const view = await runToEnd(pkg);
    expect(view.error.code).toBe('design_output_missing');
    expect(view.error.details.workspaceRootEntries).toEqual(['.od-skills', 'brief']);
    expect(view.error.details.runTranscriptDigest.runs[0]).toMatchObject({ runId: 'od-run-1', available: true });
    expect(view.error.details.collectedPaths).toEqual([]);
  });

  it.each([
    ['a symbolic link', (workspaceDir: string) => fs.symlinkSync('/etc/hostname', path.join(workspaceDir, 'assets-link')), 'design_output_invalid'],
    ['a path outside the allowlist', (workspaceDir: string) => fs.writeFileSync(path.join(workspaceDir, 'runtime-state.json'), '{}'), 'design_output_invalid'],
    ['a modified frozen input', (workspaceDir: string) => fs.writeFileSync(path.join(workspaceDir, 'brief/task.json'), '{}'), 'workspace_input_changed'],
  ])('rejects an output containing %s during preflight', async (_label, tamper, code) => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    harness.daemon.onRun = ({ workspaceDir, index }) => {
      if (index === 1) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>Launch page</main></body></html>');
        tamper(workspaceDir);
      }
      return { status: 'succeeded' };
    };
    const view = await runToEnd(pkg);
    expect(view.error.code).toBe(code);
    expect(map!.commits).toHaveLength(0);
    // 导出时冻结过引擎，且每次冻结都解冻了。
    expect(harness.daemon.freezes).toBeGreaterThan(0);
    expect(harness.daemon.freezes).toBe(harness.daemon.thaws);
  });

  it('repairs a quality rejection by telling the engine exactly what the gate rejected', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    harness.daemon.onRun = ({ workspaceDir, index, body }) => {
      if (index === 1) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main><a href="#missing">Jump</a></main></body></html>');
      }
      if (String(body.message).includes('controlled rejection reason is missing_fragment_target')) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main id="top"><a href="#top">Jump</a></main></body></html>');
      }
      return { status: 'succeeded' };
    };
    const view = await runToEnd(pkg);
    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    // 首轮 + 终审 + 一次定向修复。
    expect(harness.daemon.runBodies).toHaveLength(3);
    expect(String(harness.daemon.runBodies[2].message)).toContain('document-order position(s) 1');
    expect(await statusReasons(pkg.runId)).toContain('open_design_quality_repairing');
  });
});

describe('live preview delivery', () => {
  it('re-pushes the same page after a failed preview POST instead of treating it as delivered', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-preview-retry-'));
    fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>Stable page</main></body></html>');
    const statuses = [503, 200];
    const posted: Array<{ revision: number; html: string }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: statuses.shift() ?? 200 });
    }) as unknown as typeof fetch;
    const executor = new DesignTaskExecutor({
      paths: { workspaceDir, dataDir: workspaceDir, templatesDir: workspaceDir, outputDir: workspaceDir, webPrototypeSourceDir: workspaceDir },
      daemon: { current: () => undefined } as any,
      fetchImpl,
      relayPort: 0,
    });
    const stages: string[] = [];
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const push = (executor as any).createPreviewPusher(
        { previewUrl: 'https://map.example.test/api/design-artifacts/runtime/r1/workspace/preview', transfer: { transferToken: 't' } },
        now + 600_000,
        (stage: string) => stages.push(stage),
      ) as () => Promise<void>;
      await push();
      now += 9_000;
      // 页面没有再变：修复前指纹在推送前就记下，这一轮会直接跳过，预览永远停在失败那一刻。
      await push();
      now += 9_000;
      await push();
    } finally {
      clock.mockRestore();
    }
    expect(posted.map((item) => item.revision)).toEqual([1, 2]);
    expect(posted.every((item) => item.html.includes('Stable page'))).toBe(true);
    expect(stages).toEqual(['open_design_preview_failed', 'open_design_preview_pushed']);
  });
});
