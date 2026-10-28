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
import { AgentWorkspaceRuntimeError } from '../src/errors.js';
import { hardenSelfContainedHtml } from '../src/quality/gate.js';
import { runBrowserWorker } from '../src/quality/browser-worker.js';
import type { BrowserQualityIssue } from '../src/quality/browser-contract.js';
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

function passingBrowserResult(job: { evidenceDir: string; repairAttempt: number }) {
  fs.mkdirSync(job.evidenceDir, { recursive: true });
  const measurements = [
    { viewport: 'desktop' as const, width: 1440, height: 900 },
    { viewport: 'mobile' as const, width: 390, height: 844 },
  ].map((viewport) => {
    const screenshotPath = `assets/quality/attempt-${job.repairAttempt}-${viewport.viewport}.png`;
    fs.writeFileSync(path.join(job.evidenceDir, path.basename(screenshotPath)), Buffer.from([137, 80, 78, 71]));
    return {
      ...viewport,
      documentWidth: viewport.width,
      h1Count: 1,
      visibleHeadingCount: 2,
      visibleCtaCount: 1,
      visibleLandmarkCount: 2,
      issues: [],
      screenshotPath,
    };
  });
  return { browserVersion: 'test-chromium', measurements };
}

afterEach(async () => {
  await harness?.close();
  await map?.close();
  harness = undefined;
  map = undefined;
});

