import type { DeploymentFailure, DeploymentRun } from '../types.js';

interface FailureRule {
  code: string;
  pattern: RegExp;
  phases?: RegExp;
  owner: DeploymentFailure['owner'];
  retryable: boolean;
  suggestedAction: string;
}

const RULES: FailureRule[] = [
  {
    code: 'build.compile.csharp',
    pattern: /\berror\s+CS\d{3,5}\b|Build FAILED.*\.cs/i,
    owner: 'code', retryable: false, suggestedAction: '修复日志中的首个 C# 编译错误后重新部署',
  },
  {
    code: 'build.compile.typescript',
    pattern: /\berror\s+TS\d{3,5}\b|TypeScript.*(?:compile|type).*(?:failed|error)/i,
    owner: 'code', retryable: false, suggestedAction: '修复首个 TypeScript 类型错误后重新部署',
  },
  {
    code: 'build.dependencies.missing',
    pattern: /Cannot find module|Module not found|MODULE_NOT_FOUND|package .* not found/i,
    owner: 'code', retryable: false, suggestedAction: '核对依赖清单与 lockfile，并确认 install 阶段成功',
  },
  {
    code: 'artifact.image.pull',
    pattern: /image.+(?:not found|pull access denied)|manifest unknown|repository does not exist|镜像拉取失败/i,
    owner: 'external', retryable: true, suggestedAction: '确认镜像引用、Registry 权限和网络后重试',
  },
  {
    code: 'runtime.port.conflict',
    pattern: /EADDRINUSE|address already in use|port.+(?:in use|occupied)|端口.+占用/i,
    owner: 'config', retryable: true, suggestedAction: '释放冲突端口或让 CDS 重新分配端口后重试',
  },
  {
    code: 'runtime.memory.oom',
    pattern: /OOMKilled|out of memory|cannot allocate memory/i,
    owner: 'config', retryable: true, suggestedAction: '降低并发或提高可用内存后重试',
  },
  {
    code: 'runtime.readiness.timeout',
    pattern: /readiness|health.*timeout|就绪探测超时|容器进程未监听端口/i,
    phases: /ready|verif|start/i,
    owner: 'code', retryable: false, suggestedAction: '检查应用监听地址、端口和健康路径，并查看该服务启动日志',
  },
  {
    code: 'config.environment.missing',
    pattern: /required_env_missing|必填环境变量|缺少环境变量/i,
    owner: 'config', retryable: false, suggestedAction: '补齐项目环境变量后重新部署',
  },
  {
    code: 'config.managed.plan-invalid',
    pattern: /managed_plan_invalid|managed .*?(?:不存在|无法识别|缺少|非法)|managed capability/i,
    owner: 'config', retryable: false, suggestedAction: '修正托管应用声明或能力绑定，再重新生成生效配置',
  },
  {
    code: 'cds.state.persist',
    pattern: /state-flush|状态持久化|落盘|flush/i,
    phases: /state-flush/i,
    owner: 'cds', retryable: true, suggestedAction: '确认 CDS 状态存储健康后重试；不要把本次响应视为已完成',
  },
  {
    code: 'cds.executor.unavailable',
    pattern: /executor.*(?:offline|unavailable|拒绝|不可达)|owning_executor_offline|执行器.*(?:离线|不可达)/i,
    owner: 'cds', retryable: true, suggestedAction: '等待原执行器恢复或重新分配执行器后重试',
  },
  {
    code: 'runtime.process.crashed',
    pattern: /exit(?:\s+code|ed with code)?\s*[:=]?\s*\d+|segmentation fault|进程异常退出/i,
    owner: 'code', retryable: false, suggestedAction: '查看进程退出前的最后一段服务日志并修复应用错误',
  },
];

export function classifyDeploymentFailure(input: {
  message: string;
  phase: string;
  run?: DeploymentRun;
  serviceId?: string;
  evidenceRefs?: string[];
}): DeploymentFailure {
  const eventText = (input.run?.events || [])
    .filter((event) => event.level === 'error' || event.status === 'error')
    .slice(-10)
    .map((event) => `${event.phase} ${event.message}`)
    .join('\n');
  const text = `${input.phase}\n${input.message}\n${eventText}`;
  const rule = RULES.find((candidate) =>
    candidate.pattern.test(text) && (!candidate.phases || candidate.phases.test(input.phase)),
  );
  const evidenceRefs = collectEvidenceRefs(input.run, input.evidenceRefs);
  return {
    code: rule?.code || 'deploy.unknown',
    owner: rule?.owner || 'unknown',
    retryable: rule?.retryable ?? true,
    summary: sanitizeSummary(input.message),
    serviceId: input.serviceId || inferServiceId(input.run),
    phase: input.phase,
    evidenceRefs,
    suggestedAction: rule?.suggestedAction || '按 evidenceRefs 查看本次运行事件与服务日志，确认首个失败点后再重试',
  };
}

function collectEvidenceRefs(run?: DeploymentRun, extra: string[] = []): string[] {
  const refs = new Set<string>(extra);
  if (run) {
    refs.add(`deployment-run:${run.id}`);
    if (run.operationId) refs.add(`operation:${run.operationId}`);
    for (const event of run.events.slice(-20)) {
      if (event.level !== 'error' && event.status !== 'error') continue;
      refs.add(`deployment-run:${run.id}:event:${event.seq}`);
      for (const ref of event.evidenceRefs || []) refs.add(ref);
    }
  }
  return [...refs].slice(0, 20);
}

function inferServiceId(run?: DeploymentRun): string | undefined {
  for (const event of [...(run?.events || [])].reverse()) {
    const profileId = event.detail?.profileId;
    if (typeof profileId === 'string' && profileId) return profileId;
    const serviceId = event.detail?.serviceId;
    if (typeof serviceId === 'string' && serviceId) return serviceId;
  }
  return undefined;
}

function sanitizeSummary(message: string): string {
  return String(message || '部署失败').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2 * 1024);
}
