// GET /v1/capabilities 的内容：能不能接任务、为什么不能。每次请求都实时探测一次 OpenDesign daemon，
// 不拿缓存冒充健康；不健康时 reason 给出「谁 + 做了什么 → 于是怎样 → 要不要紧」的人话与技术细节。
import { renderCondition, type RenderedCondition } from './conditions.js';
import type { EngineLifecycle } from './engine/lifecycle.js';
import type { EngineSelfCheck } from './engine/self-check.js';
import { OPEN_DESIGN_CODEX_VERSION, OPEN_DESIGN_ENGINE_VERSION } from './prompts.js';
import { EXECUTOR_PROTOCOL } from './protocol.js';
import type { SlotState, TaskManager } from './tasks.js';

export interface CapabilitiesContext {
  apiKeyConfigured: boolean;
  selfCheck: EngineSelfCheck;
  lifecycle: EngineLifecycle;
  tasks: TaskManager;
}

export interface Capabilities {
  protocol: string;
  engine: 'open-design';
  engineVersion: string | null;
  pinnedEngineVersion: string;
  codexVersion: string | null;
  pinnedCodexVersion: string;
  designSystems: string[];
  healthy: boolean;
  /** 引擎本身能用（不看 API key）。就绪探针用它。 */
  engineReady: boolean;
  busy: boolean;
  acceptingTasks: boolean;
  maxConcurrentTasks: 1;
  state: SlotState;
  reason: RenderedCondition | null;
  conditions: RenderedCondition[];
  engineProcess: {
    running: boolean;
    unexpectedExitsInLast10Minutes: number;
    lastUnexpectedExitAt: string | null;
  };
  checkedAt: string;
}

export async function describeCapabilities(context: CapabilitiesContext): Promise<Capabilities> {
  const { selfCheck, lifecycle, tasks } = context;
  const state = tasks.slotState();
  const conditions: RenderedCondition[] = [];
  const engineConditions: RenderedCondition[] = [];

  if (!context.apiKeyConfigured) {
    conditions.push(renderCondition({
      code: 'api_key_not_configured',
      actor: { kind: 'deployment', label: '部署配置' },
      event: '没有提供 DESIGN_RUNTIME_API_KEY',
      impact: '服务拒绝一切任务接口（提交、查询、读事件、取消），能力查询照常可用',
      urgency: { kind: 'act', action: '在 CDS 项目环境变量（或生产部署配置）里设置 DESIGN_RUNTIME_API_KEY，并让 MAP 使用同一把 key' },
      retryable: false,
      technical: { env: 'DESIGN_RUNTIME_API_KEY' },
    }));
  }
  if (!selfCheck.codexMatches || selfCheck.missingSkillFiles.length > 0) {
    engineConditions.push(renderCondition({
      code: 'engine_resources_missing',
      actor: { kind: 'deployment', label: '运行镜像' },
      event: `不带本服务要求的 Codex CLI ${OPEN_DESIGN_CODEX_VERSION} 或 web-prototype 技能资源`,
      impact: '引擎无法按约定执行设计任务，暂不接新任务',
      urgency: { kind: 'act', action: '按 design-runtime/opendesign/Dockerfile 重建并重新部署镜像' },
      retryable: false,
      technical: {
        codexVersion: selfCheck.codexVersion ?? selfCheck.codexObservation,
        missingSkillFiles: selfCheck.missingSkillFiles.join(',') || null,
      },
    }));
  }
  const slotCondition = tasks.slotCondition();
  if (slotCondition) engineConditions.push(slotCondition);

  let engineVersion: string | null = null;
  const exits = lifecycle.unexpectedExitSummary();
  if (state === 'idle' || state === 'running') {
    const health = await lifecycle.probe();
    engineVersion = health.version;
    if (!health.ok) {
      engineConditions.push(renderCondition({
        code: 'engine_unhealthy',
        actor: { kind: 'engine' },
        event: '没有通过健康检查（GET /api/health）',
        impact: '暂不接新任务',
        urgency: exits.recentCount >= 3
          ? { kind: 'investigate', where: '本服务容器日志里以 [od err] 与 [engine] 开头的行（十分钟内引擎已意外退出多次）' }
          : { kind: 'wait', until: '本服务自动重新拉起引擎' },
        retryable: true,
        technical: {
          observation: health.observation.slice(0, 200),
          engineRunning: lifecycle.daemon.describe().running,
          unexpectedExitsInLast10Minutes: exits.recentCount,
        },
      }));
    } else if (health.version !== OPEN_DESIGN_ENGINE_VERSION) {
      engineConditions.push(renderCondition({
        code: 'engine_version_mismatch',
        actor: { kind: 'deployment', label: '运行镜像' },
        event: `里的 OpenDesign 报告版本 ${health.version ?? '未知'}，与本服务钉住的 ${OPEN_DESIGN_ENGINE_VERSION} 不一致`,
        impact: '为避免按旧契约驱动新引擎，暂不接新任务',
        urgency: { kind: 'act', action: '让 Dockerfile 的基础镜像与 OPEN_DESIGN_ENGINE_VERSION 一致后重建' },
        retryable: false,
        technical: { observed: health.version, pinned: OPEN_DESIGN_ENGINE_VERSION },
      }));
    }
  }
  conditions.push(...engineConditions);
  const healthy = conditions.length === 0;
  return {
    protocol: EXECUTOR_PROTOCOL,
    engine: 'open-design',
    engineVersion,
    pinnedEngineVersion: OPEN_DESIGN_ENGINE_VERSION,
    codexVersion: selfCheck.codexVersion,
    pinnedCodexVersion: OPEN_DESIGN_CODEX_VERSION,
    designSystems: selfCheck.designSystems,
    healthy,
    engineReady: engineConditions.length === 0 && state !== 'starting',
    busy: state === 'running' || state === 'resetting',
    acceptingTasks: healthy && state === 'idle',
    maxConcurrentTasks: 1,
    state,
    reason: conditions[0] ?? null,
    conditions,
    engineProcess: {
      running: lifecycle.daemon.describe().running,
      unexpectedExitsInLast10Minutes: exits.recentCount,
      lastUnexpectedExitAt: exits.last?.at ?? null,
    },
    checkedAt: new Date().toISOString(),
  };
}