describe('presentation source context', () => {
  it('passes the frozen source to OpenDesign without imposing a platform source-slot scaffold', async () => {
    harness = await startHarness({ overrides: {
      browserQualityRunner: { run: async (job) => passingBrowserResult(job) },
    } });
    const id = `sb-${'1'.repeat(64)}`;
    const plan = JSON.stringify({
      SchemaVersion: 'map-mdppt-source-plan-v2',
      Fingerprint: 'frozen',
      Blocks: [{ Id: id, Html: '<p>原始来源正文</p>' }],
      Pages: [{ Index: 1, DisplayTitle: '正常非来源标题', Blocks: [{ Id: id }] }],
    });
    const pkg = buildPackage([{ path: 'brief/source-plan.json', content: plan, mediaType: 'application/json' }], {
      taskExtras: {
        presentationContract: {
          schemaVersion: 'map-html-ppt-contract-v1', version: 2, targetPages: 1,
          sourceContentHash: 'a'.repeat(64), outlineHash: 'b'.repeat(64), theme: 'storytelling',
          requiredSlideIndexes: [1],
          sourcePlan: { path: 'brief/source-plan.json', contentHash: digest(Buffer.from(plan)) },
        },
        designDirection: {
          schemaVersion: 'map-design-direction-v1', styleId: 'deck', styleName: '演示稿',
          styleDescription: '由所选 OpenDesign deck skill 决定', designSystemId: 'minimal', reviewMode: 'strict',
          prompts: {
            generate: '你是资深网页设计师，要把 MAP 知识内容做成一张好看、可信的单页网页。手机 390px 宽度下可读。',
            edit: '你在修改一张已经发布的网页。',
            review: '手机 390px 宽度下有没有元素溢出或文字过小。',
          },
          promptFingerprint: 'native-deck-skill',
        },
      },
    });
    harness.daemon.onRun = ({ workspaceDir, index, body }) => {
      if (index === 1) {
        expect(fs.existsSync(path.join(workspaceDir, 'index.html'))).toBe(false);
        expect(String(body.systemPrompt)).toContain('input context and provenance');
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main><h1>OpenDesign 自主成稿</h1><p>TODO 由上游内容能力自行处理</p></main></body></html>');
      }
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };

    const view = await runToEnd(pkg, (request) => ({
      ...request,
      previewUrl: request.transfer.resultCommitUrl.replace('/result', '/preview'),
    }));

    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    expect(harness.daemon.imports).toHaveLength(1);
    expect(harness.daemon.imports[0].skillId).toBe('magazine-web-ppt');
    expect(harness.daemon.runBodies).toHaveLength(2);
    expect(String(harness.daemon.runBodies[0].systemPrompt)).toContain('active OpenDesign deck skill');
    expect(String(harness.daemon.runBodies[0].systemPrompt)).not.toContain('资深网页设计师');
    expect(String(harness.daemon.runBodies[0].systemPrompt)).not.toContain('390px');
    expect(String(harness.daemon.runBodies[0].systemPrompt)).not.toContain('只读这些');
    expect(String(harness.daemon.runBodies[0].systemPrompt)).not.toContain('effective rendered body text must remain at least 12px');
    expect(String(harness.daemon.runBodies[1].message)).toContain('perform one final check');
    expect(String(harness.daemon.runBodies[1].message)).not.toContain('390px');
    expect(map!.commits).toHaveLength(1);
    const committed = map!.commits[0].files.find((file: { path: string }) => file.path === 'index.html');
    expect(Buffer.from(committed.contentBase64, 'base64').toString('utf8')).toContain('OpenDesign 自主成稿');
  });

  it('keeps the presentation delivery boundary while upstream cleans its own unused draft', async () => {
    const currentHtml = '<!doctype html><html><body><main><h1>保留的父稿</h1></main></body></html>';
    const finalHtml = '<!doctype html><html><head><link rel="stylesheet" href="assets/theme.css"></head><body><main><h1>完成的演示稿</h1></main></body></html>';
    const css = 'h1 { color: #182230; }';
    // 两个状态复用同一真实执行链；stub 自行清理，不根据提示词字串模拟模型服从。
    for (const cleanOwnDraft of [false, true]) {
      harness = await startHarness();
      const pkg = buildPackage([{ path: 'current/index.html', content: currentHtml, mediaType: 'text/html' }], {
        taskExtras: {
          presentationContract: {
            schemaVersion: 'map-html-ppt-contract-v1', version: 2, targetPages: 1,
            sourceContentHash: 'a'.repeat(64), outlineHash: 'b'.repeat(64), theme: 'storytelling',
            requiredSlideIndexes: [1],
          },
        },
      });
      let mainPrompt = '';
      harness.daemon.onRun = ({ workspaceDir, index, body }) => {
        expect(fs.readFileSync(path.join(workspaceDir, 'current/index.html'), 'utf8')).toBe(currentHtml);
        if (index === 1) {
          mainPrompt = String(body.systemPrompt);
          fs.writeFileSync(path.join(workspaceDir, 'index.html'), finalHtml);
          fs.mkdirSync(path.join(workspaceDir, 'assets'), { recursive: true });
          fs.writeFileSync(path.join(workspaceDir, 'assets/theme.css'), css);
          const ownUnreferencedDraft = path.join(workspaceDir, 'working-copy.html');
          fs.writeFileSync(ownUnreferencedDraft, '<!doctype html><html><body>本轮自建且未引用的临时稿</body></html>');
          if (cleanOwnDraft) fs.unlinkSync(ownUnreferencedDraft);
        }
        return { status: 'succeeded', deliverableEntryFile: 'index.html' };
      };
      const view = await runToEnd(pkg);
      if (!cleanOwnDraft) {
        expect(view.state).toBe('failed');
        expect(view.error).toMatchObject({ code: 'design_output_invalid', details: {
          stage: 'output_preflight', rejectedPath: 'working-copy.html',
        } });
        expect(harness.daemon.runBodies).toHaveLength(1);
        expect(map!.commits).toHaveLength(0);
      } else {
        expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
        expect(harness.daemon.runBodies).toHaveLength(2);
        expect(map!.commits).toHaveLength(1);
        const files = map!.commits[0].files;
        const entry = files.find((file: { path: string }) => file.path === 'index.html');
        const asset = files.find((file: { path: string }) => file.path === 'assets/theme.css');
        const deliveredHtml = Buffer.from(entry.contentBase64, 'base64').toString('utf8');
        expect(deliveredHtml).toContain('<body><main><h1>完成的演示稿</h1></main></body>');
        expect(deliveredHtml).toContain('<link rel="stylesheet" href="assets/theme.css">');
        expect(deliveredHtml).toContain('Content-Security-Policy');
        expect(Buffer.from(asset.contentBase64, 'base64').toString('utf8')).toBe(css);
        expect(files.some((file: { path: string }) => file.path === 'working-copy.html')).toBe(false);
        expect(mainPrompt).toContain('first confirm that the requested changes are saved in the final index.html');
        expect(mainPrompt).toContain('only temporary or version drafts that you created in this operation');
        expect(mainPrompt).toContain('Never delete frozen inputs, referenced files, system-managed files, or files whose origin is unknown');
      }
      await harness.close();
      await map!.close();
      harness = undefined;
      map = undefined;
    }
  });

  it('rejects a mismatched frozen source-plan hash before opening an OpenDesign session', async () => {
    harness = await startHarness();
    const plan = JSON.stringify({
      SchemaVersion: 'map-mdppt-source-plan-v2',
      Fingerprint: 'frozen',
      Blocks: [],
      Pages: [],
    });
    const pkg = buildPackage([{ path: 'brief/source-plan.json', content: plan, mediaType: 'application/json' }], {
      taskExtras: {
        presentationContract: {
          schemaVersion: 'map-html-ppt-contract-v1', version: 2, targetPages: 1,
          sourceContentHash: 'a'.repeat(64), outlineHash: 'b'.repeat(64), theme: 'storytelling',
          requiredSlideIndexes: [1],
          sourcePlan: { path: 'brief/source-plan.json', contentHash: '0'.repeat(64) },
        },
      },
    });

    const view = await runToEnd(pkg);

    expect(view.state).toBe('failed');
    expect(view.error?.code).toBe('workspace_package_invalid');
    expect(harness.daemon.runBodies).toHaveLength(0);
    expect(map!.commits).toHaveLength(0);
  });

  it('restores a server-retained failed preview as exact non-final OpenDesign input without post-injecting source bytes', async () => {
    const id = `sb-${'c'.repeat(64)}`;
    const sourceHtml = '<p>回滚窗口、负责人和通知记录必须完整保留。</p>';
    const plan = JSON.stringify({
      SchemaVersion: 'map-mdppt-source-plan-v2',
      Fingerprint: 'frozen-repair-candidate',
      Blocks: [{ Id: id, Html: sourceHtml }],
      Pages: [{ Index: 1, Hash: 'page', DisplayTitle: '发布与回滚', Blocks: [{ Id: id }] }],
    });
    const candidate = `<!doctype html><html><head><meta charset="utf-8"><title>受限候选</title></head><body><main><div class="reveal"><div class="slides"><section data-slide-index="1"><h1>发布与回滚</h1><div data-mdppt-source="${id}"></div></section></div></div></main></body></html>`;
    harness = await startHarness({ overrides: {
      browserQualityRunner: { run: async (job) => passingBrowserResult(job) },
    } });
    const pkg = buildPackage([
      { path: 'brief/source-plan.json', content: plan, mediaType: 'application/json' },
      { path: 'candidate/index.html', content: candidate, mediaType: 'text/html' },
    ], {
      taskExtras: {
        presentationContract: {
          schemaVersion: 'map-html-ppt-contract-v1', version: 2, targetPages: 1,
          sourceContentHash: 'a'.repeat(64), outlineHash: 'b'.repeat(64), theme: 'storytelling',
          requiredSlideIndexes: [1],
          sourcePlan: { path: 'brief/source-plan.json', contentHash: digest(Buffer.from(plan)) },
          repairCandidate: { path: 'candidate/index.html', contentHash: digest(Buffer.from(candidate)) },
        },
      },
    });
    harness.daemon.onRun = ({ workspaceDir, index, body }) => {
      if (index === 1) {
        const restored = fs.readFileSync(path.join(workspaceDir, 'index.html'), 'utf8');
        expect(restored).toBe(candidate);
        expect(restored).not.toContain('candidate/index.html');
        expect(String(body.systemPrompt)).toContain('server-retained failed preview');
        expect(String(body.systemPrompt)).toContain('non-final input');
      }
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };

    const view = await runToEnd(pkg);

    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    expect(harness.daemon.runBodies.length).toBeGreaterThan(0);
    const committed = map!.commits[0].files.find((file: { path: string }) => file.path === 'index.html');
    expect(Buffer.from(committed.contentBase64, 'base64').toString('utf8')).toContain('发布与回滚');
    expect(Buffer.from(committed.contentBase64, 'base64').toString('utf8')).not.toContain(sourceHtml);
  });

  it.each([
    ['missing slot', (_id: string) => '<!doctype html><html><body><main>缺少来源槽</main></body></html>'],
    ['duplicate slot', (id: string) => `<!doctype html><html><body><main><div data-mdppt-source="${id}"></div><div data-mdppt-source="${id}"></div></main></body></html>`],
    ['hidden slot', (id: string) => `<!doctype html><html><body><main><div data-mdppt-source="${id}" hidden></div></main></body></html>`],
  ])('lets OpenDesign repair a candidate with %s without a platform source-slot gate', async (_label, candidateFor) => {
    const id = `sb-${'d'.repeat(64)}`;
    const plan = JSON.stringify({
      SchemaVersion: 'map-mdppt-source-plan-v2',
      Fingerprint: 'frozen-repair-rejection',
      Blocks: [{ Id: id, Html: '<p>冻结来源正文</p>' }],
      Pages: [{ Index: 1, Hash: 'page', DisplayTitle: '发布策略', Blocks: [{ Id: id }] }],
    });
    const candidate = candidateFor(id);
    harness = await startHarness();
    const pkg = buildPackage([
      { path: 'brief/source-plan.json', content: plan, mediaType: 'application/json' },
      { path: 'candidate/index.html', content: candidate, mediaType: 'text/html' },
    ], {
      taskExtras: {
        presentationContract: {
          schemaVersion: 'map-html-ppt-contract-v1', version: 2, targetPages: 1,
          sourceContentHash: 'a'.repeat(64), outlineHash: 'b'.repeat(64), theme: 'storytelling',
          requiredSlideIndexes: [1],
          sourcePlan: { path: 'brief/source-plan.json', contentHash: digest(Buffer.from(plan)) },
          repairCandidate: { path: 'candidate/index.html', contentHash: digest(Buffer.from(candidate)) },
        },
      },
    });

    const view = await runToEnd(pkg);

    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    expect(harness.daemon.runBodies.length).toBeGreaterThan(0);
    expect(map!.commits).toHaveLength(1);
  });

  it.each([
    ['missing', (id: string) => '封面'],
    ['duplicate', (id: string) => `<div data-mdppt-source="${id}"></div><div data-mdppt-source="${id}"></div>`],
  ])('does not route a %s source-slot shape through a platform-paid repair', async (_case, initialBody) => {
    const id = `sb-${'6'.repeat(64)}`;
    const secondId = `sb-${'8'.repeat(64)}`;
    const sourceHtml = '<h2>附件：基于 GitHub 和 PR 的版本管理与发布流程最佳实践.md</h2>';
    const secondSourceHtml = '<p>发布前先核对分支保护和回滚窗口。</p>';
    harness = await startHarness({ overrides: {
      browserQualityRunner: {
        run: async (job) => {
          expect(fs.existsSync(path.join(job.workspaceDir, 'current', 'index.html'))).toBe(false);
          return passingBrowserResult(job);
        },
      },
    } });
    const plan = JSON.stringify({
      SchemaVersion: 'map-mdppt-source-plan-v2',
      Fingerprint: 'frozen',
      Blocks: [{ Id: id, Html: sourceHtml }, { Id: secondId, Html: secondSourceHtml }],
      Pages: [{ Index: 1, Hash: 'page', DisplayTitle: '封面', Blocks: [{ Id: id }, { Id: secondId }] }],
    });
    const pkg = buildPackage([
      { path: 'brief/source-plan.json', content: plan, mediaType: 'application/json' },
    ], {
      taskExtras: {
        presentationContract: {
          schemaVersion: 'map-html-ppt-contract-v1',
          version: 2,
          targetPages: 1,
          sourceContentHash: 'a'.repeat(64),
          outlineHash: 'b'.repeat(64),
          theme: 'storytelling',
          requiredSlideIndexes: [1],
          sourcePlan: { path: 'brief/source-plan.json', contentHash: digest(Buffer.from(plan)) },
        },
      },
    });
    harness.daemon.onRun = ({ workspaceDir, index, body }) => {
      if (index === 1) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), `<!doctype html><html><body><main><div class="reveal"><div class="slides"><section>${initialBody(id)}</section></div></div></main></body></html>`);
      }
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };

    const view = await runToEnd(pkg);

    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    expect(harness.daemon.runBodies).toHaveLength(2);
    expect(await statusReasons(pkg.runId)).not.toContain('open_design_quality_repairing');
    const committed = map!.commits[0].files.find((file: { path: string }) => file.path === 'index.html');
    expect(Buffer.from(committed.contentBase64, 'base64').toString('utf8')).toContain(initialBody(id));
  });

  it('materializes an edit into the author root while keeping the frozen parent and source package byte-identical', async () => {
    const id = `sb-${'7'.repeat(64)}`;
    const sourceHtml = '<p>5% 只是示例，不是强制值。</p>';
    const parentHtml = '<!doctype html><html><body><main><div class="reveal"><div class="slides"><section>父版本</section></div></div></main></body></html>';
    const proposalHtml = parentHtml.replace('父版本', '用户修改后的版本');
    const plan = JSON.stringify({
      SchemaVersion: 'map-mdppt-source-plan-v2',
      Fingerprint: 'frozen',
      Blocks: [{ Id: id, Html: sourceHtml }],
      Pages: [{ Index: 1, Hash: 'page', DisplayTitle: '发布策略', Blocks: [{ Id: id }] }],
    });
    harness = await startHarness({ overrides: {
      browserQualityRunner: {
        run: async (job) => {
          expect(fs.readFileSync(path.join(job.workspaceDir, 'current', 'index.html'), 'utf8')).toBe(parentHtml);
          expect(fs.readFileSync(path.join(job.workspaceDir, 'brief', 'source-plan.json'), 'utf8')).toBe(plan);
          expect(fs.readFileSync(path.join(job.workspaceDir, 'index.html'), 'utf8')).toContain(`data-mdppt-source="${id}"`);
          return passingBrowserResult(job);
        },
      },
    } });
    const pkg = buildPackage([
      { path: 'current/index.html', content: parentHtml, mediaType: 'text/html' },
      { path: 'brief/source-plan.json', content: plan, mediaType: 'application/json' },
      { path: 'proposal/manual-edit.html', content: proposalHtml, mediaType: 'text/html' },
      { path: 'knowledge/source.md', content: '5% 只是示例，不是强制值。', mediaType: 'text/markdown' },
    ], {
      taskExtras: {
        presentationContract: {
          schemaVersion: 'map-html-ppt-contract-v1', version: 2, targetPages: 1,
          sourceContentHash: 'a'.repeat(64), outlineHash: 'b'.repeat(64), theme: 'storytelling',
          requiredSlideIndexes: [1],
          sourcePlan: { path: 'brief/source-plan.json', contentHash: digest(Buffer.from(plan)) },
          manualEditProposal: {
            authority: 'user-authored-untrusted-proposal',
            path: 'proposal/manual-edit.html',
            contentHash: digest(Buffer.from(proposalHtml)),
          },
        },
      },
    });
    harness.daemon.onRun = ({ body, workspaceDir, index }) => {
      if (index === 1) {
        expect(String(body.systemPrompt)).toContain('/workspace/current/ is the read-only authoritative reference');
        expect(String(body.systemPrompt)).toContain('Modify only the editable working copy already seeded at /workspace/index.html');
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), `<!doctype html><html><body><main><div class="reveal"><div class="slides"><section data-slide-index="1"><div data-mdppt-source="${id}"></div></section></div></div></main></body></html>`);
      }
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };

    const view = await runToEnd(pkg);

    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    const committed = map!.commits[0].files.find((file: { path: string }) => file.path === 'index.html');
    expect(Buffer.from(committed.contentBase64, 'base64').toString('utf8')).toContain(`data-mdppt-source="${id}"`);
    expect(Buffer.from(committed.contentBase64, 'base64').toString('utf8')).not.toContain(sourceHtml);
  });

  it('rejects a presentation edit that changes the frozen current reference instead of its editable root copy', async () => {
    const parentHtml = '<!doctype html><html><body><main><h1>父版本</h1></main></body></html>';
    const proposalHtml = parentHtml.replace('父版本', '用户修改后的版本');
    harness = await startHarness();
    const pkg = buildPackage([
      { path: 'current/index.html', content: parentHtml, mediaType: 'text/html' },
      { path: 'proposal/manual-edit.html', content: proposalHtml, mediaType: 'text/html' },
    ], {
      taskExtras: {
        presentationContract: {
          schemaVersion: 'map-html-ppt-contract-v1', version: 2, targetPages: 1,
          sourceContentHash: 'a'.repeat(64), outlineHash: 'b'.repeat(64), theme: 'storytelling',
          requiredSlideIndexes: [1],
          manualEditProposal: {
            authority: 'user-authored-untrusted-proposal',
            path: 'proposal/manual-edit.html',
            contentHash: digest(Buffer.from(proposalHtml)),
          },
        },
      },
    });
    harness.daemon.onRun = ({ workspaceDir, index }) => {
      if (index === 1) {
        expect(fs.readFileSync(path.join(workspaceDir, 'index.html'), 'utf8')).toBe(parentHtml);
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), proposalHtml);
        fs.writeFileSync(path.join(workspaceDir, 'current', 'index.html'), proposalHtml);
      }
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };

    const view = await runToEnd(pkg);

    expect(view.error.code).toBe('workspace_input_changed');
    expect(map!.commits).toHaveLength(0);
  });

  it.skipIf(!hasExternalCompletionChainFixture())(
    'replays the authoritative 210-block failed deck through generation and manual-edit quality packages',
    async () => {
      const sourcePlanPath = process.env.PPT_COMPLETION_SOURCE_PLAN_PATH!;
      const sourceMarkdownPath = process.env.PPT_COMPLETION_SOURCE_MD_PATH!;
      const failedHtmlPath = process.env.PPT_COMPLETION_FAILED_HTML_PATH!;
      const outputDir = process.env.PPT_COMPLETION_CHAIN_OUTPUT_DIR!;
      const sourcePlanJson = fs.readFileSync(sourcePlanPath, 'utf8');
      const sourceMarkdown = fs.readFileSync(sourceMarkdownPath, 'utf8');
      const failedHtml = fs.readFileSync(failedHtmlPath, 'utf8');
      expect(digest(Buffer.from(sourcePlanJson))).toBe('f811184612a2379787782f123531347bb4cd7db90600217d5f81f363fa3f3cb2');
      expect(digest(Buffer.from(sourceMarkdown))).toBe('ba22ff9d8b26081dfb409fdf565529dde2e06831e9730c5be8e9f727b07fc450');
      expect(digest(Buffer.from(failedHtml))).toBe('fc969b204cef68b7c5c6875ecba528654801ca6992ee48701da8079046ff9fa4');
      const parsedPlan = parseExternalSourcePlan(sourcePlanJson);
      expect(parsedPlan.Blocks).toHaveLength(210);
      expect(parsedPlan.Pages).toHaveLength(34);
      expect(parsedPlan.Fingerprint).toBe('93fea52f8a30d753cf1d49e80732d8fd4bb788b53a138320e2b9e5d80de30646');

      harness = await startHarness({ overrides: { browserQualityRunner: { run: runBrowserWorker } } });
      const generationPackage = buildPackage([
        { path: 'brief/source-plan.json', content: sourcePlanJson, mediaType: 'application/json' },
        { path: 'candidate/index.html', content: failedHtml, mediaType: 'text/html' },
        { path: 'knowledge/source.md', content: sourceMarkdown, mediaType: 'text/markdown' },
      ], {
        runId: 'completion-chain-generation',
        taskExtras: {
          presentationContract: {
            schemaVersion: 'map-html-ppt-contract-v1', version: 2, targetPages: parsedPlan.Pages.length,
            sourceContentHash: 'a'.repeat(64), outlineHash: 'b'.repeat(64), theme: 'storytelling',
            requiredSlideIndexes: parsedPlan.Pages.map((page) => page.Index),
            sourcePlan: { path: 'brief/source-plan.json', contentHash: digest(Buffer.from(sourcePlanJson)) },
            repairCandidate: { path: 'candidate/index.html', contentHash: digest(Buffer.from(failedHtml)) },
          },
        },
      });
      harness.daemon.onRun = ({ workspaceDir, index }) => {
        const generatedDeck = buildExternalReadableDeck(parsedPlan, '完成链受控父稿');
        if (index === 1) {
          expect(fs.readFileSync(path.join(workspaceDir, 'index.html'), 'utf8')).toBe(failedHtml);
          fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(outputDir, 'generation-authored-diagnostic.html'), generatedDeck, { mode: 0o600 });
        }
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), generatedDeck);
        return { status: 'succeeded', deliverableEntryFile: 'index.html' };
      };
      const generation = await runToEnd(
        generationPackage,
        (request) => withPublicOutputCap(request, 6 * 1024 * 1024),
        120_000,
      );
      expect(generation.state, JSON.stringify(generation.error)).toBe('succeeded');
      const generationCommit = map!.commits.at(-1)! as FakeMapCommit;
      const generationHtml = committedHtml(generationCommit);
      expect([...generationHtml.matchAll(/data-mdppt-source=["']([^"']+)["']/g)]).toHaveLength(210);
      const generationPackageHash = digest(Buffer.from(JSON.stringify(generationCommit)));
      await harness.close();
      await map!.close();
      harness = undefined;
      map = undefined;

      const manualPlan = structuredClone(parsedPlan);
      const editedBlock = manualPlan.Blocks.slice(1).find((block) => /<p>[^<]*\S[^<]*<\/p>/.test(block.Html));
      expect(editedBlock).toBeDefined();
      const originalBlockHtml = editedBlock!.Html;
      editedBlock!.Html = originalBlockHtml.replace(/>([^<]*\S[^<]*)</, '>$1（用户确认的等义表述）<');
      expect(editedBlock!.Html).not.toBe(originalBlockHtml);
      const manualPlanJson = JSON.stringify(manualPlan);
      harness = await startHarness({ overrides: { browserQualityRunner: { run: runBrowserWorker } } });
      const manualPackage = buildPackage([
        { path: 'current/index.html', content: generationHtml, mediaType: 'text/html' },
        { path: 'brief/source-plan.json', content: manualPlanJson, mediaType: 'application/json' },
        { path: 'knowledge/source.md', content: sourceMarkdown, mediaType: 'text/markdown' },
      ], {
        runId: 'completion-chain-manual',
        baseRevision: generationPackageHash,
        taskExtras: {
          presentationContract: {
            schemaVersion: 'map-html-ppt-contract-v1', version: 2, targetPages: manualPlan.Pages.length,
            sourceContentHash: 'a'.repeat(64), outlineHash: 'b'.repeat(64), theme: 'storytelling',
            requiredSlideIndexes: manualPlan.Pages.map((page) => page.Index),
            sourcePlan: { path: 'brief/source-plan.json', contentHash: digest(Buffer.from(manualPlanJson)) },
          },
        },
      });
      harness.daemon.onRun = ({ workspaceDir, index }) => {
        if (index === 1) {
          expect(fs.readFileSync(path.join(workspaceDir, 'current', 'index.html'), 'utf8')).toBe(generationHtml);
        }
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), buildExternalReadableDeck(manualPlan, '完成链用户修订稿'));
        return { status: 'succeeded', deliverableEntryFile: 'index.html' };
      };
      const manual = await runToEnd(
        manualPackage,
        (request) => withPublicOutputCap(request, 6 * 1024 * 1024),
        120_000,
      );
      expect(manual.state, JSON.stringify(manual.error)).toBe('succeeded');
      const manualCommit = map!.commits.at(-1)! as FakeMapCommit;
      const manualHtml = committedHtml(manualCommit);
      expect(manualHtml).toContain('完成链用户修订稿');
      expect(manualHtml).toContain(editedBlock!.Html);
      expect(manualHtml).not.toContain(originalBlockHtml);
      expect([...manualHtml.matchAll(/data-mdppt-source=["']([^"']+)["']/g)]).toHaveLength(210);

      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(outputDir, 0o700);
      const generationHtmlPath = path.join(outputDir, 'generation-parent.html');
      const manualHtmlPath = path.join(outputDir, 'manual-final.html');
      const generationResultPath = path.join(outputDir, 'generation-result.json');
      const manualResultPath = path.join(outputDir, 'manual-result.json');
      const receiptPath = path.join(outputDir, 'runtime-chain-receipt.json');
      const generationResultJson = JSON.stringify(generationCommit);
      const manualResultJson = JSON.stringify(manualCommit);
      const summarizeFiles = (commit: typeof generationCommit) => commit.files.map((file) => ({
        path: file.path,
        size: Buffer.from(file.contentBase64, 'base64').byteLength,
        sha256: file.sha256,
        mediaType: file.mediaType,
      }));
      const generationFiles = summarizeFiles(generationCommit);
      const manualFiles = summarizeFiles(manualCommit);
      fs.writeFileSync(generationHtmlPath, generationHtml, { mode: 0o600 });
      fs.writeFileSync(manualHtmlPath, manualHtml, { mode: 0o600 });
      fs.writeFileSync(generationResultPath, generationResultJson, { mode: 0o600 });
      fs.writeFileSync(manualResultPath, manualResultJson, { mode: 0o600 });
      fs.writeFileSync(receiptPath, JSON.stringify({
        schemaVersion: 'ppt-free-completion-runtime-chain-v1',
        sourcePlanSha256: digest(Buffer.from(sourcePlanJson)),
        stableSourceHash: parsedPlan.Fingerprint,
        sourceBlockCount: parsedPlan.Blocks.length,
        pageCount: parsedPlan.Pages.length,
        failedCandidateSha256: digest(Buffer.from(failedHtml)),
        generation: {
          runId: generationPackage.runId,
          htmlPath: generationHtmlPath,
          htmlSha256: digest(Buffer.from(generationHtml)),
          resultPath: generationResultPath,
          resultSha256: digest(Buffer.from(generationResultJson)),
          packageSha256: generationPackageHash,
          fileCount: generationFiles.length,
          browserEvidenceCount: generationFiles.filter((file) => file.path.startsWith('assets/quality/') && file.mediaType === 'image/png').length,
          files: generationFiles,
          publicFileBytes: generationCommit.files.reduce((total, file) => total + Buffer.from(file.contentBase64, 'base64').byteLength, 0),
          serializedResultBytes: Buffer.byteLength(JSON.stringify(generationCommit)),
        },
        manual: {
          runId: manualPackage.runId,
          parentRunId: generationPackage.runId,
          parentPackageSha256: generationPackageHash,
          htmlPath: manualHtmlPath,
          htmlSha256: digest(Buffer.from(manualHtml)),
          resultPath: manualResultPath,
          resultSha256: digest(Buffer.from(manualResultJson)),
          packageSha256: digest(Buffer.from(JSON.stringify(manualCommit))),
          fileCount: manualFiles.length,
          browserEvidenceCount: manualFiles.filter((file) => file.path.startsWith('assets/quality/') && file.mediaType === 'image/png').length,
          files: manualFiles,
          publicFileBytes: manualCommit.files.reduce((total, file) => total + Buffer.from(file.contentBase64, 'base64').byteLength, 0),
          serializedResultBytes: Buffer.byteLength(JSON.stringify(manualCommit)),
          nonSourceEdit: '完成链受控父稿 -> 完成链用户修订稿',
          editedSourceBlockId: editedBlock!.Id,
        },
        stubs: {
          model: 'FakeOpenDesign writes a deterministic readable layout while production executor still owns workspace, source materialization, preview, quality, browser, and package flow.',
          mapTransfer: 'in-process authenticated FakeMap input, preview, and result endpoints',
          storage: 'local temporary workspace and task-external evidence directory',
        },
      }, null, 2), { mode: 0o600 });
      for (const file of [generationHtmlPath, manualHtmlPath, generationResultPath, manualResultPath, receiptPath]) fs.chmodSync(file, 0o600);
    },
    180_000,
  );

  it('enforces the public byte cap before commit and keeps legacy transfers on their envelope cap', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    harness.daemon.onRun = ({ workspaceDir }) => {
      fs.mkdirSync(path.join(workspaceDir, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>受控页面</main></body></html>');
      fs.writeFileSync(path.join(workspaceDir, 'assets', 'large.bin'), Buffer.alloc(2048, 7));
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };
    const rejected = await runToEnd(pkg, (request) => withPublicOutputCap(request, 1024));
    expect(rejected.state).toBe('failed');
    expect(rejected.error.code).toBe('design_output_too_large');
    expect(map!.commits).toHaveLength(0);

    await harness.close();
    await map!.close();
    harness = await startHarness();
    const legacy = buildPackage([]);
    harness.daemon.onRun = ({ workspaceDir }) => {
      fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>兼容页面</main></body></html>');
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };
    const legacyView = await runToEnd(legacy, (request) => {
      const transfer = { ...request.transfer } as TaskRequest['transfer'] & { maxPublicOutputBytes?: number };
      delete transfer.maxPublicOutputBytes;
      return { ...request, transfer };
    });
    expect(legacyView.state, JSON.stringify(legacyView.error)).toBe('succeeded');
  });

  it('rejects an inconsistent public byte cap before opening OpenDesign', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    const request = taskRequest(map, pkg);
    const submitted = await harness.request('POST', '/v1/tasks', {
      ...request,
      transfer: { ...request.transfer, maxOutputBytes: 1024, maxPublicOutputBytes: 2048 },
    }, auth);
    expect(submitted.status).toBe(400);
    expect(submitted.body.error.code).toBe('workspace_transfer_invalid');
    expect(harness.daemon.runBodies).toHaveLength(0);
    expect(map!.commits).toHaveLength(0);
  });

});

