// 一次设计任务的完整执行：取任务包 → 铺工作区 → 驱动 OpenDesign 设计、终审、按闸门修复 → 收产物 →
// 向 MAP 交结果包，运行期间推实时预览。
//
// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts 的 create() + execute()（第 1 阶段：只改归属、
// 不改行为）。原来与 docker 绑定的几处换成了本机实现，其余逐字不变：
//
// | 原 CDS 做法                                  | 这里的做法                                         |
// |----------------------------------------------|----------------------------------------------------|
// | docker cp 把任务包拷进会话卷                  | 直接写 /workspace（再把属主交给引擎用户）           |
// | docker exec 打模板补丁、写 codex config.toml | 直接读写本机文件（engine/web-prototype.ts）         |
// | 经 docker 网络访问容器里的 daemon            | 访问同容器 127.0.0.1 的 daemon                      |
// | relay 容器（map-egress:8787）注入真实票据     | 本进程内只监听 127.0.0.1 的转发口（egress-relay）   |
// | docker pause + 一次性只读容器导出产物          | 冻结引擎进程组 + 本进程内同一段预检（output-preflight）|
// | docker exec stat / head 读预览                | O_NOFOLLOW 直接读 /workspace/index.html              |
//
// 任务结束后的清空（隔离方案 A）不在这里做，由 tasks.ts 统一负责：无论成功、失败、取消还是超时，
// 都走同一条「停引擎 → 清空目录 → 核对为空 → 重新拉起」的路径。
import fs from 'node:fs';
import path from 'node:path';

import {
  BROWSER_QUALITY_REPORT_PATH,
  CDS_GENERATED_ARTIFACT_PATHS,
  assertPublicArtifactFileCount,
  buildGeneratedPublicArtifactPackage,
  isAllowedOutput,
  mediaTypeForFile,
  MAX_OUTPUT_FILE_COUNT,
  prepareCurrentArtifactSeeds,
  validatePublicArtifactFiles,
} from './artifact/public-package.js';
import { runtimeDiagnosticPreview } from './diagnostics.js';
import { OpenDesignClient, signalForDeadline, type OpenDesignRunOutcome } from './engine/client.js';
import type { EngineDaemon } from './engine/daemon.js';
import { startEgressRelay, type EgressRelay, type EgressRelayOptions } from './engine/egress-relay.js';
import { prepareWebPrototypeResources } from './engine/web-prototype.js';
import { AgentWorkspaceRuntimeError, type StageReporter } from './errors.js';
import {
  OPEN_DESIGN_CODEX_HOME_RELATIVE,
  OPEN_DESIGN_WEB_PROTOTYPE_SKILL,
  buildOpenDesignCodexConfig,
  buildPlatformRules,
  buildRepairMessage,
  buildReviewMessage,
  collectDesignTaskContext,
  composeOpenDesignPrompts,
} from './prompts.js';
import {
  MAX_QUALITY_REPAIR_ATTEMPTS,
  assertRequiredFactualCoverage,
  canAcceptUntrackedWorkspaceEdit,
  classifyQualityRepairReason,
  collectArtifactQualityEvidence,
  collectVisibleTextOccurrenceConstraints,
  createArtifactQualityGate,
} from './quality/gate.js';
import {
  MAX_BROWSER_REPAIR_ATTEMPTS,
  browserRepairMessage,
  buildBrowserQualityEvidence,
  summarizeAttempt,
  type BrowserQualityAttemptEvidence,
} from './quality/browser-contract.js';
import { SubprocessBrowserQualityRunner, type BrowserQualityRunner } from './quality/browser-runner.js';
import { exportValidatedOutputs, readRegularFileNoFollow } from './workspace/output-preflight.js';
import { SHA256_RE, normalizeRelativePath, sha256 } from './workspace/primitives.js';
import {
  MAP_DESIGN_WORKSPACE_SCHEMA,
  MAX_COMMIT_RESPONSE_BYTES,
  MAX_PACKAGE_OVERHEAD_BYTES,
  PREVIEW_CHECK_INTERVAL_MS,
  PREVIEW_MAX_BYTES,
  parseWorkspacePackage,
  readResponseLimited,
  validateModelAuthority,
  type OpenDesignModelAuthority,
  type WorkspacePackageFile,
  type WorkspaceTransferRequest,
} from './workspace/transfer.js';

/**
 * OpenDesign 自己认定的交付文件，不是 `index.html`（DELIVERABLE_ENTRY_NOTE）。
 *
 * web-prototype 技能要求模型「选一个 kebab-case 的 slug，把成品包在 `<artifact>` 里交出去」，
 * 并明令禁止它再写一份根目录 HTML。OpenDesign 于是把成品存成项目里以 slug 命名的那个文件，
 * 并在 run 状态的 `deliverableEntryFile` 里指名它；而收件一直写死读 `/workspace/index.html`。
 * 判据用它自己给的那个字段，不去猜「根目录下那个不叫 index 的 html」。
 */
const DELIVERABLE_ENTRY_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.html$/;

// 十五分钟是产品总承诺，不是每个 OpenDesign run 各自可用的预算。最后 10% 固定留给
// 浏览器硬门禁与向 MAP 提交；模型终审单轮最多占 1/15，且至少要有 1/30 才值得启动。
// 默认 900 秒对应 90 秒收尾、30–60 秒终审。短任务按同一比例缩放，测试与兼容调用不会
// 因硬编码分钟数失去全部执行时间。
const FINALIZATION_RESERVE_RATIO = 0.1;
const MIN_REVIEW_PASS_RATIO = 1 / 30;
const MAX_REVIEW_PASS_RATIO = 1 / 15;

interface ExecutionBudget {
  executionDeadline: number;
  finalizationDeadline: number;
  minimumReviewPassMs: number;
  maximumReviewPassMs: number;
}

function buildExecutionBudget(startedAt: number, timeoutSeconds: number): ExecutionBudget {
  const totalMs = Math.max(1, timeoutSeconds) * 1000;
  const finalizationReserveMs = Math.max(1, Math.floor(totalMs * FINALIZATION_RESERVE_RATIO));
  return {
    executionDeadline: startedAt + totalMs,
    finalizationDeadline: startedAt + totalMs - finalizationReserveMs,
    minimumReviewPassMs: Math.max(1, Math.floor(totalMs * MIN_REVIEW_PASS_RATIO)),
    maximumReviewPassMs: Math.max(1, Math.floor(totalMs * MAX_REVIEW_PASS_RATIO)),
  };
}

