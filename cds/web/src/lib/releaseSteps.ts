/**
 * 发布步骤条的唯一渲染源（前端侧）。
 *
 * 修复前：ReleaseCenterPage 与 BranchListPage 各写一份「把日志 phase 收成 Set 再倒着
 * 找最后一条 error 反推失败步」的推断逻辑，并且把本仓库的 `./fast.sh` / `./exec_dep.sh`
 * 写死进了 CDS 这个通用产品——换成任何别的项目，步骤条立刻退化成几个笼统格子，
 * 且失败格经常点错位置（SSH 的 stderr 逐行进日志，最后一条 error 常来自上一步噪声）。
 *
 * 现在步骤由后端 run.progress 直接给出，这里只做展示映射。
 */

export type ReleaseStepState = 'pending' | 'running' | 'done' | 'failed';

export interface ReleaseRunStepLike {
  id: string;
  title: string;
  state: ReleaseStepState;
  startedAt?: string;
  finishedAt?: string;
}

export interface ReleaseRunProgressLike {
  planId?: string;
  steps?: ReleaseRunStepLike[];
  currentStepId?: string;
}

export interface ReleaseRunLogLike {
  level?: string;
  phase?: string;
  message?: string;
  at?: string;
}

export interface ReleaseRunLike {
  status: string;
  logs?: ReleaseRunLogLike[];
  progress?: ReleaseRunProgressLike;
}

export interface ReleaseStepView {
  id: string;
  label: string;
  state: ReleaseStepState;
  startedAt?: string;
  finishedAt?: string;
  /** 当前步骤最近一条可读活动；从真实发布输出提炼，不虚构阶段。 */
  activity?: string;
  activityAt?: string;
  /** 能从传输工具输出可靠解析时才给百分比。 */
  activityPercent?: number;
}

export interface ReleaseStepsView {
  steps: ReleaseStepView[];
  /** 1-based；无步骤时为 0。 */
  currentIndex: number;
  total: number;
  currentLabel: string;
  currentActivity: string;
  currentActivityAt?: string;
  currentActivityPercent?: number;
  /** true 代表退化骨架（存量 run 没有 progress），UI 可据此弱化「第 N/M 步」的确定性表述。 */
  degraded: boolean;
}

const TERMINAL_STATUS = ['success', 'failed', 'rollback_success', 'rollback_failed'];

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUS.includes(status);
}

export function resolveReleaseSteps(run: ReleaseRunLike | null | undefined): ReleaseStepsView {
  if (!run) return {
    steps: [], currentIndex: 0, total: 0, currentLabel: '', currentActivity: '', degraded: false,
  };
  const structured = run.progress?.steps || [];
  const steps: ReleaseStepView[] = structured.length > 0
    ? structured.map((step) => ({
      id: step.id,
      label: step.title,
      state: step.state,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      ...latestStepActivity(step.id, step.title, run.logs || []),
    }))
    : legacySteps(run);
  const degraded = structured.length === 0;
  const activeIndex = steps.findIndex((step) => step.state === 'running' || step.state === 'failed');
  const doneCount = steps.filter((step) => step.state === 'done').length;
  const currentIndex = steps.length === 0
    ? 0
    : activeIndex >= 0
      ? activeIndex + 1
      : Math.max(1, Math.min(doneCount === steps.length ? steps.length : doneCount + 1, steps.length));
  const current = steps[currentIndex - 1];
  return {
    steps,
    currentIndex,
    total: steps.length,
    currentLabel: current?.label || '',
    currentActivity: current?.activity || '',
    currentActivityAt: current?.activityAt,
    currentActivityPercent: current?.activityPercent,
    degraded,
  };
}

interface ReleaseActivity {
  activity?: string;
  activityAt?: string;
  activityPercent?: number;
}

/**
 * 把 SSH 原始输出压成步骤条能读懂的一行。
 *
 * 发布命令仍作为一个 SSH 会话执行，避免破坏 export、set -e 和工作目录等 shell 语义；
 * UI 从流式日志中提炼真实活动。脚本也可输出
 * `::cds-progress::{"label":"正在切换服务","percent":80}` 明确声明进度。
 */
