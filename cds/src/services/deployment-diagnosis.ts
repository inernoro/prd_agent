import type { DeploymentFailure, DeploymentRun, DeploymentVersion } from '../types.js';
import type { DeploymentRunService } from './deployment-run.js';
import type { DeploymentVersionService } from './deployment-version.js';
import { redactBodyText } from './http-log-store.js';

export interface DeploymentExplanationFacts {
  run: {
    id: string;
    status: DeploymentRun['status'];
    phase: string;
    trigger: DeploymentRun['trigger'];
    commitSha?: string;
    versionId?: string;
    executorId?: string;
    failure?: DeploymentFailure;
  };
  version?: {
    id: string;
    commitSha: string;
    profiles: Array<{ profileId: string; artifactKind: string; reusable: boolean }>;
    capabilities: Array<{ kind: string; bindingId: string }>;
  };
  eventTrail: Array<{ seq: number; phase: string; status: string; message: string; evidenceRefs: string[] }>;
}

export interface AiDeploymentExplanation {
  summary: string;
  actions: string[];
  cautions?: string[];
}

export interface DeploymentExplanationProvider {
  explain(facts: DeploymentExplanationFacts): Promise<AiDeploymentExplanation>;
}

export interface DeploymentDiagnosis {
  runId: string;
  status: DeploymentRun['status'];
  headline: string;
  failure?: DeploymentFailure;
  facts: DeploymentExplanationFacts;
  actions: string[];
  evidenceRefs: string[];
  ai: { status: 'disabled' | 'ready' | 'failed'; explanation?: AiDeploymentExplanation; error?: string };
}

export class DeploymentDiagnosisService {
  constructor(
    private readonly runService: DeploymentRunService,
    private readonly versionService: DeploymentVersionService,
    private readonly provider?: DeploymentExplanationProvider,
  ) {}

  getFacts(runId: string): DeploymentExplanationFacts {
    const run = this.runService.get(runId);
    if (!run) throw new Error(`DeploymentRun not found: ${runId}`);
    const version = run.versionId ? this.versionService.get(run.versionId) : undefined;
    return toFacts(run, version);
  }

  deterministic(runId: string): DeploymentDiagnosis {
    const run = this.runService.get(runId);
    if (!run) throw new Error(`DeploymentRun not found: ${runId}`);
    const facts = this.getFacts(runId);
    const failure = run.failure;
    const actions = failure
      ? [failure.suggestedAction || '查看证据后修复首个失败点', ...(failure.retryable ? ['修复前置条件后可直接重试本次部署'] : [])]
      : run.status === 'running'
        ? ['当前部署已成功，无需执行恢复动作']
        : ['等待本次 DeploymentRun 进入终态后再判断根因'];
    const evidenceRefs = failure?.evidenceRefs || facts.eventTrail.flatMap((event) => event.evidenceRefs);
    return {
      runId,
      status: run.status,
      headline: failure
        ? `${ownerLabel(failure.owner)}问题: ${failure.summary}`
        : run.status === 'running'
          ? '部署成功，运行态与版本事实一致'
          : `部署仍在 ${run.phase} 阶段`,
      failure,
      facts,
      actions,
      evidenceRefs: [...new Set(evidenceRefs)].slice(0, 20),
      ai: { status: this.provider ? 'ready' : 'disabled' },
    };
  }

  async explain(runId: string): Promise<DeploymentDiagnosis> {
    const diagnosis = this.deterministic(runId);
    if (!this.provider || !diagnosis.failure) return diagnosis;
    try {
      const explanation = await this.provider.explain(diagnosis.facts);
      return { ...diagnosis, ai: { status: 'ready', explanation } };
    } catch (err) {
      return { ...diagnosis, ai: { status: 'failed', error: redactBodyText((err as Error).message).slice(0, 500) } };
    }
  }
}

export class GatewayDeploymentExplanationProvider implements DeploymentExplanationProvider {
  constructor(private readonly config: { endpoint: string; apiKey?: string; model: string }) {}

  async explain(facts: DeploymentExplanationFacts): Promise<AiDeploymentExplanation> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'system',
              content: '你是 CDS 部署解释器。只解释输入的结构化事实，不推翻状态，不补造日志。输出 JSON: summary, actions, cautions。',
            },
            { role: 'user', content: JSON.stringify(facts) },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`AI Gateway HTTP ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI Gateway 未返回解释内容');
      const parsed = JSON.parse(content) as Partial<AiDeploymentExplanation>;
      if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.actions)) {
        throw new Error('AI Gateway 返回格式不符合诊断契约');
      }
      return {
        summary: redactBodyText(parsed.summary).slice(0, 2_000),
        actions: parsed.actions.filter((item): item is string => typeof item === 'string').slice(0, 8).map((item) => redactBodyText(item).slice(0, 500)),
        cautions: Array.isArray(parsed.cautions)
          ? parsed.cautions.filter((item): item is string => typeof item === 'string').slice(0, 5).map((item) => redactBodyText(item).slice(0, 500))
          : undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toFacts(run: DeploymentRun, version?: DeploymentVersion): DeploymentExplanationFacts {
  return {
    run: {
      id: run.id,
      status: run.status,
      phase: run.phase,
      trigger: run.trigger,
      commitSha: run.commitSha,
      versionId: run.versionId,
      executorId: run.executorId,
      failure: run.failure ? {
        ...run.failure,
        summary: redactBodyText(run.failure.summary),
      } : undefined,
    },
    version: version ? {
      id: version.id,
      commitSha: version.commitSha,
      profiles: version.profiles.map((profile) => ({
        profileId: profile.profileId,
        artifactKind: profile.artifactKind,
        reusable: profile.reusable,
      })),
      capabilities: version.capabilities.map(({ kind, bindingId }) => ({ kind, bindingId })),
    } : undefined,
    eventTrail: run.events.slice(-12).map((event) => ({
      seq: event.seq,
      phase: event.phase,
      status: event.status,
      message: redactBodyText(event.message).slice(0, 1_000),
      evidenceRefs: event.evidenceRefs || [],
    })),
  };
}

function ownerLabel(owner: DeploymentFailure['owner']): string {
  return ({ code: '代码侧', config: '配置侧', cds: 'CDS 侧', external: '外部依赖侧', unknown: '未归类' })[owner];
}