type TaskRequest = ReturnType<typeof taskRequest>;
type FakeMapCommit = {
  files: Array<{
    path: string;
    contentBase64: string;
    sha256: string;
    mediaType: string;
  }>;
};

function withPublicOutputCap(request: TaskRequest, maxPublicOutputBytes: number): TaskRequest {
  return {
    ...request,
    transfer: {
      ...request.transfer,
      maxOutputBytes: 20 * 1024 * 1024,
      maxPublicOutputBytes,
    },
  } as TaskRequest;
}

async function runToEnd(
  pkg: BuiltPackage,
  mutate: (request: TaskRequest) => TaskRequest = (request) => request,
  timeoutMs = 10_000,
) {
  map = await startFakeMap(pkg);
  const submitted = await harness!.request('POST', '/v1/tasks', mutate(taskRequest(map, pkg)), auth);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
  return waitFor(async () => {
    const response = await harness!.request('GET', `/v1/tasks/${pkg.runId}`, undefined, auth);
    return response.body.task?.state !== 'running' ? response.body.task : undefined;
  }, 'task to finish', timeoutMs);
}

async function statusReasons(taskId: string): Promise<string[]> {
  const events = (await harness!.request('GET', `/v1/tasks/${taskId}/events`, undefined, auth)).body.events;
  return events.filter((event: { type: string }) => event.type === 'status').map((event: { payload: { reason: string } }) => event.payload.reason);
}

