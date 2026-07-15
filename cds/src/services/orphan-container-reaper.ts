/**
 * 孤儿容器收割器（Orphan Container Reaper，2026-07-15）。
 *
 * 背景（用户实锤 + 24h 日志取证）：删除的项目 / 分支，其 infra / app 容器
 * 会永远留在宿主上——project DELETE 明确不碰容器，startup reconcile 只对孤儿
 * 记一条 warn（单日取证：68 个孤儿 app 容器，最早是 5 月删除的测试分支），
 * infra 孤儿甚至只有 console.warn。结果是容器数持续膨胀（perf-health 的
 * too-many-containers 告警），CPU 被僵尸容器吃掉。
 *
 * 原则（对账收敛，不再指望命令式级联做全对）：
 *   docker 里存在、但 state 里没有 owner 的 cds-managed 容器 = 孤儿 → 停掉。
 *   删除操作的快速级联仍然做（routes 层），本收割器是最终一致性兜底：
 *   无论哪条删除路径漏了、崩了、半途失败了，最迟一个 sweep 周期后收敛。
 *
 * 安全边界（宁可漏杀不可误杀）：
 *   1. 只碰带 `cds.managed=true` label 的容器（与 discoverInfraContainers /
 *      discoverAppContainersWithStatus 同一口径），宿主上任何非 CDS 容器绝不触碰；
 *   2. docker ps 查询失败（exitCode!=0）→ 本轮直接放弃，绝不在信息不全时动手；
 *   3. state 空库守卫：projects/branches/infraServices 全空时跳过——空库更可能是
 *      state 加载失败或全新安装，而不是"所有容器都成了孤儿"；
 *   4. 默认只 stop 不 rm（用户拍板"至少要停止"）；容器和它的数据卷留给
 *      人工 / 项目删除路径处置；
 *   5. 逃生阀：CDS_ORPHAN_CONTAINER_REAPER=0 整体关闭。
 */
import type { IShellExecutor } from '../types.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

/** 收割器状态视图的窄接口（便于单测注入，不拖整个 StateService）。 */
export interface OrphanReaperStateView {
  getProjects(): Array<{ id: string }>;
  getAllBranches(): Array<{ id: string }>;
  getInfraServices(): Array<{ containerName: string }>;
}

export interface OrphanContainerAction {
  containerName: string;
  kind: 'infra' | 'app';
  /** 关联到的 owner 标识（infra 无从考证时为空） */
  ownerHint?: string;
  action: 'stopped' | 'stop-failed' | 'already-stopped';
  detail?: string;
}

export interface OrphanSweepResult {
  skippedReason?: 'disabled' | 'state-empty' | 'docker-query-failed';
  actions: OrphanContainerAction[];
}

export function isOrphanReaperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CDS_ORPHAN_CONTAINER_REAPER || '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

const quote = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 无论 state 里有没有，永远不许收割的系统级容器（自断状态库 = 自杀）。
 * 口径对齐 state.ts 的 classifyInfraScope 已知系统 infra。
 */
const PROTECTED_CONTAINER_NAMES = new Set(['cds-infra-cds-state-mongo']);

interface DiscoveredContainer {
  name: string;
  running: boolean;
  labels: string;
}

async function listCdsContainers(
  shell: IShellExecutor,
  type: 'infra' | 'app',
): Promise<DiscoveredContainer[] | null> {
  const result = await shell.exec(
    `docker ps -a --filter "label=cds.managed=true" --filter "label=cds.type=${type}" --format '{{.Names}}|{{.State}}|{{.Labels}}'`,
  );
  if (result.exitCode !== 0) return null;
  const out: DiscoveredContainer[] = [];
  for (const line of result.stdout.trim().split('\n')) {
    if (!line) continue;
    const [name, state, labels] = line.split('|');
    if (!name) continue;
    out.push({ name, running: state === 'running', labels: labels || '' });
  }
  return out;
}

/**
 * 单轮收割：找出孤儿 infra / app 容器并停掉（只停不删）。
 * 幂等：已停的孤儿记 already-stopped，不重复动作。
 */
export async function sweepOrphanCdsContainers(opts: {
  shell: IShellExecutor;
  state: OrphanReaperStateView;
  eventLog?: ServerEventLogSink | null;
  env?: NodeJS.ProcessEnv;
}): Promise<OrphanSweepResult> {
  const { shell, state, eventLog } = opts;
  if (!isOrphanReaperEnabled(opts.env)) return { skippedReason: 'disabled', actions: [] };

  const projects = state.getProjects();
  const branches = state.getAllBranches();
  const infraServices = state.getInfraServices();
  if (projects.length === 0 && branches.length === 0 && infraServices.length === 0) {
    // 空库守卫：更可能是 state 没加载成功 / 全新安装，绝不能把全部容器当孤儿。
    return { skippedReason: 'state-empty', actions: [] };
  }

  const [infraContainers, appContainers] = await Promise.all([
    listCdsContainers(shell, 'infra'),
    listCdsContainers(shell, 'app'),
  ]);
  if (infraContainers === null || appContainers === null) {
    return { skippedReason: 'docker-query-failed', actions: [] };
  }

  const knownInfraNames = new Set(infraServices.map((s) => s.containerName).filter(Boolean));
  const knownBranchIds = new Set(branches.map((b) => b.id));

  const actions: OrphanContainerAction[] = [];

  const stopOne = async (
    container: DiscoveredContainer,
    kind: 'infra' | 'app',
    ownerHint: string | undefined,
  ): Promise<void> => {
    if (!container.running) {
      actions.push({ containerName: container.name, kind, ownerHint, action: 'already-stopped' });
      return;
    }
    const res = await shell.exec(`docker stop ${quote(container.name)}`, { timeout: 60_000 });
    const ok = res.exitCode === 0;
    actions.push({
      containerName: container.name,
      kind,
      ownerHint,
      action: ok ? 'stopped' : 'stop-failed',
      detail: ok ? undefined : (res.stderr || res.stdout || '').slice(0, 200),
    });
    eventLog?.record({
      category: 'container',
      severity: ok ? 'warn' : 'error',
      source: 'orphan-container-reaper',
      action: ok ? 'container.orphan.stopped' : 'container.orphan.stop-failed',
      message: ok
        ? `孤儿${kind === 'infra' ? '基础设施' : '应用'}容器已停止（state 中无 owner）: ${container.name}`
        : `孤儿容器停止失败: ${container.name}`,
      containerName: container.name,
      details: {
        kind,
        ownerHint: ownerHint || null,
        reason: 'owner-missing-in-state',
        stderr: ok ? undefined : (res.stderr || '').slice(0, 300),
      },
    });
  };

  for (const c of infraContainers) {
    if (PROTECTED_CONTAINER_NAMES.has(c.name)) continue;
    if (knownInfraNames.has(c.name)) continue;
    await stopOne(c, 'infra', undefined);
  }
  for (const c of appContainers) {
    const branchMatch = c.labels.match(/cds\.branch\.id=([^,]+)/);
    const branchId = branchMatch?.[1];
    // 没有 branch label 的 app 容器视为异常孤儿；有 label 的按 branch 是否存活判定。
    if (branchId && knownBranchIds.has(branchId)) continue;
    await stopOne(c, 'app', branchId);
  }

  return { actions };
}