export interface ExecutorPaths {
  workspaceDir: string;
  dataDir: string;
  templatesDir: string;
  outputDir: string;
  webPrototypeSourceDir: string;
}

export interface ExecutorOptions {
  paths: ExecutorPaths;
  daemon: EngineDaemon;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  /** 转发口监听的本机端口；0 表示临时端口（测试）。 */
  relayPort: number;
  /** MAP 与运行时共同钉住的 LLMGW 原生 Responses 基址。 */
  llmgwBaseUrl: string;
  /** 以 root 运行时，把工作区与配置文件的属主交还给引擎用户。 */
  engineUid?: number;
  engineGid?: number;
  /** 测试注入：替换转发口的实现。 */
  startRelay?: (options: EgressRelayOptions) => Promise<EgressRelay>;
  /** 浏览器检查在独立子进程执行；测试注入确定性 runner。 */
  browserQualityRunner?: BrowserQualityRunner;
}

export interface DesignTaskInput {
  taskId: string;
  transfer: WorkspaceTransferRequest;
  previewUrl?: string;
  model: OpenDesignModelAuthority;
  timeoutSeconds: number;
  /** 交给 OpenDesign 的第一轮指令：MAP 的任务信封（map-design-artifact-command-v2）序列化文本。 */
  instruction: string;
}

export interface DesignTaskResult {
  artifactRef: string;
  resultSha256: string;
  files: Array<Pick<WorkspacePackageFile, 'path' | 'sha256' | 'size' | 'mediaType'>>;
  openDesignRunId: string;
}

interface PreparedWorkspace {
  mapRunId: string;
  inputFiles: Array<{ path: string; sha256: string; size: number }>;
}

interface PreviewPusher {
  /** 定时轮询的完整性兜底。 */
  poll: () => Promise<void>;
  /** 在终止前立即推送当前最佳预览，不受轮询节流影响。 */
  flush: () => Promise<void>;
  /** 任务结束时必须清理监听器与 debounce 计时器。 */
  close: () => void;
}