type ExternalSourcePlan = {
  Fingerprint: string;
  Blocks: Array<{ Id: string; Html: string }>;
  Pages: Array<{ Index: number; DisplayTitle?: string; Blocks: Array<{ Id: string }> }>;
};

function hasExternalCompletionChainFixture(): boolean {
  return [
    process.env.PPT_COMPLETION_SOURCE_PLAN_PATH,
    process.env.PPT_COMPLETION_SOURCE_MD_PATH,
    process.env.PPT_COMPLETION_FAILED_HTML_PATH,
    process.env.PPT_COMPLETION_CHAIN_OUTPUT_DIR,
  ].every((value) => Boolean(value?.trim()));
}

function parseExternalSourcePlan(json: string): ExternalSourcePlan {
  return JSON.parse(json) as ExternalSourcePlan;
}

function escapeExternalText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function buildExternalReadableDeck(plan: ExternalSourcePlan, deckTitle: string): string {
  const blockIds = new Set(plan.Blocks.map((block) => block.Id));
  const sections = plan.Pages.map((page, pageOffset) => {
    const source = page.Blocks.map(({ Id }) => {
      if (!blockIds.has(Id)) throw new Error(`missing source block ${Id}`);
      return `<div data-mdppt-source="${escapeExternalText(Id)}"></div>`;
    }).join('');
    return `<section id="slide-${page.Index}" data-slide-index="${page.Index}"${pageOffset === 0 ? ' class="active"' : ''}><header><span>${page.Index.toString().padStart(2, '0')} / ${plan.Pages.length}</span><div><p class="deck-label">${escapeExternalText(deckTitle)}</p><h2>${escapeExternalText(page.DisplayTitle || `第 ${page.Index} 页`)}</h2></div></header><div class="source-grid">${source}</div></section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeExternalText(deckTitle)}</title><style>
  *{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Arial,"PingFang SC",sans-serif;background:#f4f7fb;color:#172033}body{position:relative}.reveal{min-height:100vh}.slides>section{display:none;min-height:100vh;padding:82px 32px 32px}.slides>section.active{display:block}header{display:flex;align-items:center;gap:18px;margin-bottom:18px;border-bottom:2px solid #2c5fd5;padding-bottom:12px}header span{font-weight:700;color:#2c5fd5}.deck-label{margin:0 0 3px;color:#51617b;font-size:12px;font-weight:700}h2{font-size:28px;margin:0}.source-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.source-grid>[data-mdppt-source]{min-width:0;border:1px solid #cad4e7;border-radius:10px;background:#fff;padding:12px;font-size:14px;line-height:1.45;overflow-wrap:anywhere}.source-grid>[data-mdppt-source] h1,.source-grid>[data-mdppt-source] h2,.source-grid>[data-mdppt-source] h3{font-size:16px;margin:0 0 6px}.source-grid>[data-mdppt-source] p,.source-grid>[data-mdppt-source] ul,.source-grid>[data-mdppt-source] ol{margin:4px 0}pre,code{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}table{width:100%;table-layout:fixed;border-collapse:collapse}th,td{overflow-wrap:anywhere}.deck-nav{position:absolute;z-index:20;top:18px;right:24px;display:flex;justify-content:center;gap:12px}.deck-nav button{min-width:88px;padding:9px 14px;border:0;border-radius:8px;background:#2c5fd5;color:#fff;font-weight:700}.deck-nav button:disabled{background:#53657f}@media(max-width:640px){.slides>section{padding:78px 16px 24px}.source-grid{grid-template-columns:1fr}h2{font-size:22px}.source-grid>[data-mdppt-source]{font-size:14px}.deck-nav{top:14px;right:16px}}
  </style></head><body><main class="reveal"><div class="slides">${sections}</div></main><nav class="deck-nav" aria-label="演示稿导航"><button id="prev" type="button">上一页</button><button id="next" type="button">下一页</button></nav><script>
  const slides=[...document.querySelectorAll('.slides>section')];let current=0;function show(index){current=Math.max(0,Math.min(slides.length-1,index));slides.forEach((slide,i)=>slide.classList.toggle('active',i===current));document.getElementById('prev').disabled=current===0;document.getElementById('next').disabled=current===slides.length-1;history.replaceState(null,'','#slide-'+(current+1));}globalThis.Reveal={slide:show,getIndices:()=>({h:current})};document.getElementById('prev').addEventListener('click',()=>show(current-1));document.getElementById('next').addEventListener('click',()=>show(current+1));show(Math.max(0,Number(location.hash.replace('#slide-',''))-1||0));
  </script></body></html>`;
}

function committedHtml(commit: { files: Array<{ path: string; contentBase64: string }> }): string {
  const file = commit.files.find((item) => item.path === 'index.html');
  if (!file) throw new Error('committed package is missing index.html');
  return Buffer.from(file.contentBase64, 'base64').toString('utf8');
}

describe('public output boundary', () => {
  it('keeps the native deck assets README private without allowing public Markdown', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    harness.daemon.onRun = ({ workspaceDir, index }) => {
      if (index === 1) {
        fs.mkdirSync(path.join(workspaceDir, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="assets/deck.css"></head><body><main><h1>Native deck</h1><p>完整可见正文。</p></main></body></html>');
        fs.writeFileSync(path.join(workspaceDir, 'assets/deck.css'), 'body { color: #123; }');
        fs.writeFileSync(path.join(workspaceDir, 'assets/README.md'), '# Agent workspace notes\nThis file is not a public page resource.\n');
      }
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };

    const view = await runToEnd(pkg);
    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    const committedPaths = map!.commits[0].files.map((file: { path: string }) => file.path);
    expect(committedPaths).toContain('assets/deck.css');
    expect(committedPaths).not.toContain('assets/README.md');

    const markdown = Buffer.from('# Public notes');
    expect(() => buildGeneratedPublicArtifactPackage('<!doctype html><html><body>Public</body></html>', [{
      path: 'assets/NOTES.md',
      contentBase64: markdown.toString('base64'),
      sha256: digest(markdown),
      size: markdown.length,
      mediaType: 'text/markdown; charset=utf-8',
    }])).toThrow(AgentWorkspaceRuntimeError);
  });
});

describe('edit runs seeded from the current published site', () => {
  it.each([[false, true], [true, true]])('seeds complete edit resources and never restores deleted output: delete=%s reports=%s', async (removeAsset, includeReports) => {
    harness = await startHarness();
    const html = '<!doctype html><html><head><title>Library</title></head><body><main><h1>Original sentence.</h1><p>Library information.</p></main></body></html>';
    const metadataPaths = ['assets/accessibility-static-report.json', 'assets/design-tokens.json', 'assets/page-outline.json', 'assets/provenance.json'];
    const browserEvidence = [
      { path: 'assets/visual-quality-report.json', content: '{"schemaVersion":"map-browser-quality-v1","attempts":[]}', mediaType: 'application/json; charset=utf-8' },
      { path: 'assets/quality/attempt-0-desktop.png', content: Buffer.from('previous desktop screenshot'), mediaType: 'image/png' },
      { path: 'assets/quality/attempt-0-mobile.png', content: Buffer.from('previous mobile screenshot'), mediaType: 'image/png' },
    ].map((file) => ({
      path: file.path,
      contentBase64: Buffer.from(file.content).toString('base64'),
      sha256: digest(Buffer.from(file.content)),
      size: Buffer.byteLength(file.content),
      mediaType: file.mediaType,
    }));
    const browserEvidencePaths = browserEvidence.map((file) => file.path);
    const assets = [
      { path: 'assets/site.css', content: 'body { color: #123; }', mediaType: 'text/css' },
      { path: 'assets/app.js', content: 'document.documentElement.dataset.ready = "yes";', mediaType: 'application/javascript' },
      { path: 'assets/pixel.png', content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6hQAAAABJRU5ErkJggg==', 'base64'), mediaType: 'image/png' },
    ];
    const oldPackage = buildGeneratedPublicArtifactPackage(hardenSelfContainedHtml(html), assets.map((file) => ({
      path: file.path, contentBase64: Buffer.from(file.content).toString('base64'), sha256: digest(Buffer.from(file.content)),
      size: Buffer.byteLength(file.content), mediaType: file.path.endsWith('.css') ? 'text/css; charset=utf-8' : file.path.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.mediaType,
    })), browserEvidence);
    const inputFiles = [
      { path: 'current/index.html', content: html, mediaType: 'text/html' },
      ...assets.map((file) => ({ ...file, path: `current/${file.path}` })),
      ...oldPackage.filter((file) => metadataPaths.includes(file.path) || browserEvidencePaths.includes(file.path) || file.path === 'manifest.json').map((file) => ({
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
        for (const filePath of [...metadataPaths, ...browserEvidencePaths, 'manifest.json']) {
          expect(fs.existsSync(path.join(workspaceDir, filePath))).toBe(false);
          expect(fs.existsSync(path.join(workspaceDir, 'current', filePath))).toBe(true);
        }
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), html.replace('Original sentence.', 'Updated sentence.'));
        fs.writeFileSync(path.join(workspaceDir, 'current/index.html.artifact.json'), '{"runtime":"metadata"}');
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
        const expected = buildGeneratedArtifactFiles(
          hardenSelfContainedHtml(html.replace('Original sentence.', 'Updated sentence.')),
          assets.filter((asset) => !removeAsset || asset.path !== 'assets/pixel.png').map((asset) => asset.path),
          ['assets/quality/attempt-0-desktop.png', 'assets/quality/attempt-0-mobile.png', 'assets/visual-quality-report.json'],
        ).find((item) => item.path === filePath);
        expect(file).toEqual(expected);
      } else expect(file).toBeUndefined();
    }
    const manifest = JSON.parse(Buffer.from(committed.files.find((item: { path: string }) => item.path === 'manifest.json').contentBase64, 'base64').toString('utf8'));
    expect(manifest.artifactRevision).toBe(computePublicArtifactRevision(committed.files.filter((item: { path: string }) => item.path !== 'manifest.json')));
    expect(Buffer.from(committed.files.find((item: { path: string }) => item.path === 'index.html').contentBase64, 'base64').toString('utf8')).toContain('Updated sentence.');
    expect(committed.files.some((item: { path: string }) => item.path === 'current/index.html.artifact.json')).toBe(false);
  });

  it('rejects a legacy output allowlist that cannot retain browser quality evidence', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    harness.daemon.onRun = ({ workspaceDir, index }) => {
      if (index === 1) expect(fs.existsSync(path.join(workspaceDir, 'index.html'))).toBe(false);
      fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>Launch page</main></body></html>');
      return { status: 'succeeded' };
    };
    const view = await runToEnd(pkg, (request) => ({
      ...request,
      transfer: { ...request.transfer, allowedOutputPaths: ['index.html', 'manifest.json'] },
    }));
    expect(view.error.code).toBe('workspace_quality_evidence_unsupported');
    expect(map!.commits).toHaveLength(0);
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
    expect(harness.daemon.imports[0].skillId).toBe('web-prototype');
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
    expect(harness.daemon.conversations).toEqual([{
      title: 'MAP quality review map-run-1',
      sessionMode: 'design',
    }]);
    expect(runBodies[0].conversationId).toBe('od-conversation');
    expect(runBodies.slice(1).every((body) => body.conversationId === 'od-quality-conversation-1')).toBe(true);
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
    expect(harness.daemon.conversations).toHaveLength(0);
    expect(view.result.openDesignRunId).toBe('od-run-1');
  });

  it('bounds a slow review, restores the last verified output, and still runs the browser hard gate', async () => {
    const browserInputs: string[] = [];
    harness = await startHarness({ overrides: {
      browserQualityRunner: {
        run: async (job) => {
          browserInputs.push(fs.readFileSync(path.join(job.workspaceDir, 'index.html'), 'utf8'));
          fs.mkdirSync(job.evidenceDir, { recursive: true });
          return {
            browserVersion: 'test-chromium',
            measurements: [
              { viewport: 'desktop' as const, width: 1440, height: 900 },
              { viewport: 'mobile' as const, width: 390, height: 844 },
            ].map((viewport) => {
              const screenshotPath = `assets/quality/${viewport.viewport}.png`;
              fs.writeFileSync(path.join(job.evidenceDir, path.basename(screenshotPath)), Buffer.from([137, 80, 78, 71]));
              return {
                ...viewport,
                documentWidth: viewport.width,
                h1Count: 1,
                visibleHeadingCount: 1,
                visibleCtaCount: 1,
                visibleLandmarkCount: 1,
                issues: [],
                screenshotPath,
              };
            }),
          };
        },
      },
    } });
    const pkg = buildPackage([], { taskExtras: { designDirection: direction } });
    harness.daemon.onRun = async ({ workspaceDir, index, signal }) => {
      fs.mkdirSync(path.join(workspaceDir, 'assets'), { recursive: true });
      if (index === 1) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main><h1>verified-main</h1></main></body></html>');
        fs.writeFileSync(path.join(workspaceDir, 'assets/site.css'), 'main { display: block; }');
        return { status: 'succeeded', deliverableEntryFile: 'index.html' };
      }
      fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>partial-review</main></body></html>');
      fs.writeFileSync(path.join(workspaceDir, 'assets/site.css'), 'partial-review');
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'succeeded' };
    };

    const view = await runToEnd(pkg, (request) => ({ ...request, timeoutSeconds: 30 }));

    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    expect(harness.daemon.runBodies).toHaveLength(2);
    expect(harness.daemon.cancels).toContain('od-run-2');
    expect(view.result.openDesignRunId).toBe('od-run-1');
    expect(browserInputs).toHaveLength(1);
    expect(browserInputs[0]).toContain('verified-main');
    expect(browserInputs[0]).not.toContain('partial-review');
    const committedIndex = map!.commits[0].files.find((file: { path: string }) => file.path === 'index.html');
    const committedCss = map!.commits[0].files.find((file: { path: string }) => file.path === 'assets/site.css');
    expect(Buffer.from(committedIndex.contentBase64, 'base64').toString('utf8')).toContain('verified-main');
    expect(Buffer.from(committedCss.contentBase64, 'base64').toString('utf8')).toBe('main { display: block; }');
    expect(await statusReasons(pkg.runId)).toEqual(expect.arrayContaining([
      'open_design_reviewing',
      'open_design_review_budget_exhausted',
      'open_design_browser_quality_checking',
    ]));
  }, 15_000);

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
    const resolved = events.find((event: { payload: { reason?: string; promoted?: boolean } }) => event.payload.reason === 'deliverable_entry_checkpointed' && event.payload.promoted);
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
    ['an unrelated current sidecar', (workspaceDir: string) => { fs.mkdirSync(path.join(workspaceDir, 'current')); fs.writeFileSync(path.join(workspaceDir, 'current/runtime-state.json'), '{}'); }, 'design_output_invalid'],
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

  it('bounds deterministic repair before finalization and checkpoints the timed-out candidate without committing it', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    harness.daemon.onRun = async ({ workspaceDir, index, signal }) => {
      if (index === 1) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main><a href="#missing">trusted-invalid</a></main></body></html>');
      }
      if (index === 3) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>partial-repair</main></body></html>');
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };

    const view = await runToEnd(pkg, (request) => ({ ...request, timeoutSeconds: 30 }));

    expect(view.state).toBe('failed');
    expect(view.error.code).toBe('design_output_quality_rejected');
    expect(view.error.details).toMatchObject({
      issueCodes: ['missing_fragment_target'],
      repairAttempts: 1,
      repairBudgetExhausted: true,
    });
    expect(harness.daemon.cancels).toContain('od-run-3');
    expect(harness.daemon.freezes).toBe(harness.daemon.thaws);
    expect(map!.commits).toHaveLength(0);
    expect(map!.previews.at(-1)?.html).toContain('partial-repair');
    expect(await statusReasons(pkg.runId)).toEqual(expect.arrayContaining([
      'open_design_quality_repairing',
      'open_design_quality_repair_budget_exhausted',
    ]));
    const events = (await harness.request('GET', `/v1/tasks/${pkg.runId}/events`, undefined, auth)).body.events;
    const terminal = events.find((event: { type: string }) => event.type === 'error');
    expect(terminal.payload.details).toMatchObject({
      issueCodes: ['missing_fragment_target'],
      repairAttempts: 1,
      repairBudgetExhausted: true,
    });
  });

  it('records presentation browser findings without triggering an automatic paid repair', async () => {
    const firstSourceId = `sb-${'a'.repeat(64)}`;
    const secondSourceId = `sb-${'b'.repeat(64)}`;
    const firstSourceHtml = '<p>Frozen release conditions stay visible while layout is repaired.</p>';
    const secondSourceHtml = '<p>Frozen rollback steps stay visible while layout is repaired.</p>';
    const sourcePlan = JSON.stringify({
      SchemaVersion: 'map-mdppt-source-plan-v2',
      Fingerprint: 'frozen-browser-repair',
      Blocks: [
        { Id: firstSourceId, Html: firstSourceHtml },
        { Id: secondSourceId, Html: secondSourceHtml },
      ],
      Pages: [{ Index: 1, Hash: 'page', DisplayTitle: 'Release contract', Blocks: [{ Id: firstSourceId }, { Id: secondSourceId }] }],
    });
    const seenAttempts: number[] = [];
    const seenEvidenceDirs: string[] = [];
    harness = await startHarness({ overrides: {
      browserQualityRunner: {
        run: async (job) => {
          seenAttempts.push(job.repairAttempt);
          seenEvidenceDirs.push(job.evidenceDir);
          fs.mkdirSync(job.evidenceDir, { recursive: true });
          const authored = fs.readFileSync(path.join(job.workspaceDir, 'index.html'), 'utf8');
          expect(authored).toContain(`data-mdppt-source="${firstSourceId}"`);
          expect(authored).not.toContain(firstSourceHtml);
          const measurements = [
            { viewport: 'desktop' as const, width: 1440, height: 900 },
            { viewport: 'mobile' as const, width: 390, height: 844 },
          ].map((viewport) => {
            const screenshotPath = `assets/quality/attempt-${job.repairAttempt}-${viewport.viewport}.png`;
            fs.writeFileSync(path.join(job.evidenceDir, path.basename(screenshotPath)), Buffer.from([137, 80, 78, 71]));
            const actual: BrowserQualityIssue['actual'] = viewport.viewport === 'mobile'
              ? { measured: 12 }
              : {
                slideIndex: 1,
                sourceSlotCount: 2,
                unreadableSourceSlotCount: 2,
                invisibleSourceSlotCount: 0,
                clippedSourceSlotCount: 0,
                overflowingSourceSlotCount: 2,
                minimumSlotWidth: 3,
                maximumScrollWidth: 96,
                maximumScrollHeight: 1952,
              };
            return {
              ...viewport,
              documentWidth: viewport.width,
              h1Count: 1,
              visibleHeadingCount: 2,
              visibleCtaCount: 1,
              visibleLandmarkCount: 2,
              issues: job.repairAttempt < 2 ? [{
                issueCode: viewport.viewport === 'mobile'
                  ? 'mobile_navigation_unusable' as const
                  : 'presentation_source_content_unreadable' as const,
                severity: 'hard' as const,
                ruleVersion: 'browser-hard-gate-v1' as const,
                viewport: viewport.viewport,
                actual,
                target: viewport.viewport === 'mobile'
                  ? 'measured hard target'
                  : 'every materialized source block fits inside a visible readable box on its assigned slide',
                element: { tag: 'main', id: 'content' },
              }] : [],
              screenshotPath,
            };
          });
          return { browserVersion: 'test-chromium', measurements };
        },
      },
    } });
    const pkg = buildPackage([
      { path: 'brief/source-plan.json', content: sourcePlan, mediaType: 'application/json' },
    ], {
      taskExtras: {
        presentationContract: {
          schemaVersion: 'map-html-ppt-contract-v1', version: 2, targetPages: 1,
          sourceContentHash: 'a'.repeat(64), outlineHash: 'b'.repeat(64), theme: 'storytelling',
          requiredSlideIndexes: [1],
          sourcePlan: { path: 'brief/source-plan.json', contentHash: digest(Buffer.from(sourcePlan)) },
        },
      },
    });
    harness.daemon.onRun = ({ workspaceDir, index, body }) => {
      if (index === 1) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), `<!doctype html><html><body><main id="content" class="reveal"><div class="slides"><section data-slide-index="1"><h1>Launch page</h1><div class="source-rail"><div data-mdppt-source="${firstSourceId}"></div><div data-mdppt-source="${secondSourceId}"></div></div></section></div></main></body></html>`);
      }
      return { status: 'succeeded' };
    };
    const view = await runToEnd(pkg);
    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    expect(seenAttempts).toEqual([0]);
    expect(seenEvidenceDirs.every((dir) => dir.startsWith(path.dirname(harness!.config.outputDir)))).toBe(true);
    expect(seenEvidenceDirs.every((dir) => !dir.startsWith(harness!.config.odDataDir))).toBe(true);
    expect(harness.daemon.runBodies).toHaveLength(2);
    expect(harness.daemon.runBodies[0].conversationId).toBe('od-conversation');
    expect(new Set(harness.daemon.runBodies.slice(1).map((body) => body.conversationId))).toEqual(
      new Set(['od-quality-conversation-1']),
    );
    const reportFile = map!.commits[0].files.find((file: { path: string }) => file.path === 'assets/visual-quality-report.json');
    const reportText = Buffer.from(reportFile.contentBase64, 'base64').toString('utf8');
    const report = JSON.parse(reportText);
    expect(report).toMatchObject({
      schemaVersion: 'map-browser-quality-evidence-v1',
      ruleVersion: 'browser-hard-gate-v1',
      firstPassPassed: false,
      repairAttempts: 0,
      repairSucceeded: false,
      finalHardPassed: false,
    });
    expect(report.attempts).toHaveLength(1);
    expect(reportText).not.toContain('<!doctype html>');
    expect(reportText).not.toContain('thinking');
  });

  it('cancels a browser repair at its absolute deadline, restores the trusted snapshot, and reruns both viewports', async () => {
    const checkedHtml: string[] = [];
    harness = await startHarness({ overrides: {
      browserQualityRunner: {
        run: async (job) => {
          const html = fs.readFileSync(path.join(job.workspaceDir, 'index.html'), 'utf8');
          checkedHtml.push(html);
          fs.mkdirSync(job.evidenceDir, { recursive: true });
          const measurements = [
            { viewport: 'desktop' as const, width: 1440, height: 900 },
            { viewport: 'mobile' as const, width: 390, height: 844 },
          ].map((viewport) => {
            const screenshotPath = `assets/quality/deadline-${job.repairAttempt}-${viewport.viewport}.png`;
            fs.writeFileSync(path.join(job.evidenceDir, path.basename(screenshotPath)), Buffer.from([137, 80, 78, 71]));
            return {
              ...viewport,
              documentWidth: viewport.width,
              h1Count: 1,
              visibleHeadingCount: 1,
              visibleCtaCount: 1,
              visibleLandmarkCount: 1,
              issues: job.repairAttempt === 0 ? [{
                issueCode: 'mobile_navigation_unusable' as const,
                severity: 'hard' as const,
                ruleVersion: 'browser-hard-gate-v1' as const,
                viewport: viewport.viewport,
                actual: { measured: false },
                target: 'usable navigation',
              }] : [],
              screenshotPath,
            };
          });
          return { browserVersion: 'test-chromium', measurements };
        },
      },
    } });
    const pkg = buildPackage([]);
    harness.daemon.onRun = async ({ workspaceDir, index, signal }) => {
      if (index === 1) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main><h1>trusted-candidate</h1></main></body></html>');
      }
      if (index === 3) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>partial-browser-repair</main></body></html>');
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };

    const view = await runToEnd(pkg, (request) => ({ ...request, timeoutSeconds: 30 }));

    expect(view.state, JSON.stringify(view.error)).toBe('succeeded');
    expect(harness.daemon.cancels).toContain('od-run-3');
    expect(checkedHtml).toHaveLength(2);
    expect(checkedHtml[0]).toContain('trusted-candidate');
    expect(checkedHtml[1]).toContain('trusted-candidate');
    expect(checkedHtml[1]).not.toContain('partial-browser-repair');
    const committedIndex = map!.commits[0].files.find((file: { path: string }) => file.path === 'index.html');
    expect(Buffer.from(committedIndex.contentBase64, 'base64').toString('utf8')).toContain('trusted-candidate');
    expect(await statusReasons(pkg.runId)).toEqual(expect.arrayContaining([
      'open_design_quality_repairing',
      'open_design_browser_quality_checked',
    ]));
    expect(await statusReasons(pkg.runId)).not.toContain('open_design_quality_repair_budget_exhausted');
  }, 15_000);

  it('uses the reserved second browser repair after the first times out and retains complete rejection evidence', async () => {
    const checkedHtml: string[] = [];
    harness = await startHarness({ overrides: {
      browserQualityRunner: {
        run: async (job) => {
          checkedHtml.push(fs.readFileSync(path.join(job.workspaceDir, 'index.html'), 'utf8'));
          fs.mkdirSync(job.evidenceDir, { recursive: true });
          const measurements = [
            { viewport: 'desktop' as const, width: 1440, height: 900 },
            { viewport: 'mobile' as const, width: 390, height: 844 },
          ].map((viewport) => {
            const screenshotPath = `assets/quality/rejected-${job.repairAttempt}-${viewport.viewport}.png`;
            fs.writeFileSync(path.join(job.evidenceDir, path.basename(screenshotPath)), Buffer.from([137, 80, 78, 71]));
            return {
              ...viewport,
              documentWidth: viewport.width,
              h1Count: 1,
              visibleHeadingCount: 1,
              visibleCtaCount: 1,
              visibleLandmarkCount: 1,
              issues: [{
                issueCode: 'key_text_contrast_low' as const,
                severity: 'hard' as const,
                ruleVersion: 'browser-hard-gate-v1' as const,
                viewport: viewport.viewport,
                actual: { ratio: 2.5, minimum: 4.5 },
                target: 'at least 4.5',
                element: { tag: 'h1', id: 'hero-title', role: 'heading', label: 'Launch heading' },
              }],
              screenshotPath,
            };
          });
          return { browserVersion: 'test-chromium', measurements };
        },
      },
    } });
    const pkg = buildPackage([]);
    harness.daemon.onRun = async ({ workspaceDir, index, signal }) => {
      if (index === 1) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main><h1>trusted-with-hard-issue</h1></main></body></html>');
      }
      if (index === 3) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>partial-browser-repair</main></body></html>');
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      if (index === 4) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main><h1>trusted-with-hard-issue</h1></main></body></html>');
      }
      return { status: 'succeeded', deliverableEntryFile: 'index.html' };
    };

    const view = await runToEnd(pkg, (request) => ({ ...request, timeoutSeconds: 30 }));

    expect(view.state).toBe('failed');
    expect(view.error.code).toBe('design_browser_quality_rejected');
    expect(view.error.details).toMatchObject({
      repairAttempts: 2,
      repairBudgetExhausted: false,
      issueCodes: ['key_text_contrast_low'],
      bestRepairAttempt: 0,
      browserQualityEvidence: {
        schemaVersion: 'map-browser-quality-failure-evidence-v1',
        repairAttempts: 2,
        repairBudgetExhausted: false,
      },
    });
    const failureEvidence = view.error.details.browserQualityEvidence;
    expect(failureEvidence.attempts).toHaveLength(3);
    expect(failureEvidence.attempts.map((attempt: { repairAttempt: number }) => attempt.repairAttempt)).toEqual([0, 1, 2]);
    expect(failureEvidence.attempts[0].issues[0]).toEqual({
      issueCode: 'key_text_contrast_low',
      viewport: 'desktop',
      actual: { ratio: 2.5, minimum: 4.5 },
      target: 'at least 4.5',
      elementSummary: { tag: 'h1', id: 'hero-title', role: 'heading', label: 'Launch heading' },
    });
    expect(JSON.stringify(view.error.details)).not.toContain('trusted-with-hard-issue');
    expect(JSON.stringify(view.error.details)).not.toContain('assets/quality/');
    expect(harness.daemon.cancels).toContain('od-run-3');
    expect(checkedHtml).toHaveLength(3);
    expect(checkedHtml[1]).toContain('trusted-with-hard-issue');
    expect(checkedHtml[1]).not.toContain('partial-browser-repair');
    expect(checkedHtml[2]).toContain('trusted-with-hard-issue');
    expect(map!.commits).toHaveLength(0);
  }, 15_000);

  it('restores and flushes the best measured preview when two browser repairs still fail', async () => {
    harness = await startHarness({ overrides: {
      browserQualityRunner: {
        run: async (job) => {
          fs.mkdirSync(job.evidenceDir, { recursive: true });
          const html = fs.readFileSync(path.join(job.workspaceDir, 'index.html'), 'utf8');
          const issueCount = html.includes('best-initial') ? 1 : html.includes('repair-one') ? 4 : 3;
          const measurements = [
            { viewport: 'desktop' as const, width: 1440, height: 900 },
            { viewport: 'mobile' as const, width: 390, height: 844 },
          ].map((viewport) => {
            const screenshotPath = `assets/quality/attempt-${job.repairAttempt}-${viewport.viewport}.png`;
            fs.writeFileSync(path.join(job.evidenceDir, path.basename(screenshotPath)), Buffer.from([137, 80, 78, 71]));
            return {
              ...viewport,
              documentWidth: viewport.width,
              h1Count: 1,
              visibleHeadingCount: 2,
              visibleCtaCount: 1,
              visibleLandmarkCount: 2,
              issues: Array.from({ length: issueCount }, () => ({
                issueCode: 'horizontal_overflow' as const,
                severity: 'hard' as const,
                ruleVersion: 'browser-hard-gate-v1' as const,
                viewport: viewport.viewport,
                actual: { measured: issueCount },
                target: 'measured hard target',
              })),
              screenshotPath,
            };
          });
          return { browserVersion: 'test-chromium', measurements };
        },
      },
    } });
    const pkg = buildPackage([]);
    harness.daemon.onRun = ({ workspaceDir, index }) => {
      const marker = index === 1 ? 'best-initial' : index === 3 ? 'repair-one' : index === 4 ? 'repair-two' : '';
      if (marker) {
        fs.writeFileSync(path.join(workspaceDir, 'index.html'), `<!doctype html><html><body><main><h1>${marker}</h1></main></body></html>`);
      }
      return { status: 'succeeded' };
    };
    const view = await runToEnd(pkg);
    expect(view.state).toBe('failed');
    expect(view.error.code).toBe('design_browser_quality_rejected');
    expect(view.error.details.bestRepairAttempt).toBe(0);
    expect(view.error.details).toMatchObject({
      repairAttempts: 2,
      repairBudgetExhausted: false,
      browserQualityEvidence: {
        repairAttempts: 2,
        repairBudgetExhausted: false,
      },
    });
    expect(view.error.details.browserQualityEvidence.attempts).toHaveLength(3);
    expect(view.error.details.browserQualityEvidence.attempts.map(
      (attempt: { repairAttempt: number }) => attempt.repairAttempt,
    )).toEqual([0, 1, 2]);
    expect(map!.commits).toHaveLength(0);
    expect(map!.previews.at(-1)?.html).toContain('best-initial');
  });

  it('fails honestly when the isolated browser worker is unavailable and does not commit an unchecked artifact', async () => {
    harness = await startHarness({ overrides: {
      browserQualityRunner: { run: async () => { throw new Error('browser process missing'); } },
    } });
    const pkg = buildPackage([]);
    harness.daemon.onRun = ({ workspaceDir }) => {
      fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><html><body><main>Launch page</main></body></html>');
      return { status: 'succeeded' };
    };
    const view = await runToEnd(pkg);
    expect(view.state).toBe('failed');
    expect(view.error.message).toContain('browser process missing');
    expect(map!.commits).toHaveLength(0);
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
      paths: { workspaceDir, dataDir: workspaceDir, templatesDir: workspaceDir, outputDir: workspaceDir, webPrototypeSourceDir: workspaceDir, presentationSkillSourceDir: workspaceDir },
      daemon: { current: () => undefined } as any,
      fetchImpl,
      relayPort: 0,
      llmgwBaseUrl: 'http://gateway/gw/v1',
    });
    const stages: string[] = [];
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const preview = (executor as any).createPreviewPusher(
        { previewUrl: 'https://map.example.test/api/design-artifacts/runtime/r1/workspace/preview', transfer: { transferToken: 't' } },
        now + 600_000,
        (stage: string) => stages.push(stage),
      ) as { poll: () => Promise<void>; close: () => void };
      await preview.poll();
      now += 9_000;
      // 页面没有再变：修复前指纹在推送前就记下，这一轮会直接跳过，预览永远停在失败那一刻。
      await preview.poll();
      now += 9_000;
      await preview.poll();
      preview.close();
    } finally {
      clock.mockRestore();
    }
    expect(posted.map((item) => item.revision)).toEqual([1, 2]);
    expect(posted.every((item) => item.html.includes('Stable page'))).toBe(true);
    expect(stages).toEqual(['open_design_preview_failed', 'open_design_preview_pushed']);
  });

  it('pushes file changes from fs.watch before polling and cleans the watcher on close', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-preview-watch-'));
    const posted: Array<{ revision: number; html: string }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const executor = new DesignTaskExecutor({
      paths: { workspaceDir, dataDir: workspaceDir, templatesDir: workspaceDir, outputDir: workspaceDir, webPrototypeSourceDir: workspaceDir, presentationSkillSourceDir: workspaceDir },
      daemon: { current: () => undefined } as any,
      fetchImpl,
      relayPort: 0,
      llmgwBaseUrl: 'http://gateway/gw/v1',
    });
    const preview = (executor as any).createPreviewPusher(
      { previewUrl: 'https://map.example.test/api/design-artifacts/runtime/r1/workspace/preview', transfer: { transferToken: 't' } },
      Date.now() + 600_000,
      () => undefined,
    ) as { poll: () => Promise<void>; close: () => void };
    fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><main>First page</main>');
    await waitFor(() => posted.length === 1, 'watch preview push');
    expect(posted[0].html).toContain('First page');
    preview.close();
    fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<!doctype html><main>Second page</main>');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(posted).toHaveLength(1);
  });
});