export function parseReleaseActivity(message: string | undefined): { label: string; percent?: number } | null {
  const text = String(message || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .trim();
  if (!text) return null;

  const marker = text.match(/^::cds-progress::\s*(\{.*\})$/);
  if (marker) {
    try {
      const data = JSON.parse(marker[1]) as { label?: unknown; percent?: unknown };
      const label = typeof data.label === 'string' ? compactActivityLabel(data.label) : '';
      const percent = normalizePercent(data.percent);
      return label ? { label, ...(percent === undefined ? {} : { percent }) } : null;
    } catch {
      return null;
    }
  }

  // curl 的进度表会持续覆盖同一行；后端按换行收集后，这里把噪声压成可读百分比。
  const curl = text.match(/^(\d{1,3})\s+\d+(?:\.\d+)?[kKmMgGtT]?\s+(?:\d+(?:\.\d+)?[kKmMgGtT]?\s+){1,}/);
  if (curl) {
    const percent = normalizePercent(Number(curl[1]));
    return percent === undefined ? null : { label: `正在传输文件 ${percent}%`, percent };
  }
  if (/^%\s+Total\b|^Dload\s+Upload\b|^--:--:--/.test(text)) return null;

  const warming = text.match(/^Warming\s+(.+?)\s+image(?:\.\.\.)?$/i);
  if (warming) return { label: compactActivityLabel(`正在预热 ${warming[1]} 镜像`) };
  const warmed = text.match(/^(.+?)\s+image\s+warmup\s+completed/i);
  if (warmed) return { label: compactActivityLabel(`${warmed[1]} 镜像预热完成`) };
  const downloading = text.match(/^Downloading\s+(.+?)(?:\s+with\s+resume)?:\s*/i);
  if (downloading) return { label: compactActivityLabel(`正在下载 ${downloading[1]}`) };
  const pull = text.match(/^(?:Pulling|Pull)\s+(.+)/i);
  if (pull) return { label: compactActivityLabel(`正在拉取 ${pull[1]}`) };
  const build = text.match(/^(?:Building|Build)\s+(.+)/i);
  if (build) return { label: compactActivityLabel(`正在构建 ${build[1]}`) };

  // 环境变量、shell 控制语句和纯命令回显不适合占据主进度；完整内容仍在实时日志里。
  if (/^(?:export\s+|set\s+-|cd\s+|if\s+|then\b|fi\b|done\b|\[\s)/.test(text)) return null;
  return { label: compactActivityLabel(text) };
}

function latestStepActivity(
  stepId: string,
  stepTitle: string,
  logs: ReadonlyArray<ReleaseRunLogLike>,
): ReleaseActivity {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index];
    const phaseMatches = log.phase === stepId
      || (stepId === 'deploy' && Boolean(log.phase?.startsWith('script:')));
    if (!phaseMatches) continue;
    const parsed = parseReleaseActivity(log.message);
    if (!parsed || parsed.label === stepTitle) continue;
    return {
      activity: parsed.label,
      activityAt: log.at,
      ...(parsed.percent === undefined ? {} : { activityPercent: parsed.percent }),
    };
  }
  return {};
}

function compactActivityLabel(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
}

function normalizePercent(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return undefined;
  return Math.round(parsed);
}

/**
 * 存量 run（阶段二之前入库、没有 progress）的兜底骨架。
 *
 * 刻意只用**通用**步骤名：历史记录仍然可读，但本仓库的脚本名不会借兜底路径复活到
 * 这个通用产品里。粒度弱于新 run 是有意的取舍——旧日志本来也只有 phase 可依。
 */
function legacySteps(run: ReleaseRunLike): ReleaseStepView[] {
  const phases = new Set((run.logs || []).map((log) => log.phase).filter(Boolean) as string[]);
  const seenDeploy = [...phases].some((phase) => phase === 'deploy' || phase.startsWith('script:'));
  const seenHealth = phases.has('healthcheck');
  const failed = run.status.includes('failed');
  const success = run.status === 'success' || run.status === 'rollback_success';
  const skeleton: ReleaseStepView[] = [
    { id: 'connect', label: '连接服务器', state: phases.has('connect') ? 'done' : 'pending' },
    {
      id: 'prepare',
      label: '进入站点目录',
      state: phases.has('prepare') || seenDeploy || seenHealth || success ? 'done' : 'pending',
    },
    {
      id: 'deploy',
      label: '执行发布命令',
      state: seenHealth || success ? 'done' : seenDeploy ? 'running' : 'pending',
    },
    {
      id: 'healthcheck',
      label: '检查上线地址',
      state: seenHealth ? (failed ? 'failed' : 'done') : 'pending',
    },
    { id: 'record', label: '标记完成', state: success ? 'done' : 'pending' },
  ];
  if (failed) {
    if (!skeleton.some((step) => step.state === 'failed')) {
      const next = skeleton.find((step) => step.state === 'running' || step.state === 'pending');
      if (next) next.state = 'failed';
      else {
        const lastDone = [...skeleton].reverse().find((step) => step.state === 'done');
        if (lastDone) lastDone.state = 'failed';
      }
    }
  } else if (!isTerminalStatus(run.status)) {
    const next = skeleton.find((step) => step.state === 'running' || step.state === 'pending');
    if (next) next.state = 'running';
  }
  return skeleton;
}