export class DesignTaskExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly startRelay: (options: EgressRelayOptions) => Promise<EgressRelay>;
  private readonly browserQualityRunner: BrowserQualityRunner;

  constructor(private readonly options: ExecutorOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.pollIntervalMs = Math.max(5, options.pollIntervalMs || 750);
    this.startRelay = options.startRelay || startEgressRelay;
    this.browserQualityRunner = options.browserQualityRunner
      || new SubprocessBrowserQualityRunner(options.engineUid, options.engineGid);
  }

  async run(
    task: DesignTaskInput,
    signal: AbortSignal,
    onCreatingStage: StageReporter,
    onStage: StageReporter,
  ): Promise<DesignTaskResult> {
    const prepared = await this.prepare(task, signal, onCreatingStage);
    return this.execute(task, prepared, signal, onStage);
  }

  /**
   * 伙伴侧（MAP）传输的唯一出口。任务创建时 inputPackageUrl / resultCommitUrl / 预览地址被钉在同一个
   * MAP origin 上，但 fetch 默认会跟随 3xx——跟过去的那一跳不再受钉定约束，等于把本服务变成一个可被
   * 伙伴端指挥的内网请求器。所以这里一律 redirect: 'manual' 并把 3xx 判成失败。
   */
  private async fetchPartnerTransfer(url: string, init: RequestInit, field: string): Promise<Response> {
    const response = await this.fetchImpl(url, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_transfer_redirect_rejected',
        `${field} responded with HTTP ${response.status}; redirects are not followed because the target origin is pinned at session creation`,
        false,
      );
    }
    return response;
  }

  private daemonClient(): OpenDesignClient {
    const handle = this.options.daemon.current();
    if (!handle) {
      throw new AgentWorkspaceRuntimeError(
        'open_design_not_ready',
        'OpenDesign engine process is not running; the task cannot be driven',
        true,
      );
    }
    return new OpenDesignClient(this.fetchImpl, handle.baseUrl, handle.apiToken, this.pollIntervalMs);
  }

  private chownForEngine(target: string): void {
    const uid = this.options.engineUid;
    if (uid === undefined || typeof process.getuid !== 'function' || process.getuid() !== 0) return;
    const gid = this.options.engineGid ?? uid;
    const visit = (entry: string): void => {
      fs.lchownSync(entry, uid, gid);
      const stat = fs.lstatSync(entry);
      if (!stat.isDirectory()) return;
      for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
    };
    visit(target);
  }

  private async prepare(
    task: DesignTaskInput,
    signal: AbortSignal,
    onStage: StageReporter,
  ): Promise<PreparedWorkspace> {
    const { transfer } = task;
    const { workspaceDir } = this.options.paths;
    onStage('workspace_downloading');
    const response = await this.fetchPartnerTransfer(transfer.inputPackageUrl, {
      headers: { Authorization: `Bearer ${transfer.transferToken}`, Accept: 'application/json' },
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.min(task.timeoutSeconds * 1000, 60_000)),
      ]),
    }, 'workspaceTransfer.inputPackageUrl');
    if (signal.aborted) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_creation_cancelled',
        'OpenDesign workspace creation was cancelled during input transfer',
        false,
      );
    }
    if (!response.ok) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_download_failed',
        `MAP workspace download failed with status ${response.status}`,
        response.status >= 500,
      );
    }
    const packageBytes = await readResponseLimited(
      response,
      Math.ceil(transfer.maxInputBytes * 1.5) + MAX_PACKAGE_OVERHEAD_BYTES,
    );
    const workspacePackage = parseWorkspacePackage(packageBytes, transfer);
    if (workspacePackage.runId !== task.taskId) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_package_invalid',
        'workspace input package runId does not match the task id MAP submitted',
      );
    }
    const files = workspacePackage.files;
    const editableSeeds = prepareCurrentArtifactSeeds(files, transfer);
    fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o755 });
    for (const file of files) {
      const target = path.join(workspaceDir, ...file.path.split('/'));
      const relative = path.relative(workspaceDir, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `workspace path escaped root: ${file.path}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.writeFileSync(target, file.bytes, { mode: 0o644, flag: 'wx' });
    }
    for (const file of editableSeeds) {
      const target = path.join(workspaceDir, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.writeFileSync(target, Buffer.from(file.contentBase64, 'base64'), { mode: 0o644, flag: 'wx' });
    }
    this.chownForEngine(workspaceDir);
    onStage('workspace_materialized', { fileCount: files.length });
    prepareWebPrototypeResources(
      {
        sourceDir: this.options.paths.webPrototypeSourceDir,
        templatesDir: this.options.paths.templatesDir,
        workspaceDir,
      },
      (target) => this.chownForEngine(target),
    );
    await this.daemonClient().waitForHealth(task.timeoutSeconds);
    if (signal.aborted) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_creation_cancelled',
        'OpenDesign workspace creation was cancelled before readiness',
        false,
      );
    }
    return {
      mapRunId: workspacePackage.runId,
      inputFiles: files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.bytes.byteLength })),
    };
  }

  private async execute(
    task: DesignTaskInput,
    prepared: PreparedWorkspace,
    signal: AbortSignal,
    onStage: StageReporter,
  ): Promise<DesignTaskResult> {
    const { transfer, model } = task;
    const { workspaceDir } = this.options.paths;
    const sessionId = task.taskId;
    const instruction = task.instruction;
    const budget = buildExecutionBudget(Date.now(), task.timeoutSeconds);
    const { executionDeadline } = budget;
    if (!instruction.trim() || instruction.length > 12_000) {
      throw new AgentWorkspaceRuntimeError('design_instruction_invalid', 'design instruction must contain 1 to 12000 characters');
    }
    validateModelAuthority(model, transfer.inputPackageUrl, this.options.llmgwBaseUrl);
    const transferToken = transfer.transferToken;
    if (!transferToken || transferToken.length > 8192) {
      throw new AgentWorkspaceRuntimeError('workspace_transfer_invalid', 'workspace transfer token is missing');
    }
    const daemonHandle = this.options.daemon.current();
    const client = this.daemonClient();
    onStage('open_design_importing');
    const imported = await client.odJson('/api/import/folder', {
      method: 'POST',
      body: {
        baseDir: workspaceDir,
        name: `MAP design ${sessionId.slice(-12)}`,
        skillId: OPEN_DESIGN_WEB_PROTOTYPE_SKILL,
        orchestratorWorkspace: {
          kind: 'scratch',
          sourceLabel: 'MAP design workspace',
          sourceRef: sessionId,
          baseRevision: transfer.baseRevision,
          writeback: 'external',
        },
      },
      signal: signalForDeadline(executionDeadline, signal),
    });
    const project = imported.project as Record<string, unknown> | undefined;
    const projectId = typeof project?.id === 'string' ? project.id : '';
    const conversationId = typeof imported.conversationId === 'string' ? imported.conversationId : '';
    if (!projectId || !conversationId) {
      throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign folder import returned no project identity');
    }
    if (project?.skillId !== OPEN_DESIGN_WEB_PROTOTYPE_SKILL) {
      throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign folder import did not retain the required web prototype skill');
    }
    const relayClientToken = daemonHandle?.modelPlaceholderToken || '';
    if (!model.apiKey || /[\0\r\n]/.test(model.apiKey) || !relayClientToken || /[\0\r\n]/.test(relayClientToken)) {
      throw new AgentWorkspaceRuntimeError(
        'model_authority_invalid',
        'Task-scoped model gateway credential is missing or malformed',
      );
    }
    let relay: EgressRelay;
    try {
      relay = await this.startRelay({
        modelBaseUrl: model.baseUrl,
        modelGatewayCredential: model.apiKey,
        relayClientToken,
        port: this.options.relayPort,
        sourceSystem: model.sourceSystem,
        appCallerCode: model.appCallerCode,
        userId: model.userId,
        runId: model.runId,
        allowPrivateTarget: model.baseUrl.replace(/\/$/, '') === this.options.llmgwBaseUrl.replace(/\/$/, ''),
      });
    } catch (error) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_egress_unavailable',
        `Controlled model egress relay could not be started: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
        true,
      );
    }
    // Include nested originals from the verified MAP package, not only top-level
    // text snapshots or files the generator might have added to the directory.
    const knowledgeFiles = prepared.inputFiles
      .filter((file) => file.path.startsWith('knowledge/'))
      .map((file) => `/workspace/${file.path}`)
      .sort();
    const currentIndexPath = path.join(workspaceDir, 'current', 'index.html');
    const editingExistingPage = fs.existsSync(currentIndexPath);
    // One execution owns its frozen evidence and repair-retention state. Neither
    // a later model edit nor another session can redefine the facts being checked.
    // 证据口径与 MAP 发布闸（HostedSiteEditRunWorker.BuildQualityEvidence）一致：用户写的标题与要求是
    // 生成请求，不是能证明日期、联系方式、网址或数值的证据。此前这里把它们算进证据，同一页在这里通过、
    // 到 MAP 最后一步才被拒，白等一整轮（判据与接线纪律 形状 3，Codex P2，2026-09-24）。
    const qualityEvidence = collectArtifactQualityEvidence(workspaceDir, false);
    const checkArtifactQuality = createArtifactQualityGate(
      qualityEvidence,
      collectVisibleTextOccurrenceConstraints(workspaceDir),
      qualityEvidence,
    );
    let activeRunId: string | undefined;
    let previewPusher: PreviewPusher | undefined;
    const browserEvidenceDir = path.join(
      path.dirname(this.options.paths.outputDir),
      'browser-quality',
      sha256(Buffer.from(sessionId)).slice(0, 24),
    );
    try {
      this.writeCodexConfig(buildOpenDesignCodexConfig(relay.proxiedBaseUrl, model.model));
      const designContext = collectDesignTaskContext(workspaceDir);
      const designDirection = designContext.direction;
      const reviewMode = designDirection?.reviewMode ?? 'light';
      const reviewPasses = reviewMode === 'off' ? 0 : reviewMode === 'strict' ? 2 : 1;
      const mainRunDeadline = reviewPasses > 0
        ? budget.finalizationDeadline - budget.minimumReviewPassMs
        : budget.finalizationDeadline;
      const hasReferenceImages = prepared.inputFiles.some((file) => file.path.startsWith('reference/'));
      const platformRules = buildPlatformRules({ knowledgeFiles, editingExistingPage });
      const { systemPrompt, reviewAddendum } = composeOpenDesignPrompts({
        platformRules,
        direction: designDirection,
        brief: designContext.brief,
        brand: designContext.brand,
        editingExistingPage,
        hasReferenceImages,
      });
      // designSystemId 让 OpenDesign 把 /app/design-systems/<id> 的 DESIGN.md、tokens 与组件注入它自己的提示词。
      let activeConversationId = conversationId;
      const buildRunBody = (message: string) => ({
        projectId,
        conversationId: activeConversationId,
        agentId: 'codex',
        model: model.model,
        message,
        systemPrompt,
        ...(designContext.brand || designDirection
          ? { designSystemId: designContext.brand?.designSystemId ?? designDirection!.designSystemId }
          : {}),
      });
      previewPusher = this.createPreviewPusher(task, executionDeadline, onStage);
      onStage('open_design_run_starting', { projectId });
      const run = await client.odJson('/api/runs', {
        method: 'POST',
        body: buildRunBody(instruction.trim()),
        signal: signalForDeadline(executionDeadline, signal),
        acceptedStatuses: [200, 202],
      });
      const runId = typeof run.runId === 'string'
        ? run.runId
        : typeof run.id === 'string'
          ? run.id
          : '';
      if (!runId) {
        throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign run creation returned no run id');
      }
      activeRunId = runId;
      let finalRunId = runId;
      let runOutcome: OpenDesignRunOutcome = await client.waitForRun(runId, mainRunDeadline, signal, onStage, previewPusher.poll);
      // 交付文件由 OpenDesign 指名，一轮里只有产出的那几次会带上它——终审与修复常报
      // no_artifact（它们没新建产物），那不等于上一轮指名的文件失效。所以只往前记，不清空。
      let deliverableEntryFile = runOutcome.deliverableEntryFile;
      if (Date.now() >= executionDeadline) {
        throw new AgentWorkspaceRuntimeError('open_design_run_timeout', 'OpenDesign run exceeded the session timeout', true);
      }
      // 自查强度（MAP 设置冻结进任务书）：off 跳过模型终审，只留确定性发布闸门与修复回路；
      // light 一轮终审；strict 在终审之后再加一轮只看视觉质量的审美复查。旧运行没有方向，按 light。
      if (reviewPasses > 0) {
        // Quality work needs the same project and live workspace, but not the generation transcript.
        // Reusing the imported conversation made every review request resend the complete generation
        // history. A real strict run reached 132k input tokens and exhausted the 15-minute task
        // deadline before browser quality could start. Keep review and all targeted repairs in one
        // fresh quality conversation so they can inspect the authoritative workspace without carrying
        // the generation tool transcript forward.
        activeConversationId = await client.createConversation(
          projectId,
          `MAP quality review ${sessionId.slice(-12)}`,
          signalForDeadline(executionDeadline, signal),
        );
      }
      for (let reviewPass = 0; reviewPass < reviewPasses; reviewPass += 1) {
        const stableRunId = finalRunId;
        const stableOutcome = runOutcome;
        const stableDeliverableEntryFile = deliverableEntryFile;
        this.promoteDeliverableEntry(stableDeliverableEntryFile, (stage, detail) => {
          onStage(stage === 'deliverable_entry_resolved' ? 'deliverable_entry_checkpointed' : stage, detail);
        });
        this.exportOutputs(transfer, prepared);
        const stableOutputs = this.collectOutputs(transfer);
        const remainingReviewMs = budget.finalizationDeadline - Date.now();
        const allottedReviewMs = Math.min(budget.maximumReviewPassMs, remainingReviewMs);
        if (allottedReviewMs < budget.minimumReviewPassMs) {
          onStage('open_design_review_budget_exhausted', {
            completedPasses: reviewPass,
            skippedPasses: reviewPasses - reviewPass,
            remainingSeconds: Math.max(0, Math.floor(remainingReviewMs / 1000)),
          });
          break;
        }
        const reviewDeadline = Date.now() + allottedReviewMs;
        const review = await client.odJson('/api/runs', {
          method: 'POST',
          body: buildRunBody(buildReviewMessage({ reviewPass, editingExistingPage, reviewAddendum })),
          signal: signalForDeadline(reviewDeadline, signal),
          acceptedStatuses: [200, 202],
        });
        finalRunId = typeof review.runId === 'string'
          ? review.runId
          : typeof review.id === 'string'
            ? review.id
            : '';
        if (!finalRunId) {
          throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign review run returned no run id');
        }
        activeRunId = finalRunId;
        onStage('open_design_reviewing', {
          runId: finalRunId,
          pass: reviewPass + 1,
          allottedSeconds: Math.floor(allottedReviewMs / 1000),
        });
        try {
          runOutcome = await client.waitForRun(finalRunId, reviewDeadline, signal, onStage, previewPusher.poll);
          deliverableEntryFile = runOutcome.deliverableEntryFile || deliverableEntryFile;
        } catch (error) {
          const reviewBudgetExpired = error instanceof AgentWorkspaceRuntimeError
            && error.code === 'open_design_run_timeout'
            && !signal.aborted
            && Date.now() < executionDeadline;
          if (!reviewBudgetExpired) throw error;
          this.restoreOutputCheckpoint(transfer, stableOutputs);
          finalRunId = stableRunId;
          runOutcome = stableOutcome;
          deliverableEntryFile = stableDeliverableEntryFile;
          onStage('open_design_review_budget_exhausted', {
            completedPasses: reviewPass,
            skippedPasses: reviewPasses - reviewPass,
            allottedSeconds: Math.floor(allottedReviewMs / 1000),
            retainedRunId: stableRunId,
          });
          break;
        }
      }
      let collectedFiles: WorkspacePackageFile[] = [];
      let indexFile: WorkspacePackageFile | undefined;
      let hardenedHtml = '';
      for (let qualityRepairAttempt = 0; ; qualityRepairAttempt += 1) {
        onStage('workspace_collecting');
        assertExecutionDeadline(executionDeadline);
        // 成品未必叫 index.html：OpenDesign 在 run 状态里指名了这一轮的交付文件，按它指的搬。
        this.promoteDeliverableEntry(deliverableEntryFile, onStage);
        assertExecutionDeadline(executionDeadline);
        this.exportOutputs(transfer, prepared);
        assertExecutionDeadline(executionDeadline);
        collectedFiles = this.collectOutputs(transfer);
        assertExecutionDeadline(executionDeadline);
        indexFile = collectedFiles.find((file) => file.path === 'index.html');
        if (!indexFile) {
          // 「没有 index.html」有好几种完全不同的成因：模型一个文件都没产出、产出了但
          // OpenDesign 没指名、指名了但名字不在允许的输出路径里……只报一句「没有」，
          // 读的人无从下手（`external-cause-first.md`）。所以把这一刻的现场一起交出来。
          throw new AgentWorkspaceRuntimeError(
            'design_output_missing',
            'OpenDesign completed without index.html',
            false,
            {
              stage: 'collect_outputs',
              collectedPaths: collectedFiles.map((file) => file.path).slice(0, 40),
              workspaceRootEntries: this.listWorkspaceRootEntries(),
              deliverableValid: runOutcome.deliverableValid,
              deliverableValidation: runOutcome.deliverableValidation || null,
              deliverableEntryFile: deliverableEntryFile || null,
              // 模型这一轮到底干了什么——没有这份记录，「没有 index.html」永远只能靠猜。
              runTranscriptDigest: await client.captureRunTranscriptDigest(
                [runId, finalRunId],
                () => remainingExecutionMs(executionDeadline),
              ),
            },
          );
        }
        const outputHtml = Buffer.from(indexFile.contentBase64, 'base64');
        const currentHtml = fs.existsSync(currentIndexPath) ? fs.readFileSync(currentIndexPath) : undefined;
        if (
          !runOutcome.deliverableValid
          && !canAcceptUntrackedWorkspaceEdit(runOutcome.deliverableValidation, currentHtml, outputHtml)
        ) {
          throw new AgentWorkspaceRuntimeError(
            'open_design_deliverable_invalid',
            runOutcome.deliverableValidation || 'OpenDesign rejected its final deliverable',
          );
        }
        try {
          hardenedHtml = checkArtifactQuality(
            outputHtml.toString('utf8'),
            collectedFiles.map((file) => file.path),
          );
          assertRequiredFactualCoverage(
            hardenedHtml,
            designContext.brief?.factualCoverageRequirements.requiredFacts ?? [],
          );
          break;
        } catch (error) {
          if (
            !(error instanceof AgentWorkspaceRuntimeError)
            || error.code !== 'design_output_quality_rejected'
            || qualityRepairAttempt >= MAX_QUALITY_REPAIR_ATTEMPTS
          ) {
            throw error;
          }
          if (Date.now() >= executionDeadline) {
            throw new AgentWorkspaceRuntimeError('open_design_run_timeout', 'OpenDesign run exceeded the session timeout', true);
          }
          const repairReason = classifyQualityRepairReason(error);
          if (!repairReason) throw error;
          const preserveMeasuredFacts = repairReason.code === 'measured_claim_context_unresolved'
            || repairReason.code === 'retained_measured_claim_missing';
          const repair = await client.odJson('/api/runs', {
            method: 'POST',
            body: buildRunBody(buildRepairMessage({ repairReason, preserveMeasuredFacts, knowledgeFiles, editingExistingPage })),
            signal: signalForDeadline(executionDeadline, signal),
            acceptedStatuses: [200, 202],
          });
          finalRunId = typeof repair.runId === 'string'
            ? repair.runId
            : typeof repair.id === 'string'
              ? repair.id
              : '';
          if (!finalRunId) {
            throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign quality repair run returned no run id');
          }
          activeRunId = finalRunId;
          onStage('open_design_quality_repairing', {
            runId: finalRunId,
            attempt: qualityRepairAttempt + 1,
          });
          runOutcome = await client.waitForRun(finalRunId, executionDeadline, signal, onStage, previewPusher.poll);
          deliverableEntryFile = runOutcome.deliverableEntryFile || deliverableEntryFile;
        }
      }
      const browserAttempts: BrowserQualityAttemptEvidence[] = [];
      let bestBrowserCandidate = { score: Number.NEGATIVE_INFINITY, html: hardenedHtml, repairAttempt: 0 };
      let browserVersion = '';
      fs.rmSync(browserEvidenceDir, { recursive: true, force: true });
      fs.mkdirSync(browserEvidenceDir, { recursive: true, mode: 0o700 });
      this.chownForEngine(browserEvidenceDir);
      for (let browserRepairAttempt = 0; ; browserRepairAttempt += 1) {
        assertExecutionDeadline(executionDeadline);
        const indexPath = path.join(workspaceDir, 'index.html');
        fs.writeFileSync(indexPath, hardenedHtml);
        this.chownForEngine(indexPath);
        onStage('open_design_browser_quality_checking', {
          repairAttempt: browserRepairAttempt,
          viewports: ['desktop-1440', 'mobile-390'],
        });
        const checked = await this.browserQualityRunner.run({
          workspaceDir,
          evidenceDir: browserEvidenceDir,
          repairAttempt: browserRepairAttempt,
        }, signal);
        browserVersion = checked.browserVersion;
        const evidence = summarizeAttempt(browserRepairAttempt, browserVersion, checked.measurements);
        browserAttempts.push(evidence);
        if (evidence.score > bestBrowserCandidate.score) {
          bestBrowserCandidate = { score: evidence.score, html: hardenedHtml, repairAttempt: browserRepairAttempt };
        }
        onStage('open_design_browser_quality_checked', {
          repairAttempt: browserRepairAttempt,
          hardPassed: evidence.hardPassed,
          issueCodes: evidence.issueCodes,
          score: evidence.score,
        });
        if (evidence.hardPassed) break;
        if (browserRepairAttempt >= MAX_BROWSER_REPAIR_ATTEMPTS) {
          if (bestBrowserCandidate.html !== hardenedHtml) {
            fs.writeFileSync(indexPath, bestBrowserCandidate.html);
            this.chownForEngine(indexPath);
          }
          await previewPusher?.flush();
          throw new AgentWorkspaceRuntimeError(
            'design_browser_quality_rejected',
            'The isolated browser quality gate still found hard layout or usability issues after two targeted repair attempts',
            false,
            {
              ruleVersion: evidence.viewports[0]?.issues[0]?.ruleVersion ?? null,
              repairAttempts: browserRepairAttempt,
              issueCodes: evidence.issueCodes,
              bestScore: Math.max(...browserAttempts.map((attempt) => attempt.score)),
              bestRepairAttempt: bestBrowserCandidate.repairAttempt,
            },
          );
        }
        const repair = await client.odJson('/api/runs', {
          method: 'POST',
          body: buildRunBody(browserRepairMessage(evidence)),
          signal: signalForDeadline(executionDeadline, signal),
          acceptedStatuses: [200, 202],
        });
        finalRunId = typeof repair.runId === 'string'
          ? repair.runId
          : typeof repair.id === 'string'
            ? repair.id
            : '';
        if (!finalRunId) {
          throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign browser quality repair run returned no run id');
        }
        activeRunId = finalRunId;
        onStage('open_design_quality_repairing', {
          runId: finalRunId,
          attempt: browserRepairAttempt + 1,
          kind: 'browser-hard-gate',
          issueCodes: evidence.issueCodes,
        });
        runOutcome = await client.waitForRun(finalRunId, executionDeadline, signal, onStage, previewPusher.poll);
        deliverableEntryFile = runOutcome.deliverableEntryFile || deliverableEntryFile;
        this.promoteDeliverableEntry(deliverableEntryFile, onStage);
        this.exportOutputs(transfer, prepared);
        collectedFiles = this.collectOutputs(transfer);
        indexFile = collectedFiles.find((file) => file.path === 'index.html');
        if (!indexFile) {
          throw new AgentWorkspaceRuntimeError('design_output_missing', 'OpenDesign browser repair completed without index.html');
        }
        const repairedBytes = Buffer.from(indexFile.contentBase64, 'base64');
        const currentHtml = fs.existsSync(currentIndexPath) ? fs.readFileSync(currentIndexPath) : undefined;
        if (
          !runOutcome.deliverableValid
          && !canAcceptUntrackedWorkspaceEdit(runOutcome.deliverableValidation, currentHtml, repairedBytes)
        ) {
          throw new AgentWorkspaceRuntimeError(
            'open_design_deliverable_invalid',
            runOutcome.deliverableValidation || 'OpenDesign rejected its browser quality repair deliverable',
          );
        }
        hardenedHtml = checkArtifactQuality(
          repairedBytes.toString('utf8'),
          collectedFiles.map((file) => file.path),
        );
        assertRequiredFactualCoverage(
          hardenedHtml,
          designContext.brief?.factualCoverageRequirements.requiredFacts ?? [],
        );
      }
      activeRunId = undefined;
      const browserQuality = buildBrowserQualityEvidence(browserVersion, browserAttempts);
      const browserEvidenceFiles: WorkspacePackageFile[] = [];
      const reportBytes = Buffer.from(`${JSON.stringify(browserQuality, null, 2)}\n`);
      browserEvidenceFiles.push({
        path: BROWSER_QUALITY_REPORT_PATH,
        contentBase64: reportBytes.toString('base64'),
        sha256: sha256(reportBytes),
        size: reportBytes.byteLength,
        mediaType: mediaTypeForFile(BROWSER_QUALITY_REPORT_PATH),
      });
      for (const evidenceRef of [...new Set(browserAttempts.flatMap((attempt) => attempt.evidenceRefs))]) {
        const screenshot = fs.readFileSync(path.join(browserEvidenceDir, path.basename(evidenceRef)));
        browserEvidenceFiles.push({
          path: evidenceRef,
          contentBase64: screenshot.toString('base64'),
          sha256: sha256(screenshot),
          size: screenshot.byteLength,
          mediaType: mediaTypeForFile(evidenceRef),
        });
      }
      const hardenedBytes = Buffer.from(hardenedHtml);
      indexFile!.contentBase64 = hardenedBytes.toString('base64');
      indexFile!.sha256 = sha256(hardenedBytes);
      indexFile!.size = hardenedBytes.byteLength;
      // Keep validated author assets byte-for-byte. The service alone produces its
      // reserved metadata and manifest; no author manifest is trusted.
      collectedFiles = validatePublicArtifactFiles(collectedFiles, true);
      const generatedPaths = [...CDS_GENERATED_ARTIFACT_PATHS, ...browserEvidenceFiles.map((file) => file.path)];
      if (!generatedPaths.every((reportPath) => isAllowedOutput(reportPath, transfer.allowedOutputPaths))) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_quality_evidence_unsupported',
          'MAP output allowlist does not permit the versioned browser quality evidence bundle',
        );
      }
      const files = buildGeneratedPublicArtifactPackage(hardenedHtml, collectedFiles, browserEvidenceFiles);
      assertPublicArtifactFileCount(files.length);
      const totalOutputBytes = files.reduce((total, file) => total + file.size, 0);
      if (totalOutputBytes > transfer.maxOutputBytes) {
        throw new AgentWorkspaceRuntimeError('design_output_too_large', 'OpenDesign output and CDS manifest exceed maxOutputBytes');
      }
      const commitBody = {
        schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
        sessionId,
        runId: prepared.mapRunId,
        baseRevision: transfer.baseRevision,
        files,
      };
      const serialized = JSON.stringify(commitBody);
      if (Buffer.byteLength(serialized, 'utf8') > transfer.maxOutputBytes) {
        throw new AgentWorkspaceRuntimeError('design_output_too_large', 'Serialized public output exceeds maxOutputBytes');
      }
      assertExecutionDeadline(executionDeadline);
      onStage('workspace_committing', { fileCount: files.length });
      const commitDeadline = Math.min(
        executionDeadline,
        Date.now() + Math.min(task.timeoutSeconds * 1000, 60_000),
      );
      const commitResponse = await this.fetchPartnerTransfer(transfer.resultCommitUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${transferToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: serialized,
        signal: signalForDeadline(commitDeadline, signal),
      }, 'workspaceTransfer.resultCommitUrl');
      const commitBytes = await readResponseLimited(commitResponse, MAX_COMMIT_RESPONSE_BYTES);
      assertExecutionDeadline(executionDeadline);
      let commit: Record<string, unknown> = {};
      try {
        commit = commitBytes.length ? JSON.parse(commitBytes.toString('utf8')) as Record<string, unknown> : {};
      } catch {
        throw new AgentWorkspaceRuntimeError('workspace_commit_invalid_response', 'MAP result commit returned invalid JSON');
      }
      if (!commitResponse.ok) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_commit_failed',
          typeof commit.message === 'string'
            ? commit.message
            : `MAP result commit failed with status ${commitResponse.status}`,
          commitResponse.status >= 500,
        );
      }
      const artifactRef = typeof commit.artifactRef === 'string' ? commit.artifactRef : '';
      if (!artifactRef) {
        throw new AgentWorkspaceRuntimeError('workspace_commit_invalid_response', 'MAP result commit returned no artifactRef');
      }
      const resultSha256 = typeof commit.resultSha256 === 'string'
        ? commit.resultSha256.toLowerCase()
        : '';
      if (!SHA256_RE.test(resultSha256)) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_commit_invalid_response',
          'MAP result commit returned no valid resultSha256',
        );
      }
      return {
        artifactRef,
        resultSha256,
        files: files.map(({ path: filePath, sha256: fileSha, size, mediaType }) => ({
          path: filePath,
          sha256: fileSha,
          size,
          mediaType,
        })),
        openDesignRunId: finalRunId,
      };
    } finally {
      previewPusher?.close();
      if (activeRunId) await client.cancelRun(activeRunId);
      await relay.close().catch(() => undefined);
      fs.rmSync(browserEvidenceDir, { recursive: true, force: true });
    }
  }

  /**
   * 写 Codex 的会话配置。原来是 `docker exec node -e` 在容器里写，判据照搬：
   * CODEX_HOME 必须真实位于数据目录下（不是被换成符号链接的别处），配置文件不跟随符号链接、0600。
   */
  private writeCodexConfig(config: string): void {
    try {
      const dataDir = fs.realpathSync(this.options.paths.dataDir);
      const home = path.join(dataDir, OPEN_DESIGN_CODEX_HOME_RELATIVE);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(home) !== home) throw new Error('Codex home must remain session-local');
      const file = path.join(home, 'config.toml');
      const fd = fs.openSync(
        file,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeSync(fd, config);
      } finally {
        fs.closeSync(fd);
      }
      this.chownForEngine(path.join(dataDir, 'sandbox'));
    } catch {
      throw new AgentWorkspaceRuntimeError(
        'open_design_codex_config_failed',
        'OpenDesign could not prepare its session-scoped MAP model configuration',
      );
    }
  }

  /**
   * 把 OpenDesign 指名的交付文件（`deliverableEntryFile`）搬成 `/workspace/index.html`。
   * 它没指名、或指名的就是 `index.html` 时什么都不做——那是模型直接改了根页面的情形。
   * 指名了却搬不动才算故障：文件不在、不是 HTML 文档、或路径形状不对，一律当场失败，
   * 不许把种子当成产物交出去（`predicate-and-wiring-discipline.md` 形状 10）。
   *
   * 与原实现相比多了一道判据：路径必须规范（不含 `..`）、真实路径必须仍在工作区里、
   * 读取不跟随符号链接。原来这一步在引擎容器里执行，读不到本服务；现在同处一个容器，
   * 一个被指成 `../../proc/1/environ` 的「交付文件」不能被搬进页面。
   */
  private promoteDeliverableEntry(entryFile: string | undefined, onStage: StageReporter): void {
    if (!entryFile || entryFile === 'index.html') {
      onStage('deliverable_entry_resolved', { entryFile: entryFile || null, promoted: false });
      return;
    }
    let normalized = '';
    try {
      normalized = normalizeRelativePath(entryFile);
    } catch {
      normalized = '';
    }
    if (!DELIVERABLE_ENTRY_PATH.test(entryFile) || normalized !== entryFile) {
      throw new AgentWorkspaceRuntimeError(
        'open_design_deliverable_entry_invalid',
        'OpenDesign named a deliverable entry file that is not a workspace-relative .html path',
        false,
        { stage: 'deliverable_entry', entryFile },
      );
    }
    const workspaceDir = this.options.paths.workspaceDir;
    let html: string;
    try {
      const from = path.join(workspaceDir, ...entryFile.split('/'));
      const realRoot = fs.realpathSync(workspaceDir);
      const realFrom = fs.realpathSync(from);
      if (!realFrom.startsWith(`${realRoot}${path.sep}`)) throw new Error('deliverable entry resolves outside the workspace');
      html = readRegularFileNoFollow(from).toString('utf8');
      if (!/<html[\s>]/i.test(html)) throw new Error(`deliverable entry is not an HTML document: ${entryFile}`);
      const target = path.join(workspaceDir, 'index.html');
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
      fs.writeFileSync(target, html);
      this.chownForEngine(target);
    } catch (error) {
      throw new AgentWorkspaceRuntimeError(
        'open_design_deliverable_entry_unreadable',
        'OpenDesign named a deliverable entry file that could not be read back as the page',
        true,
        {
          stage: 'deliverable_entry',
          entryFile,
          reasonPreview: runtimeDiagnosticPreview(error instanceof Error ? error.message : String(error), []),
        },
      );
    }
    onStage('deliverable_entry_resolved', {
      entryFile,
      promoted: true,
      bytes: html.length,
    });
  }

  /** 冻结引擎、校验并导出白名单内的产物，结束后一定解冻（对应原来的 docker pause / unpause）。 */
  private exportOutputs(transfer: WorkspaceTransferRequest, prepared: PreparedWorkspace): void {
    this.options.daemon.freeze();
    try {
      exportValidatedOutputs({
        workspaceDir: this.options.paths.workspaceDir,
        outputDir: this.options.paths.outputDir,
        allowedOutputPaths: transfer.allowedOutputPaths,
        inputFiles: prepared.inputFiles,
        maxOutputBytes: transfer.maxOutputBytes,
      });
    } finally {
      this.options.daemon.thaw();
    }
  }

  private collectOutputs(transfer: WorkspaceTransferRequest): WorkspacePackageFile[] {
    const outputDir = this.options.paths.outputDir;
    const results: WorkspacePackageFile[] = [];
    let total = 0;
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(outputDir, absolute).split(path.sep).join('/');
        normalizeRelativePath(relative);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          throw new AgentWorkspaceRuntimeError('design_output_invalid', `symbolic links are not allowed: ${relative}`);
        }
        if (stat.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (!stat.isFile()) {
          throw new AgentWorkspaceRuntimeError('design_output_invalid', `special files are not allowed: ${relative}`);
        }
        if (
          relative === 'manifest.json'
          || !isAllowedOutput(relative, transfer.allowedOutputPaths)
        ) continue;
        if (results.length >= MAX_OUTPUT_FILE_COUNT - 1) {
          throw new AgentWorkspaceRuntimeError(
            'design_output_too_many_files',
            `OpenDesign output exceeds the ${MAX_OUTPUT_FILE_COUNT}-file limit`,
          );
        }
        total += stat.size;
        if (total > transfer.maxOutputBytes) {
          throw new AgentWorkspaceRuntimeError('design_output_too_large', 'OpenDesign output exceeds maxOutputBytes');
        }
        const bytes = fs.readFileSync(absolute);
        results.push({
          path: relative,
          contentBase64: bytes.toString('base64'),
          sha256: sha256(bytes),
          size: bytes.byteLength,
          mediaType: mediaTypeForFile(relative),
        });
      }
    };
    walk(outputDir);
    return results.sort((left, right) => left.path.localeCompare(right.path));
  }

  /**
   * 模型终审超出它自己的预算时，不能把半写状态交给浏览器门禁。终审开始前的输出已经过
   * output-preflight；这里冻结引擎、清空声明过的输出根，再把那份受信快照原样恢复。
   * brief、knowledge、current、reference 等冻结输入不在输出白名单里，因此不会被触碰。
   */
  private restoreOutputCheckpoint(
    transfer: WorkspaceTransferRequest,
    checkpoint: WorkspacePackageFile[],
  ): void {
    const workspaceDir = this.options.paths.workspaceDir;
    this.options.daemon.freeze();
    try {
      for (const allowed of transfer.allowedOutputPaths) {
        const outputPath = allowed.endsWith('/**') ? allowed.slice(0, -3) : allowed;
        const normalized = normalizeRelativePath(outputPath);
        fs.rmSync(path.join(workspaceDir, ...normalized.split('/')), { recursive: true, force: true });
      }
      for (const file of checkpoint) {
        const normalized = normalizeRelativePath(file.path);
        if (!isAllowedOutput(normalized, transfer.allowedOutputPaths)) {
          throw new AgentWorkspaceRuntimeError(
            'design_output_invalid',
            `review checkpoint contains a path outside the output allowlist: ${normalized}`,
          );
        }
        const target = path.join(workspaceDir, ...normalized.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, Buffer.from(file.contentBase64, 'base64'));
      }
      this.chownForEngine(workspaceDir);
    } finally {
      this.options.daemon.thaw();
    }
  }

  /**
   * 失败取证用：工作区根目录实际有哪些条目。只在「没有 index.html」那条路径上调，
   * 用来分清「模型一个文件都没产出」与「产出了但没被认成交付物」。
   */
  private listWorkspaceRootEntries(): string[] {
    try {
      return fs.readdirSync(this.options.paths.workspaceDir).sort().slice(0, 40);
    } catch {
      // 取证失败不能把原始故障顶替掉——原始故障才是要报的那个。
      return ['<listing unavailable>'];
    }
  }

  /**
   * 所见即所得：运行期间每隔几秒看一眼 /workspace/index.html，变了就把整页推给 MAP
   * （同一张工作区传输凭证、同一个钉死的 MAP origin，地址由 resultCommitUrl 推出或由任务显式给出）。
   * 预览是尽力而为：失败不影响生成本身，但第一次失败会以阶段事件留痕，不静默（形状 10）。
   * 不跟随符号链接、超过 1 MB 不推——预览不是产物，产物仍只认最终整包提交。
   */
  private createPreviewPusher(
    task: DesignTaskInput,
    executionDeadline: number,
    onStage: StageReporter,
  ): PreviewPusher {
    const previewUrl = task.previewUrl;
    const indexPath = path.join(this.options.paths.workspaceDir, 'index.html');
    let lastCheckAt = 0;
    let lastFingerprint = '';
    let revision = 0;
    let failureReported = false;
    let disabled = !previewUrl;
    let closed = false;
    let debounceTimer: NodeJS.Timeout | undefined;
    let watcher: fs.FSWatcher | undefined;
    let pushing = false;
    let forcedAgain = false;
    const push = async (force = false): Promise<void> => {
      if (disabled || !previewUrl) return;
      const now = Date.now();
      if (!force && now - lastCheckAt < PREVIEW_CHECK_INTERVAL_MS) return;
      if (remainingExecutionMs(executionDeadline) < 15_000) return;
      if (pushing) {
        forcedAgain = forcedAgain || force;
        return;
      }
      pushing = true;
      lastCheckAt = now;
      try {
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(indexPath);
        } catch {
          return;
        }
        if (!stat.isFile()) return;
        if (stat.size <= 0 || stat.size > PREVIEW_MAX_BYTES) return;
        const html = readRegularFileNoFollow(indexPath, PREVIEW_MAX_BYTES).toString('utf8');
        if (!html.trim()) return;
        // 文件监听可能在同一毫秒内收到两版同字节数内容；只看 mtime/size 会吞掉真实变化。
        // 以正文摘要作为修订判据，轮询与 watch 共用同一条完整性口径。
        const fingerprint = sha256(Buffer.from(html, 'utf8'));
        if (fingerprint === lastFingerprint) return;
        // 指纹只在对端确认收下之后才记：推送失败（超时 / 5xx）时下一轮要重推同一份内容，
        // 否则页面停止变化后预览永远卡在失败前那一版。修订号照常递增，保持单调。
        revision += 1;
        const response = await this.fetchPartnerTransfer(previewUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${task.transfer.transferToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ html, revision }),
          signal: AbortSignal.timeout(10_000),
        }, 'workspaceTransfer.previewUrl');
        await readResponseLimited(response, 4096).catch(() => Buffer.alloc(0));
        if (response.status === 404 || response.status === 405) {
          // 对端 MAP 还没有预览端点（旧版本）：本次运行不再尝试，也不算故障。
          disabled = true;
          onStage('open_design_preview_unsupported', { status: response.status });
          return;
        }
        if (!response.ok) throw new Error(`MAP preview endpoint responded with HTTP ${response.status}`);
        lastFingerprint = fingerprint;
        onStage('open_design_preview_pushed', { revision, bytes: Buffer.byteLength(html, 'utf8') });
      } catch (error) {
        if (!failureReported) {
          failureReported = true;
          onStage('open_design_preview_failed', {
            message: error instanceof Error ? error.message.slice(0, 200) : 'preview push failed',
          });
        }
      } finally {
        pushing = false;
        if (forcedAgain && !closed) {
          forcedAgain = false;
          queueMicrotask(() => { void push(true); });
        }
      }
    };
    if (!disabled) {
      try {
        watcher = fs.watch(this.options.paths.workspaceDir, { persistent: false }, (_event, filename) => {
          if (closed || !filename || path.basename(filename.toString()) !== 'index.html') return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => { void push(true); }, 100);
        });
        watcher.on('error', () => {
          watcher?.close();
          watcher = undefined;
          // 监听不可用时不停任务；waitForRun 仍会持续调 poll 作兜底。
          onStage('open_design_preview_watch_unavailable');
        });
      } catch {
        onStage('open_design_preview_watch_unavailable');
      }
    }
    return {
      poll: () => push(false),
      flush: () => push(true),
      close: () => {
        closed = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        watcher?.close();
      },
    };
  }
}

function remainingExecutionMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new AgentWorkspaceRuntimeError('open_design_run_timeout', 'OpenDesign run exceeded the session timeout', true);
  }
  return remaining;
}

function assertExecutionDeadline(deadline: number): void {
  remainingExecutionMs(deadline);
}
